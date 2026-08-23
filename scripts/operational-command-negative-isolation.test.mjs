import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

const TENANT_A = "tenant-a";
const TENANT_B = "tenant-b";
const CLIENT = "user-client";
const BARBER_A = "barber-a";
const BARBER_B = "barber-b";
const ADMIN_A = "admin-a";
const EMAIL = "shared@example.test";

function emailKey(tenant, email) {
  const normalized = String(email ?? "").trim().toLowerCase();
  return normalized ? `${tenant}/${createHash("sha256").update(normalized).digest("hex")}` : "";
}

class AccessFixture {
  constructor() {
    this.members = new Map();
    this.resources = new Map();
  }

  member(tenant, uid, roles) {
    this.members.set(`${tenant}/${uid}`, new Set(roles));
  }

  resource(tenant, id, ownerUid) {
    this.resources.set(`${tenant}/${id}`, { tenant, id, ownerUid });
  }

  authorize({ authUid, tenant, role, ownerUid }) {
    if (!authUid) throw new Error("UNAUTHENTICATED");
    const roles = this.members.get(`${tenant}/${authUid}`);
    if (!roles?.has(role)) throw new Error("PERMISSION_DENIED");
    if (ownerUid && role !== "ADMIN" && ownerUid !== authUid) throw new Error("PERMISSION_DENIED");
    return true;
  }

  operateResource({ authUid, tenant, resourceId, role }) {
    const resource = this.resources.get(`${tenant}/${resourceId}`);
    if (!resource) throw new Error("NOT_FOUND");
    this.authorize({ authUid, tenant, role, ownerUid: resource.ownerUid });
    return resource;
  }
}

class AtomicStore {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.occupancyLegacy = new Map();
    this.occupancyV2 = new Map();
    this.emailIndex = new Map();
  }

  snapshot() {
    return structuredClone({
      legacy: this.legacy,
      v2: this.v2,
      occupancyLegacy: this.occupancyLegacy,
      occupancyV2: this.occupancyV2,
      emailIndex: this.emailIndex,
    });
  }

  restore(snapshot) {
    Object.assign(this, snapshot);
  }

  transaction(work, failAt = "") {
    const before = this.snapshot();
    const write = (stage, callback) => {
      if (failAt === stage) throw new Error(`INJECTED_${stage}`);
      callback();
    };
    try {
      return work(write);
    } catch (error) {
      this.restore(before);
      throw error;
    }
  }

  createFixture(tenant, id, email, failAt = "") {
    const index = emailKey(tenant, email);
    return this.transaction((write) => {
      write("legacy", () => this.legacy.set(`${tenant}/${id}`, { tenant, id, status: "ativo" }));
      write("v2", () => this.v2.set(`${tenant}/${id}`, { tenant, id, status: "ativo" }));
      write("occupancy", () => {
        this.occupancyLegacy.set(`${tenant}/${id}`, { tenant, id });
        this.occupancyV2.set(`${tenant}/${id}`, { tenant, id });
      });
      write("index", () => this.emailIndex.set(index, { tenant, barberId: id }));
      return id;
    }, failAt);
  }

  removeFixture(tenant, id, email, failAt = "") {
    const index = emailKey(tenant, email);
    return this.transaction((write) => {
      write("legacy", () => this.legacy.set(`${tenant}/${id}`, { tenant, id, status: "cancelado" }));
      write("v2", () => this.v2.set(`${tenant}/${id}`, { tenant, id, status: "cancelado" }));
      write("occupancy", () => {
        this.occupancyLegacy.delete(`${tenant}/${id}`);
        this.occupancyV2.delete(`${tenant}/${id}`);
      });
      write("index", () => this.emailIndex.delete(index));
      return id;
    }, failAt);
  }
}

class AgendaModel {
  constructor() {
    this.appointments = new Map();
    this.operations = new Map();
  }

  add({ tenant, id, status, ownerUid, barberUid }) {
    this.appointments.set(`${tenant}/${id}`, { tenant, id, status, ownerUid, barberUid });
  }

  transition({ authUid, tenant, id, action, requestId }) {
    const previous = this.operations.get(requestId);
    if (previous) return { duplicate: true, ...previous };
    const appointment = this.appointments.get(`${tenant}/${id}`);
    if (!appointment) throw new Error("NOT_FOUND");
    const active = new Set(["agendado", "cliente_chegou", "em_atendimento"]);
    if (!active.has(appointment.status)) throw new Error("FAILED_PRECONDITION");
    const isAdmin = authUid === ADMIN_A && tenant === TENANT_A;
    const isBarber = authUid === appointment.barberUid;
    const isClient = authUid === appointment.ownerUid;
    if (["cliente_chegou", "em_atendimento", "concluir", "nao_compareceu"].includes(action) && !isAdmin && !isBarber) {
      throw new Error("PERMISSION_DENIED");
    }
    if (action === "cancelar" && !isAdmin && !isBarber && !isClient) throw new Error("PERMISSION_DENIED");
    const expected = { cliente_chegou: "agendado", em_atendimento: "cliente_chegou" }[action];
    if (expected && appointment.status !== expected) throw new Error("FAILED_PRECONDITION");
    const next = action === "concluir" ? "concluido" : action === "cancelar" ? "cancelado" : action === "nao_compareceu" ? "nao_compareceu" : action;
    appointment.status = next;
    const result = { appointmentId: id, status: next };
    this.operations.set(requestId, result);
    return { duplicate: false, ...result };
  }
}

test("mesmo cliente pode existir em A/B, mas papéis não atravessam tenants", () => {
  const fixture = new AccessFixture();
  fixture.member(TENANT_A, CLIENT, ["CLIENTE"]);
  fixture.member(TENANT_B, CLIENT, ["CLIENTE"]);
  fixture.member(TENANT_A, BARBER_A, ["BARBEIRO"]);
  fixture.member(TENANT_B, BARBER_A, ["CLIENTE"]);
  fixture.member(TENANT_A, ADMIN_A, ["ADMIN"]);
  fixture.member(TENANT_B, ADMIN_A, ["CLIENTE"]);
  fixture.resource(TENANT_A, "resource-a", BARBER_A);
  fixture.resource(TENANT_B, "resource-b", BARBER_B);

  assert.doesNotThrow(() => fixture.authorize({ authUid: CLIENT, tenant: TENANT_A, role: "CLIENTE" }));
  assert.doesNotThrow(() => fixture.authorize({ authUid: CLIENT, tenant: TENANT_B, role: "CLIENTE" }));
  assert.throws(() => fixture.authorize({ authUid: BARBER_A, tenant: TENANT_B, role: "BARBEIRO" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.authorize({ authUid: ADMIN_A, tenant: TENANT_B, role: "ADMIN" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.operateResource({ authUid: BARBER_A, tenant: TENANT_B, resourceId: "resource-b", role: "BARBEIRO" }), /PERMISSION_DENIED/);
});

test("mesmo email em tenants diferentes usa índices independentes", () => {
  assert.notEqual(emailKey(TENANT_A, EMAIL), emailKey(TENANT_B, EMAIL));
  assert.equal(emailKey(TENANT_A, " Shared@Example.Test "), emailKey(TENANT_A, EMAIL));
});

test("negativas de autenticação e papel não atravessam a fronteira", () => {
  const fixture = new AccessFixture();
  fixture.member(TENANT_A, CLIENT, ["CLIENTE"]);
  fixture.member(TENANT_A, BARBER_A, ["BARBEIRO"]);
  fixture.member(TENANT_A, ADMIN_A, ["ADMIN"]);
  fixture.resource(TENANT_A, "client-resource", CLIENT);
  fixture.resource(TENANT_A, "barber-resource", BARBER_A);

  assert.throws(() => fixture.authorize({ authUid: "", tenant: TENANT_A, role: "CLIENTE" }), /UNAUTHENTICATED/);
  assert.throws(() => fixture.authorize({ authUid: CLIENT, tenant: TENANT_A, role: "BARBEIRO" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.authorize({ authUid: BARBER_A, tenant: TENANT_A, role: "ADMIN" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.operateResource({ authUid: CLIENT, tenant: TENANT_A, resourceId: "barber-resource", role: "CLIENTE" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.operateResource({ authUid: BARBER_A, tenant: TENANT_A, resourceId: "client-resource", role: "BARBEIRO" }), /PERMISSION_DENIED/);
  assert.throws(() => fixture.authorize({ authUid: "missing", tenant: TENANT_A, role: "CLIENTE" }), /PERMISSION_DENIED/);
});

test("agenda aceita transições válidas, rejeita inválidas e mantém replay idempotente", () => {
  const agenda = new AgendaModel();
  agenda.add({ tenant: TENANT_A, id: "appointment-a", status: "agendado", ownerUid: CLIENT, barberUid: BARBER_A });
  assert.equal(agenda.transition({ authUid: BARBER_A, tenant: TENANT_A, id: "appointment-a", action: "cliente_chegou", requestId: "request-1" }).status, "cliente_chegou");
  assert.equal(agenda.transition({ authUid: BARBER_A, tenant: TENANT_A, id: "appointment-a", action: "em_atendimento", requestId: "request-2" }).status, "em_atendimento");
  assert.equal(agenda.transition({ authUid: BARBER_A, tenant: TENANT_A, id: "appointment-a", action: "concluir", requestId: "request-3" }).status, "concluido");
  assert.throws(() => agenda.transition({ authUid: BARBER_A, tenant: TENANT_A, id: "appointment-a", action: "cancelar", requestId: "request-4" }), /FAILED_PRECONDITION/);
  assert.throws(() => agenda.transition({ authUid: BARBER_A, tenant: TENANT_A, id: "missing", action: "cancelar", requestId: "request-5" }), /NOT_FOUND/);

  const replayAgenda = new AgendaModel();
  replayAgenda.add({ tenant: TENANT_A, id: "appointment-b", status: "agendado", ownerUid: CLIENT, barberUid: BARBER_A });
  const first = replayAgenda.transition({ authUid: CLIENT, tenant: TENANT_A, id: "appointment-b", action: "cancelar", requestId: "same-request" });
  const second = replayAgenda.transition({ authUid: CLIENT, tenant: TENANT_A, id: "appointment-b", action: "cancelar", requestId: "same-request" });
  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.appointmentId, first.appointmentId);
});

test("agenda impede operação cross-tenant", () => {
  const agenda = new AgendaModel();
  agenda.add({ tenant: TENANT_A, id: "appointment-a", status: "agendado", ownerUid: CLIENT, barberUid: BARBER_A });
  assert.throws(() => agenda.transition({ authUid: BARBER_A, tenant: TENANT_B, id: "appointment-a", action: "cancelar", requestId: "cross-tenant" }), /NOT_FOUND/);
});

test("falhas em qualquer etapa de criação fazem rollback integral Legado/V2/ocupação/índice", () => {
  for (const failAt of ["legacy", "v2", "occupancy", "index"]) {
    const store = new AtomicStore();
    assert.throws(() => store.createFixture(TENANT_A, `barber-${failAt}`, EMAIL, failAt), /INJECTED_/);
    assert.equal(store.legacy.size, 0);
    assert.equal(store.v2.size, 0);
    assert.equal(store.occupancyLegacy.size, 0);
    assert.equal(store.occupancyV2.size, 0);
    assert.equal(store.emailIndex.size, 0);
  }
});

test("falhas em qualquer etapa de remoção preservam o estado anterior sem órfãos", () => {
  for (const failAt of ["legacy", "v2", "occupancy", "index"]) {
    const store = new AtomicStore();
    store.createFixture(TENANT_A, "barber-remove", EMAIL);
    const before = store.snapshot();
    assert.throws(() => store.removeFixture(TENANT_A, "barber-remove", EMAIL, failAt), /INJECTED_/);
    assert.deepEqual(store.snapshot(), before);
  }

  const store = new AtomicStore();
  store.createFixture(TENANT_A, "barber-remove-ok", EMAIL);
  store.removeFixture(TENANT_A, "barber-remove-ok", EMAIL);
  assert.equal(store.legacy.get(`${TENANT_A}/barber-remove-ok`).status, "cancelado");
  assert.equal(store.v2.get(`${TENANT_A}/barber-remove-ok`).status, "cancelado");
  assert.equal(store.occupancyLegacy.size, 0);
  assert.equal(store.occupancyV2.size, 0);
  assert.equal(store.emailIndex.size, 0);
});
