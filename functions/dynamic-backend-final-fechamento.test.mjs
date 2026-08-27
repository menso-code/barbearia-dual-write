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
const closures = ["admin.fechamento.salvar", "admin.fechamento.remover"];
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

function dateList(size) {
  return Array.from({ length: size }, (_, index) => {
    const month = String(Math.floor(index / 31) + 1).padStart(2, "0");
    const day = String((index % 31) + 1).padStart(2, "0");
    return `2099-${month}-${day}`;
  });
}

class ClosureModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.audit = new Map();
    this.occupations = new Map([["occupation/appointment", { type: "appointment" }]]);
    this.appointments = new Map([["appointment/1", { status: "agendado" }]]);
    this.blocks = new Map([["block/1", { type: "manual" }]]);
    this.credits = new Map([["credit/1", { remaining: 1 }]]);
    this.financial = new Map([["financial/1", { total: 10 }]]);
    this.io = [];
  }

  snapshot() { return structuredClone(this); }
  restore(snapshot) { Object.assign(this, snapshot); }
  key(tenant, id) { return `barbearias/${tenant}/fechamentos_globais/${id}`; }
  limit(mode) { return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? 200 : 366; }
  validate(ids, mode) {
    const unique = [...new Set(ids)];
    if (!unique.length || unique.length > this.limit(mode) || unique.some((id) => !id)) throw new Error("FECHAMENTO_LIMITE_EXCEDIDO");
    return unique;
  }
  write(mode, tenant, id, value) {
    this.io.push({ type: "write", mode, key: id });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.set(`fechamentos_globais/${id}`, structuredClone(value));
    this.v2.set(this.key(tenant, id), structuredClone(value));
  }
  delete(mode, tenant, id) {
    this.io.push({ type: "write", mode, key: id });
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.delete(`fechamentos_globais/${id}`);
    this.v2.delete(this.key(tenant, id));
  }
  primary(mode, tenant, id) {
    this.io.push({ type: "read", mode, key: id });
    return mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE
      ? this.legacy.get(`fechamentos_globais/${id}`)
      : this.v2.get(this.key(tenant, id));
  }
  run({ operation, mode, tenant, roles = ["ADMIN"], requestId, payload, execute }) {
    if (!roles.includes("ADMIN")) throw new Error("ADMIN_REQUIRED");
    const fingerprint = operationalPayloadFingerprint(payload);
    const auditKey = `${tenant}/${requestId}`;
    const replay = this.audit.get(auditKey);
    if (replay) { assertIdempotentReplay(replay, operation, fingerprint); return { duplicate: true, ...replay.result }; }
    const before = this.snapshot();
    try {
      const result = execute();
      this.audit.set(auditKey, { operation, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) { this.restore(before); throw cause; }
  }
  save({ mode, tenant, dates, requestId, roles, failAt = "" }) {
    const validDates = this.validate(dates, mode);
    return this.run({ operation: "admin.fechamento.salvar", mode, tenant, roles, requestId, payload: { dates: validDates }, execute: () => {
      validDates.forEach((date, index) => {
        this.write(mode, tenant, date, { data: date, fechamento_id: "closure-1", ativo: true });
        if (failAt === "write" && index === 1) throw new Error("INJECTED_FAILURE");
      });
      return { documents: validDates.length };
    } });
  }
  remove({ mode, tenant, ids, requestId, roles, failAt = "" }) {
    const validIds = this.validate(ids, mode);
    return this.run({ operation: "admin.fechamento.remover", mode, tenant, roles, requestId, payload: { ids: validIds }, execute: () => {
      let removed = 0;
      validIds.forEach((id, index) => {
        if (this.primary(mode, tenant, id)) { this.delete(mode, tenant, id); removed += 1; }
        if (failAt === "delete" && index === 1) throw new Error("INJECTED_FAILURE");
      });
      return { removed };
    } });
  }
}

test("ALL_32_COMMANDS_MIGRATED, closure handlers use OperationalContext and no legacy fallback remains", () => {
  assert.equal(allCommands.length, 32);
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS.filter((command) => closures.includes(command)), closures);
  assert.equal(allCommands.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command)).length, 0);
  assert.match(runtime, /MAX_CLOSURE_DATES_ANTUNES = 200/);
  assert.match(runtime, /MAX_CLOSURE_DATES_V2 = 366/);
  assert.match(runtime, /if \(action === "fechamento\.salvar"\)[\s\S]*validateClosureItems[\s\S]*tenantSet\(tx, context, "fechamentos_globais"/);
  assert.match(runtime, /if \(action === "fechamento\.remover"\)[\s\S]*validateClosureItems[\s\S]*tenantPrimaryRef\(context, "fechamentos_globais"[\s\S]*tenantDelete\(tx, context, "fechamentos_globais"/);
  assert.doesNotMatch(runtime.slice(runtime.indexOf("if (TENANT_SCOPED_ADMIN_ACTIONS.has(action))")), /mirror(Set|Delete)\(tx, "fechamentos_globais"/);
});

test("ANTUNES_200 and V2_366 pass; over-limit requests fail before any write", () => {
  const model = new ClosureModel();
  assert.equal(model.save({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", dates: dateList(200), requestId: "antunes-save-200" }).documents, 200);
  assert.equal(model.legacy.size, 200); assert.equal(model.v2.size, 200);
  const beforeAntunes = model.snapshot();
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", dates: dateList(201), requestId: "antunes-save-201" }), /FECHAMENTO_LIMITE_EXCEDIDO/);
  assert.deepEqual(model.snapshot(), beforeAntunes);
  const v2 = new ClosureModel();
  assert.equal(v2.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: dateList(366), requestId: "v2-save-366" }).documents, 366);
  assert.equal(v2.legacy.size, 0); assert.equal(v2.v2.size, 366);
  const beforeV2 = v2.snapshot();
  assert.throws(() => v2.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: dateList(367), requestId: "v2-save-367" }), /FECHAMENTO_LIMITE_EXCEDIDO/);
  assert.deepEqual(v2.snapshot(), beforeV2);
});

test("remove honors both limits, removes only tenant closure documents and rolls back on failure", () => {
  const antunes = new ClosureModel(); const antunesDates = dateList(200);
  antunes.save({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", dates: antunesDates, requestId: "seed-antunes-200" });
  assert.equal(antunes.remove({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", ids: antunesDates, requestId: "antunes-remove-200" }).removed, 200);
  const antunesBefore = antunes.snapshot();
  assert.throws(() => antunes.remove({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenant: "antunes", ids: dateList(201), requestId: "antunes-remove-201" }), /FECHAMENTO_LIMITE_EXCEDIDO/);
  assert.deepEqual(antunes.snapshot(), antunesBefore);
  const v2 = new ClosureModel(); const v2Dates = dateList(366);
  v2.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: v2Dates, requestId: "seed-v2-366" });
  assert.equal(v2.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", ids: v2Dates, requestId: "v2-remove-366" }).removed, 366);
  assert.equal(v2.legacy.size, 0);
  const before = v2.snapshot();
  assert.throws(() => v2.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", ids: dateList(367), requestId: "v2-remove-367" }), /FECHAMENTO_LIMITE_EXCEDIDO/);
  assert.deepEqual(v2.snapshot(), before);
  const rollback = new ClosureModel(); rollback.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: dateList(3), requestId: "seed-rollback" });
  const rollbackBefore = rollback.snapshot();
  assert.throws(() => rollback.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", ids: dateList(3), requestId: "remove-rollback", failAt: "delete" }), /INJECTED_FAILURE/);
  assert.deepEqual(rollback.snapshot(), rollbackBefore);
  for (const field of ["occupations", "appointments", "blocks", "credits", "financial"]) assert.deepEqual(rollback[field], rollbackBefore[field]);
});

test("tenant isolation, admin authorization, idempotency and recursive selector rejection are enforced", () => {
  const model = new ClosureModel();
  model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: ["2099-01-01"], requestId: "shared-request" });
  assert.equal(model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: ["2099-01-01"], requestId: "shared-request" }).duplicate, true);
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: ["2099-01-02"], requestId: "shared-request" }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
  assert.equal(model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", dates: ["2099-01-01"], requestId: "shared-request" }).duplicate, false);
  assert.equal(model.remove({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-b", ids: ["2099-01-01"], requestId: "remove-tenant-b" }).removed, 1);
  assert.ok(model.v2.get(model.key("tenant-a", "2099-01-01")));
  assert.throws(() => model.save({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenant: "tenant-a", dates: ["2099-01-02"], requestId: "non-admin", roles: ["CLIENTE"] }), /ADMIN_REQUIRED/);
  for (const data of [{ tenantId: "tenant-b" }, { nested: { tenant_id: "tenant-b", write_mode: "legacy" } }, { path: "fechamentos_globais/x" }, { writeMode: "legacy" }]) {
    assert.throws(() => validateOperationalEnvelope({ command: "admin.fechamento.salvar", requestId: "selector-test", data }), (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE");
  }
});
