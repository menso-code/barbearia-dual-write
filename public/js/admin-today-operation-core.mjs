const TODAY_APPOINTMENT_STATUSES = Object.freeze([
  "agendado",
  "cliente_chegou",
  "em_atendimento",
  "concluido",
  "nao_compareceu",
]);

const NEXT_APPOINTMENT_STATUSES = Object.freeze(["agendado"]);
export const LATE_APPOINTMENT_TOLERANCE_MINUTES = 10;
export const FITTING_SOURCE_STATUSES = Object.freeze(["cancelado", "nao_compareceu"]);

function statusOf(appointment) {
  return String(appointment?.status || "").toLowerCase();
}

export function appointmentDateTime(appointment) {
  const date = String(appointment?.data || "");
  const time = String(appointment?.horario || "00:00").slice(0, 5);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  const value = new Date(`${date}T${time}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

export function appointmentsForToday(appointments = [], today) {
  return appointments.filter((appointment) =>
    appointment?.data === today
    && statusOf(appointment) !== "cancelado"
    && TODAY_APPOINTMENT_STATUSES.includes(statusOf(appointment)),
  );
}

export function nextAppointmentsByProfessional(
  appointments = [],
  professionals = [],
  now = new Date(),
) {
  return professionals
    .filter((professional) => professional?.ativo !== false)
    .map((professional) => {
      const appointment = appointments
        .filter((item) =>
          item?.barbeiro_id === professional.id
          && NEXT_APPOINTMENT_STATUSES.includes(statusOf(item)),
        )
        .filter((item) => {
          const scheduledAt = appointmentDateTime(item);
          return scheduledAt && scheduledAt.getTime() > now.getTime();
        })
        .sort((a, b) => appointmentDateTime(a).getTime() - appointmentDateTime(b).getTime())[0];

      return {
        barberId: professional.id,
        barberName: professional.nome || professional.name || "Sem nome",
        time: appointment?.horario?.slice(0, 5) || "—",
      };
    });
}

export function lateAppointmentsForToday(
  appointments = [],
  today,
  now = new Date(),
) {
  const cutoff = now.getTime() - LATE_APPOINTMENT_TOLERANCE_MINUTES * 60 * 1000;
  return appointments
    .filter((appointment) => {
      if (appointment?.data !== today || statusOf(appointment) !== "agendado") return false;
      const scheduledAt = appointmentDateTime(appointment);
      return scheduledAt && scheduledAt.getTime() <= cutoff;
    })
    .sort((left, right) => appointmentDateTime(left).getTime() - appointmentDateTime(right).getTime());
}

export function lateDurationMinutes(appointment, now = new Date()) {
  const scheduledAt = appointmentDateTime(appointment);
  if (!scheduledAt) return 0;
  return Math.max(0, Math.floor((now.getTime() - scheduledAt.getTime()) / 60000));
}

function timeValue(date, time) {
  const value = new Date(`${date}T${String(time || "00:00").slice(0, 5)}`);
  return Number.isNaN(value.getTime()) ? null : value;
}

function intervalsOverlap(leftStart, leftEnd, rightStart, rightEnd) {
  return leftStart < rightEnd && leftEnd > rightStart;
}

function intervalFor(item, date, defaultDuration = 30) {
  const start = timeValue(date, item?.horario || item?.inicio);
  const duration = Number(item?.duracao || defaultDuration);
  if (!start || !Number.isFinite(duration) || duration <= 0) return null;
  return {
    start,
    end: new Date(start.getTime() + duration * 60000),
  };
}

function fittingCandidateIsFree({
  appointment,
  candidateStart,
  candidateEnd,
  appointments,
  blocks,
  today,
}) {
  const hasAppointmentConflict = appointments.some((item) => {
    if (item?.id === appointment.id || item?.data !== today || item?.barbeiro_id !== appointment.barbeiro_id) return false;
    if (FITTING_SOURCE_STATUSES.includes(statusOf(item))) return false;
    const interval = intervalFor(item, today);
    return interval && intervalsOverlap(candidateStart, candidateEnd, interval.start, interval.end);
  });
  if (hasAppointmentConflict) return false;

  return !blocks.some((block) => {
    if (block?.data !== today || block?.barbeiro_id !== appointment.barbeiro_id) return false;
    const interval = intervalFor(block, today);
    return interval && intervalsOverlap(candidateStart, candidateEnd, interval.start, interval.end);
  });
}

export function fittingAppointmentsForToday({
  appointments = [],
  professionals = [],
  today,
  now = new Date(),
  candidateSlots = () => [],
  blocks = [],
} = {}) {
  const activeProfessionals = new Map(
    professionals
      .filter((professional) => professional?.ativo !== false)
      .map((professional) => [professional.id, professional]),
  );
  const fittings = [];
  const usedSlots = new Set();

  appointments
    .filter((appointment) => appointment?.data === today && FITTING_SOURCE_STATUSES.includes(statusOf(appointment)))
    .forEach((appointment) => {
      const professional = activeProfessionals.get(appointment.barbeiro_id);
      const duration = Number(appointment.duracao);
      const originalInterval = intervalFor(appointment, today, 0);
      if (!professional || !Number.isFinite(duration) || duration <= 0 || !originalInterval) return;

      candidateSlots(professional, duration).some((slot) => {
        const candidateInterval = intervalFor({ horario: slot, duracao: duration }, today, 0);
        if (!candidateInterval || candidateInterval.start <= now || candidateInterval.start < originalInterval.start || candidateInterval.end > originalInterval.end) return false;
        const slotKey = `${appointment.barbeiro_id}|${today}|${String(slot).slice(0, 5)}`;
        if (usedSlots.has(slotKey) || !fittingCandidateIsFree({
          appointment,
          candidateStart: candidateInterval.start,
          candidateEnd: candidateInterval.end,
          appointments,
          blocks,
          today,
        })) return false;

        usedSlots.add(slotKey);
        fittings.push({
          id: `${appointment.id}|${slotKey}`,
          appointmentId: appointment.id,
          barberId: appointment.barbeiro_id,
          barberName: professional.nome || professional.name || appointment.barbeiro_nome || "Sem nome",
          date: today,
          time: String(slot).slice(0, 5),
          duration,
          origin: statusOf(appointment) === "cancelado" ? "Cancelamento" : "Não compareceu",
        });
        return true;
      });
    });

  return fittings.sort((left, right) => `${left.time}|${left.barberName}`.localeCompare(`${right.time}|${right.barberName}`));
}

export function fittingPrefill(fitting) {
  return {
    barbeiroId: fitting?.barberId || "",
    data: fitting?.date || "",
    horario: fitting?.time || "",
  };
}

export function fittingIsStillValid({
  fitting,
  appointments = [],
  professionals = [],
  today,
  now = new Date(),
  candidateSlots = () => [],
  blocks = [],
} = {}) {
  if (!fitting) return false;
  return fittingAppointmentsForToday({
    appointments,
    professionals,
    today,
    now,
    candidateSlots,
    blocks,
  }).some((candidate) => candidate.id === fitting.id);
}

export function buildTodayOperationSummary({
  appointments = [],
  professionals = [],
  today,
  now = new Date(),
  candidateSlots,
  blocks = [],
} = {}) {
  const appointmentsToday = appointmentsForToday(appointments, today);
  return {
    appointmentsToday,
    customersServedToday: appointmentsToday.filter(
      (appointment) => statusOf(appointment) === "concluido",
    ).length,
    nextAppointments: nextAppointmentsByProfessional(
      appointmentsToday,
      professionals,
      now,
    ),
    lateAppointments: lateAppointmentsForToday(appointments, today, now),
    fittings: fittingAppointmentsForToday({
      appointments,
      professionals,
      today,
      now,
      candidateSlots,
      blocks,
    }),
    occupancy: {
      implementation: "BLOCKED_BY_DATA_MODEL",
      percentage: null,
    },
  };
}
