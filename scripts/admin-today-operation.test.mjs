import assert from "node:assert/strict";
import test from "node:test";
import {
  appointmentsForToday,
  buildTodayOperationSummary,
  fittingAppointmentsForToday,
  fittingIsStillValid,
  fittingPrefill,
  LATE_APPOINTMENT_TOLERANCE_MINUTES,
} from "../public/js/admin-today-operation-core.mjs";

const today = "2026-08-25";
const now = new Date("2026-08-25T10:00:00");
const professionals = [
  { id: "barber-1", nome: "Lucas", ativo: true },
  { id: "barber-2", nome: "Rafael", ativo: true },
  { id: "barber-3", nome: "Matheus", ativo: false },
];

test("today metrics include only today's non-cancelled appointments", () => {
  const appointments = [
    { id: "scheduled", data: today, horario: "11:00", status: "agendado" },
    { id: "arrived", data: today, horario: "09:00", status: "cliente_chegou" },
    { id: "serving", data: today, horario: "09:30", status: "em_atendimento" },
    { id: "done", data: today, horario: "08:00", status: "concluido" },
    { id: "no-show", data: today, horario: "07:00", status: "nao_compareceu" },
    { id: "cancelled", data: today, horario: "12:00", status: "cancelado" },
    { id: "yesterday", data: "2026-08-24", horario: "12:00", status: "agendado" },
    { id: "tomorrow", data: "2026-08-26", horario: "12:00", status: "agendado" },
  ];
  assert.equal(appointmentsForToday(appointments, today).length, 5);
  const summary = buildTodayOperationSummary({ appointments, professionals, today, now });
  assert.equal(summary.appointmentsToday.length, 5);
  assert.equal(summary.customersServedToday, 1);
});

test("next appointments show one future agendado per active professional", () => {
  const appointments = [
    { id: "past", barbeiro_id: "barber-1", data: today, horario: "09:00", status: "agendado" },
    { id: "future", barbeiro_id: "barber-1", data: today, horario: "11:00", status: "agendado" },
    { id: "later", barbeiro_id: "barber-1", data: today, horario: "12:00", status: "agendado" },
    { id: "serving", barbeiro_id: "barber-2", data: today, horario: "11:30", status: "em_atendimento" },
    { id: "done", barbeiro_id: "barber-2", data: today, horario: "12:30", status: "concluido" },
    { id: "tomorrow", barbeiro_id: "barber-2", data: "2026-08-26", horario: "11:00", status: "agendado" },
  ];
  const summary = buildTodayOperationSummary({ appointments, professionals, today, now });
  assert.deepEqual(summary.nextAppointments, [
    { barberId: "barber-1", barberName: "Lucas", time: "11:00" },
    { barberId: "barber-2", barberName: "Rafael", time: "—" },
  ]);
});

test("late appointments use one ten-minute threshold and only agendado today", () => {
  assert.equal(LATE_APPOINTMENT_TOLERANCE_MINUTES, 10);
  const appointments = [
    { id: "nine-minutes", data: today, horario: "09:51", status: "agendado" },
    { id: "ten-minutes", data: today, horario: "09:50", status: "agendado" },
    { id: "more-than-ten", data: today, horario: "09:00", status: "agendado" },
    { id: "arrived", data: today, horario: "09:00", status: "cliente_chegou" },
    { id: "serving", data: today, horario: "09:00", status: "em_atendimento" },
    { id: "done", data: today, horario: "09:00", status: "concluido" },
    { id: "cancelled", data: today, horario: "09:00", status: "cancelado" },
    { id: "no-show", data: today, horario: "09:00", status: "nao_compareceu" },
    { id: "yesterday", data: "2026-08-24", horario: "09:00", status: "agendado" },
    { id: "tomorrow", data: "2026-08-26", horario: "09:00", status: "agendado" },
  ];
  const summary = buildTodayOperationSummary({ appointments, professionals, today, now });
  assert.deepEqual(summary.lateAppointments.map((appointment) => appointment.id), [
    "more-than-ten",
    "ten-minutes",
  ]);
});

test("cancelled and no-show appointments expose only future fitting slots", () => {
  const appointments = [
    { id: "cancelled", data: today, horario: "11:00", duracao: 30, barbeiro_id: "barber-1", status: "cancelado" },
    { id: "no-show", data: today, horario: "12:00", duracao: 30, barbeiro_id: "barber-1", status: "nao_compareceu" },
    { id: "yesterday", data: "2026-08-24", horario: "11:00", duracao: 30, barbeiro_id: "barber-1", status: "cancelado" },
    { id: "inactive", data: today, horario: "11:00", duracao: 30, barbeiro_id: "barber-3", status: "cancelado" },
  ];
  const fittings = fittingAppointmentsForToday({
    appointments,
    professionals,
    today,
    now,
    candidateSlots: () => ["11:00", "12:00"],
  });
  assert.deepEqual(fittings.map((fitting) => [fitting.barberName, fitting.time, fitting.origin]), [
    ["Lucas", "11:00", "Cancelamento"],
    ["Lucas", "12:00", "Não compareceu"],
  ]);
});

test("fittings reject passed, occupied, blocked and non-releasable intervals", () => {
  const appointments = [
    { id: "passed", data: today, horario: "09:00", duracao: 30, barbeiro_id: "barber-1", status: "cancelado" },
    { id: "occupied-source", data: today, horario: "12:00", duracao: 30, barbeiro_id: "barber-1", status: "nao_compareceu" },
    { id: "occupied", data: today, horario: "12:00", duracao: 30, barbeiro_id: "barber-1", status: "agendado" },
    { id: "blocked-source", data: today, horario: "13:00", duracao: 30, barbeiro_id: "barber-1", status: "cancelado" },
    { id: "arrived", data: today, horario: "14:00", duracao: 30, barbeiro_id: "barber-1", status: "cliente_chegou" },
    { id: "serving", data: today, horario: "15:00", duracao: 30, barbeiro_id: "barber-1", status: "em_atendimento" },
    { id: "done", data: today, horario: "16:00", duracao: 30, barbeiro_id: "barber-1", status: "concluido" },
  ];
  const fittings = fittingAppointmentsForToday({
    appointments,
    professionals,
    today,
    now,
    candidateSlots: () => ["09:00", "12:00", "13:00", "14:00", "15:00", "16:00"],
    blocks: [{ data: today, inicio: "13:00", duracao: 30, barbeiro_id: "barber-1" }],
  });
  assert.deepEqual(fittings, []);
});

test("fitting prefill contains only barber, today and time", () => {
  assert.deepEqual(fittingPrefill({
    barberId: "barber-1",
    date: today,
    time: "11:00",
    customerId: "must-not-be-prefilled",
    serviceId: "must-not-be-prefilled",
  }), {
    barbeiroId: "barber-1",
    data: today,
    horario: "11:00",
  });
});

test("fitting revalidation rejects a conflict, block, expired slot or inactive barber", () => {
  const fitting = {
    id: "cancelled|barber-1|2026-08-25|11:00",
    barberId: "barber-1",
    date: today,
    time: "11:00",
  };
  const source = { id: "cancelled", data: today, horario: "11:00", duracao: 30, barbeiro_id: "barber-1", status: "cancelado" };
  const base = {
    fitting,
    appointments: [source],
    professionals,
    today,
    candidateSlots: () => ["11:00"],
  };
  assert.equal(fittingIsStillValid({ ...base, now }), true);
  assert.equal(fittingIsStillValid({
    ...base,
    appointments: [source, { id: "new", data: today, horario: "11:00", duracao: 30, barbeiro_id: "barber-1", status: "agendado" }],
  }), false);
  assert.equal(fittingIsStillValid({
    ...base,
    blocks: [{ data: today, inicio: "11:00", duracao: 30, barbeiro_id: "barber-1" }],
  }), false);
  assert.equal(fittingIsStillValid({ ...base, now: new Date("2026-08-25T11:01:00") }), false);
  assert.equal(fittingIsStillValid({
    ...base,
    professionals: [{ id: "barber-1", nome: "Lucas", ativo: false }],
  }), false);
});

test("occupancy remains explicitly blocked when the dashboard dataset is insufficient", () => {
  const summary = buildTodayOperationSummary({ appointments: [], professionals, today, now });
  assert.equal(summary.occupancy.implementation, "BLOCKED_BY_DATA_MODEL");
  assert.equal(summary.occupancy.percentage, null);
});

console.log("admin today operation tests: PASS");
