import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANTUNES_TENANT_ID,
  DYNAMIC_TENANT_COMMANDS,
  OPERATIONAL_CONTEXT_MODES,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const command = "admin.assinatura.renovar";
const allCommands = [
  "cliente.garantir-perfil", "cliente.atualizar-perfil", "assinatura.solicitar",
  "agenda.disponibilidade.obter", "agenda.criar", "agenda.reagendar", "agenda.cliente_chegou",
  "agenda.em_atendimento", "agenda.concluir", "agenda.cancelar", "agenda.nao_compareceu",
  "bloqueio.criar", "bloqueio.remover", "admin.funcionamento.salvar", "admin.abertura.salvar",
  "admin.abertura.remover", "admin.fechamento.salvar", "admin.fechamento.remover",
  "admin.barbeiro.salvar", "admin.barbeiro.ativar", "admin.barbeiro.remover",
  "admin.servico.salvar", "admin.servico.remover", "admin.plano.salvar", "admin.plano.inicial",
  "admin.plano.ativar", "admin.assinatura.aprovar", "admin.assinatura.recusar",
  "admin.assinatura.renovar", "admin.assinatura.cancelar", "admin.assinatura.expirar",
  "admin.estudio.identidade.salvar",
];

function sourceBetween(start, end) {
  const from = runtime.indexOf(start);
  const to = runtime.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `marcador inicial ausente: ${start}`);
  assert.notEqual(to, -1, `marcador final ausente: ${end}`);
  return runtime.slice(from, to);
}

function fail(code) {
  const cause = new Error(code);
  cause.code = code;
  throw cause;
}

class RenewalModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
    this.financialWrites = 0;
    this.agendaWrites = 0;
  }

  snapshot() { return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit, io: this.io, financialWrites: this.financialWrites, agendaWrites: this.agendaWrites }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(mode, tenantId, collection, id) { return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : `barbearias/${tenantId}/${collection}/${id}`; }
  seed(mode, tenantId, collection, id, value) {
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(this.key(mode, tenantId, collection, id), structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
  }
  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, key });
    return (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2).get(key);
  }
  update(mode, tenantId, collection, id, changes) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, key });
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, { ...(target.get(key) || {}), ...structuredClone(changes) });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      const v2Key = `barbearias/${tenantId}/${collection}/${id}`;
      this.v2.set(v2Key, { ...(this.v2.get(v2Key) || {}), ...structuredClone(changes) });
    }
  }
  renew({ mode, tenantId, roles, memberActive = true, id, requestId, failAt = "" }) {
    const fingerprint = operationalPayloadFingerprint({ id });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) { assertIdempotentReplay(previous, command, fingerprint); return { duplicate: true, ...previous.result }; }
    const before = this.snapshot();
    try {
      if (!memberActive || !roles.includes("ADMIN")) fail("MEMBERSHIP_REQUIRED");
      const subscription = this.read(mode, tenantId, "solicitacoes_assinatura", id);
      if (!subscription || !["ATIVA", "EXPIRADA"].includes(subscription.status)) fail("ASSINATURA_INDISPONIVEL");
      const plan = this.read(mode, tenantId, "planos_assinatura", subscription.plano_id);
      if (!plan || (mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY && plan.ativo !== true)) fail("PLANO_SEM_CREDITOS");
      const ids = [...new Set(Array.isArray(plan.servicos_ids) ? plan.servicos_ids : [])];
      if (!ids.length || !Number.isInteger(plan.usos_mensais) || plan.usos_mensais < 1 || plan.usos_mensais % ids.length) fail("PLANO_SEM_CREDITOS");
      const services = ids.map((serviceId) => this.read(mode, tenantId, "servicos", serviceId));
      if (services.some((service) => !service)) fail("PLANO_SEM_CREDITOS");
      if (failAt === "before-update") fail("INJECTED_FAILURE");
      const total = plan.usos_mensais / ids.length;
      this.update(mode, tenantId, "solicitacoes_assinatura", id, {
        status: "ATIVA", servicos_ids: ids,
        creditos_mensais: Object.fromEntries(ids.map((serviceId, index) => [serviceId, { servico_id: serviceId, nome: services[index].nome, total, utilizados: 0, restantes: total, reservados: 0 }])),
      });
      if (failAt === "after-update") fail("INJECTED_FAILURE");
      const result = { subscriptionId: id, status: "ATIVA" };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
}

const plan = { ativo: true, usos_mensais: 4, servicos_ids: ["corte", "barba"] };
const subscription = { status: "EXPIRADA", plano_id: "prime", creditos_mensais: {} };
function seedValid(model, mode, tenantId, status = "EXPIRADA") {
  model.seed(mode, tenantId, "solicitacoes_assinatura", "subscription-1", { ...subscription, status });
  model.seed(mode, tenantId, "planos_assinatura", "prime", plan);
  model.seed(mode, tenantId, "servicos", "corte", { nome: "Corte" });
  model.seed(mode, tenantId, "servicos", "barba", { nome: "Barba" });
}

test("Slice 13 registra somente admin.assinatura.renovar e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 2);
  const handler = sourceBetween('if (action === "assinatura.renovar")', 'error("internal"');
  assert.match(handler, /requireContextAdmin\(tx, uid, context\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "solicitacoes_assinatura", id\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "planos_assinatura", planId\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "servicos", serviceId\)/);
  assert.match(handler, /tenantUpdate\(tx, context, "solicitacoes_assinatura", id/);
  assert.doesNotMatch(handler, /legacyRef\(/);
  assert.doesNotMatch(handler, /historico_assinaturas|financeiro|agendamentos/);
});

test("TENANT_A_ASSINATURA_RENOVAR_PASS e TENANT_B_ASSINATURA_RENOVAR_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId);
    assert.equal(model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, roles: ["ADMIN"], id: "subscription-1", requestId: `renew-${tenantId}-0001` }).status, "ATIVA");
    assert.equal(model.v2.get(`barbearias/${tenantId}/solicitacoes_assinatura/subscription-1`).creditos_mensais.corte.restantes, 2);
  }
});

test("ADMIN_AUTH_VALIDATED, CROSS_TENANT_DENIED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a");
  assert.throws(() => model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["CLIENTE"], id: "subscription-1", requestId: "non-admin-0001" }), /MEMBERSHIP_REQUIRED/);
  assert.throws(() => model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-1", requestId: "cross-tenant-0001" }), /ASSINATURA_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
});

test("VALID_STATES_VALIDATED, invalid states, plano e serviço falham fechados", () => {
  for (const status of ["ATIVA", "EXPIRADA"]) { const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", status); assert.equal(model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: `valid-${status}` }).status, "ATIVA"); }
  for (const status of ["PENDENTE", "RECUSADA", "CANCELADA"]) { const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", status); assert.throws(() => model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: `invalid-${status}` }), /ASSINATURA_INDISPONIVEL/); }
  const inactive = new RenewalModel(); seedValid(inactive, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); inactive.v2.get("barbearias/tenant-a/planos_assinatura/prime").ativo = false; assert.throws(() => inactive.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "inactive-plan" }), /PLANO_SEM_CREDITOS/);
  const missing = new RenewalModel(); seedValid(missing, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); missing.v2.delete("barbearias/tenant-a/servicos/barba"); assert.throws(() => missing.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "missing-service" }), /PLANO_SEM_CREDITOS/);
});

test("WRITE_MODE_REJECTED_RECURSIVELY e tenant selector payload é rejeitado", () => {
  for (const payload of [{ tenantId: "tenant-b" }, { data: { tenant_id: "tenant-b" } }, { data: { nested: { path: "x", writeMode: "V2_ONLY", write_mode: "V2_ONLY" } } }]) assert.throws(() => validateOperationalEnvelope({ command, ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
});

test("ANTUNES_DUAL_WRITE_PRESERVED, requestId tenant-scoped e rollback", () => {
  const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID);
  assert.equal(model.renew({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, roles: ["ADMIN"], id: "subscription-1", requestId: "shared-request" }).duplicate, false);
  assert.equal(model.legacy.get("solicitacoes_assinatura/subscription-1").status, "ATIVA");
  assert.equal(model.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/subscription-1`).status, "ATIVA");
  const tenantB = new RenewalModel(); seedValid(tenantB, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b"); assert.equal(tenantB.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-1", requestId: "shared-request" }).duplicate, false);
  const rollback = new RenewalModel(); seedValid(rollback, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); assert.throws(() => rollback.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "rollback-0001", failAt: "after-update" }), /INJECTED_FAILURE/); assert.equal(rollback.v2.get("barbearias/tenant-a/solicitacoes_assinatura/subscription-1").status, "EXPIRADA");
});

test("CREDITOS_MENSAIS_RECOMPOSTOS sem escrita financeira ou de agenda", () => {
  const model = new RenewalModel(); seedValid(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); model.renew({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "credits-0001" });
  assert.equal(model.financialWrites, 0); assert.equal(model.agendaWrites, 0);
  assert.equal(model.io.every(({ key }) => !/financeiro|agendamentos/.test(key)), true);
});

test("OTHER_2_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 2);
  assert.equal(remaining.includes(command), false);
  assert.equal(remaining.includes("agenda.criar"), false);
  assert.equal(allCommands.length, 32);
});
