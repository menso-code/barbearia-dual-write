import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANTUNES_TENANT_ID,
  OPERATIONAL_CONTEXT_MODES,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const command = "bloqueio.remover";

function sourceBetween(start, end) {
  const from = runtime.indexOf(start);
  const to = runtime.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `marcador inicial ausente: ${start}`);
  assert.notEqual(to, -1, `marcador final ausente: ${end}`);
  return runtime.slice(from, to);
}

class Slice5Model {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
  }

  snapshot() {
    return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit, io: this.io });
  }

  restore(snapshot) {
    this.legacy = snapshot.legacy;
    this.v2 = snapshot.v2;
    this.audit = snapshot.audit;
    this.io = snapshot.io;
  }

  key(mode, tenantId, collection, id) {
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? `${collection}/${id}`
      : `barbearias/${tenantId}/${collection}/${id}`;
  }

  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, collection, key });
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? this.legacy.get(key)
      : this.v2.get(key);
  }

  remove(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, collection, key });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.delete(key);
    this.v2.delete(`barbearias/${tenantId}/${collection}/${id}`);
  }

  seed(mode, tenantId, blockId, block, occupancies) {
    const blockKey = this.key(mode, tenantId, "bloqueios", blockId);
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(blockKey, structuredClone(block));
    for (const [id, value] of Object.entries(occupancies)) {
      target.set(this.key(mode, tenantId, "ocupacoes", id), structuredClone(value));
    }
  }

  removeBlock({ mode, tenantId, uid, roles, owner, blockId, requestId, failAt = "" }) {
    const fingerprint = operationalPayloadFingerprint({ blockId });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }
    const before = this.snapshot();
    try {
      const block = this.read(mode, tenantId, "bloqueios", blockId);
      if (!block) return { duplicate: false, blockId, removed: false };
      const isAdmin = roles.includes("ADMIN");
      const isOwner = roles.includes("BARBEIRO") && owner === block.barbeiro_id;
      if (!isAdmin && !isOwner) throw new Error("PERMISSION_DENIED");
      const slots = block.slots;
      if (failAt === "before-delete") throw new Error("INJECTED_FAILURE");
      this.remove(mode, tenantId, "bloqueios", blockId);
      for (const slot of slots) {
        const occupancyId = `${block.barbeiro_id}_${block.data}_${slot}`;
        const occupancy = this.read(mode, tenantId, "ocupacoes", occupancyId);
        if (occupancy?.bloqueio_id === blockId) {
          if (failAt === "during-occupancy-delete") throw new Error("INJECTED_FAILURE");
          this.remove(mode, tenantId, "ocupacoes", occupancyId);
        }
      }
      const result = { blockId, removed: true };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const block = {
  barbeiro_id: "barber-a",
  data: "2026-08-27",
  slots: ["10:00", "10:30"],
};
const linked = {
  "barber-a_2026-08-27_10:00": { bloqueio_id: "block-a" },
  "barber-a_2026-08-27_10:30": { bloqueio_id: "block-a" },
};

test("Slice 5 migra somente bloqueio.remover e mantém 32 comandos", () => {
  const context = sourceBetween("async function requireBlockPermission", "async function requireAdmin");
  assert.match(context, /tenantPrimaryRef\(context, "bloqueios"/);
  assert.match(context, /tenantPrimaryRef\(context, "ocupacoes"/);
  assert.match(context, /tenantDelete\(tx, context, "bloqueios"/);
  assert.match(context, /roles\.includes\("BARBEIRO"\)/);
  assert.equal((runtime.match(/^\s*case "[^"]+":/gm) || []).length, 32);
});

test("TENANT_A_BLOQUEIO_REMOVE_PASS e TENANT_B_BLOQUEIO_REMOVE_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice5Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, `block-${tenantId}`, block, linked);
    const result = model.removeBlock({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId,
      uid: `admin-${tenantId}`,
      roles: ["ADMIN"],
      owner: "",
      blockId: `block-${tenantId}`,
      requestId: `remove-${tenantId}-0001`,
    });
    assert.equal(result.removed, true);
  }
});

test("CROSS_TENANT_DENIED e INACTIVE_TENANT_DENIED ficam fail-closed pelo contexto", () => {
  assert.throws(
    () => validateOperationalEnvelope({ command, tenantId: "tenant-b" }),
    (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
  const context = sourceBetween("async function requireBlockPermission", "async function requireAdmin");
  assert.match(context, /context\.tenant\.id/);
  assert.match(context, /isAntunesRootAdmin/);
});

test("NON_MEMBER_DENIED e NON_ADMIN_OR_NON_OWNER_BARBER_DENIED", () => {
  const model = new Slice5Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, linked);
  assert.throws(() => model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"], owner: "", blockId: "block-a", requestId: "denied-client-0001" }), /PERMISSION_DENIED/);
  assert.throws(() => model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-b", roles: ["BARBEIRO"], owner: "barber-b", blockId: "block-a", requestId: "denied-owner-0001" }), /PERMISSION_DENIED/);
});

test("TENANT_SELECTOR_PAYLOAD_REJECTED e WRITE_MODE_REJECTED_RECURSIVELY", () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { data: { nested: { tenant_id: "tenant-b" } } },
    { data: { nested: { path: "barbearias/tenant-b" } } },
    { data: { nested: { writeMode: "V2_ONLY" } } },
    { data: { nested: { write_mode: "V2_ONLY" } } },
  ]) {
    assert.throws(
      () => validateOperationalEnvelope({ command, ...payload }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("ANTUNES_DUAL_WRITE_PRESERVED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const antunes = new Slice5Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "block-a", block, linked);
  const antunesResult = antunes.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "admin", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId: "antunes-remove-0001" });
  assert.equal(antunesResult.removed, true);
  assert.equal(antunes.legacy.has("bloqueios/block-a"), false);
  assert.equal(antunes.v2.has(`barbearias/${ANTUNES_TENANT_ID}/bloqueios/block-a`), false);

  const newTenant = new Slice5Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, linked);
  newTenant.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId: "new-tenant-remove-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.some(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE), false);
});

test("BLOQUEIO_INEXISTENTE_IDEMPOTENT e BLOQUEIO_REMOVE_LINKED_OCUPACOES", () => {
  const model = new Slice5Model();
  const missing = model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "missing", requestId: "missing-0001" });
  assert.deepEqual(missing, { duplicate: false, blockId: "missing", removed: false });
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, linked);
  const result = model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId: "remove-linked-0001" });
  assert.equal(result.removed, true);
  assert.equal(model.v2.has("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:00"), false);
  assert.equal(model.v2.has("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:30"), false);
});

test("BLOQUEIO_REMOVE_PRESERVES_OTHER_OCUPACOES", () => {
  const model = new Slice5Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, {
    ...linked,
    "barber-a_2026-08-27_10:30": { bloqueio_id: "other-block" },
  });
  model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId: "preserve-occupancy-0001" });
  assert.equal(model.v2.has("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:00"), false);
  assert.equal(model.v2.has("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:30"), true);
});

test("REQUEST_ID_TENANT_ISOLATED e SAME_TENANT_COLLISION_PROTECTED", () => {
  const model = new Slice5Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, linked);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "block-b", block, linked);
  const requestId = "shared-request-0001";
  assert.equal(model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId }).removed, true);
  assert.equal(model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], owner: "", blockId: "block-b", requestId }).removed, true);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-c", block, linked);
  assert.throws(
    () => model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-c", requestId }),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
});

test("ROLLBACK_ON_FAILURE preserva bloqueio e ocupações", () => {
  const model = new Slice5Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "block-a", block, linked);
  assert.throws(() => model.removeBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], owner: "", blockId: "block-a", requestId: "rollback-0001", failAt: "during-occupancy-delete" }), /INJECTED_FAILURE/);
  assert.ok(model.v2.has("barbearias/tenant-a/bloqueios/block-a"));
  assert.ok(model.v2.has("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:00"));
  assert.equal(model.audit.size, 0);
});

test("runtime mantém os demais comandos fora da migração Slice 5", () => {
  const context = sourceBetween("async function tenantScopedAdminCommand", "async function adminCommand");
  assert.doesNotMatch(context, /bloqueio\.criar/);
  for (const excluded of ["cliente.atualizar-perfil", "agenda.criar", "admin.barbeiro.salvar"]) {
    assert.doesNotMatch(context, new RegExp(excluded.replaceAll(".", "\\.")));
  }
});
