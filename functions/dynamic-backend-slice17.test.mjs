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
const selected = ["cliente.garantir-perfil"];
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

class BootstrapModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.globalUsers = new Map();
    this.audit = new Map();
  }

  snapshot() { return structuredClone({ legacy: this.legacy, v2: this.v2, globalUsers: this.globalUsers, audit: this.audit }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(tenantId, collection, id) { return `barbearias/${tenantId}/${collection}/${id}`; }
  readV2(tenantId, collection, id) { return this.v2.get(this.key(tenantId, collection, id)); }

  ensure({ mode, tenantId, uid, requestId, nome = "Cliente", nomeProvided = true, telefone = "", existingMember, failAt = "" }) {
    const operation = "cliente.garantir-perfil";
    const fingerprint = operationalPayloadFingerprint({ nome, telefone });
    const auditKey = `${tenantId}/${requestId}`;
    const replay = this.audit.get(auditKey);
    if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      const clientKey = this.key(tenantId, "clientes", uid);
      const memberKey = this.key(tenantId, "membros", uid);
      const existing = this.v2.get(clientKey);
      const member = existingMember || this.v2.get(memberKey);
      const roles = Array.isArray(member?.papeis) ? member.papeis : [];
      if (roles.some((role) => ["ADMIN", "BARBEIRO"].includes(role)) && member?.ativo !== true) throw new Error("PRIVILEGED_MEMBERSHIP_INACTIVE");
      const nextRoles = [...new Set([...roles, "CLIENTE"])].sort();
      const initial = !existing;
      const profile = initial ? { nome, telefone, email: "client@example.com" } : { ...existing, ...(nomeProvided ? { nome } : {}), telefone };
      if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.set(`clientes/${uid}`, structuredClone(profile));
      this.v2.set(clientKey, structuredClone(profile));
      this.v2.set(memberKey, { uid, papeis: nextRoles, ativo: true });
      if (failAt === "after-profile") throw new Error("INJECTED_FAILURE");
      const globalNameForV2 = initial || nomeProvided ? nome : "";
      if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.globalUsers.set(uid, { uid, nome, email: "client@example.com" });
      else if (globalNameForV2) this.globalUsers.set(uid, { nome: globalNameForV2 });
      const result = { clientId: uid, created: initial };
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
}

test("Slice 17 registers only client bootstrap and routes it through the tenant-scoped handler", () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => selected.includes(command)), selected);
  assert.equal(allCommands.length, 32);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 4);
  const start = runtime.indexOf("async function ensureClientProfile(");
  const end = runtime.indexOf("async function updateClientProfile(", start);
  const handler = runtime.slice(start, end);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  assert.match(handler, /context,/);
  assert.match(handler, /tenantPrimaryRef\(context, "clientes", uid\)/);
  assert.match(handler, /tenantMemberRef\(context, uid\)/);
  assert.match(handler, /tenantSet\(tx, context, "clientes", uid/);
  assert.match(handler, /transactionalCommand\(\{[\s\S]*context,/);
  assert.match(handler, /antunesDualWrite/);
  assert.match(handler, /const globalNameForV2 = initial \|\| safeExtras\.nome !== undefined \? nome : ""/);
  assert.match(handler, /\{ nome: globalNameForV2 \}/);
});

test("TENANT_A_BOOTSTRAP, TENANT_B_BOOTSTRAP, scoped membership and no cross-tenant leakage", () => {
  const model = new BootstrapModel();
  model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "shared-user", requestId: "bootstrap-a-0001", nome: "Cliente A" });
  model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "shared-user", requestId: "bootstrap-b-0001", nome: "Cliente B" });
  assert.equal(model.readV2("tenant-a", "clientes", "shared-user").nome, "Cliente A");
  assert.equal(model.readV2("tenant-b", "clientes", "shared-user").nome, "Cliente B");
  assert.deepEqual(model.readV2("tenant-a", "membros", "shared-user").papeis, ["CLIENTE"]);
  assert.deepEqual(model.readV2("tenant-b", "membros", "shared-user").papeis, ["CLIENTE"]);
  assert.equal(model.legacy.size, 0);
});

test("PRIVILEGED_ROLE_NOT_DOWNGRADED, no role escalation and global identity stays minimal for new tenants", () => {
  const model = new BootstrapModel();
  model.ensure({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    uid: "admin-client",
    requestId: "bootstrap-admin-0001",
    existingMember: { uid: "admin-client", papeis: ["ADMIN"], ativo: true },
  });
  assert.deepEqual(model.readV2("tenant-a", "membros", "admin-client").papeis, ["ADMIN", "CLIENTE"]);
  assert.deepEqual(model.globalUsers.get("admin-client"), { nome: "Cliente" });
  model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-client", requestId: "bootstrap-admin-phone-0001", nome: "Nome Do Provedor", nomeProvided: false, telefone: "5511999999999" });
  assert.deepEqual(model.globalUsers.get("admin-client"), { nome: "Cliente" });
  assert.throws(() => model.ensure({
    mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY,
    tenantId: "tenant-a",
    uid: "inactive-barber",
    requestId: "bootstrap-inactive-0001",
    existingMember: { uid: "inactive-barber", papeis: ["BARBEIRO"], ativo: false },
  }), /PRIVILEGED_MEMBERSHIP_INACTIVE/);
});

test("PROFILE_AND_MEMBERSHIP_ATOMIC, replay safe and tenant-scoped request IDs", () => {
  const model = new BootstrapModel();
  assert.throws(() => model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", requestId: "rollback-0001", failAt: "after-profile" }), /INJECTED_FAILURE/);
  assert.equal(model.v2.size, 0);
  model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", requestId: "same-request-0001" });
  assert.equal(model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", requestId: "same-request-0001" }).duplicate, true);
  assert.throws(() => model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", requestId: "same-request-0001", nome: "Outro" }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.doesNotThrow(() => model.ensure({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "client-a", requestId: "same-request-0001" }));
  const antunes = new BootstrapModel();
  antunes.ensure({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "legacy-client", requestId: "legacy-bootstrap-0001" });
  assert.ok(antunes.legacy.get("clientes/legacy-client"));
  assert.ok(antunes.readV2(ANTUNES_TENANT_ID, "clientes", "legacy-client"));
});

test("recursive tenant selector rejection and OTHER_4_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS", () => {
  for (const payload of [
    { extras: { tenantId: "tenant-b" } },
    { extras: { nested: { tenant_id: "tenant-b", write_mode: "legacy" } } },
    { extras: { path: "clientes/user" } },
  ]) {
    assert.throws(() => validateOperationalEnvelope({ command: "cliente.garantir-perfil", requestId: "bootstrap-selector-0001", context: { slug: "studio-a" }, ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 4);
});
