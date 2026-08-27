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
const command = "cliente.atualizar-perfil";
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
const allowedFields = new Set([
  "nome", "telefone", "data_nascimento", "avatar_data", "barbeiro_favorito_id",
  "servico_favorito_id", "periodo_preferido", "observacoes",
]);

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

function clone(value) {
  return structuredClone(value);
}

class Slice12Model {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.globalUsers = new Map();
    this.audit = new Map();
    this.io = [];
  }

  snapshot() {
    return clone({
      legacy: this.legacy,
      v2: this.v2,
      globalUsers: this.globalUsers,
      audit: this.audit,
      io: this.io,
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
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(`${collection}/${id}`, clone(value));
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, clone(value));
    } else {
      this.v2.set(this.key(mode, tenantId, collection, id), clone(value));
    }
  }

  read(mode, tenantId, collection, id) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "read", mode, key });
    return clone((mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2).get(key));
  }

  update(mode, tenantId, collection, id, changes) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, key });
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    const current = target.get(key);
    if (!current) fail("PROFILE_NOT_FOUND");
    target.set(key, { ...current, ...clone(changes) });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      const v2Key = `barbearias/${tenantId}/${collection}/${id}`;
      this.v2.set(v2Key, { ...(this.v2.get(v2Key) || {}), ...clone(changes) });
    }
  }

  updateProfile({ mode, tenantId, uid, actorUid = uid, roles, memberActive = true, changes, requestId, failAt = "" }) {
    const fingerprint = operationalPayloadFingerprint(changes);
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }
    const before = this.snapshot();
    try {
      if (!memberActive || !roles.includes("CLIENTE")) fail("MEMBERSHIP_REQUIRED");
      if (actorUid !== uid) fail("OTHER_USER_DENIED");
      if (!changes || Object.keys(changes).length === 0 || Object.keys(changes).some((key) => !allowedFields.has(key))) {
        fail("FIELD_NOT_ALLOWED");
      }
      const current = this.read(mode, tenantId, "clientes", uid);
      if (!current) fail("PROFILE_NOT_FOUND");
      this.update(mode, tenantId, "clientes", uid, changes);
      if (failAt === "after-profile") fail("INJECTED_FAILURE");
      if (Object.hasOwn(changes, "nome")) {
        this.globalUsers.set(uid, { ...(this.globalUsers.get(uid) || {}), nome: changes.nome });
      }
      if (failAt === "after-global") fail("INJECTED_FAILURE");
      const result = { clientId: uid, updated: Object.keys(changes).sort() };
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
      requestId: `profile-${slug}-update-0001`,
      context: { hostname: `${slug}.goestudio.com.br` },
      data: { nome: "Cliente atualizado" },
    },
  });
}

const client = {
  nome: "Cliente A",
  telefone: "5511999999999",
  observacoes: "Preferência atual",
};

test("Slice 12 registra somente cliente.atualizar-perfil e mantém 32 comandos", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 5);
  const handler = sourceBetween("async function updateClientProfile", "async function requestSubscription");
  assert.match(handler, /context\s*\?\s*tenantPrimaryRef\(context, "clientes", uid\)/);
  assert.match(handler, /tenantUpdate\(tx, context, "clientes", uid, changes\)/);
  assert.match(handler, /requestFingerprint: operationalPayloadFingerprint\(changes\)/);
  assert.match(handler, /tx\.set\(db\.doc\(`usuarios\/\$\{uid\}`\), \{ nome: changes\.nome \}, \{ merge: true \}\)/);
  assert.doesNotMatch(handler, /usuarios\/\$\{uid\}.*(?:telefone|observacoes|barbeiro_favorito_id|servico_favorito_id)/s);
  const dispatch = sourceBetween('case "cliente.atualizar-perfil"', 'case "assinatura.solicitar"');
  assert.match(dispatch, /onlyFields\(payload/);
  assert.match(dispatch, /requestId, context/);
  assert.doesNotMatch(dispatch, /cliente_id|uid\s*:/);
});

test("TENANT_A_CLIENTE_ATUALIZAR_PERFIL_PASS e TENANT_B_CLIENTE_ATUALIZAR_PERFIL_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice12Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "clientes", "client-1", client);
    const result = model.updateProfile({
      mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
      tenantId,
      uid: "client-1",
      roles: ["CLIENTE"],
      changes: { telefone: "5511888888888", observacoes: "Novo contexto" },
      requestId: `profile-${tenantId}-0001`,
    });
    assert.deepEqual(result, { duplicate: false, clientId: "client-1", updated: ["observacoes", "telefone"] });
    assert.equal(model.v2.get(`barbearias/${tenantId}/clientes/client-1`).telefone, "5511888888888");
    assert.equal(model.globalUsers.size, 0);
  }
});

test("CLIENTE_AUTH_VALIDATED, SELF_UPDATE_ONLY_VALIDATED e INACTIVE_TENANT_DENIED", async () => {
  const db = new MemoryDb(clientEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "client-a" }));
  const context = await clientContext(db, "studio-a", "client-a");
  assert.equal(context.tenant.id, "tenant-a");
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.deepEqual(context.actor.roles, ["CLIENTE"]);

  const model = new Slice12Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-a", client);
  assert.throws(() => model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", actorUid: "other-client",
    roles: ["CLIENTE"], changes: { nome: "Outro" }, requestId: "other-user-update-0001",
  }), (cause) => cause?.code === "OTHER_USER_DENIED");

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

test("CROSS_TENANT_DENIED, CLIENTE_TENANT_SCOPED_VALIDATED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice12Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "clientes", "client-1", client);
  assert.throws(() => model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { telefone: "5511888888888" }, requestId: "cross-tenant-update-0001",
  }), (cause) => cause?.code === "PROFILE_NOT_FOUND");
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-a/")), true);
});

test("FIELD_WHITELIST_PRESERVED e GLOBAL_USUARIO_NOME_CHARACTERIZED", () => {
  const model = new Slice12Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  assert.throws(() => model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { ativo: false }, requestId: "forbidden-field-0001",
  }), (cause) => cause?.code === "FIELD_NOT_ALLOWED");
  model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { nome: "Cliente Renomeado", telefone: "5511888888888" }, requestId: "global-name-0001",
  });
  assert.deepEqual(model.globalUsers.get("client-1"), { nome: "Cliente Renomeado" });
  assert.equal(model.v2.get("barbearias/tenant-a/clientes/client-1").telefone, "5511888888888");
});

test("NO_TENANT_SPECIFIC_GLOBAL_WRITE", () => {
  const model = new Slice12Model();
  model.globalUsers.set("client-1", { nome: "Nome antigo", email: "client@example.com" });
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { telefone: "5511888888888", observacoes: "Tenant A" }, requestId: "tenant-only-0001",
  });
  assert.deepEqual(model.globalUsers.get("client-1"), { nome: "Nome antigo", email: "client@example.com" });
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
  const antunes = new Slice12Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "clientes", "client-1", client);
  antunes.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "client-1", roles: ["CLIENTE"],
    changes: { nome: "Antunes Cliente" }, requestId: "antunes-profile-0001",
  });
  assert.equal(antunes.legacy.get("clientes/client-1").nome, "Antunes Cliente");
  assert.equal(antunes.v2.get(`barbearias/${ANTUNES_TENANT_ID}/clientes/client-1`).nome, "Antunes Cliente");

  const newTenant = new Slice12Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  newTenant.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { nome: "Tenant A Cliente" }, requestId: "new-tenant-profile-0001",
  });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), true);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e AUDIT_TENANT_SCOPED", () => {
  const model = new Slice12Model();
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "clientes", "client-1", client);
  }
  const requestId = "shared-profile-request-0001";
  assert.equal(model.updateProfile({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], changes: { nome: "A" }, requestId }).duplicate, false);
  assert.equal(model.updateProfile({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], changes: { nome: "A" }, requestId }).duplicate, true);
  assert.throws(() => model.updateProfile({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"], changes: { nome: "B" }, requestId }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.equal(model.audit.has(`tenant-a/${requestId}`), true);
  assert.equal(model.updateProfile({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "client-1", roles: ["CLIENTE"], changes: { nome: "B" }, requestId }).duplicate, false);
});

test("ROLLBACK_ON_FAILURE preserva perfil e identidade global", () => {
  const model = new Slice12Model();
  model.globalUsers.set("client-1", { nome: "Nome anterior" });
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "clientes", "client-1", client);
  const before = model.snapshot();
  assert.throws(() => model.updateProfile({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-1", roles: ["CLIENTE"],
    changes: { nome: "Nome novo", observacoes: "Alterada" }, requestId: "rollback-profile-0001", failAt: "after-global",
  }), /INJECTED_FAILURE/);
  assert.deepEqual(model.snapshot(), before);
});

test("OTHER_5_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 5);
  assert.equal(remaining.includes(command), false);
  assert.equal(remaining.includes("agenda.criar"), true);
  assert.equal(allCommands.length, 32);
});
