export const TERMINAL_APPOINTMENT_STATUSES = Object.freeze([
  "concluido",
  "cancelado",
  "nao_compareceu",
]);

export const NON_TERMINAL_APPOINTMENT_STATUSES = Object.freeze([
  "agendado",
  "cliente_chegou",
  "em_atendimento",
]);

// Uses the browser's local timezone, matching the existing Agenda comparison
// model. No timezone is hardcoded into the pending rule.
export function appointmentDateTime(appointment) {
  const date = String(appointment?.data || "");
  const time = String(appointment?.horario || "00:00").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function isPendingAppointment(appointment, now = new Date()) {
  if (!NON_TERMINAL_APPOINTMENT_STATUSES.includes(appointment?.status)) return false;
  const scheduledAt = appointmentDateTime(appointment);
  return Boolean(scheduledAt && scheduledAt.getTime() < now.getTime());
}

export function pendingDurationLabel(appointment, now = new Date()) {
  const scheduledAt = appointmentDateTime(appointment);
  if (!scheduledAt) return "Horário não informado";
  const totalMinutes = Math.max(0, Math.floor((now.getTime() - scheduledAt.getTime()) / 60000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days) return `Pendente há ${days}d${hours ? ` ${hours}h` : ""}`;
  if (hours) return `Pendente há ${hours}h${minutes ? ` ${minutes}min` : ""}`;
  return `Pendente há ${minutes}min`;
}

export const PENDING_STATUS_LABELS = Object.freeze({
  agendado: "Agendado",
  cliente_chegou: "Cliente chegou",
  em_atendimento: "Em atendimento",
});
