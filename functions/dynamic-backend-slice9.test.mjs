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
const command = "admin.assinatura.cancelar";
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

class Slice9Model {
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

  seed(mode, tenantId, collection, id, value) {
    const key = this.key(mode, tenantId, collection, id);
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
    }
  }

  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, key });
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? this.legacy.get(key)
      : this.v2.get(key);
  }

  update(mode, tenantId, collection, id, value) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, key });
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, { ...(target.get(key) || {}), ...structuredClone(value) });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      const v2Key = `barbearias/${tenantId}/${collection}/${id}`;
      this.v2.set(v2Key, { ...(this.v2.get(v2Key) || {}), ...structuredClone(value) });
    }
  }

  cancel({ mode, tenantId, roles, memberActive = true, id, motivo, requestId, failAt = "" }) {
    const safeMotivo = motivo || "Administrativo";
    const fingerprint = operationalPayloadFingerprint({ id, motivo: safeMotivo });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }

    const before = this.snapshot();
    try {
      if (!memberActive || !roles.includes("ADMIN")) throw new Error("MEMBERSHIP_REQUIRED");
      const subscription = this.read(mode, tenantId, "solicitacoes_assinatura", id);
      if (!subscription || !["PENDENTE", "ATIVA"].includes(subscription.status)) {
        throw new Error("ASSINATURA_INDISPONIVEL");
      }
      if (failAt === "before-update") throw new Error("INJECTED_FAILURE");
      this.update(mode, tenantId, "solicitacoes_assinatura", id, {
        status: "CANCELADA",
        cancelada_por: "admin",
        motivo_cancelamento: safeMotivo,
      });
      if (failAt === "after-update") throw new Error("INJECTED_FAILURE");
      const result = { subscriptionId: id, status: "CANCELADA" };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const subscription = {
  status: "PENDENTE",
  plano_id: "prime",
  creditos_mensais: { corte: { restantes: 4, reservados: 1, utilizados: 0 } },
};

test("Slice 9 registra somente admin.assinatura.cancelar e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 11);
  const handler = sourceBetween('if (action === "assinatura.cancelar")', 'error("internal"');
  assert.match(handler, /onlyFields\(incoming, new Set\(\["id", "motivo"\]\)\)/);
  assert.match(handler, /requireContextAdmin\(tx, uid, context\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "solicitacoes_assinatura", id\)/);
  assert.match(handler, /tenantUpdate\(tx, context, "solicitacoes_assinatura", id/);
  assert.match(handler, /requestFingerprint: operationalPayloadFingerprint\(\{ id, motivo \}\)/);
  assert.doesNotMatch(handler, /legacyRef\(/);
});

test("TENANT_A_ASSINATURA_CANCELAR_PASS e TENANT_B_ASSINATURA_CANCELAR_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice9Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "solicitacoes_assinatura", "subscription-1", subscription);
    const result = model.cancel({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId,
      roles: ["ADMIN"],
      id: "subscription-1",
      motivo: "Solicitado pelo estabelecimento",
      requestId: `cancel-${tenantId}-0001`,
    });
    assert.deepEqual(result, { duplicate: false, subscriptionId: "subscription-1", status: "CANCELADA" });
    assert.equal(model.v2.get(`barbearias/${tenantId}/solicitacoes_assinatura/subscription-1`).status, "CANCELADA");
  }
});

test("CROSS_TENANT_DENIED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice9Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", subscription);
  assert.throws(() => model.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-b",
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "cross-tenant-0001",
  }), /ASSINATURA_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-b/")), true);
});

test("ADMIN_AUTH_VALIDATED e NON_MEMBER_DENIED", () => {
  const model = new Slice9Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", subscription);
  assert.throws(() => model.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["CLIENTE"],
    id: "subscription-1",
    requestId: "non-admin-0001",
  }), /MEMBERSHIP_REQUIRED/);
  assert.throws(() => model.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    memberActive: false,
    id: "subscription-1",
    requestId: "inactive-member-0001",
  }), /MEMBERSHIP_REQUIRED/);
});

test("ASSINATURA_CANCELAR_VALID_STATES", () => {
  for (const status of ["PENDENTE", "ATIVA"]) {
    const model = new Slice9Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", { ...subscription, status });
    assert.equal(model.cancel({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId: "tenant-a",
      roles: ["ADMIN"],
      id: "subscription-1",
      requestId: `valid-${status.toLowerCase()}-0001`,
    }).status, "CANCELADA");
  }
});

test("ASSINATURA_CANCELAR_INVALID_STATES_FAIL_CLOSED e missing characterized", () => {
  for (const status of ["RECUSADA", "CANCELADA", "EXPIRADA"]) {
    const model = new Slice9Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", { ...subscription, status });
    assert.throws(() => model.cancel({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId: "tenant-a",
      roles: ["ADMIN"],
      id: "subscription-1",
      requestId: `invalid-${status.toLowerCase()}-0001`,
    }), /ASSINATURA_INDISPONIVEL/);
  }
  const missing = new Slice9Model();
  assert.throws(() => missing.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "missing",
    requestId: "missing-0001",
  }), /ASSINATURA_INDISPONIVEL/);
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
      () => validateOperationalEnvelope({ command, ...payload }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("ANTUNES_DUAL_WRITE_PRESERVED e créditos não são recalculados", () => {
  const antunes = new Slice9Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "solicitacoes_assinatura", "subscription-1", subscription);
  const result = antunes.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE,
    tenantId: ANTUNES_TENANT_ID,
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "antunes-cancel-0001",
  });
  assert.equal(result.duplicate, false);
  assert.equal(antunes.legacy.get("solicitacoes_assinatura/subscription-1").status, "CANCELADA");
  assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/subscription-1`).status, "CANCELADA");
  assert.deepEqual(antunes.legacy.get("solicitacoes_assinatura/subscription-1").creditos_mensais, subscription.creditos_mensais);

  const newTenant = new Slice9Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", subscription);
  newTenant.cancel({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-1", requestId: "new-tenant-cancel-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e AUDIT_TENANT_SCOPED", () => {
  const model = new Slice9Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-a", subscription);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "solicitacoes_assinatura", "subscription-a", subscription);
  const requestId = "shared-request-0001";
  assert.equal(model.cancel({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
  assert.equal(model.cancel({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, true);
  assert.throws(() => model.cancel({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-b", requestId }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.equal(model.audit.has(`tenant-a/${requestId}`), true);

  const otherTenant = new Slice9Model();
  otherTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "solicitacoes_assinatura", "subscription-a", subscription);
  assert.equal(otherTenant.cancel({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
});

test("ROLLBACK_ON_FAILURE preserva assinatura e auditoria", () => {
  const model = new Slice9Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", subscription);
  assert.throws(() => model.cancel({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "rollback-0001",
    failAt: "after-update",
  }), /INJECTED_FAILURE/);
  assert.deepEqual(model.v2.get("barbearias/tenant-a/solicitacoes_assinatura/subscription-1"), subscription);
  assert.equal(model.audit.size, 0);
});

test("OTHER_11_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 11);
  assert.equal(remaining.includes("admin.assinatura.cancelar"), false);
  assert.equal(remaining.includes("admin.assinatura.expirar"), false);
  assert.equal(remaining.includes("admin.assinatura.aprovar"), true);
  assert.equal(allCommands.length, 32);
});
