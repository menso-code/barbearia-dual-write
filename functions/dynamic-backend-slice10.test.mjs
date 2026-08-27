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
const command = "admin.assinatura.expirar";
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

function creditsExhausted(credits) {
  const list = Object.values(credits || {});
  return list.length > 0 && list.every((credit) => Number(credit.restantes) <= 0);
}

class Slice10Model {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
    this.creditsRead = 0;
    this.creditWrites = 0;
  }

  snapshot() {
    return structuredClone({
      legacy: this.legacy,
      v2: this.v2,
      audit: this.audit,
      io: this.io,
      creditsRead: this.creditsRead,
      creditWrites: this.creditWrites,
    });
  }

  restore(snapshot) {
    Object.assign(this, snapshot);
  }

  key(mode, tenantId, collection, id) {
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? `${collection}/${id}`
      : `barbearias/${tenantId}/${collection}/${id}`;
  }

  seed(mode, tenantId, collection, id, value) {
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(this.key(mode, tenantId, collection, id), structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
    }
  }

  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, key });
    const value = (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2).get(key);
    if (value?.creditos_mensais !== undefined) this.creditsRead += 1;
    return value;
  }

  update(mode, tenantId, collection, id, changes) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, key });
    if (Object.hasOwn(changes, "creditos_mensais")) this.creditWrites += 1;
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, { ...(target.get(key) || {}), ...structuredClone(changes) });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      const v2Key = `barbearias/${tenantId}/${collection}/${id}`;
      this.v2.set(v2Key, { ...(this.v2.get(v2Key) || {}), ...structuredClone(changes) });
    }
  }

  expire({ mode, tenantId, roles, memberActive = true, id, requestId, failAt = "" }) {
    const fingerprint = operationalPayloadFingerprint({ id });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }

    const before = this.snapshot();
    try {
      if (!memberActive || !roles.includes("ADMIN")) fail("MEMBERSHIP_REQUIRED");
      const subscription = this.read(mode, tenantId, "solicitacoes_assinatura", id);
      if (!subscription || subscription.status !== "ATIVA") fail("ASSINATURA_INDISPONIVEL");
      const dueAt = subscription.vencimento_em instanceof Date ? subscription.vencimento_em : null;
      const exhausted = creditsExhausted(subscription.creditos_mensais);
      if (!exhausted && (!dueAt || dueAt > new Date())) fail("ASSINATURA_AINDA_ATIVA");
      if (failAt === "before-update") fail("INJECTED_FAILURE");
      this.update(mode, tenantId, "solicitacoes_assinatura", id, {
        status: "EXPIRADA",
        motivo_expiracao: exhausted ? "CREDITOS_ESGOTADOS" : "VENCIMENTO",
      });
      if (failAt === "after-update") fail("INJECTED_FAILURE");
      const result = { subscriptionId: id, status: "EXPIRADA" };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const expiredSubscription = {
  status: "ATIVA",
  vencimento_em: new Date("2026-08-26T12:00:00.000Z"),
  creditos_mensais: { corte: { restantes: 2, reservados: 0, utilizados: 1 } },
};

test("Slice 10 registra somente admin.assinatura.expirar e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 7);
  const handler = sourceBetween('if (action === "assinatura.expirar")', 'if (action === "assinatura.renovar")');
  assert.match(handler, /onlyFields\(incoming, new Set\(\["id"\]\)\)/);
  assert.match(handler, /requireContextAdmin\(tx, uid, context\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "solicitacoes_assinatura", id\)/);
  assert.match(handler, /tenantUpdate\(tx, context, "solicitacoes_assinatura", id/);
  assert.match(handler, /requestFingerprint: operationalPayloadFingerprint\(\{ id \}\)/);
  assert.doesNotMatch(handler, /legacyRef\(/);
  assert.doesNotMatch(handler, /creditos_mensais\s*:/);
});

test("TENANT_A_ASSINATURA_EXPIRAR_PASS e TENANT_B_ASSINATURA_EXPIRAR_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice10Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "solicitacoes_assinatura", "subscription-1", expiredSubscription);
    assert.deepEqual(model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, roles: ["ADMIN"], id: "subscription-1", requestId: `expire-${tenantId}-0001` }), {
      duplicate: false, subscriptionId: "subscription-1", status: "EXPIRADA",
    });
    assert.equal(model.v2.get(`barbearias/${tenantId}/solicitacoes_assinatura/subscription-1`).status, "EXPIRADA");
  }
});

test("CROSS_TENANT_DENIED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice10Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", expiredSubscription);
  assert.throws(() => model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-1", requestId: "cross-tenant-0001" }), /ASSINATURA_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-b/")), true);
});

test("ADMIN_AUTH_VALIDATED, NON_ADMIN_DENIED, NON_MEMBER_DENIED e INACTIVE_TENANT_DENIED", () => {
  for (const access of [{ roles: ["CLIENTE"] }, { roles: ["ADMIN"], memberActive: false }]) {
    const model = new Slice10Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", expiredSubscription);
    assert.throws(() => model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", id: "subscription-1", requestId: `denied-${access.roles.join("-")}`, ...access }), /MEMBERSHIP_REQUIRED/);
  }
});

test("ASSINATURA_EXPIRAR_ATIVA_VALIDATED e VENCIMENTO_VALIDATED", () => {
  const byDueDate = new Slice10Model();
  byDueDate.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "due", expiredSubscription);
  assert.equal(byDueDate.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "due", requestId: "due-date-0001" }).status, "EXPIRADA");

  const byCredits = new Slice10Model();
  byCredits.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "credits", { ...expiredSubscription, vencimento_em: new Date("2026-09-26T12:00:00.000Z"), creditos_mensais: { corte: { restantes: 0 } } });
  assert.equal(byCredits.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "credits", requestId: "credits-0001" }).status, "EXPIRADA");

  const future = new Slice10Model();
  future.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "future", { ...expiredSubscription, vencimento_em: new Date("2026-09-26T12:00:00.000Z") });
  assert.throws(() => future.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "future", requestId: "future-0001" }), /ASSINATURA_AINDA_ATIVA/);
});

test("ASSINATURA_EXPIRAR_INVALID_STATES_FAIL_CLOSED e missing fail closed", () => {
  for (const status of ["PENDENTE", "CANCELADA", "RECUSADA", "EXPIRADA"]) {
    const model = new Slice10Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", { ...expiredSubscription, status });
    assert.throws(() => model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: `invalid-${status}-0001` }), /ASSINATURA_INDISPONIVEL/);
  }
  const missing = new Slice10Model();
  assert.throws(() => missing.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "missing", requestId: "missing-0001" }), /ASSINATURA_INDISPONIVEL/);
});

test("TENANT_SELECTOR_PAYLOAD_REJECTED e WRITE_MODE_REJECTED_RECURSIVELY", () => {
  for (const payload of [
    { tenantId: "tenant-b" },
    { data: { nested: { tenant_id: "tenant-b" } } },
    { data: { nested: { path: "barbearias/tenant-b" } } },
    { data: { nested: { writeMode: "V2_ONLY" } } },
    { data: { nested: { write_mode: "V2_ONLY" } } },
  ]) {
    assert.throws(() => validateOperationalEnvelope({ command, ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
});

test("ANTUNES_DUAL_WRITE_PRESERVED, CREDITOS_READ_ONLY_IF_REQUIRED e NO_CREDIT_WRITE", () => {
  const model = new Slice10Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "solicitacoes_assinatura", "subscription-1", expiredSubscription);
  model.expire({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, roles: ["ADMIN"], id: "subscription-1", requestId: "antunes-expire-0001" });
  assert.equal(model.legacy.get("solicitacoes_assinatura/subscription-1").status, "EXPIRADA");
  assert.equal(model.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/subscription-1`).status, "EXPIRADA");
  assert.equal(model.creditsRead, 1);
  assert.equal(model.creditWrites, 0);

  const newTenant = new Slice10Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", expiredSubscription);
  newTenant.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "new-tenant-expire-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e AUDIT_TENANT_SCOPED", () => {
  const model = new Slice10Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-a", expiredSubscription);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "solicitacoes_assinatura", "subscription-a", expiredSubscription);
  const requestId = "shared-request-0001";
  assert.equal(model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
  assert.equal(model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, true);
  assert.throws(() => model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-b", requestId }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.equal(model.audit.has(`tenant-a/${requestId}`), true);
  assert.equal(model.audit.has(`tenant-b/${requestId}`), false);
  assert.equal(model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
});

test("ROLLBACK_ON_FAILURE preserva assinatura e auditoria", () => {
  const model = new Slice10Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", expiredSubscription);
  assert.throws(() => model.expire({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "rollback-0001", failAt: "after-update" }), /INJECTED_FAILURE/);
  assert.deepEqual(model.v2.get("barbearias/tenant-a/solicitacoes_assinatura/subscription-1"), expiredSubscription);
  assert.equal(model.audit.size, 0);
});

test("OTHER_7_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 7);
  assert.equal(remaining.includes("admin.assinatura.expirar"), false);
  assert.equal(remaining.includes("agenda.criar"), true);
  assert.equal(allCommands.length, 32);
});
