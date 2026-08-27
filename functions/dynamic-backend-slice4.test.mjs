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
const SLICE_4_COMMANDS = Object.freeze([
  "admin.plano.inicial",
  "admin.plano.salvar",
]);
const INITIAL_PLAN_IDS = new Set(["essencial", "prime", "premium"]);

function sourceBetween(start, end) {
  const from = runtime.indexOf(start);
  const to = runtime.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `marcador inicial ausente: ${start}`);
  assert.notEqual(to, -1, `marcador final ausente: ${end}`);
  return runtime.slice(from, to);
}

class Slice4Model {
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

  path(tenantId, collection, id) {
    return `barbearias/${tenantId}/${collection}/${id}`;
  }

  read(mode, tenantId, collection, id) {
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? this.legacy.get(`${collection}/${id}`)
      : this.v2.get(this.path(tenantId, collection, id));
  }

  write(mode, tenantId, collection, id, value) {
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(`${collection}/${id}`, structuredClone(value));
    }
    this.v2.set(this.path(tenantId, collection, id), structuredClone(value));
  }

  transaction({ tenantId, operation, requestId, fingerprint, failAt = "", execute }) {
    const context = { tenant: { id: tenantId } };
    const logPath = tenantOperationLogPath(context, requestId);
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

  saveInitial({ mode, tenantId, requestId, id, nome = "Plano inicial", usos = 4 }) {
    if (!INITIAL_PLAN_IDS.has(id)) throw new Error("PLANO_INICIAL_INVALIDO");
    const plan = {
      nome,
      descricao: "Configuração inicial",
      usos_mensais: usos,
      servicos_incluidos: ["Serviço inicial"],
      servicos_ids: [],
      preco_centavos: 0,
      preco_definido: false,
      ativo: false,
    };
    return this.transaction({
      tenantId,
      requestId,
      operation: SLICE_4_COMMANDS[0],
      fingerprint: operationalPayloadFingerprint({ id, ...plan }),
      execute: (write) => {
        if (this.read(mode, tenantId, "planos_assinatura", id)) return { planId: id, created: false };
        write("plan", () => this.write(mode, tenantId, "planos_assinatura", id, plan));
        return { planId: id, created: true };
      },
    });
  }

  savePlan({ mode, tenantId, requestId, id, serviceIds, price = 5000, active = false, failAt = "" }) {
    const input = {
      id,
      nome: "Plano mensal",
      descricao: "Plano de teste",
      preco_centavos: price,
      preco_definido: true,
      usos_mensais: serviceIds.length * 2,
      servicos_ids: serviceIds,
      ativo: active,
    };
    return this.transaction({
      tenantId,
      requestId,
      operation: SLICE_4_COMMANDS[1],
      fingerprint: operationalPayloadFingerprint(input),
      failAt,
      execute: (write) => {
        const services = serviceIds.map((serviceId) => this.read(mode, tenantId, "servicos", serviceId));
        if (services.some((service) => !service)) throw new Error("SERVICO_INDISPONIVEL");
        const existing = this.read(mode, tenantId, "planos_assinatura", id);
        const plan = { ...input, servicos_incluidos: services.map((service) => service.nome) };
        write("plan", () => this.write(mode, tenantId, "planos_assinatura", id, { ...existing, ...plan }));
        return { planId: id, created: !existing };
      },
    });
  }
}

test("Slice 4 registra somente os dois comandos aprovados e mantém 32 comandos", () => {
  const actionSet = sourceBetween("const TENANT_SCOPED_ADMIN_ACTIONS", `]);`);
  for (const command of SLICE_4_COMMANDS) {
    assert.match(actionSet, new RegExp(`"${command.replace("admin.", "").replaceAll(".", "\\.")}"`));
  }
  for (const excluded of ["bloqueio.criar", "fechamento.salvar"]) {
    assert.doesNotMatch(actionSet, new RegExp(`"${excluded.replaceAll(".", "\\.")}"`));
  }
  assert.equal((runtime.match(/^\s*case "[^"]+":/gm) || []).length, 32);
});

test("TENANT_SELECTOR_PAYLOAD_REJECTED e WRITE_MODE_REJECTED_RECURSIVELY", () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { data: { tenant_id: "tenant-b" } },
    { data: { nested: { path: "barbearias/tenant-b" } } },
    { writeMode: "V2_ONLY" },
    { data: { nested: { write_mode: "V2_ONLY" } } },
  ]) {
    assert.throws(
      () => validateOperationalEnvelope({ command: SLICE_4_COMMANDS[0], ...payload }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("PLANO_INICIAL_CREATE_ONLY, allowed IDs, replay e colisão", () => {
  const store = new Slice4Model();
  assert.throws(() => store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-invalid-plan-0001", id: "custom" }), /PLANO_INICIAL_INVALIDO/);
  for (const id of INITIAL_PLAN_IDS) {
    const requestId = `slice4-initial-${id}-0001`;
    const first = store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId, id });
    assert.equal(first.created, true);
    assert.equal(store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId, id }).duplicate, true);
    const secondRequest = store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: `${requestId}-second`, id });
    assert.equal(secondRequest.created, false);
  }
  assert.throws(
    () => store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-initial-essencial-0001", id: "essencial", nome: "Outro nome" }),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
});

test("PLANO_SALVAR_CREATE_UPDATE, serviços tenant-scoped e campos derivados", () => {
  const store = new Slice4Model();
  store.v2.set(store.path("tenant-a", "servicos", "service-a"), { nome: "Corte A" });
  store.v2.set(store.path("tenant-b", "servicos", "service-a"), { nome: "Corte B" });
  const created = store.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-save-plan-create-01", id: "plan-a", serviceIds: ["service-a"] });
  assert.equal(created.created, true);
  assert.deepEqual(store.v2.get(store.path("tenant-a", "planos_assinatura", "plan-a")).servicos_incluidos, ["Corte A"]);
  const updated = store.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-save-plan-update-01", id: "plan-a", serviceIds: ["service-a"], price: 6000 });
  assert.equal(updated.created, false);
  assert.equal(store.v2.get(store.path("tenant-a", "planos_assinatura", "plan-a")).preco_centavos, 6000);
  assert.deepEqual(store.v2.get(store.path("tenant-b", "servicos", "service-a")), { nome: "Corte B" });
});

test("PLANO_SALVAR_SERVICO_AUSENTE_FAIL_CLOSED e rollback", () => {
  const missing = new Slice4Model();
  assert.throws(
    () => missing.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-missing-service-01", id: "plan-a", serviceIds: ["missing"] }),
    /SERVICO_INDISPONIVEL/,
  );
  assert.equal(missing.v2.size, 0);
  assert.equal(missing.audit.size, 0);

  const rollback = new Slice4Model();
  rollback.v2.set(rollback.path("tenant-a", "servicos", "service-a"), { nome: "Corte" });
  const before = rollback.snapshot();
  assert.throws(
    () => rollback.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-rollback-plan-01", id: "plan-a", serviceIds: ["service-a"], failAt: "plan" }),
    /INJECTED_plan/,
  );
  assert.deepEqual(rollback.snapshot(), before);
});

test("ANTUNES_DUAL_WRITE_PRESERVED e novo tenant tem ZERO_LEGACY_IO", () => {
  const antunes = new Slice4Model();
  antunes.write(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "servicos", "service-a", { nome: "Corte" });
  antunes.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, requestId: "slice4-antunes-plan-save-01", id: "plan-a", serviceIds: ["service-a"] });
  assert.deepEqual(antunes.legacy.get("planos_assinatura/plan-a"), antunes.v2.get(antunes.path(ANTUNES_TENANT_ID, "planos_assinatura", "plan-a")));

  const tenant = new Slice4Model();
  tenant.v2.set(tenant.path("tenant-a", "servicos", "service-a"), { nome: "Corte" });
  const legacyBefore = structuredClone(tenant.legacy);
  tenant.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-tenant-initial-01", id: "essencial" });
  tenant.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "slice4-tenant-save-0001", id: "plan-a", serviceIds: ["service-a"] });
  assert.deepEqual(tenant.legacy, legacyBefore);
});

test("PLANO_SALVAR_ATIVO_TRUE_CHARACTERIZATION preserva contrato Antunes", () => {
  const store = new Slice4Model();
  store.write(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "servicos", "service-a", { nome: "Corte" });
  store.savePlan({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, requestId: "slice4-active-character-01", id: "plan-zero", serviceIds: ["service-a"], price: 0, active: true });
  assert.equal(store.legacy.get("planos_assinatura/plan-zero").ativo, true);
  assert.equal(store.legacy.get("planos_assinatura/plan-zero").preco_centavos, 0);
  const saveBranch = sourceBetween('if (action === "plano.salvar")', 'if (action === "plano.ativar")');
  assert.match(saveBranch, /price < 0/);
  assert.doesNotMatch(saveBranch, /price <= 0|PLANO_INDISPONIVEL/);
});

test("REQUEST_ID_TENANT_ISOLATED e SAME_TENANT_COLLISION_PROTECTED", () => {
  const store = new Slice4Model();
  const requestId = "slice4-shared-request-0001";
  const tenantA = store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId, id: "essencial" });
  const tenantB = store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", requestId, id: "essencial" });
  assert.equal(tenantA.created, true);
  assert.equal(tenantB.created, true);
  assert.throws(
    () => store.saveInitial({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId, id: "essencial", nome: "Mudança" }),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
});

test("runtime usa somente helpers tenant-scoped nos handlers da Slice 4", () => {
  const initial = sourceBetween('if (action === "plano.inicial")', 'if (action === "plano.salvar")');
  const save = sourceBetween('if (action === "plano.salvar")', 'if (action === "plano.ativar")');
  assert.match(initial, /tenantPrimaryRef\(context, "planos_assinatura"/);
  assert.match(initial, /tenantSet\(tx, context, "planos_assinatura"/);
  assert.match(save, /tenantPrimaryRef\(context, "servicos"/);
  assert.match(save, /tenantPrimaryRef\(context, "planos_assinatura"/);
  assert.match(save, /tenantSet\(tx, context, "planos_assinatura"/);
  for (const branch of [initial, save]) {
    assert.doesNotMatch(branch, /legacyRef|mirrorSet|mirrorUpdate|mirrorDelete/);
    assert.match(branch, /requireContextAdmin/);
    assert.match(branch, /operationalPayloadFingerprint/);
  }
});
