import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  DYNAMIC_TENANT_COMMANDS,
  OPERATIONAL_CONTEXT_MODES,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const selected = ["agenda.criar", "agenda.reagendar"];
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
  assert.notEqual(from, -1, `missing ${start}`);
  assert.notEqual(to, -1, `missing ${end}`);
  return runtime.slice(from, to);
}

class AgendaModel {
  constructor() { this.legacy = new Map(); this.v2 = new Map(); this.audit = new Map(); this.io = []; }
  snapshot() { return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit, io: this.io }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(tenant, collection, id) { return `barbearias/${tenant}/${collection}/${id}`; }
  read(mode, tenant, collection, id) {
    this.io.push({ type: "read", mode, collection });
    return (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2)
      .get(mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : this.key(tenant, collection, id));
  }
  write(mode, tenant, collection, id, value) {
    this.io.push({ type: "write", mode, collection });
    const copy = structuredClone(value);
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(`${collection}/${id}`, copy); this.v2.set(this.key(tenant, collection, id), structuredClone(copy));
    } else this.v2.set(this.key(tenant, collection, id), copy);
  }
  remove(mode, tenant, collection, id) {
    this.io.push({ type: "write", mode, collection });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) { this.legacy.delete(`${collection}/${id}`); this.v2.delete(this.key(tenant, collection, id)); }
    else this.v2.delete(this.key(tenant, collection, id));
  }
  slots(start, duration) {
    if (!Number.isInteger(duration) || duration < 30 || duration > 120 || duration % 30) throw new Error("DURACAO_INVALIDA");
    const [hour, minute] = start.split(":").map(Number);
    return Array.from({ length: duration / 30 }, (_, index) => `${String(hour + Math.floor((minute + index * 30) / 60)).padStart(2, "0")}:${String((minute + index * 30) % 60).padStart(2, "0")}`);
  }
  authorize({ action, roles, uid, barberUid, clientId }) {
    const admin = roles.includes("ADMIN"); const owner = roles.includes("BARBEIRO") && uid === barberUid;
    if (action === "create" && (admin || owner || clientId === uid)) return;
    if (action === "rebook" && (admin || owner)) return;
    throw new Error("PERMISSION_DENIED");
  }
  create({ mode, tenant, uid = "client", roles = ["CLIENTE"], barberUid = "barber", barber = "barber-1", serviceActive = true, barberActive = true, closed = false, duration = 30, time = "10:00", clientId = uid, subscription = null, requestId, failAt = "" }) {
    const operation = "agenda.criar"; const id = `${barber}_2099-01-01_${time}`;
    const fingerprint = operationalPayloadFingerprint({ barber, duration, time, clientId, subscription: Boolean(subscription) });
    const auditKey = `${tenant}/${requestId}`; const replay = this.audit.get(auditKey);
    if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      this.authorize({ action: "create", roles, uid, barberUid, clientId });
      if (!serviceActive || !barberActive) throw new Error("RESOURCE_INACTIVE");
      if (closed) throw new Error("BARBEARIA_FECHADA");
      const slots = this.slots(time, duration);
      for (const slot of slots) if (this.read(mode, tenant, "ocupacoes", `${barber}_2099-01-01_${slot}`)) throw new Error("HORARIO_OCUPADO");
      if (subscription && subscription.restantes - subscription.reservados < 1) throw new Error("CREDITO_INDISPONIVEL");
      this.write(mode, tenant, "agendamentos", id, { id, barbeiro_id: barber, cliente_id: clientId, horario: time, duracao: duration, status: "agendado", ...(subscription ? { assinatura_id: subscription.id } : {}) });
      for (const slot of slots) this.write(mode, tenant, "ocupacoes", `${barber}_2099-01-01_${slot}`, { agendamento_id: id });
      if (failAt === "after-occupations") throw new Error("INJECTED_FAILURE");
      if (subscription) { subscription.reservados += 1; this.write(mode, tenant, "solicitacoes_assinatura", subscription.id, subscription); }
      const result = { appointmentId: id, slots: slots.length }; this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
  rebook({ mode, tenant, uid = "admin", roles = ["ADMIN"], barberUid = "barber", originalId, targetTime, requestId, failAt = "" }) {
    const operation = "agenda.reagendar"; const fingerprint = operationalPayloadFingerprint({ originalId, targetTime }); const auditKey = `${tenant}/${requestId}`;
    const replay = this.audit.get(auditKey); if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      const original = this.read(mode, tenant, "agendamentos", originalId); if (!original || !["agendado", "cliente_chegou"].includes(original.status)) throw new Error("AGENDAMENTO_INDISPONIVEL");
      this.authorize({ action: "rebook", roles, uid, barberUid, clientId: original.cliente_id });
      const targetId = `${original.barbeiro_id}_2099-01-01_${targetTime}`; if (targetId === originalId) throw new Error("AGENDAMENTO_SEM_ALTERACAO");
      const oldSlots = this.slots(original.horario, original.duracao); const newSlots = this.slots(targetTime, original.duracao);
      for (const slot of newSlots) { const occupied = this.read(mode, tenant, "ocupacoes", `${original.barbeiro_id}_2099-01-01_${slot}`); if (occupied && occupied.agendamento_id !== originalId) throw new Error("HORARIO_OCUPADO"); }
      this.write(mode, tenant, "agendamentos", targetId, { ...original, id: targetId, horario: targetTime, status: "agendado", reagendado_de: originalId });
      this.write(mode, tenant, "agendamentos", originalId, { ...original, status: "cancelado", reagendado_para: targetId });
      for (const slot of oldSlots) if (!newSlots.includes(slot)) this.remove(mode, tenant, "ocupacoes", `${original.barbeiro_id}_2099-01-01_${slot}`);
      for (const slot of newSlots) this.write(mode, tenant, "ocupacoes", `${original.barbeiro_id}_2099-01-01_${slot}`, { agendamento_id: targetId });
      if (failAt === "after-occupations") throw new Error("INJECTED_FAILURE");
      const result = { appointmentId: targetId, replacedAppointmentId: originalId }; this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result }); return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
}

test("Slice 18 migra somente criar/reagendar, reutiliza o limite e não contém refs legadas em V2", () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => selected.includes(command)), selected);
  assert.equal(allCommands.length, 32);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 2);
  const create = sourceBetween("async function createAppointment", "async function rebookAppointment");
  const rebook = sourceBetween("async function rebookAppointment", "async function transitionAppointment");
  for (const handler of [create, rebook]) { assert.match(handler, /context/); assert.match(handler, /tenantPrimaryRef\(context/); assert.doesNotMatch(handler, /legacyRef\(/); }
  assert.match(create, /tenantSet\(tx, context, "agendamentos"/); assert.match(create, /tenantUpdate\(tx, context, "solicitacoes_assinatura"/);
  assert.match(rebook, /tenantSet\(tx, context, "agendamentos"/); assert.match(rebook, /tenantDelete\(tx, context, "ocupacoes"/);
});

test("CREATE_TENANT_A_B, crédito, limite e zero I/O legado V2", () => {
  const model = new AgendaModel(); const subscription = { id: "sub-a", restantes: 2, reservados: 0 };
  model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "create-a-0001", subscription });
  model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", requestId: "create-b-0001", time: "11:00" });
  assert.equal(subscription.reservados, 1); assert.equal(model.legacy.size, 0);
  assert.throws(() => model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "too-long-0001", duration: 150 }), /DURACAO_INVALIDA/);
  assert.throws(() => model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "closed-00001", closed: true }), /BARBEARIA_FECHADA/);
  assert.throws(() => model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "inactive-0001", serviceActive: false }), /RESOURCE_INACTIVE/);
});

test("RESCHEDULE_TENANT_A_B preserva crédito, protege ocupações e faz rollback integral", () => {
  const model = new AgendaModel(); const created = model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "origin-a-00001", duration: 60 });
  const before = model.snapshot();
  assert.throws(() => model.rebook({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", originalId: created.appointmentId, targetTime: "11:00", requestId: "rollback-00001", failAt: "after-occupations" }), /INJECTED_FAILURE/);
  assert.deepEqual(model.snapshot(), before);
  const moved = model.rebook({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", originalId: created.appointmentId, targetTime: "11:00", requestId: "move-a-0000001" });
  assert.equal(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "agendamentos", created.appointmentId).status, "cancelado");
  assert.equal(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "agendamentos", moved.appointmentId).status, "agendado");
  const createdB = model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", requestId: "origin-b-00001", time: "12:00" });
  const movedB = model.rebook({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", originalId: createdB.appointmentId, targetTime: "13:00", requestId: "move-b-0000001" });
  assert.equal(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "agendamentos", movedB.appointmentId).status, "agendado");
  assert.throws(() => model.rebook({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", originalId: created.appointmentId, targetTime: "12:00", requestId: "cross-tenant001" }), /AGENDAMENTO_INDISPONIVEL/);
});

test("AUTHORIZATION, conflito, replay, colisão e dual-write Antunes são preservados", () => {
  const model = new AgendaModel();
  assert.throws(() => model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", uid: "other", clientId: "client", requestId: "denied-create01" }), /PERMISSION_DENIED/);
  const first = model.create({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", requestId: "antunes-create1" });
  assert.ok(model.legacy.get(`agendamentos/${first.appointmentId}`));
  assert.equal(model.create({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", requestId: "antunes-create1" }).duplicate, true);
  assert.throws(
    () => model.create({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", requestId: "antunes-create1", time: "11:00" }),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
  const isolated = model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", requestId: "antunes-create1", time: "12:00" });
  assert.equal(isolated.duplicate, false);
  model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "tenant-a-create1" });
  assert.throws(() => model.create({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", requestId: "conflict-create1" }), /HORARIO_OCUPADO/);
  for (const payload of [{ data: { tenantId: "tenant-b" } }, { data: { nested: { write_mode: "legacy" } } }, { path: "agendamentos/x" }]) {
    assert.throws(() => validateOperationalEnvelope({ command: "agenda.criar", requestId: "selector-create1", ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
});
