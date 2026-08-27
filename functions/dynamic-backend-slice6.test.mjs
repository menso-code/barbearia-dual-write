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
const selectedCommands = ["agenda.cliente_chegou", "agenda.em_atendimento"];
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

class Slice6Model {
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

  update(mode, tenantId, collection, id, patch) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, collection, key });
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, { ...target.get(key), ...patch });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, { ...this.v2.get(`barbearias/${tenantId}/${collection}/${id}`), ...patch });
    }
  }

  seed(mode, tenantId, appointmentId, appointment) {
    const key = this.key(mode, tenantId, "agendamentos", appointmentId);
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, structuredClone(appointment));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/agendamentos/${appointmentId}`, structuredClone(appointment));
    }
  }

  transition({ mode, tenantId, uid, roles, ownerUid, appointmentId, action, requestId, failAt = "" }) {
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
      const isAdmin = roles.includes("ADMIN");
      const isOwner = roles.includes("BARBEIRO") && ownerUid === uid && appointment.barbeiro_id === ownerUid;
      if (!isAdmin && !isOwner) throw new Error("PERMISSION_DENIED");
      if (action === "cliente_chegou" && appointment.status !== "agendado") throw new Error("AGENDAMENTO_INDISPONIVEL");
      if (action === "em_atendimento" && appointment.status !== "cliente_chegou") throw new Error("AGENDAMENTO_INDISPONIVEL");
      const patch = { status: action, [`${action}_at`]: "SERVER_TIMESTAMP" };
      this.update(mode, tenantId, "agendamentos", appointmentId, patch);
      if (failAt === "after-update") throw new Error("INJECTED_FAILURE");
      const result = { appointmentId, status: action };
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const appointment = { cliente_id: "client-a", barbeiro_id: "barber-a", status: "agendado" };

test("Slice 6 migra somente as duas transições aprovadas e mantém 32 comandos", () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => selectedCommands.includes(command)), selectedCommands);
  assert.equal(allCommands.length, 32);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 15);
  const selectedCase = sourceBetween('case "agenda.cliente_chegou"', 'case "agenda.concluir"');
  assert.match(selectedCase, /requestId, context/);
  const transition = sourceBetween("async function transitionAppointment", "async function createBlock");
  assert.match(transition, /tenantUpdate\(tx, context, "agendamentos"/);
  const legacyCase = sourceBetween('case "agenda.concluir"', 'case "bloqueio.criar"');
  assert.doesNotMatch(legacyCase, /requestId, context/);
});

test("TENANT_A_AGENDA_TRANSITIONS_PASS e TENANT_B_AGENDA_TRANSITIONS_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice6Model();
    const barberId = `barber-${tenantId.slice(-1)}`;
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "appointment-1", { ...appointment, barbeiro_id: barberId });
    const result = model.transition({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId,
      uid: `admin-${tenantId.slice(-1)}`,
      roles: ["ADMIN"],
      ownerUid: "",
      appointmentId: "appointment-1",
      action: "cliente_chegou",
      requestId: `arrive-${tenantId}-0001`,
    });
    assert.equal(result.status, "cliente_chegou");
  }
});

test("CROSS_TENANT_DENIED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-1", appointment);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "cross-tenant-0001" }), /AGENDAMENTO_INDISPONIVEL/);
  assert.equal(model.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
  assert.equal(model.legacy.size, 0);
});

test("OWNER_BARBER_AUTH_VALIDATED e NON_MEMBER_DENIED", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-1", appointment);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "client-denied-0001" }), /PERMISSION_DENIED/);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-b", roles: ["BARBEIRO"], ownerUid: "barber-b", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "wrong-owner-0001" }), /PERMISSION_DENIED/);
  const result = model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-a", roles: ["BARBEIRO"], ownerUid: "barber-a", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "owner-pass-0001" });
  assert.equal(result.status, "cliente_chegou");
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
      () => validateOperationalEnvelope({ command: "agenda.cliente_chegou", ...payload }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("ANTUNES_DUAL_WRITE_PRESERVED e V2_ONLY sem legado", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "appointment-1", appointment);
  const antunes = model.transition({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "admin-antunes", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "antunes-arrive-0001" });
  assert.equal(antunes.status, "cliente_chegou");
  assert.equal(model.legacy.get("agendamentos/appointment-1").status, "cliente_chegou");
  assert.equal(model.v2.get(`barbearias/${ANTUNES_TENANT_ID}/agendamentos/appointment-1`).status, "cliente_chegou");

  const newTenant = new Slice6Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-1", appointment);
  newTenant.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "tenant-a-arrive-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.some(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE), false);
});

test("INVALID_TRANSITIONS_FAIL_CLOSED", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-1", appointment);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "em_atendimento", requestId: "invalid-order-0001" }), /AGENDAMENTO_INDISPONIVEL/);
  model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "valid-order-0001" });
  const result = model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "em_atendimento", requestId: "valid-order-0002" });
  assert.equal(result.status, "em_atendimento");
});

test("REQUEST_ID_TENANT_ISOLATED e SAME_TENANT_COLLISION_PROTECTED", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-a", appointment);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "appointment-b", appointment);
  const requestId = "shared-request-0001";
  assert.equal(model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-a", action: "cliente_chegou", requestId }).status, "cliente_chegou");
  assert.equal(model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-b", action: "cliente_chegou", requestId }).status, "cliente_chegou");
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-c", appointment);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-c", action: "cliente_chegou", requestId }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
});

test("ROLLBACK_ON_FAILURE preserva o agendamento", () => {
  const model = new Slice6Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "appointment-1", appointment);
  assert.throws(() => model.transition({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], ownerUid: "", appointmentId: "appointment-1", action: "cliente_chegou", requestId: "rollback-0001", failAt: "after-update" }), /INJECTED_FAILURE/);
  assert.equal(model.v2.get("barbearias/tenant-a/agendamentos/appointment-1").status, "agendado");
  assert.equal(model.audit.size, 0);
});

test("OTHER_15_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS", () => {
  const remaining = allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command));
  assert.equal(remaining.length, 15);
  assert.equal(remaining.includes("agenda.criar"), true);
  assert.equal(remaining.includes("admin.assinatura.recusar"), false);
  assert.equal(remaining.includes("bloqueio.criar"), false);
});
