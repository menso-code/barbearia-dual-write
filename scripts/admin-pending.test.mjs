import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  isPendingAppointment,
  pendingDurationLabel,
} from "../public/js/admin-pending-core.mjs";

const appointment = (data, horario, status) => ({
  id: "appointment-test",
  data,
  horario,
  status,
});

test("past non-terminal appointment is pending", () => {
  assert.equal(isPendingAppointment(appointment("2026-08-20", "09:00", "agendado"), new Date("2026-08-25T10:00:00")), true);
  assert.equal(isPendingAppointment(appointment("2026-08-20", "09:00", "cliente_chegou"), new Date("2026-08-25T10:00:00")), true);
  assert.equal(isPendingAppointment(appointment("2026-08-20", "09:00", "em_atendimento"), new Date("2026-08-25T10:00:00")), true);
});

test("future non-terminal appointment is not pending", () => {
  assert.equal(isPendingAppointment(appointment("2026-08-25", "17:00", "agendado"), new Date("2026-08-25T16:30:00")), false);
});

test("terminal appointments are not pending", () => {
  for (const status of ["concluido", "cancelado", "nao_compareceu"]) {
    assert.equal(isPendingAppointment(appointment("2026-08-20", "09:00", status), new Date("2026-08-25T10:00:00")), false, status);
  }
});

test("date comparison handles day, month and year boundaries", () => {
  const now = new Date("2027-01-01T00:05:00");
  assert.equal(isPendingAppointment(appointment("2026-12-31", "23:59", "agendado"), now), true);
  assert.equal(isPendingAppointment(appointment("2027-01-01", "00:10", "agendado"), now), false);
});

test("the project timezone model is browser-local and not hardcoded", () => {
  assert.equal(isPendingAppointment(appointment("2026-08-25", "10:00", "agendado"), new Date("2026-08-25T09:59:00")), false);
  assert.equal(isPendingAppointment(appointment("2026-08-25", "10:00", "agendado"), new Date("2026-08-25T10:01:00")), true);
});

test("pending duration is human-readable", () => {
  assert.equal(pendingDurationLabel(appointment("2026-08-25", "08:00", "agendado"), new Date("2026-08-25T10:30:00")), "Pendente há 2h 30min");
  assert.equal(pendingDurationLabel(appointment("2026-08-20", "08:00", "agendado"), new Date("2026-08-25T10:00:00")), "Pendente há 5d 2h");
});

test("pending UI reuses existing action bridge and does not add commands or reads", async () => {
  const pending = await readFile(new URL("../public/js/admin-pending.js", import.meta.url), "utf8");
  assert.match(pending, /admin:pending-action/);
  assert.doesNotMatch(pending, /executeOperationalCommand|firestore|Firestore|getDocs|getDoc|collection\(/);
  assert.doesNotMatch(pending, /window\.(confirm|alert|prompt)\s*\(/);
});

test("pending contract is wired into the existing agenda render event", async () => {
  const admin = await readFile(new URL("../public/js/admin.js", import.meta.url), "utf8");
  const html = await readFile(new URL("../public/admin.html", import.meta.url), "utf8");
  assert.match(admin, /allAppointments/);
  assert.match(admin, /actionsByAppointment/);
  assert.match(admin, /admin:pending-action/);
  assert.match(html, /data-view="pendencias"/);
  assert.match(html, /id="view-pendencias"/);
});
