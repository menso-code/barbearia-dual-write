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
const selected = ["agenda.concluir", "agenda.cancelar", "agenda.nao_compareceu"];
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
  assert.notEqual(from, -1, `missing start: ${start}`);
  assert.notEqual(to, -1, `missing end: ${end}`);
  return runtime.slice(from, to);
}

class AgendaFinalModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
  }

  snapshot() { return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit, io: this.io }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(mode, tenantId, collection, id) {
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? `${collection}/${id}` : `barbearias/${tenantId}/${collection}/${id}`;
  }
  target(mode) { return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2; }
  v2Key(tenantId, collection, id) { return `barbearias/${tenantId}/${collection}/${id}`; }
  read(mode, tenantId, collection, id) {
    this.io.push({ kind: "read", mode, collection });
    return this.target(mode).get(this.key(mode, tenantId, collection, id));
  }
  write(mode, tenantId, collection, id, value) {
    this.io.push({ kind: "write", mode, collection });
    this.target(mode).set(this.key(mode, tenantId, collection, id), structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.set(this.v2Key(tenantId, collection, id), structuredClone(value));
  }
  patch(mode, tenantId, collection, id, value) {
    this.write(mode, tenantId, collection, id, { ...this.read(mode, tenantId, collection, id), ...value });
  }
  delete(mode, tenantId, collection, id) {
    this.io.push({ kind: "write", mode, collection });
    this.target(mode).delete(this.key(mode, tenantId, collection, id));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.delete(this.v2Key(tenantId, collection, id));
  }
  seed(mode, tenantId, collection, id, value) { this.write(mode, tenantId, collection, id, value); this.io = []; }

  transition({ mode, tenantId, uid, roles, action, requestId, appointmentId = "appointment-1", failAt = "" }) {
    const operation = `agenda.${action}`;
    const fingerprint = operationalPayloadFingerprint({ appointmentId });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, operation, fingerprint);
      return { duplicate: true, ...previous.result };
    }
    const before = this.snapshot();
    try {
      const appointment = this.read(mode, tenantId, "agendamentos", appointmentId);
      if (!appointment) throw new Error("AGENDAMENTO_INDISPONIVEL");
      const barberOwner = roles.includes("BARBEIRO") && appointment.barbeiro_uid === uid;
      const clientOwner = action === "cancelar" && roles.includes("CLIENTE") && appointment.cliente_id === uid;
      if (!roles.includes("ADMIN") && !barberOwner && !clientOwner) throw new Error("PERMISSION_DENIED");
      if (!["agendado", "cliente_chegou", "em_atendimento"].includes(appointment.status)) throw new Error("AGENDAMENTO_INDISPONIVEL");

      const consumes = ["concluir", "nao_compareceu"].includes(action) && appointment.origem === "assinatura";
      const releases = action === "cancelar" && appointment.credito_assinatura_reservado === true && appointment.credito_assinatura_consumido !== true;
      if (consumes || releases) {
        const subscription = this.read(mode, tenantId, "solicitacoes_assinatura", appointment.assinatura_id);
        const credit = subscription?.creditos_mensais?.[appointment.assinatura_credito_tipo];
        if (!credit || (consumes && (subscription.status !== "ATIVA" || credit.restantes < 1 || credit.reservados < 1)) || (releases && credit.reservados < 1)) throw new Error("CREDITO_INDISPONIVEL");
        const updated = { ...credit, reservados: credit.reservados - 1, ...(consumes ? { restantes: credit.restantes - 1, utilizados: credit.utilizados + 1 } : {}) };
        this.patch(mode, tenantId, "solicitacoes_assinatura", appointment.assinatura_id, { creditos_mensais: { ...subscription.creditos_mensais, [appointment.assinatura_credito_tipo]: updated } });
        if (consumes) this.write(mode, tenantId, "historico_assinaturas", `${appointmentId}_credito`, { agendamento_id: appointmentId, assinatura_id: appointment.assinatura_id, creditos_consumidos: 1 });
      }
      const status = action === "concluir" ? "concluido" : action === "cancelar" ? "cancelado" : "nao_compareceu";
      this.patch(mode, tenantId, "agendamentos", appointmentId, { status, ...(consumes ? { credito_assinatura_consumido: true } : {}) });
      if (action !== "concluir") this.delete(mode, tenantId, "ocupacoes", appointment.ocupacao_id);
      if (failAt === "after-effects") throw new Error("INJECTED_FAILURE");
      const result = { appointmentId, status };
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

function seedAgenda(model, mode, tenantId, status = "agendado") {
  const appointment = { status, origem: "assinatura", assinatura_id: "subscription-1", assinatura_credito_tipo: "corte", cliente_id: "client-a", barbeiro_uid: "barber-a", ocupacao_id: "barber-a_2026-08-27_10:00", credito_assinatura_reservado: true };
  model.seed(mode, tenantId, "agendamentos", "appointment-1", appointment);
  model.seed(mode, tenantId, "solicitacoes_assinatura", "subscription-1", { status: "ATIVA", creditos_mensais: { corte: { restantes: 2, reservados: 1, utilizados: 0 } } });
  model.seed(mode, tenantId, "ocupacoes", appointment.ocupacao_id, { agendamento_id: "appointment-1" });
}

test("Slice 15 registers exactly the three final agenda transitions and preserves the tenant-scoped runtime", () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => selected.includes(command)), selected);
  assert.equal(allCommands.length, 32);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 2);
  const transition = sourceBetween("async function transitionAppointment", "async function createBlock");
  assert.match(transition, /tenantPrimaryRef\(context, "agendamentos", id\)/);
  assert.match(transition, /tenantPrimaryRef\(context, "solicitacoes_assinatura", subscriptionId\)/);
  assert.match(transition, /tenantSet\(tx, context, "historico_assinaturas"/);
  assert.match(transition, /tenantDelete\(tx, context, "ocupacoes"/);
  const dispatch = sourceBetween('case "agenda.concluir"', 'case "bloqueio.criar"');
  assert.match(dispatch, /requestId, context/);
  assert.match(sourceBetween("async function ensureAppointmentPermission", "async function rebookAppointment"), /action === "cancelar" && roles\.includes\("CLIENTE"\) && appointment\.cliente_id === uid/);
});

test("VALID_STATUS_TRANSITIONS, CREDIT_FLOW, HISTORY_FLOW and OCCUPATION_FLOW are atomic per tenant", () => {
  for (const [action, initial, expected, keepsOccupation] of [["concluir", "em_atendimento", "concluido", true], ["cancelar", "agendado", "cancelado", false], ["nao_compareceu", "agendado", "nao_compareceu", false]]) {
    const model = new AgendaFinalModel();
    seedAgenda(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", initial);
    const result = model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], action, requestId: `request-${action}` });
    assert.equal(result.status, expected);
    assert.equal(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "agendamentos", "appointment-1").status, expected);
    assert.equal(Boolean(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "ocupacoes", "barber-a_2026-08-27_10:00")), keepsOccupation);
    const subscription = model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1");
    assert.equal(subscription.creditos_mensais.corte.reservados, 0);
    assert.equal(subscription.creditos_mensais.corte.restantes, action === "cancelar" ? 2 : 1);
    assert.equal(Boolean(model.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "historico_assinaturas", "appointment-1_credito")), action !== "cancelar");
  }
});

test("ADMIN_AUTH, BARBER_OWNER_AUTH and CLIENT_OWNER_CANCEL_AUTH reject non-owners and cross-tenant state", () => {
  const model = new AgendaFinalModel();
  seedAgenda(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a");
  assert.doesNotThrow(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-a", roles: ["BARBEIRO"], action: "cancelar", requestId: "barber-owner" }));
  seedAgenda(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a");
  assert.doesNotThrow(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"], action: "cancelar", requestId: "client-owner" }));
  seedAgenda(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a");
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"], action: "concluir", requestId: "client-conclude" }), /PERMISSION_DENIED/);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], action: "cancelar", requestId: "cross-tenant" }), /AGENDAMENTO_INDISPONIVEL/);
});

test("ANTUNES_DUAL_WRITE, NEW_TENANT_ZERO_LEGACY_IO, replay isolation and transaction rollback are preserved", () => {
  const antunes = new AgendaFinalModel();
  seedAgenda(antunes, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID);
  antunes.transition({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "admin", roles: ["ADMIN"], action: "cancelar", requestId: "same-request" });
  assert.equal(antunes.legacy.get("agendamentos/appointment-1").status, "cancelado");
  assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/agendamentos/appointment-1`).status, "cancelado");
  const v2 = new AgendaFinalModel();
  seedAgenda(v2, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a");
  v2.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], action: "cancelar", requestId: "same-request" });
  assert.equal(v2.legacy.size, 0);
  assert.equal(v2.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], action: "cancelar", requestId: "same-request" }).duplicate, true);
  seedAgenda(v2, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b");
  assert.doesNotThrow(() => v2.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], action: "cancelar", requestId: "same-request" }));
  const rollback = new AgendaFinalModel();
  seedAgenda(rollback, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "em_atendimento");
  assert.throws(() => rollback.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], action: "concluir", requestId: "rollback", failAt: "after-effects" }), /INJECTED_FAILURE/);
  assert.equal(rollback.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "agendamentos", "appointment-1").status, "em_atendimento");
  assert.equal(rollback.read(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1").creditos_mensais.corte.restantes, 2);
});

test("WRITE_MODE_REJECTED_RECURSIVELY, INVALID_STATUS_FAIL_CLOSED and OTHER_2_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS", () => {
  for (const payload of [{ data: { tenantId: "tenant-b" } }, { data: { nested: { write_mode: "legacy" } } }, { data: { path: "agendamentos/x" } }]) {
    assert.throws(() => validateOperationalEnvelope({ command: "agenda.cancelar", requestId: "request-1", ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
  const model = new AgendaFinalModel();
  seedAgenda(model, OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "concluido");
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], action: "cancelar", requestId: "invalid-state" }), /AGENDAMENTO_INDISPONIVEL/);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 2);
});
