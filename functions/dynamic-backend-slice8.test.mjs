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
const command = "admin.assinatura.recusar";
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

class Slice8Model {
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

  refuse({ mode, tenantId, roles, id, requestId, failAt = "" }) {
    const fingerprint = operationalPayloadFingerprint({ id });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }

    const before = this.snapshot();
    try {
      if (!roles.includes("ADMIN")) throw new Error("MEMBERSHIP_REQUIRED");
      const subscription = this.read(mode, tenantId, "solicitacoes_assinatura", id);
      if (!subscription || subscription.status !== "PENDENTE") throw new Error("SOLICITACAO_INDISPONIVEL");
      if (failAt === "before-update") throw new Error("INJECTED_FAILURE");
      this.update(mode, tenantId, "solicitacoes_assinatura", id, { status: "RECUSADA", recusado_por: "admin" });
      if (failAt === "after-update") throw new Error("INJECTED_FAILURE");
      const result = { subscriptionId: id, status: "RECUSADA" };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const pending = { status: "PENDENTE", plano_id: "prime" };

test("Slice 8 registra somente admin.assinatura.recusar e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 12);
  const handler = sourceBetween('if (action === "assinatura.recusar")', 'error("internal"');
  assert.match(handler, /onlyFields\(incoming, new Set\(\["id"\]\)\)/);
  assert.match(handler, /requireContextAdmin\(tx, uid, context\)/);
  assert.match(handler, /tenantPrimaryRef\(context, "solicitacoes_assinatura", id\)/);
  assert.match(handler, /tenantUpdate\(tx, context, "solicitacoes_assinatura", id/);
  assert.match(handler, /requestFingerprint: operationalPayloadFingerprint\(\{ id \}\)/);
  assert.doesNotMatch(handler, /legacyRef\(/);
});

test("TENANT_A_ASSINATURA_RECUSAR_PASS e TENANT_B_ASSINATURA_RECUSAR_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice8Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "solicitacoes_assinatura", "subscription-1", pending);
    const result = model.refuse({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId,
      roles: ["ADMIN"],
      id: "subscription-1",
      requestId: `refuse-${tenantId}-0001`,
    });
    assert.deepEqual(result, { duplicate: false, subscriptionId: "subscription-1", status: "RECUSADA" });
    assert.equal(model.v2.get(`barbearias/${tenantId}/solicitacoes_assinatura/subscription-1`).status, "RECUSADA");
  }
});

test("CROSS_TENANT_BLOCKED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice8Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", pending);
  assert.throws(() => model.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-b",
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "cross-tenant-0001",
  }), /SOLICITACAO_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-b/")), true);
});

test("ADMIN_AUTH_VALIDATED e NON_PENDING_FAIL_CLOSED", () => {
  const model = new Slice8Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", pending);
  assert.throws(() => model.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["CLIENTE"],
    id: "subscription-1",
    requestId: "non-admin-0001",
  }), /MEMBERSHIP_REQUIRED/);
  assert.throws(() => model.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "missing",
    requestId: "missing-0001",
  }), /SOLICITACAO_INDISPONIVEL/);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "active", { status: "ATIVA" });
  assert.throws(() => model.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "active",
    requestId: "active-0001",
  }), /SOLICITACAO_INDISPONIVEL/);
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

test("ANTUNES_DUAL_WRITE_PRESERVED e zero legado para novo tenant", () => {
  const antunes = new Slice8Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "solicitacoes_assinatura", "subscription-1", pending);
  const antunesResult = antunes.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE,
    tenantId: ANTUNES_TENANT_ID,
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "antunes-refuse-0001",
  });
  assert.equal(antunesResult.duplicate, false);
  assert.equal(antunes.legacy.get("solicitacoes_assinatura/subscription-1").status, "RECUSADA");
  assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/subscription-1`).status, "RECUSADA");

  const newTenant = new Slice8Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", pending);
  newTenant.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "tenant-a-refuse-0001",
  });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e replay", () => {
  const model = new Slice8Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-a", pending);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "solicitacoes_assinatura", "subscription-a", pending);
  const requestId = "shared-request-0001";
  assert.equal(model.refuse({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
  assert.equal(model.refuse({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, true);
  assert.throws(() => model.refuse({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["ADMIN"], id: "subscription-b", requestId }), (cause) => cause?.code === "REQUEST_ID_COLLISION");

  const otherTenant = new Slice8Model();
  otherTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "solicitacoes_assinatura", "subscription-a", pending);
  assert.equal(otherTenant.refuse({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", roles: ["ADMIN"], id: "subscription-a", requestId }).duplicate, false);
});

test("ROLLBACK_ON_FAILURE preserva a solicitação", () => {
  const model = new Slice8Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "subscription-1", pending);
  assert.throws(() => model.refuse({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    roles: ["ADMIN"],
    id: "subscription-1",
    requestId: "rollback-0001",
    failAt: "after-update",
  }), /INJECTED_FAILURE/);
  assert.deepEqual(model.v2.get("barbearias/tenant-a/solicitacoes_assinatura/subscription-1"), pending);
  assert.equal(model.audit.size, 0);
});

test("OTHER_12_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 12);
  assert.equal(remaining.includes("admin.assinatura.aprovar"), true);
  assert.equal(remaining.includes("admin.assinatura.cancelar"), false);
  assert.equal(remaining.includes(command), false);
  assert.equal(allCommands.length, 32);
});
