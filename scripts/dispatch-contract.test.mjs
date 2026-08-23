import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { extractCommandData, extractRebookCommand, requireAppointmentId } from "../functions/dual-write.js";

const appointmentId = "appointment-123";
const transitionCommands = [
  "agenda.cancelar",
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
  "agenda.concluir",
  "agenda.nao_compareceu",
];

for (const command of transitionCommands) {
  const data = extractCommandData({ command, requestId: "regression-request-001", data: { appointmentId } });
  assert.equal(requireAppointmentId(data), appointmentId, `${command} deve usar data.appointmentId`);
}

assert.equal(requireAppointmentId(extractCommandData({ data: { appointmentId } })), appointmentId);
assert.throws(() => requireAppointmentId(extractCommandData({ data: {} })), /appointmentId obrigatório/);
assert.throws(() => requireAppointmentId(extractCommandData({ data: { appointmentId: "" } })), /appointmentId obrigatório/);
assert.throws(() => requireAppointmentId(extractCommandData({ data: { appointmentId: null } })), /appointmentId obrigatório/);
assert.throws(() => extractCommandData({}), /Dados inválidos|invalid-argument/);
assert.equal(requireAppointmentId(extractCommandData({ data: { appointmentId, data: { extra: true } } })), appointmentId);

const rebookPayload = {
  command: "agenda.reagendar",
  requestId: "rebook-contract-001",
  appointmentId,
  data: { servico_id: "service-1", data: "2026-09-01", horario: "09:00" },
};
const extractedRebook = extractRebookCommand(rebookPayload);
assert.equal(extractedRebook.appointmentId, appointmentId);
assert.deepEqual(extractedRebook.data, rebookPayload.data);
assert.throws(() => extractRebookCommand({ ...rebookPayload, appointmentId: undefined }), /appointmentId obrigatório/);
assert.throws(() => extractRebookCommand({ ...rebookPayload, appointmentId: undefined, data: { ...rebookPayload.data, appointmentId } }), /appointmentId obrigatório/);
assert.throws(() => extractRebookCommand({ ...rebookPayload, data: { ...rebookPayload.data, appointmentId } }), /Campo não permitido/);
assert.throws(() => extractRebookCommand({ ...rebookPayload, data: { ...rebookPayload.data, inesperado: true } }), /Campo não permitido/);

const hmlAgenda = await readFile(new URL("../public-hml/js/agenda.js", import.meta.url), "utf8");
const productionAgenda = await readFile(new URL("../public/js/agenda.js", import.meta.url), "utf8");
assert.match(hmlAgenda, /agenda\.reagendar", \{ appointmentId: agendamento\.id, data: dados \}/, "frontend HML deve usar appointmentId externo");
for (const command of ["cancelar", "concluir", "nao_compareceu"]) {
  assert.match(hmlAgenda, new RegExp(`agenda\\.${command}", \\{ data: \\{ appointmentId: agendamento\\.id \\} \\}`));
}
assert.match(productionAgenda, /agenda\.reagendar", \{ appointmentId: agendamento\.id, data: dados \}/, "frontend de produção deve usar appointmentId externo");
assert.doesNotMatch(productionAgenda, /agenda\.reagendar", \{ data: \{ \.\.\.dados, appointmentId: agendamento\.id \} \}/, "frontend de produção não pode usar appointmentId dentro de data");

console.log("dispatch contract self-test: PASS");
