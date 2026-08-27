import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANTUNES_TENANT_ID,
  OPERATIONAL_CONTEXT_MODES,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  tenantOperationLogPath,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const SLICE_3_COMMANDS = Object.freeze([
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.plano.ativar",
]);

function sourceBetween(start, end) {
  const from = runtime.indexOf(start);
  const to = runtime.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `marcador inicial ausente: ${start}`);
  assert.notEqual(to, -1, `marcador final ausente: ${end}`);
  return runtime.slice(from, to);
}

function context(tenantId, mode) {
  return Object.freeze({
    tenant: Object.freeze({ id: tenantId, slug: tenantId }),
    actor: Object.freeze({ uid: `admin-${tenantId}`, roles: Object.freeze(["ADMIN"]) }),
    mode,
  });
}

class Slice3Model {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
  }

  snapshot() {
    return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit });
  }

  restore(snapshot) {
    this.legacy = snapshot.legacy;
    this.v2 = snapshot.v2;
    this.audit = snapshot.audit;
  }

  transaction({ tenantId, requestId, operation, fingerprint, failAt = "", execute }) {
    const logPath = `${tenantId}/${requestId}`;
    const previous = this.audit.get(logPath);
    if (previous) {
      assertIdempotentReplay(previous, operation, fingerprint);
      return { duplicate: true, ...structuredClone(previous.result) };
    }
    const before = this.snapshot();
    const write = (stage, callback) => {
      if (stage === failAt) throw new Error(`INJECTED_${stage}`);
      callback();
    };
    try {
      const result = execute(write);
      this.audit.set(logPath, { operation, request_fingerprint: fingerprint, result: structuredClone(result) });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }

  ref(tenantId, collection, id) {
    return `barbearias/${tenantId}/${collection}/${id}`;
  }

  set(mode, tenantId, collection, id, value) {
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(`${collection}/${id}`, structuredClone(value));
    }
    this.v2.set(this.ref(tenantId, collection === "fechamentos_globais" ? "fechamentos" : collection, id), structuredClone(value));
  }

  delete(mode, tenantId, collection, id) {
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.delete(`${collection}/${id}`);
    this.v2.delete(this.ref(tenantId, collection === "fechamentos_globais" ? "fechamentos" : collection, id));
  }

  get(mode, tenantId, collection, id) {
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? this.legacy.get(`${collection}/${id}`)
      : this.v2.get(this.ref(tenantId, collection, id));
  }

  saveOpening({ mode, tenantId, date, start, end, requestId }) {
    const openingId = `abertura_${date}`;
    const value = { data: date, tipo: "abertura", inicio_horario: start, fim_horario: end, ativo: true };
    return this.transaction({
      tenantId,
      requestId,
      operation: SLICE_3_COMMANDS[0],
      fingerprint: operationalPayloadFingerprint(value),
      execute: (write) => {
        write("opening", () => this.set(mode, tenantId, "fechamentos_globais", openingId, value));
        return { openingId };
      },
    });
  }

  removeOpening({ mode, tenantId, date, requestId }) {
    const openingId = `abertura_${date}`;
    return this.transaction({
      tenantId,
      requestId,
      operation: SLICE_3_COMMANDS[1],
      fingerprint: operationalPayloadFingerprint({ date, openingId }),
      execute: (write) => {
        write("opening", () => this.delete(mode, tenantId, "fechamentos_globais", openingId));
        return { openingId, removed: true };
      },
    });
  }

  activatePlan({ mode, tenantId, planId, active, requestId, failAt = "" }) {
    const activation = { id: planId, ativo: active };
    return this.transaction({
      tenantId,
      requestId,
      operation: SLICE_3_COMMANDS[2],
      fingerprint: operationalPayloadFingerprint(activation),
      failAt,
      execute: (write) => {
        const plan = this.get(mode, tenantId, "planos_assinatura", planId);
        if (!plan) throw new Error("PLANO_INDISPONIVEL");
        if (active && (!(plan.preco_centavos > 0) || !Array.isArray(plan.servicos_ids) || !plan.servicos_ids.length)) {
          throw new Error("PLANO_INDISPONIVEL");
        }
        write("plan", () => this.set(mode, tenantId, "planos_assinatura", planId, { ...plan, ativo: active }));
        return { planId };
      },
    });
  }
}

test("Slice 3 mantém os três handlers e não incorpora domínios excluídos", () => {
  const actionSet = sourceBetween("const TENANT_SCOPED_ADMIN_ACTIONS", `]);`);
  for (const command of SLICE_3_COMMANDS) {
    assert.match(actionSet, new RegExp(`"${command.replace("admin.", "").replaceAll(".", "\\.")}"`));
  }
});

test("TENANT_SELECTOR_PAYLOAD_REJECTED e WRITE_MODE_REJECTED recursivamente", () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { data: { tenant_id: "tenant-b" } },
    { data: { nested: { path: "barbearias/tenant-b" } } },
    { writeMode: "V2_ONLY" },
    { data: { nested: { write_mode: "V2_ONLY" } } },
  ]) {
    assert.throws(
      () => validateOperationalEnvelope({ command: SLICE_3_COMMANDS[0], ...payload }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("ABERTURA_ID_SERVER_SIDE e remoção são determinísticas e idempotentes", () => {
  const store = new Slice3Model();
  const first = store.saveOpening({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    date: "2026-09-10",
    start: "09:00",
    end: "18:00",
    requestId: "slice3-opening-save-0001",
  });
  assert.equal(first.openingId, "abertura_2026-09-10");
  assert.equal(store.legacy.size, 0);
  assert.equal(store.v2.has("barbearias/tenant-a/fechamentos/abertura_2026-09-10"), true);
  assert.equal(store.saveOpening({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", date: "2026-09-10", start: "09:00", end: "18:00", requestId: "slice3-opening-save-0001" }).duplicate, true);

  store.removeOpening({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", date: "2026-09-10", requestId: "slice3-opening-remove-01" });
  assert.equal(store.v2.has("barbearias/tenant-a/fechamentos/abertura_2026-09-10"), false);
  assert.equal(store.removeOpening({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", date: "2026-09-10", requestId: "slice3-opening-remove-02" }).removed, true);
});

test("ANTUNES_DUAL_WRITE_PRESERVED e novos tenants têm ZERO_LEGACY_IO", () => {
  const store = new Slice3Model();
  store.saveOpening({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, date: "2026-09-11", start: "09:00", end: "18:00", requestId: "slice3-antunes-opening-01" });
  assert.deepEqual(
    store.legacy.get("fechamentos_globais/abertura_2026-09-11"),
    store.v2.get(`barbearias/${ANTUNES_TENANT_ID}/fechamentos/abertura_2026-09-11`),
  );

  const beforeLegacy = structuredClone(store.legacy);
  store.saveOpening({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", date: "2026-09-12", start: "10:00", end: "19:00", requestId: "slice3-tenant-b-opening-01" });
  assert.deepEqual(store.legacy, beforeLegacy);
});

test("PLANO_AUSENTE e PLANO_INCOMPLETO falham fechados", () => {
  const absent = new Slice3Model();
  assert.throws(
    () => absent.activatePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", planId: "plan-a", active: true, requestId: "slice3-plan-absent-0001" }),
    /PLANO_INDISPONIVEL/,
  );

  const incomplete = new Slice3Model();
  incomplete.v2.set("barbearias/tenant-a/planos_assinatura/plan-a", { preco_centavos: 0, servicos_ids: [], ativo: false });
  assert.throws(
    () => incomplete.activatePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", planId: "plan-a", active: true, requestId: "slice3-plan-incomplete-01" }),
    /PLANO_INDISPONIVEL/,
  );
  assert.equal(incomplete.v2.get("barbearias/tenant-a/planos_assinatura/plan-a").ativo, false);
});

test("PLANO_ATIVAR_ROLLBACK_ON_FAILURE e requestId tenant-scoped", () => {
  const store = new Slice3Model();
  const plan = { preco_centavos: 5000, servicos_ids: ["service-a"], ativo: false };
  store.v2.set("barbearias/tenant-a/planos_assinatura/plan-a", plan);
  store.v2.set("barbearias/tenant-b/planos_assinatura/plan-a", plan);
  const before = store.snapshot();
  assert.throws(
    () => store.activatePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", planId: "plan-a", active: true, requestId: "slice3-plan-rollback-01", failAt: "plan" }),
    /INJECTED_plan/,
  );
  assert.deepEqual(store.snapshot(), before);

  store.activatePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", planId: "plan-a", active: true, requestId: "slice3-shared-plan-request" });
  store.activatePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", planId: "plan-a", active: true, requestId: "slice3-shared-plan-request" });
  assert.equal(store.audit.size, 2);
  assert.notEqual(
    tenantOperationLogPath(context("tenant-a", OPERATIONAL_CONTEXT_MODES.V2_ONLY), "slice3-shared-plan-request"),
    tenantOperationLogPath(context("tenant-b", OPERATIONAL_CONTEXT_MODES.V2_ONLY), "slice3-shared-plan-request"),
  );
});

test("SAME_TENANT_COLLISION_PROTECTED", () => {
  const first = operationalPayloadFingerprint({ id: "plan-a", ativo: true });
  const changed = operationalPayloadFingerprint({ id: "plan-a", ativo: false });
  assert.throws(
    () => assertIdempotentReplay({ operation: SLICE_3_COMMANDS[2], request_fingerprint: first }, SLICE_3_COMMANDS[2], changed),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
});

test("runtime usa somente helpers tenant-scoped nos handlers da Slice 3 e mantém 32 comandos", () => {
  const handler = sourceBetween("async function tenantScopedAdminCommand", "async function adminCommand");
  const openingSave = sourceBetween('if (action === "abertura.salvar")', 'if (action === "abertura.remover")');
  const openingRemove = sourceBetween('if (action === "abertura.remover")', 'if (action === "plano.ativar")');
  const planActivate = sourceBetween('if (action === "plano.ativar")', 'error("internal", "Comando tenant-scoped não suportado.")');
  assert.match(openingSave, /const openingId = `abertura_\$\{date\}`/);
  assert.match(openingSave, /tenantSet\(tx, context, "fechamentos_globais"/);
  assert.match(openingRemove, /tenantDelete\(tx, context, "fechamentos_globais"/);
  assert.match(planActivate, /tenantPrimaryRef\(context, "planos_assinatura"/);
  assert.match(planActivate, /tenantUpdate\(tx, context, "planos_assinatura"/);
  for (const branch of [openingSave, openingRemove, planActivate]) {
    assert.doesNotMatch(branch, /legacyRef|mirrorSet|mirrorUpdate|mirrorDelete/);
    assert.match(branch, /context,/);
    assert.match(branch, /operationalPayloadFingerprint/);
  }
  assert.equal((runtime.match(/^\s*case "[^"]+":/gm) || []).length, 32);
});
