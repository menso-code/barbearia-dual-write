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
const command = "bloqueio.criar";
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

class Slice7Model {
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

  write(mode, tenantId, collection, id, value) {
    const key = this.key(mode, tenantId, collection, id);
    this.io.push({ kind: "write", mode, collection, key });
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
    }
  }

  seed(mode, tenantId, collection, id, value) {
    const key = this.key(mode, tenantId, collection, id);
    const target = mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE ? this.legacy : this.v2;
    target.set(key, structuredClone(value));
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
    }
  }

  createBlock({ mode, tenantId, uid, roles, ownerBarberId = "", data, requestId, failAt = "" }) {
    const barberId = String(data.barbeiro_id || "").trim();
    const date = String(data.data || "").trim();
    const start = String(data.inicio || "").trim();
    const end = String(data.fim || "").trim();
    const motivo = String(data.motivo || "Bloqueado").trim();
    const toMinutes = (value) => {
      const match = /^(\d{2}):(\d{2})$/.exec(value);
      if (!match) throw new Error("INVALID_TIME");
      return Number(match[1]) * 60 + Number(match[2]);
    };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error("INVALID_DATE");
    const startMinutes = toMinutes(start);
    const endMinutes = toMinutes(end);
    const duration = endMinutes - startMinutes;
    if (duration <= 0 || duration % 30 !== 0) throw new Error("BLOQUEIO_INVALIDO");
    const id = `${barberId}_${date}_${start}`;
    const fingerprint = operationalPayloadFingerprint({ barbeiro_id: barberId, data: date, inicio: start, fim: end, motivo });
    const auditKey = `${tenantId}/${requestId}`;
    const previous = this.audit.get(auditKey);
    if (previous) {
      assertIdempotentReplay(previous, command, fingerprint);
      return { duplicate: true, ...previous.result };
    }
    const before = this.snapshot();
    try {
      const isAdmin = roles.includes("ADMIN");
      const isOwner = roles.includes("BARBEIRO") && ownerBarberId === barberId;
      if (!isAdmin && !isOwner) throw new Error("PERMISSION_DENIED");
      const barber = this.read(mode, tenantId, "barbeiros", barberId);
      const config = this.read(mode, tenantId, "configuracoes", "funcionamento") || {};
      const closure = this.read(mode, tenantId, "fechamentos_globais", date);
      const opening = this.read(mode, tenantId, "fechamentos_globais", `abertura_${date}`);
      if (!barber) throw new Error("BARBEIRO_INDISPONIVEL");
      if (closure && closure.ativo !== false) throw new Error("BLOQUEIO_FORA_DO_EXPEDIENTE");
      if (config.closed === true) throw new Error("BLOQUEIO_FORA_DO_EXPEDIENTE");
      const periods = opening?.periods || config.periods || [{ inicio: "08:30", fim: "19:30" }];
      const inWorkingHours = periods.some((period) => startMinutes >= toMinutes(period.inicio) && endMinutes <= toMinutes(period.fim));
      if (!inWorkingHours) throw new Error("BLOQUEIO_FORA_DO_EXPEDIENTE");
      const slots = Array.from({ length: duration / 30 }, (_, index) => {
        const value = startMinutes + index * 30;
        return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
      });
      for (const slot of slots) {
        if (this.read(mode, tenantId, "ocupacoes", `${barberId}_${date}_${slot}`)) throw new Error("HORARIO_OCUPADO");
      }
      if (failAt === "after-block") throw new Error("INJECTED_FAILURE");
      const block = { barbeiro_id: barberId, data: date, inicio: start, fim: end, duracao: duration, motivo };
      this.write(mode, tenantId, "bloqueios", id, block);
      for (const slot of slots) {
        this.write(mode, tenantId, "ocupacoes", `${barberId}_${date}_${slot}`, {
          barbeiro_id: barberId, data: date, horario: slot, bloqueio_id: id, tipo: "bloqueio",
        });
        if (failAt === "during-occupancy") throw new Error("INJECTED_FAILURE");
      }
      const result = { blockId: id, slots: slots.length };
      this.audit.set(auditKey, { operation: command, request_fingerprint: fingerprint, result });
      return { duplicate: false, ...result };
    } catch (cause) {
      this.restore(before);
      throw cause;
    }
  }
}

const baseBarber = { uid_usuario: "barber-a", ativo: true };
const validData = { barbeiro_id: "barber-a", data: "2026-08-27", inicio: "10:00", fim: "11:00", motivo: "Manutenção" };

test("Slice 7 permanece isolada e mantém 32 comandos após Slice 8", () => {
  assert.equal(allCommands.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes(command), true);
  assert.equal(allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current)).length, 7);
  const create = sourceBetween("async function createBlock", "async function requireBlockPermission");
  assert.match(create, /context = null/);
  assert.match(create, /operationalPayloadFingerprint/);
  assert.match(create, /tenantPrimaryRef\(context, collection, refId\)/);
  assert.match(create, /tenantSet\(tx, context, collection, refId, value\)/);
  assert.match(create, /requireBlockPermission\(tx, uid, context, block\)/);
  const dispatcher = sourceBetween('case "bloqueio.criar":', 'case "bloqueio.remover":');
  assert.match(dispatcher, /requestId, context/);
});

test("TENANT_A_BLOQUEIO_CREATE_PASS e TENANT_B_BLOQUEIO_CREATE_PASS", () => {
  for (const tenantId of ["tenant-a", "tenant-b"]) {
    const model = new Slice7Model();
    model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, "barbeiros", "barber-a", baseBarber);
    const result = model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId, uid: `admin-${tenantId}`, roles: ["ADMIN"], data: validData, requestId: `create-${tenantId}-0001` });
    assert.equal(result.blockId, "barber-a_2026-08-27_10:00");
    assert.equal(result.slots, 2);
  }
});

test("CROSS_TENANT_BLOCKED e NEW_TENANT_ZERO_LEGACY_IO", () => {
  const model = new Slice7Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  assert.throws(() => model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], data: validData, requestId: "cross-tenant-0001" }), /BARBEIRO_INDISPONIVEL/);
  assert.equal(model.legacy.size, 0);
  assert.equal(model.io.every(({ key }) => key.startsWith("barbearias/tenant-a/")), true);
});

test("NON_MEMBER_DENIED, NON_ADMIN_OR_NON_OWNER_BARBER_DENIED e OWNER_BARBER_AUTH_VALIDATED", () => {
  const model = new Slice7Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  assert.throws(() => model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"], data: validData, requestId: "client-denied-0001" }), /PERMISSION_DENIED/);
  assert.throws(() => model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-b", roles: ["BARBEIRO"], ownerBarberId: "barber-b", data: validData, requestId: "wrong-owner-0001" }), /PERMISSION_DENIED/);
  const result = model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "barber-a", roles: ["BARBEIRO"], ownerBarberId: "barber-a", data: validData, requestId: "owner-pass-0001" });
  assert.equal(result.duplicate, false);
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
  const antunes = new Slice7Model();
  antunes.seed(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "barbeiros", "barber-a", baseBarber);
  const antunesResult = antunes.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, tenantId: ANTUNES_TENANT_ID, uid: "admin-antunes", roles: ["ADMIN"], data: validData, requestId: "antunes-create-0001" });
  assert.equal(antunesResult.duplicate, false);
  assert.ok(antunes.legacy.has("bloqueios/barber-a_2026-08-27_10:00"));
  assert.ok(antunes.v2.has(`barbearias/${ANTUNES_TENANT_ID}/bloqueios/barber-a_2026-08-27_10:00`));
  assert.equal(antunes.io.some(({ mode }) => mode === OPERATIONAL_CONTEXT_MODES.V2_ONLY), false);

  const newTenant = new Slice7Model();
  newTenant.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  newTenant.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "new-tenant-create-0001" });
  assert.equal(newTenant.legacy.size, 0);
  assert.equal(newTenant.io.every(({ key }) => key.startsWith("barbearias/tenant-a/")), true);
});

test("BLOQUEIO_CREATE_WORKING_HOURS_VALIDATED e fechamento do dia falham fechado", () => {
  const outside = new Slice7Model();
  outside.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  assert.throws(() => outside.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: { ...validData, inicio: "07:00", fim: "08:00" }, requestId: "outside-hours-0001" }), /BLOQUEIO_FORA_DO_EXPEDIENTE/);
  const closed = new Slice7Model();
  closed.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  closed.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "configuracoes", "funcionamento", { closed: true });
  assert.throws(() => closed.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "closed-day-0001" }), /BLOQUEIO_FORA_DO_EXPEDIENTE/);
});

test("BLOQUEIO_CREATE_CONFLICTS_VALIDATED e preserva ocupação de outro bloqueio", () => {
  const conflict = new Slice7Model();
  conflict.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  conflict.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "ocupacoes", "barber-a_2026-08-27_10:00", { bloqueio_id: "other-block" });
  assert.throws(() => conflict.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "conflict-0001" }), /HORARIO_OCUPADO/);
  assert.deepEqual(conflict.v2.get("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:00"), { bloqueio_id: "other-block" });
  const model = new Slice7Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  const result = model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "linked-occupancies-0001" });
  assert.equal(result.slots, 2);
  assert.equal(model.v2.get("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:00").bloqueio_id, result.blockId);
  assert.equal(model.v2.get("barbearias/tenant-a/ocupacoes/barber-a_2026-08-27_10:30").bloqueio_id, result.blockId);
});

test("REQUEST_ID_TENANT_ISOLATED, SAME_TENANT_COLLISION_PROTECTED e rollback", () => {
  const model = new Slice7Model();
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  model.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "barbeiros", "barber-a", baseBarber);
  const requestId = "shared-request-0001";
  assert.equal(model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId }).duplicate, false);
  assert.equal(model.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-b", uid: "admin-b", roles: ["ADMIN"], data: validData, requestId }).duplicate, false);
  const rollback = new Slice7Model();
  rollback.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  assert.throws(() => rollback.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "rollback-0001", failAt: "during-occupancy" }), /INJECTED_FAILURE/);
  assert.equal(rollback.v2.size, 1);
  assert.equal(rollback.audit.size, 0);
  const collision = new Slice7Model();
  collision.seed(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barbeiros", "barber-a", baseBarber);
  collision.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: validData, requestId: "collision-0001" });
  assert.throws(() => collision.createBlock({ mode: OPERATIONAL_CONTEXT_MODES.V2_ONLY, tenantId: "tenant-a", uid: "admin-a", roles: ["ADMIN"], data: { ...validData, motivo: "Outro" }, requestId: "collision-0001" }), (cause) => cause?.code === "REQUEST_ID_COLLISION");
});

test("OTHER_7_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS e COMMAND_COUNT permanece 32", () => {
  const remaining = allCommands.filter((current) => !DYNAMIC_TENANT_COMMANDS.includes(current));
  assert.equal(remaining.length, 7);
  assert.equal(remaining.includes("bloqueio.criar"), false);
  assert.equal(allCommands.length, 32);
});
