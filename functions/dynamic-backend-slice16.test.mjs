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
const selected = ["admin.barbeiro.salvar", "admin.barbeiro.remover"];
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

class BarberModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.io = [];
  }

  snapshot() { return structuredClone({ legacy: this.legacy, v2: this.v2, audit: this.audit, io: this.io }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(tenantId, collection, id) { return `barbearias/${tenantId}/${collection}/${id}`; }
  target(mode) { return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2; }
  read(mode, tenantId, collection, id) {
    this.io.push({ kind: "read", mode, collection });
    return this.target(mode).get(mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : this.key(tenantId, collection, id));
  }
  write(mode, tenantId, collection, id, value) {
    this.io.push({ kind: "write", mode, collection });
    this.target(mode).set(mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : this.key(tenantId, collection, id), structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.set(this.key(tenantId, collection, id), structuredClone(value));
  }
  delete(mode, tenantId, collection, id) {
    this.io.push({ kind: "write", mode, collection });
    this.target(mode).delete(mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? `${collection}/${id}` : this.key(tenantId, collection, id));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.v2.delete(this.key(tenantId, collection, id));
  }
  v2Write(tenantId, collection, id, value) { this.v2.set(this.key(tenantId, collection, id), structuredClone(value)); }
  v2Delete(tenantId, collection, id) { this.v2.delete(this.key(tenantId, collection, id)); }
  v2Read(tenantId, collection, id) { return this.v2.get(this.key(tenantId, collection, id)); }

  save({ mode, tenantId, uid = "admin", roles = ["ADMIN"], requestId, barberId = "barber-1", email = "barber@example.com", barberUid = "barber-uid", failAt = "" }) {
    if (!roles.includes("ADMIN")) throw new Error("ADMIN_REQUIRED");
    const operation = "admin.barbeiro.salvar";
    const fingerprint = operationalPayloadFingerprint({ barberId, email, barberUid });
    const auditKey = `${tenantId}/${requestId}`;
    const replay = this.audit.get(auditKey);
    if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      const emailId = email.toLowerCase();
      const emailIndex = this.v2Read(tenantId, "email_acesso_index", emailId);
      const uidLink = this.v2Read(tenantId, "vinculos_barbeiro", barberUid);
      const member = this.v2Read(tenantId, "membros", barberUid);
      if (emailIndex && emailIndex.barbeiro_id !== barberId) throw new Error("EMAIL_JA_VINCULADO");
      if (uidLink && uidLink.barbeiro_id !== barberId) throw new Error("UID_JA_VINCULADO");
      if (member?.barbeiro_id && member.barbeiro_id !== barberId) throw new Error("UID_JA_VINCULADO");
      this.v2Write(tenantId, "email_acesso_index", emailId, { barbeiro_id: barberId, tenant_id: tenantId });
      this.write(mode, tenantId, "barbeiros", barberId, { nome: "Barber", email_acesso: emailId, uid_usuario: barberUid, ativo: true });
      if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.set(`vinculos_barbeiro/${barberUid}`, { barbeiro_id: barberId });
      this.v2Write(tenantId, "vinculos_barbeiro", barberUid, { barbeiro_id: barberId, tenant_id: tenantId });
      this.v2Write(tenantId, "membros", barberUid, { uid: barberUid, barbeiro_id: barberId, papeis: ["BARBEIRO"], ativo: true });
      if (failAt === "after-links") throw new Error("INJECTED_FAILURE");
      const result = { barberId, created: true };
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }

  remove({ mode, tenantId, uid = "admin", roles = ["ADMIN"], requestId, barberId = "barber-1", failAt = "" }) {
    if (!roles.includes("ADMIN")) throw new Error("ADMIN_REQUIRED");
    const operation = "admin.barbeiro.remover";
    const fingerprint = operationalPayloadFingerprint({ barberId });
    const auditKey = `${tenantId}/${requestId}`;
    const replay = this.audit.get(auditKey);
    if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      const barber = this.read(mode, tenantId, "barbeiros", barberId);
      if (!barber) return { barberId, removed: false };
      this.v2Delete(tenantId, "email_acesso_index", barber.email_acesso);
      this.delete(mode, tenantId, "barbeiros", barberId);
      if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.delete(`vinculos_barbeiro/${barber.uid_usuario}`);
      this.v2Delete(tenantId, "vinculos_barbeiro", barber.uid_usuario);
      this.v2Write(tenantId, "membros", barber.uid_usuario, { uid: barber.uid_usuario, barbeiro_id: "", papeis: [], ativo: false });
      if (failAt === "after-delete") throw new Error("INJECTED_FAILURE");
      const result = { barberId, removed: true };
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
}

test("Slice 16 registers only barber save/remove and uses tenant-scoped index, link and membership helpers", () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => selected.includes(command)), selected);
  assert.equal(allCommands.length, 32);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 5);
  const handlers = sourceBetween('if (action === "barbeiro.salvar")', 'if (action === "abertura.salvar")');
  assert.match(handlers, /await requireContextAdmin\(tx, uid, context\)/);
  assert.match(handlers, /emailAccessIndexPath\(context, barber\.email_acesso\)/);
  assert.match(handlers, /tenantBarberLinkRef\(context, barber\.uid_usuario\)/);
  assert.match(handlers, /tenantMemberRef\(context, barber\.uid_usuario\)/);
  assert.match(handlers, /uid_vinculo_original: originalUidHint/);
  assert.match(handlers, /tenantSet\(tx, context, "barbeiros"/);
  assert.match(handlers, /tenantDelete\(tx, context, "barbeiros"/);
  assert.match(handlers, /context\.mode === OPERATIONAL_CONTEXT_MODES\.ANTUNES_DUAL_WRITE/);
});

test("EMAIL_UNIQUENESS_PER_TENANT, UID_UNIQUENESS_PER_TENANT and cross-tenant isolation", () => {
  const model = new BarberModel();
  model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "save-a", email: "same@example.com", barberUid: "same-uid" });
  assert.doesNotThrow(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", requestId: "save-b", email: "same@example.com", barberUid: "same-uid" }));
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "duplicate-email", barberId: "barber-2", email: "same@example.com", barberUid: "other-uid" }), /EMAIL_JA_VINCULADO/);
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "duplicate-uid", barberId: "barber-2", email: "other@example.com", barberUid: "same-uid" }), /UID_JA_VINCULADO/);
  assert.equal(model.v2Read("tenant-a", "barbeiros", "barber-1").uid_usuario, "same-uid");
  assert.equal(model.v2Read("tenant-b", "barbeiros", "barber-1").uid_usuario, "same-uid");
});

test("ANTUNES_DUAL_WRITE is preserved while V2 tenants have zero legacy I/O", () => {
  const antunes = new BarberModel();
  antunes.save({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, requestId: "save-antunes" });
  assert.ok(antunes.legacy.get("barbeiros/barber-1"));
  assert.ok(antunes.v2Read(ANTUNES_TENANT_ID, "barbeiros", "barber-1"));
  assert.ok(antunes.legacy.get("vinculos_barbeiro/barber-uid"));
  const v2 = new BarberModel();
  v2.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "save-v2" });
  assert.equal(v2.legacy.size, 0);
  assert.ok(v2.v2Read("tenant-a", "email_acesso_index", "barber@example.com"));
  assert.ok(v2.v2Read("tenant-a", "vinculos_barbeiro", "barber-uid"));
  assert.ok(v2.v2Read("tenant-a", "membros", "barber-uid"));
});

test("SAVE_ATOMIC, REMOVE_ATOMIC, replay safety and tenant-scoped request IDs", () => {
  const model = new BarberModel();
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "rollback-save", failAt: "after-links" }), /INJECTED_FAILURE/);
  assert.equal(model.v2.size, 0);
  model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "same-request" });
  assert.equal(model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "same-request" }).duplicate, true);
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "same-request", email: "different@example.com" }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.doesNotThrow(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", requestId: "same-request" }));
  assert.throws(() => model.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "rollback-remove", failAt: "after-delete" }), /INJECTED_FAILURE/);
  assert.ok(model.v2Read("tenant-a", "barbeiros", "barber-1"));
  assert.doesNotThrow(() => model.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", requestId: "remove" }));
  assert.equal(model.v2Read("tenant-a", "barbeiros", "barber-1"), undefined);
  assert.ok(model.v2Read("tenant-b", "barbeiros", "barber-1"));
});

test("ADMIN_AUTH, recursive selector rejection and OTHER_5_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS", () => {
  const model = new BarberModel();
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", roles: ["BARBEIRO"], requestId: "non-admin" }), /ADMIN_REQUIRED/);
  for (const payload of [{ data: { tenantId: "tenant-b" } }, { data: { nested: { tenant_id: "tenant-b", write_mode: "legacy" } } }, { data: { path: "barbeiros/x" } }]) {
    assert.throws(() => validateOperationalEnvelope({ command: "admin.barbeiro.salvar", requestId: "request-1", ...payload }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 5);
});
