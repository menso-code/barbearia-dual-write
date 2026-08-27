import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTUNES_TENANT_ID,
  DYNAMIC_TENANT_COMMANDS,
  OPERATIONAL_CONTEXT_MODES,
  OperationalContextError,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  resolveOperationalContext,
  tenantOperationLogPath,
  tenantV2DocumentPath,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

class MemorySnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this.value;
  }
}

class MemoryDb {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.reads = [];
  }

  doc(path) {
    return {
      get: async () => {
        this.reads.push(path);
        return new MemorySnapshot(this.entries.get(path));
      },
    };
  }
}

function tenantEntries({ slug, tenantId, uid, roles = ["ADMIN", "CLIENTE"], status = "ACTIVE" }) {
  return {
    [`tenant_slugs/${slug}`]: { tenantId, status: "ACTIVE" },
    [`barbearias/${tenantId}`]: { slug, status },
    [`barbearias/${tenantId}/membros/${uid}`]: { ativo: true, papeis: roles },
  };
}

function fixture() {
  return new MemoryDb({
    ...tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "admin-a" }),
    ...tenantEntries({ slug: "studio-b", tenantId: "tenant-b", uid: "admin-b" }),
  });
}

async function identityContext(db, slug, uid) {
  return resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: uid,
    command: "admin.estudio.identidade.salvar",
    payload: {
      command: "admin.estudio.identidade.salvar",
      requestId: `identity-${slug}-request-0001`,
      context: { hostname: `${slug}.goestudio.com.br` },
      data: { nome: slug },
    },
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (cause) => {
    assert.ok(cause instanceof OperationalContextError);
    assert.equal(cause.code, code);
    return true;
  });
}

test("TENANT_A_COMMAND_WORKS e TENANT_B_COMMAND_WORKS", async () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS, [
    "agenda.disponibilidade.obter",
    "admin.estudio.identidade.salvar",
  ]);
  const db = fixture();
  const tenantA = await identityContext(db, "studio-a", "admin-a");
  const tenantB = await identityContext(db, "studio-b", "admin-b");
  assert.equal(tenantA.tenant.id, "tenant-a");
  assert.equal(tenantB.tenant.id, "tenant-b");
  assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.deepEqual(tenantA.actor.roles, ["ADMIN", "CLIENTE"]);
});

test("agenda.disponibilidade.obter resolve slug e exige CLIENTE", async () => {
  const db = new MemoryDb(tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"] }));
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "client-a",
    command: "agenda.disponibilidade.obter",
    payload: {
      command: "agenda.disponibilidade.obter",
      requestId: "availability-request-0001",
      data: { data: "2026-08-26", slug: "studio-a" },
    },
  });
  assert.equal(context.tenant.id, "tenant-a");
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.READ_ONLY);
});

test("TENANT_A_CANNOT_ACCESS_B", async () => {
  const db = fixture();
  await rejectsCode(identityContext(db, "studio-b", "admin-a"), "MEMBERSHIP_REQUIRED");
});

test("TENANT_ID_PAYLOAD_REJECTED e path do payload rejeitado", () => {
  assert.throws(
    () => validateOperationalEnvelope({ command: "x", tenantId: "tenant-b" }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
  assert.throws(
    () => validateOperationalEnvelope({ command: "x", data: { path: "barbearias/tenant-b" } }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
});

test("CROSS_TENANT_REQUEST_ID_ISOLATED", async () => {
  const db = fixture();
  const tenantA = await identityContext(db, "studio-a", "admin-a");
  const tenantB = await identityContext(db, "studio-b", "admin-b");
  const requestId = "shared-request-id-0001";
  assert.notEqual(tenantOperationLogPath(tenantA, requestId), tenantOperationLogPath(tenantB, requestId));
  assert.equal(tenantOperationLogPath(tenantA, requestId), `barbearias/tenant-a/audit_logs/operation-${requestId}`);
});

test("SAME_TENANT_REQUEST_ID_COLLISION_PROTECTED", () => {
  const first = operationalPayloadFingerprint({ nome: "Studio A", primaryColor: "#112233" });
  const equivalent = operationalPayloadFingerprint({ primaryColor: "#112233", nome: "Studio A" });
  const changed = operationalPayloadFingerprint({ nome: "Studio B", primaryColor: "#112233" });
  assert.equal(first, equivalent);
  assert.doesNotThrow(() => assertIdempotentReplay({ operation: "admin.estudio.identidade.salvar", request_fingerprint: first }, "admin.estudio.identidade.salvar", equivalent));
  assert.throws(
    () => assertIdempotentReplay({ operation: "admin.estudio.identidade.salvar", request_fingerprint: first }, "admin.estudio.identidade.salvar", changed),
    (cause) => cause instanceof OperationalContextError && cause.code === "REQUEST_ID_COLLISION",
  );
});

test("NON_MEMBER_REJECTED", async () => {
  const db = new MemoryDb({
    "tenant_slugs/studio-a": { tenantId: "tenant-a", status: "ACTIVE" },
    "barbearias/tenant-a": { slug: "studio-a", status: "ACTIVE" },
  });
  await rejectsCode(identityContext(db, "studio-a", "admin-a"), "MEMBERSHIP_REQUIRED");
});

test("INACTIVE_TENANT_REJECTED", async () => {
  const db = new MemoryDb(tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "admin-a", status: "INACTIVE" }));
  await rejectsCode(identityContext(db, "studio-a", "admin-a"), "TENANT_UNAVAILABLE");
});

test("LEGACY_MODE_CANNOT_BE_CLIENT_SELECTED", () => {
  assert.throws(
    () => validateOperationalEnvelope({ command: "agenda.criar", context: { hostname: "studio-a.goestudio.com.br" }, writeMode: "ANTUNES_DUAL_WRITE" }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
});

test("LEGACY_COMMAND_BLOCKED_FOR_NEW_TENANT", async () => {
  const db = fixture();
  await rejectsCode(resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "admin-a",
    command: "agenda.criar",
    payload: {
      command: "agenda.criar",
      requestId: "legacy-command-request-0001",
      context: { hostname: "studio-a.goestudio.com.br" },
      data: {},
    },
  }), "COMMAND_NOT_AVAILABLE_FOR_TENANT");
});

test("30 comandos legados preservam compatibilidade Antunes sem localizador", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/legacy-user`]: { ativo: true, papeis: ["CLIENTE"] },
  });
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "legacy-user",
    command: "agenda.criar",
    payload: { command: "agenda.criar", requestId: "legacy-antunes-request-01", data: {} },
  });
  assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE);
});

test("omitir localizador não seleciona Antunes para membro de outro tenant", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    "barbearias/tenant-b": { slug: "studio-b", status: "ACTIVE" },
    "barbearias/tenant-b/membros/user-b": { ativo: true, papeis: ["CLIENTE"] },
  });
  await rejectsCode(resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "user-b",
    command: "agenda.criar",
    payload: { command: "agenda.criar", requestId: "omitted-context-request-01", data: {} },
  }), "MEMBERSHIP_REQUIRED");
});

test("host Firebase legado é allowlist exata e identidade continua V2-only", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/admin-antunes`]: { ativo: true, papeis: ["ADMIN"] },
  });
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "admin-antunes",
    command: "admin.estudio.identidade.salvar",
    payload: {
      command: "admin.estudio.identidade.salvar",
      requestId: "legacy-host-identity-01",
      context: { hostname: "barber-a01e7.web.app" },
      data: { nome: "Antunes" },
    },
  });
  assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
});

test("OperationalContext e referências tenant-scoped são imutáveis e isoladas", async () => {
  const context = await identityContext(fixture(), "studio-a", "admin-a");
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.tenant), true);
  assert.equal(Object.isFrozen(context.actor.roles), true);
  assert.throws(() => { context.tenant.id = "tenant-b"; }, TypeError);
  assert.equal(tenantV2DocumentPath(context, "configuracoes", "identidade"), "barbearias/tenant-a/configuracoes/identidade");
});
