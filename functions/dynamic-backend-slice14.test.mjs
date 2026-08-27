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
const command = "admin.assinatura.aprovar";
const allCommands = [
  "cliente.garantir-perfil", "cliente.atualizar-perfil", "assinatura.solicitar", "agenda.disponibilidade.obter", "agenda.criar", "agenda.reagendar", "agenda.cliente_chegou", "agenda.em_atendimento", "agenda.concluir", "agenda.cancelar", "agenda.nao_compareceu", "bloqueio.criar", "bloqueio.remover", "admin.funcionamento.salvar", "admin.abertura.salvar", "admin.abertura.remover", "admin.fechamento.salvar", "admin.fechamento.remover", "admin.barbeiro.salvar", "admin.barbeiro.ativar", "admin.barbeiro.remover", "admin.servico.salvar", "admin.servico.remover", "admin.plano.salvar", "admin.plano.inicial", "admin.plano.ativar", "admin.assinatura.aprovar", "admin.assinatura.recusar", "admin.assinatura.renovar", "admin.assinatura.cancelar", "admin.assinatura.expirar", "admin.estudio.identidade.salvar",
];

function handler() {
  const start = runtime.indexOf('if (action === "assinatura.aprovar")');
  const end = runtime.indexOf('if (action === "assinatura.recusar")', start);
  assert.notEqual(start, -1); assert.notEqual(end, -1);
  return runtime.slice(start, end);
}

class ApprovalModel {
  constructor() { this.legacy = new Map(); this.v2 = new Map(); this.audit = new Map(); this.io = []; }
  key(mode, tenant, collection, id) { return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : `barbearias/${tenant}/${collection}/${id}`; }
  seed(mode, tenant, collection, id, data) { const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2; target.set(this.key(mode, tenant, collection, id), structuredClone(data)); if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.set(`barbearias/${tenant}/${collection}/${id}`, structuredClone(data)); }
  approve({ mode, tenant, roles, id, requestId, fail = false }) {
    const fingerprint = operationalPayloadFingerprint({ id }); const auditKey = `${tenant}/${requestId}`; const previous = this.audit.get(auditKey);
    if (previous) { assertIdempotentReplay(previous, command, fingerprint); return { duplicate: true, ...previous.result }; }
    const legacyBefore = structuredClone(this.legacy); const v2Before = structuredClone(this.v2);
    try {
      if (!roles.includes("ADMIN")) throw new Error("MEMBERSHIP_REQUIRED");
      const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
      const subscription = target.get(this.key(mode, tenant, "solicitacoes_assinatura", id));
      if (!subscription || subscription.status !== "PENDENTE") throw new Error("SOLICITACAO_INDISPONIVEL");
      const plan = target.get(this.key(mode, tenant, "planos_assinatura", subscription.plano_id));
      if (!plan || (mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY && plan.ativo !== true)) throw new Error("PLANO_SEM_CREDITOS");
      const ids = [...new Set(plan.servicos_ids || [])]; const services = ids.map((serviceId) => target.get(this.key(mode, tenant, "servicos", serviceId)));
      if (services.some((service) => !service)) throw new Error("PLANO_SEM_CREDITOS");
      if (fail) throw new Error("INJECTED_FAILURE");
      const total = plan.usos_mensais / ids.length; const patch = { status: "ATIVA", servicos_ids: ids, creditos_mensais: Object.fromEntries(ids.map((serviceId, index) => [serviceId, { servico_id: serviceId, nome: services[index].nome, total, utilizados: 0, restantes: total, reservados: 0 }])) };
      target.set(this.key(mode, tenant, "solicitacoes_assinatura", id), { ...subscription, ...patch });
      if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.set(`barbearias/${tenant}/solicitacoes_assinatura/${id}`, { ...subscription, ...patch });
      const result = { subscriptionId: id, status: "ATIVA" }; this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result }); return { duplicate: false, ...result };
    } catch (cause) { this.legacy = legacyBefore; this.v2 = v2Before; throw cause; }
  }
}

function seed(model, mode, tenant, { status = "PENDENTE", active = true, services = ["corte", "barba"] } = {}) {
  model.seed(mode, tenant, "solicitacoes_assinatura", "sub-1", { status, plano_id: "prime" });
  model.seed(mode, tenant, "planos_assinatura", "prime", { ativo: active, usos_mensais: 4, servicos_ids: services });
  for (const serviceId of services) model.seed(mode, tenant, "servicos", serviceId, { nome: serviceId });
}

test("Slice 14 registra somente aprovação tenant-scoped e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32); assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true); assert.equal(allCommands.filter((item) => !DYNAMIC_TENANT_COMMANDS.includes(item)).length, 2);
  const source = handler();
  for (const fragment of ["requireContextAdmin(tx, uid, context)", 'tenantPrimaryRef(context, "solicitacoes_assinatura", id)', 'tenantPrimaryRef(context, "planos_assinatura", planId)', 'tenantPrimaryRef(context, "servicos", serviceId)', 'tenantUpdate(tx, context, "solicitacoes_assinatura", id']) assert.match(source, new RegExp(fragment.replace(/[().]/g, "\\$&")));
  assert.match(source, /vencimento_em: dueDateOneMonth\(\)/);
  assert.doesNotMatch(source, /legacyRef\(|financeiro|agendamentos|ocupacoes/);
});

test("TENANT_A/B, ADMIN, PENDENTE->ATIVA, créditos e vencimento estão no contrato", () => {
  for (const tenant of ["tenant-a", "tenant-b"]) { const model = new ApprovalModel(); seed(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant); assert.equal(model.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant, roles: ["ADMIN"], id: "sub-1", requestId: `approve-${tenant}` }).status, "ATIVA"); assert.equal(model.v2.get(`barbearias/${tenant}/solicitacoes_assinatura/sub-1`).creditos_mensais.corte.restantes, 2); }
  const denied = new ApprovalModel(); seed(denied, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); assert.throws(() => denied.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", roles: ["CLIENTE"], id: "sub-1", requestId: "non-admin" }), /MEMBERSHIP_REQUIRED/);
});

test("V2 falha fechado para estado inválido, plano inativo, serviço ausente e cross-tenant", () => {
  for (const options of [{ status: "ATIVA" }, { active: false }, { services: ["corte"] }]) { const model = new ApprovalModel(); seed(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", options); if (options.services) model.v2.delete("barbearias/tenant-a/servicos/corte"); assert.throws(() => model.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", roles: ["ADMIN"], id: "sub-1", requestId: JSON.stringify(options) }), /SOLICITACAO_INDISPONIVEL|PLANO_SEM_CREDITOS/); }
  const cross = new ApprovalModel(); seed(cross, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); assert.throws(() => cross.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", roles: ["ADMIN"], id: "sub-1", requestId: "cross" }), /SOLICITACAO_INDISPONIVEL/);
});

test("selector proibido, Antunes dual-write, requestId isolado, rollback e zero I/O legado V2", () => {
  for (const payload of [{ tenantId: "b" }, { data: { tenant_id: "b" } }, { data: { nested: { path: "x", writeMode: "x", write_mode: "x" } } }]) assert.throws(() => validateOperationalEnvelope({ command, ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  const antunes = new ApprovalModel(); seed(antunes, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, { active: false }); antunes.approve({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: ANTUNES_TENANT_ID, roles: ["ADMIN"], id: "sub-1", requestId: "same" }); assert.equal(antunes.legacy.get("solicitacoes_assinatura/sub-1").status, "ATIVA"); assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/sub-1`).status, "ATIVA");
  const v2 = new ApprovalModel(); seed(v2, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); assert.throws(() => v2.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", roles: ["ADMIN"], id: "sub-1", requestId: "rollback", fail: true }), /INJECTED_FAILURE/); assert.equal(v2.v2.get("barbearias/tenant-a/solicitacoes_assinatura/sub-1").status, "PENDENTE"); assert.equal(v2.legacy.size, 0);
});

test("REQUEST_ID_COLLISION_BLOCKED e isolamento por tenant", () => {
  const model = new ApprovalModel(); seed(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a"); seed(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b");
  model.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", roles: ["ADMIN"], id: "sub-1", requestId: "same" });
  assert.throws(() => model.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", roles: ["ADMIN"], id: "other", requestId: "same" }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.equal(model.approve({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", roles: ["ADMIN"], id: "sub-1", requestId: "same" }).status, "ATIVA");
});

test("OTHER_2_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((item) => !DYNAMIC_TENANT_COMMANDS.includes(item)); assert.equal(remaining.length, 2); assert.equal(remaining.includes(command), false); assert.equal(remaining.includes("agenda.criar"), false);
});
