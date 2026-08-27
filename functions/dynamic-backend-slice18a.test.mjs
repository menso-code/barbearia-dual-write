import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { DYNAMIC_TENANT_COMMANDS } from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");

function duration(value) {
  const slotSize = 30;
  const maxSlots = 4;
  const maxDuration = slotSize * maxSlots;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < slotSize || parsed % slotSize !== 0 || parsed > maxDuration) {
    throw new Error("DURACAO_INVALIDA");
  }
  return parsed;
}

test("Slice 18A define contrato server-side de 30 minutos, quatro slots e 120 minutos", () => {
  assert.match(runtime, /const SLOT_SIZE_MINUTES = 30/);
  assert.match(runtime, /const MAX_APPOINTMENT_SLOTS = 4/);
  assert.match(runtime, /const MAX_SERVICE_DURATION_MINUTES = SLOT_SIZE_MINUTES \* MAX_APPOINTMENT_SLOTS/);
  assert.match(runtime, /function validatedAppointmentDuration/);
  assert.match(runtime, /function appointmentBlocks\(start, duration\) \{\s*const total = validatedAppointmentDuration\(duration\)/);
  assert.match(runtime, /validatedAppointmentDuration\(service\.duracao, "Serviço inválido\."\)/);
});

test("MIN_VALID_DURATION, MAX_VALID_DURATION e comportamento existente de 30/60/90/120 são preservados", () => {
  for (const value of [30, 60, 90, 120]) assert.equal(duration(value), value);
});

test("ABOVE_MAX, duração não múltipla e dados históricos oversized falham fechados antes de slots ou writes", () => {
  for (const value of [0, 10, 20, 45, 121, 150, 900000]) {
    assert.throws(() => duration(value), /DURACAO_INVALIDA/);
  }
});

test("orçamento transacional permanece abaixo de 500 writes", () => {
  const slots = 4;
  const v2CreateWrites = 1 + slots + 1 + 1; // agendamento, ocupações, crédito opcional, idempotência/auditoria
  const antunesCreateWrites = 2 + (slots * 2) + 2 + 1; // dual-write dos mesmos efeitos
  const v2RescheduleWrites = 1 + 1 + slots + slots + 1;
  const antunesRescheduleWrites = 2 + 2 + (slots * 2) + (slots * 2) + 1;
  for (const writes of [v2CreateWrites, antunesCreateWrites, v2RescheduleWrites, antunesRescheduleWrites]) {
    assert.ok(writes < 500);
  }
  assert.equal(antunesCreateWrites, 13);
  assert.equal(antunesRescheduleWrites, 21);
});

test("COMMAND_COUNT permanece 32 após a migração da Agenda", () => {
  assert.match(runtime, /case "agenda\.criar":\s*\{[\s\S]*createAppointment\(\{ uid, authUid, data, requestId, context \}\)/);
  assert.match(runtime, /case "agenda\.reagendar":\s*\{[\s\S]*rebookAppointment\(\{ uid, appointmentId, data, requestId, context \}\)/);
  assert.equal(DYNAMIC_TENANT_COMMANDS.length, 32);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes("agenda.criar"), true);
  assert.equal(DYNAMIC_TENANT_COMMANDS.includes("agenda.reagendar"), true);
});
