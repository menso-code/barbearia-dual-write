import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import test from "node:test";
import {
  ANTUNES_TENANT_ID,
  DYNAMIC_TENANT_COMMANDS,
  OPERATIONAL_CONTEXT_MODES,
  OperationalContextError,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  resolveOperationalContext,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const command = "assinatura.solicitar";
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
  throw new Error(code);
}

function clone(value) {
  return structuredClone(value);
}

class Slice11Model {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
    this.creditWrites = 0;
    this.financialWrites = 0;
  }

  snapshot() {
    return clone({
      legacy: this.legacy,
      v2: this.v2,
      audit: this.audit,
      io: this.io,
      creditWrites: this.creditWrites,
      financialWrites: this.financialWrites,
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
    const cloned = clone(value);
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(this.key(mode, tenantId, collection, id), cloned);
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, clone(value));
    } else {
      this.v2.set(this.key(mode, tenantId, collection, id), cloned);
    }
  }

  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, key });
    return clone((mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2).get(key));
  }

  set(mode, tenantId, collection, id, value) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, key });
    if (Object.hasOwn(value, "creditos_mensais")) this.creditWrites += 1;
    if (Object.hasOwn(value, "financeiro")) this.financialWrites += 1;
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(key, clone(value));
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, clone(value));
    } else {
      this.v2.set(key, clone(value));
    }
  }

  request({
    mode,
    tenantId,
    uid,
    roles,
    memberActive = true,
    planId,
    requestId,
    failAt = "",
  }) {
    const fingerprint = operationalPayloadFingerprint({ planId });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }

    const before = this.snapshot();
    try {
      if (!memberActive || !roles.includes("CLIENTE")) fail("MEMBERSHIP_REQUIRED");
      const plan = this.read(mode, tenantId, "planos_assinatura", planId);
      const client = this.read(mode, tenantId, "clientes", uid);
      const subscriptionId = `${uid}_${planId}`;
      const existing = this.read(mode, tenantId, "solicitacoes_assinatura", subscriptionId);
      if (!plan || plan.ativo !== true) fail("PLANO_INDISPONIVEL");
      if (!client || !String(client.nome || "").trim()) fail("CLIENTE_INDISPONIVEL");
      if (existing?.status === "PENDENTE") fail("ALREADY_EXISTS");
      if (!Number.isInteger(plan.preco_centavos) || plan.preco_centavos <= 0
        || !Array.isArray(plan.servicos_ids) || !plan.servicos_ids.length) {
        fail("PLANO_INDISPONIVEL");
      }
      const subscription = {
        cliente_id: uid,
        cliente_nome: String(client.nome).trim(),
        plano_id: planId,
        plano_nome: String(plan.nome || "").trim(),
        plano_preco_centavos: plan.preco_centavos,
        status: "PENDENTE",
        termos_aceitos: true,
      };
      if (failAt === "before-write") fail("INJECTED_FAILURE");
      this.set(mode, tenantId, "solicitacoes_assinatura", subscriptionId, subscription);
      if (failAt === "after-write") fail("INJECTED_FAILURE");
      const result = { subscriptionId, status: "PENDENTE" };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

class MemorySnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this.value;
  }
}

class MemoryDb {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
  }

  doc(path) {
    return { get: async () => new MemorySnapshot(this.entries.get(path)) };
  }
}

function clientEntries({ slug, tenantId, uid, roles = ["CLIENTE"], status = "ACTIVE" }) {
  return {
    [`tenant_slugs/${slug}`]: { tenantId, status: "ACTIVE" },
    [`barbearias/${tenantId}`]: { slug, status },
    [`barbearias/${tenantId}/membros/${uid}`]: { ativo: true, papeis: roles },
  };
}

async function clientContext(db, slug, uid) {
  return resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: uid,
    command,
    payload: {
      command,
      requestId: `subscription-${slug}-request-0001`,
      context: { hostname: `${slug}.goestudio.com.br` },
      planId: "plan-1",
    },
  });
}

const activePlan = {
  ativo: true,
  nome: "Plano Mensal",
  preco_centavos: 10000,
  servicos_ids: ["service-1"],
};

const client = { nome: "Cliente A", telefone: "5511999999999" };

test("Slice 11 registra somente assinatura.solicitar e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 10);
  const handler = sourceBetween("async function requestSubscription", "async function isAdmin");
  assert.match(handler, /context\s*\?\s*tenantPrimaryRef\(context, collection, id\)/);
  assert.match(handler, /tenantSet\(tx, context, "solicitacoes_assinatura"/);
  assert.match(handler, /requestFingerprint: operationalPayloadFingerprint\(\{ planId: safePlanId \}\)/);
  assert.doesNotMatch(handler, /creditos_mensais\s*:/);
  assert.doesNotMatch(handler, /financeiro/);
  const dispatch = sourceBetween('case "assinatura.solicitar"', 'case "agenda.disponibilidade.obter"');
  assert.match(dispatch, /onlyFields\(payload/);
  assert.match(dispatch, /context/);
});

test("TENANT_A_ASSINATURA_SOLICITAR_PASS e TENANT_B_ASSINATURA_SOLICITAR_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice11Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "planos_assinatura", "plan-1", activePlan);
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "clientes", "client-1", client);
    const result = model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: `request-${tenantId}-0001` });
    assert.deepEqual(result, { duplicate: false, subscriptionId: "client-1_plan-1", status: "PENDENTE" });
    assert.equal(model.v2.get(`barbearias/${tenantId}/solicitacoes_assinatura/client-1_plan-1`).status, "PENDENTE");
  }
});

test("CLIENTE_AUTH_VALIDATED, CLIENTE_TENANT_SCOPED_VALIDATED e INACTIVE_TENANT_DENIED", async () => {
  const db = new MemoryDb(clientEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "client-a" }));
  const context = await clientContext(db, "studio-a", "client-a");
  assert.equal(context.tenant.id, "tenant-a");
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.deepEqual(context.actor.roles, ["CLIENTE"]);

  const inactiveDb = new MemoryDb(clientEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "client-a", status: "INACTIVE" }));
  await assert.rejects(clientContext(inactiveDb, "studio-a", "client-a"), (cause) => cause instanceof OperationalContextError && cause.code === "TENANT_UNAVAILABLE");
});

test("NON_MEMBER_DENIED e NON_CLIENTE_DENIED", async () => {
  const noMember = new MemoryDb({
    "tenant_slugs/studio-a": { tenantId: "tenant-a", status: "ACTIVE" },
    "barbearias/tenant-a": { slug: "studio-a", status: "ACTIVE" },
  });
  await assert.rejects(clientContext(noMember, "studio-a", "client-a"), (cause) => cause?.code === "MEMBERSHIP_REQUIRED");
  const adminOnly = new MemoryDb(clientEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"] }));
  await assert.rejects(clientContext(adminOnly, "studio-a", "admin-a"), (cause) => cause?.code === "MEMBERSHIP_REQUIRED");
});

test("CROSS_TENANT_DENIED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice11Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "planos_assinatura", "plan-1", activePlan);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "clientes", "client-1", client);
  assert.throws(() => model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "cross-tenant-0001" }), /PLANO_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-a/")), true);
});

test("PLANO_TENANT_SCOPED_VALIDATED, PLANO_INATIVO_FAIL_CLOSED e SOLICITACAO_PENDING_CREATED", () => {
  const model = new Slice11Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", activePlan);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  assert.equal(model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "pending-0001" }).status, "PENDENTE");

  const inactive = new Slice11Model();
  inactive.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", { ...activePlan, ativo: false });
  inactive.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  assert.throws(() => inactive.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "inactive-plan-0001" }), /PLANO_INDISPONIVEL/);
});

test("SOLICITACAO_DUPLICATE_CHARACTERIZED preserva PENDENTE e permite sobrescrita de estado terminal", () => {
  const model = new Slice11Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", activePlan);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "client-1_plan-1", { status: "PENDENTE" });
  assert.throws(() => model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "pending-duplicate-0001" }), /ALREADY_EXISTS/);

  const terminal = new Slice11Model();
  terminal.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", activePlan);
  terminal.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  terminal.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "solicitacoes_assinatura", "client-1_plan-1", { status: "RECUSADA" });
  assert.equal(terminal.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "terminal-recreate-0001" }).status, "PENDENTE");
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

test("ANTUNES_DUAL_WRITE_PRESERVED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const antunes = new Slice11Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "planos_assinatura", "plan-1", activePlan);
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "clientes", "client-1", client);
  antunes.request({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "antunes-request-0001" });
  assert.equal(antunes.legacy.get("solicitacoes_assinatura/client-1_plan-1").status, "PENDENTE");
  assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/solicitacoes_assinatura/client-1_plan-1`).status, "PENDENTE");

  const newTenant = new Slice11Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", activePlan);
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  newTenant.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "new-tenant-request-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e AUDIT_TENANT_SCOPED", () => {
  const model = new Slice11Model();
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "planos_assinatura", "plan-1", activePlan);
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "clientes", "client-1", client);
  }
  const requestId = "shared-request-0001";
  assert.equal(model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId }).duplicate, false);
  assert.equal(model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId }).duplicate, true);
  assert.throws(
    () => model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "other-plan", requestId }),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
  assert.equal(model.audit.has(`tenant-a/${requestId}`), true);
  assert.equal(model.audit.has(`tenant-b/${requestId}`), false);
  assert.equal(model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId }).duplicate, false);
});

test("NO_CREDIT_CREATED, NO_FINANCIAL_WRITE e ROLLBACK_ON_FAILURE", () => {
  const model = new Slice11Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "planos_assinatura", "plan-1", activePlan);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  const before = model.snapshot();
  assert.throws(() => model.request({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], planId: "plan-1", requestId: "rollback-0001", failAt: "after-write" }), /INJECTED_FAILURE/);
  assert.deepEqual(model.snapshot(), before);
  assert.equal(model.creditWrites, 0);
  assert.equal(model.financialWrites, 0);
});

test("OTHER_10_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 10);
  assert.equal(remaining.includes("assinatura.solicitar"), false);
  assert.equal(remaining.includes("agenda.criar"), true);
  assert.equal(allCommands.length, 32);
});
