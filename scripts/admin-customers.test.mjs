import assert from "node:assert/strict";
import {
  buildCustomerRecords,
  filterCustomerRecords,
  normalizeSearch,
  statusLabel,
} from "../public/js/admin-customers-core.mjs";

const now = new Date("2026-08-25T12:00:00");
const records = buildCustomerRecords({
  now,
  clients: [
    { id: "alice", data: { nome: "Álice Silva", telefone: "(11) 98888-0000" } },
    { id: "bob", data: { nome: "Bruno Lima" } },
    { id: "carol", data: { nome: "Carol Souza" } },
    { id: "duplicate-name-a", data: { nome: "Cliente Repetido", telefone: "11999990000" } },
    { id: "duplicate-name-b", data: { nome: "Cliente Repetido", telefone: "11999990000" } },
  ],
  appointments: [
    { id: "old", cliente_id: "alice", data: "2026-08-20", horario: "10:00", status: "concluido", servico_nome: "Corte" },
    { id: "next", cliente_id: "alice", data: "2026-08-26", horario: "14:00", status: "agendado" },
    { id: "cancelled", cliente_id: "alice", data: "2026-08-24", horario: "09:00", status: "cancelado" },
    { id: "no-show", cliente_id: "alice", data: "2026-08-23", horario: "11:00", status: "nao_compareceu" },
    { id: "legacy", cliente_id: "alice", data: "2026-08-24", horario: "18:00", status: "legacy_unresolved" },
    { id: "carol-scheduled", cliente_id: "carol", data: "2026-08-24", horario: "12:00", status: "agendado" },
    { id: "carol-cancelled", cliente_id: "carol", data: "2026-08-22", horario: "12:00", status: "cancelado" },
    { id: "carol-no-show", cliente_id: "carol", data: "2026-08-21", horario: "12:00", status: "nao_compareceu" },
    { id: "carol-legacy", cliente_id: "carol", data: "2026-08-20", horario: "12:00", status: "legacy_unresolved" },
    { id: "duplicate-a-appointment", cliente_id: "duplicate-name-a", data: "2026-08-24", horario: "12:00", status: "concluido" },
    { id: "duplicate-b-appointment", cliente_id: "duplicate-name-b", data: "2026-08-24", horario: "13:00", status: "cancelado" },
  ],
  subscriptions: [
    { id: "sub-alice", cliente_id: "alice", status: "ATIVA", plano_nome: "Prime", vencimento_em: new Date("2026-09-01T12:00:00") },
    { id: "sub-bob", cliente_id: "bob", status: "PENDENTE", plano_nome: "Essencial" },
  ],
});

assert.equal(records.length, 5, "clientes sem agendamento também devem aparecer");
const alice = records.find((item) => item.id === "alice");
const bob = records.find((item) => item.id === "bob");
const carol = records.find((item) => item.id === "carol");
assert.equal(alice.name, "Álice Silva");
assert.equal(alice.totalAppointments, 5);
assert.equal(alice.lastAppointment.id, "old");
assert.equal(alice.nextAppointment.id, "next");
assert.equal(alice.noShowCount, 1);
assert.equal(alice.cancellationCount, 1);
assert.equal(alice.subscription.status, "ATIVA");
assert.equal(alice.subscription.planName, "Prime");
assert.equal(bob.totalAppointments, 0);
assert.equal(bob.subscription.status, "PENDENTE");
assert.equal(carol.lastAppointment, null, "sem concluído não há último atendimento");
assert.equal(alice.appointments.find((item) => item.id === "legacy").status, "legacy_unresolved");
const duplicateA = records.find((item) => item.id === "duplicate-name-a");
const duplicateB = records.find((item) => item.id === "duplicate-name-b");
assert.notEqual(duplicateA, duplicateB, "nomes e telefones duplicados não podem misturar clientes");
assert.equal(duplicateA.totalAppointments, 1);
assert.equal(duplicateB.totalAppointments, 1);
assert.equal(duplicateA.lastAppointment.id, "duplicate-a-appointment");
assert.equal(duplicateB.cancellationCount, 1);

assert.equal(normalizeSearch("Álice  Silva"), "alice silva");
assert.equal(filterCustomerRecords(records, { search: "alice" }).length, 1);
assert.equal(filterCustomerRecords(records, { search: "988880000" }).length, 1);
assert.equal(filterCustomerRecords(records, { filter: "future" }).length, 1);
assert.equal(filterCustomerRecords(records, { filter: "subscription" }).length, 2);
assert.equal(statusLabel("nao_compareceu"), "Não compareceu");
assert.equal(statusLabel("legacy_unresolved"), "Status não definido");

console.log("admin customers core tests: PASS");
