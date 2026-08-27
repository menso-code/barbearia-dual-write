import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtime = await readFile(new URL("../functions/dual-write.js", import.meta.url), "utf8");

const COMMANDS = [
  "cliente.garantir-perfil", "cliente.atualizar-perfil", "assinatura.solicitar",
  "agenda.disponibilidade.obter", "agenda.criar", "agenda.reagendar", "agenda.cliente_chegou", "agenda.em_atendimento",
  "agenda.concluir", "agenda.cancelar", "agenda.nao_compareceu", "bloqueio.criar", "bloqueio.remover",
  "admin.funcionamento.salvar", "admin.abertura.salvar", "admin.abertura.remover",
  "admin.fechamento.salvar", "admin.fechamento.remover", "admin.barbeiro.salvar",
  "admin.barbeiro.ativar", "admin.barbeiro.remover", "admin.servico.salvar", "admin.servico.remover",
  "admin.plano.salvar", "admin.plano.inicial", "admin.plano.ativar", "admin.assinatura.aprovar",
  "admin.assinatura.recusar", "admin.assinatura.renovar", "admin.assinatura.cancelar", "admin.assinatura.expirar",
  "admin.estudio.identidade.salvar",
];

function clone(value) {
  return structuredClone(value);
}

class Domain {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.occupancies = new Map();
    this.audit = new Map();
    this.blocks = new Map();
    this.subscriptions = new Map();
  }

  snapshot() {
    return clone({ legacy: this.legacy, v2: this.v2, occupancies: this.occupancies, audit: this.audit, blocks: this.blocks, subscriptions: this.subscriptions });
  }

  transaction(requestId, operation, work, failAt = "") {
    const before = this.snapshot();
    const write = (stage, fn) => {
      if (stage === failAt) throw new Error(`INJECTED_${stage}`);
      fn();
    };
    if (this.audit.has(requestId)) return { duplicate: true, ...clone(this.audit.get(requestId)) };
    try {
      const result = work(write);
      this.audit.set(requestId, { operation, ...clone(result) });
      return { duplicate: false, ...result };
    } catch (error) {
      Object.assign(this, before);
      throw error;
    }
  }
}

function assertEquivalentProjection(legacy, v2) {
  const fields = ["tenant", "ownerId", "status", "resourceId", "barberId", "clientId", "serviceId"];
  for (const field of fields) assert.equal(legacy[field], v2[field], `projeções divergem em ${field}`);
  return true;
}

function requireRole(roles, expected) {
  if (!roles?.includes(expected)) throw new Error("PERMISSION_DENIED");
}

function updateClient(domain, { uid, requestId, changes, failAt = "" }) {
  const allowed = new Set(["nome", "telefone", "data_nascimento", "avatar_data", "barbeiro_favorito_id", "servico_favorito_id", "periodo_preferido", "observacoes"]);
  if (Object.keys(changes).some((key) => !allowed.has(key))) throw new Error("PERMISSION_DENIED");
  if (!Object.keys(changes).length) throw new Error("INVALID_ARGUMENT");
  return domain.transaction(requestId, "cliente.atualizar-perfil", (write) => {
    const current = domain.legacy.get(`clientes/${uid}`);
    if (!current) throw new Error("FAILED_PRECONDITION");
    const next = { ...current, ...changes };
    write("legacy", () => domain.legacy.set(`clientes/${uid}`, next));
    write("v2", () => domain.v2.set(`clientes/${uid}`, { ...current, ...changes }));
    return { clientId: uid, updated: Object.keys(changes).sort() };
  }, failAt);
}

function requestSubscription(domain, { uid, planId, requestId, failAt = "" }) {
  if (domain.audit.has(requestId)) return { duplicate: true, ...clone(domain.audit.get(requestId)) };
  const plan = domain.legacy.get(`planos/${planId}`);
  if (!plan?.active || plan.price <= 0 || !plan.services?.length) throw new Error("FAILED_PRECONDITION");
  if (!domain.legacy.has(`clientes/${uid}`)) throw new Error("FAILED_PRECONDITION");
  const id = `${uid}_${planId}`;
  if (domain.subscriptions.has(id)) throw new Error("ALREADY_EXISTS");
  return domain.transaction(requestId, "assinatura.solicitar", (write) => {
    const value = { clientId: uid, planId, status: "PENDENTE", tenant: plan.tenant };
    write("legacy", () => domain.subscriptions.set(id, value));
    write("v2", () => domain.v2.set(`assinaturas/${id}`, value));
    return { subscriptionId: id, status: "PENDENTE" };
  }, failAt);
}

function createBlock(domain, { uid, roles, tenant, id, barberId, start, end, requestId, failAt = "" }) {
  if (!roles?.includes("ADMIN") && uid !== barberId) throw new Error("PERMISSION_DENIED");
  if (start >= end) throw new Error("INVALID_ARGUMENT");
  return domain.transaction(requestId, "bloqueio.criar", (write) => {
    const value = { tenant, id, barberId, start, end, status: "ativo" };
    write("legacy", () => domain.blocks.set(`legacy/${tenant}/${id}`, value));
    write("v2", () => domain.v2.set(`bloqueios/${tenant}/${id}`, value));
    return { blockId: id };
  }, failAt);
}

function removeBlock(domain, { uid, roles, tenant, id, barberId, requestId, failAt = "" }) {
  const key = `legacy/${tenant}/${id}`;
  const block = domain.blocks.get(key);
  if (!block) throw new Error("NOT_FOUND");
  if (!roles?.includes("ADMIN") && uid !== barberId) throw new Error("PERMISSION_DENIED");
  return domain.transaction(requestId, "bloqueio.remover", (write) => {
    write("legacy", () => domain.blocks.delete(key));
    write("v2", () => domain.v2.delete(`bloqueios/${tenant}/${id}`));
    return { blockId: id };
  }, failAt);
}

function rebook(domain, { tenant, originalId, newId, barberId, requestId, failAt = "" }) {
  const oldKey = `agendamentos/${tenant}/${originalId}`;
  const newKey = `agendamentos/${tenant}/${newId}`;
  const original = domain.legacy.get(oldKey);
  if (!original) throw new Error("NOT_FOUND");
  if (!["agendado", "cliente_chegou"].includes(original.status)) throw new Error("FAILED_PRECONDITION");
  if (domain.legacy.has(newKey)) throw new Error("ALREADY_EXISTS");
  return domain.transaction(requestId, "agenda.reagendar", (write) => {
    const replacement = { ...original, resourceId: newId, barberId, status: "agendado", replaced: originalId };
    write("new-legacy", () => domain.legacy.set(newKey, replacement));
    write("new-v2", () => domain.v2.set(newKey, replacement));
    write("old-legacy", () => domain.legacy.set(oldKey, { ...original, status: "cancelado", replacedBy: newId }));
    write("old-v2", () => domain.v2.set(oldKey, { ...original, status: "cancelado", replacedBy: newId }));
    write("old-occupancy", () => domain.occupancies.delete(`${tenant}/${originalId}`));
    write("new-occupancy", () => domain.occupancies.set(`${tenant}/${newId}`, { tenant, appointmentId: newId }));
    return { appointmentId: newId, replacedAppointmentId: originalId };
  }, failAt);
}

test("dispatcher atual registra exatamente 32 comandos e nenhum contrato crítico ficou fora", () => {
  const registered = [...runtime.matchAll(/case "([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(registered, COMMANDS);
});

test("agenda.disponibilidade.obter permanece read-only e fora do log de idempotência", () => {
  const start = runtime.indexOf('case "agenda.disponibilidade.obter"');
  const end = runtime.indexOf('case "agenda.criar"', start);
  const commandBody = runtime.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.match(commandBody, /getTenantAgendaAvailability/);
  assert.match(commandBody, /context\.tenant\.id/);
  assert.match(commandBody, /onlyFields\(data, new Set\(\["data", "slug"\]\)\)/);
  assert.doesNotMatch(commandBody, /data\.tenantId|payload\.tenantId|closureId|path/);
  assert.doesNotMatch(commandBody, /transactionalCommand|operationLogRef|auditRecord|runTransaction/);
});

test("cliente pode atualizar somente seu perfil, sem conceder papel", () => {
  const domain = new Domain();
  domain.legacy.set("clientes/client-1", { id: "client-1", nome: "Antes", papeis: ["CLIENTE"] });
  updateClient(domain, { uid: "client-1", requestId: "client-update-1", changes: { nome: "Depois" } });
  assert.equal(domain.legacy.get("clientes/client-1").nome, "Depois");
  assert.deepEqual(domain.legacy.get("clientes/client-1").papeis, ["CLIENTE"]);
  assertEquivalentProjection(domain.legacy.get("clientes/client-1"), domain.v2.get("clientes/client-1"));
  assert.throws(() => updateClient(domain, { uid: "client-1", requestId: "client-update-2", changes: { papeis: ["ADMIN"] } }), /PERMISSION_DENIED/);
  assert.throws(() => updateClient(domain, { uid: "client-1", requestId: "client-update-3", changes: {} }), /INVALID_ARGUMENT/);
  assert.throws(() => updateClient(domain, { uid: "client-1", requestId: "client-update-4", changes: { nome: "outro" }, failAt: "v2" }), /INJECTED_v2/);
  assert.equal(domain.legacy.get("clientes/client-1").nome, "Depois");
  assert.equal(domain.v2.get("clientes/client-1").nome, "Depois");
});

test("perfil e assinatura são idempotentes e rejeitam pré-condições inválidas", () => {
  const domain = new Domain();
  domain.legacy.set("clientes/client-1", { id: "client-1", nome: "Cliente" });
  domain.legacy.set("planos/plan-1", { tenant: "tenant-a", active: true, price: 100, services: ["service-1"] });
  const first = requestSubscription(domain, { uid: "client-1", planId: "plan-1", requestId: "subscription-1" });
  const replay = requestSubscription(domain, { uid: "client-1", planId: "plan-1", requestId: "subscription-1" });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.throws(() => requestSubscription(domain, { uid: "client-1", planId: "missing", requestId: "subscription-2" }), /FAILED_PRECONDITION/);
  assert.throws(() => requestSubscription(domain, { uid: "other", planId: "plan-1", requestId: "subscription-3" }), /FAILED_PRECONDITION/);
  assertEquivalentProjection(domain.subscriptions.get("client-1_plan-1"), domain.v2.get("assinaturas/client-1_plan-1"));
  assert.throws(() => requestSubscription(domain, { uid: "client-1", planId: "plan-1", requestId: "subscription-4", failAt: "v2" }), /ALREADY_EXISTS/);
});

test("bloqueios exigem dono ou ADMIN, têm contrato de intervalo e replay", () => {
  const domain = new Domain();
  const first = createBlock(domain, { uid: "barber-1", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-1", barberId: "barber-1", start: "08:30", end: "09:30", requestId: "block-1" });
  const replay = createBlock(domain, { uid: "barber-1", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-1", barberId: "barber-1", start: "08:30", end: "09:30", requestId: "block-1" });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.throws(() => createBlock(domain, { uid: "barber-2", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-2", barberId: "barber-1", start: "08:30", end: "09:30", requestId: "block-2" }), /PERMISSION_DENIED/);
  assert.throws(() => createBlock(domain, { uid: "barber-1", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-3", barberId: "barber-1", start: "10:00", end: "09:30", requestId: "block-3" }), /INVALID_ARGUMENT/);
  assert.throws(() => removeBlock(domain, { uid: "barber-2", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-1", barberId: "barber-1", requestId: "block-4" }), /PERMISSION_DENIED/);
  removeBlock(domain, { uid: "barber-1", roles: ["BARBEIRO"], tenant: "tenant-a", id: "block-1", barberId: "barber-1", requestId: "block-5" });
  assert.equal(domain.blocks.size, 0);
});

test("reagendamento reserva nova vaga e libera a antiga na mesma transação", () => {
  const domain = new Domain();
  const original = { tenant: "tenant-a", resourceId: "old", barberId: "barber-1", status: "agendado" };
  domain.legacy.set("agendamentos/tenant-a/old", original);
  domain.v2.set("agendamentos/tenant-a/old", clone(original));
  domain.occupancies.set("tenant-a/old", { tenant: "tenant-a", appointmentId: "old" });
  const result = rebook(domain, { tenant: "tenant-a", originalId: "old", newId: "new", barberId: "barber-1", requestId: "rebook-1" });
  assert.equal(result.replacedAppointmentId, "old");
  assert.equal(domain.legacy.get("agendamentos/tenant-a/old").status, "cancelado");
  assert.equal(domain.legacy.get("agendamentos/tenant-a/new").status, "agendado");
  assert.equal(domain.v2.get("agendamentos/tenant-a/new").status, "agendado");
  assert.equal(domain.occupancies.has("tenant-a/old"), false);
  assert.equal(domain.occupancies.get("tenant-a/new").appointmentId, "new");
  for (const failAt of ["new-legacy", "new-v2", "old-legacy", "old-v2", "old-occupancy", "new-occupancy"]) {
    const isolated = new Domain();
    isolated.legacy.set("agendamentos/tenant-a/old", original);
    isolated.v2.set("agendamentos/tenant-a/old", clone(original));
    isolated.occupancies.set("tenant-a/old", { tenant: "tenant-a", appointmentId: "old" });
    const before = isolated.snapshot();
    assert.throws(() => rebook(isolated, { tenant: "tenant-a", originalId: "old", newId: "new", barberId: "barber-1", requestId: `rebook-${failAt}`, failAt }), /INJECTED_/);
    assert.deepEqual(isolated.snapshot(), before);
  }
});

test("admin exige papel, tenant e replay; efeitos Legado/V2 permanecem equivalentes", () => {
  const domain = new Domain();
  const admin = { tenant: "tenant-a", resourceId: "service-1", status: "ativo", ownerId: "none" };
  requireRole(["ADMIN"], "ADMIN");
  assert.throws(() => requireRole(["BARBEIRO"], "ADMIN"), /PERMISSION_DENIED/);
  domain.legacy.set("servicos/tenant-a/service-1", admin);
  domain.v2.set("servicos/tenant-a/service-1", clone(admin));
  const before = domain.snapshot();
  const result = domain.transaction("admin-service-1", "admin.servico.salvar", (write) => {
    const next = { ...admin, status: "inativo" };
    write("legacy", () => domain.legacy.set("servicos/tenant-a/service-1", next));
    write("v2", () => domain.v2.set("servicos/tenant-a/service-1", next));
    return { id: "service-1", status: "inativo" };
  });
  assert.equal(result.duplicate, false);
  assert.equal(domain.transaction("admin-service-1", "admin.servico.salvar", () => ({ id: "ignored" })).duplicate, true);
  assertEquivalentProjection(domain.legacy.get("servicos/tenant-a/service-1"), domain.v2.get("servicos/tenant-a/service-1"));
  assert.notDeepEqual(domain.snapshot(), before);
});
