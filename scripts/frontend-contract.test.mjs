import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const agenda = await read("public/js/agenda.js");
const admin = await read("public/js/admin.js");
const barber = await read("public/js/barber.js");

assert.match(agenda, /agenda\.cancelar", \{ data: \{ appointmentId: agendamento\.id \} \}/);
assert.match(agenda, /agenda\.concluir", \{ data: \{ appointmentId: agendamento\.id \} \}/);
assert.match(agenda, /agenda\.nao_compareceu", \{ data: \{ appointmentId: agendamento\.id \} \}/);
assert.match(agenda, /agenda\.reagendar", \{ appointmentId: agendamento\.id, data: dados \}/);
assert.doesNotMatch(agenda, /agenda\.reagendar", \{ data: \{ \.\.\.dados, appointmentId: agendamento\.id \} \}/);
assert.match(agenda, /agenda\.reagendar", \{ appointmentId: agendamento\.id, data: dados \}/, "campos opcionais permanecem no objeto data recebido");
assert.match(admin, /agenda\.\$\{status\}.*data: \{ appointmentId: agendamento\.id \}/s);
assert.match(barber, /agenda\.\$\{status\}.*data: \{ appointmentId: item\.id \}/s);
assert.match(agenda, /agenda\.criar", \{ data: dados \}/);
assert.doesNotMatch(agenda, /agenda\.(?:cancelar|concluir|nao_compareceu)", \{\s*appointmentId:/);
assert.doesNotMatch(admin, /agenda\.\$\{status\}`, \{\s*appointmentId:/);
assert.doesNotMatch(barber, /agenda\.\$\{status\}`, \{\s*appointmentId:/);

console.log("frontend contract self-test: PASS");
