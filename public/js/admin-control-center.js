import { dataLocalHoje, horariosCandidatos } from "./agenda.js";
import {
  buildTodayOperationSummary,
  fittingIsStillValid,
  fittingPrefill,
  lateDurationMinutes,
  LATE_APPOINTMENT_TOLERANCE_MINUTES,
} from "./admin-today-operation-core.mjs";

const currentDate = document.querySelector("[data-admin-current-date]");
const sidebar = document.getElementById("admin-sidebar");
const sidebarToggle = document.querySelector(".admin-sidebar-toggle");
const sidebarItems = document.querySelectorAll(".admin-sidebar [data-view]");

function formatCurrentDate(date = new Date()) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "short",
    day: "2-digit",
    month: "short",
  }).format(date);
}

if (currentDate) currentDate.textContent = formatCurrentDate();

sidebarToggle?.addEventListener("click", () => {
  const open = sidebar?.classList.toggle("is-open") || false;
  sidebarToggle.setAttribute("aria-expanded", String(open));
});

sidebarItems.forEach((button) => {
  button.addEventListener("click", () => {
    sidebar?.classList.remove("is-open");
    sidebarToggle?.setAttribute("aria-expanded", "false");
  });
});

function syncSidebarState(targetView) {
  sidebarItems.forEach((item) => {
    const active = item.dataset.view === targetView;
    item.classList.toggle("active", active);
    if (active) item.setAttribute("aria-current", "page");
    else item.removeAttribute("aria-current");
  });
}

document.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-view]");
  if (!button) return;
  syncSidebarState(button.dataset.view);
});

// Values are populated only when an existing screen already provides them.
const professionalsLimit = document.getElementById("limite-barbeiros");
const appointmentsKpi = document.querySelector('[data-kpi="appointments"]');
const clientsKpi = document.querySelector('[data-kpi="clients"]');
const fittingsKpi = document.querySelector('[data-kpi="fittings"]');
const nextKpi = document.querySelector('[data-kpi="next"]');
const professionalsKpi = document.querySelector('[data-kpi="professionals"]');
const appointmentsKpiState = document.querySelector('[data-kpi-state="appointments"]');
const clientsKpiState = document.querySelector('[data-kpi-state="clients"]');
const fittingsKpiState = document.querySelector('[data-kpi-state="fittings"]');
const fittingsCount = document.getElementById("admin-fitting-count");
const nextKpiState = document.querySelector('[data-kpi-state="next"]');
const fittingsAction = document.getElementById("overview-fittings-action");
const fittingsList = document.getElementById("admin-fittings-list");
const fittingsSummaryCount = document.getElementById("admin-fittings-summary-count");
const fittingsFeedback = document.getElementById("admin-fittings-feedback");
const lateAlert = document.getElementById("overview-late-alert");
const lateAlertTitle = document.getElementById("overview-late-alert-title");
const lateAlertDescription = document.getElementById("overview-late-alert-description");
const lateAlertAction = document.getElementById("overview-late-alert-action");
const latePanel = document.getElementById("overview-late-panel");
const latePanelClose = document.getElementById("overview-late-panel-close");
const lateList = document.getElementById("overview-late-list");

let todayAppointmentsSource = [];
let todayProfessionals = [];
let todayBlocks = [];
let todayActionsById = new Map();
let latePanelOpen = false;

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function mergeTodayAppointments(incoming) {
  const byId = new Map(todayAppointmentsSource.map((appointment) => [appointment.id, appointment]));
  incoming.forEach((appointment) => {
    if (appointment?.id) byId.set(appointment.id, appointment);
  });
  todayAppointmentsSource = [...byId.values()];
}

function lateDurationLabel(appointment, now) {
  const minutes = lateDurationMinutes(appointment, now);
  if (minutes < 60) return `${minutes} min de atraso`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder ? `${hours}h ${remainder}min de atraso` : `${hours}h de atraso`;
}

function availableLateActions(appointment) {
  const actions = todayActionsById.get(appointment.id)
    || window.adminAgendaActionDefinitions?.(appointment)
    || [];
  return actions.filter((action) => [
    "data-chegada-agendamento",
    "data-falta-agendamento",
  ].includes(action.attribute));
}

function renderLateList(appointments, now) {
  if (!lateList) return;
  lateList.innerHTML = "";
  appointments.forEach((appointment) => {
    const item = document.createElement("article");
    item.className = "late-appointment-item";
    item.dataset.appointmentId = appointment.id;

    const details = document.createElement("div");
    details.className = "late-appointment-details";
    const time = document.createElement("strong");
    time.textContent = appointment.horario || "—";
    const client = document.createElement("span");
    client.textContent = appointment.cliente_nome || "Cliente sem nome";
    const barber = document.createElement("span");
    barber.textContent = appointment.barbeiro_nome || "Profissional não informado";
    const delay = document.createElement("small");
    delay.className = "late-appointment-delay";
    delay.textContent = lateDurationLabel(appointment, now);
    details.append(time, client, barber, delay);

    const actions = document.createElement("div");
    actions.className = "late-appointment-actions";
    availableLateActions(appointment).forEach((action) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = action.attribute === "data-falta-agendamento"
        ? "btn btn-danger btn-sm"
        : "btn btn-primary btn-sm";
      button.textContent = action.attribute === "data-chegada-agendamento"
        ? "Cliente chegou"
        : "Não compareceu";
      button.addEventListener("click", () => {
        window.dispatchEvent(new CustomEvent("admin:pending-action", {
          detail: { appointment, action, button },
        }));
      });
      actions.appendChild(button);
    });

    item.append(details, actions);
    lateList.appendChild(item);
  });
}

function renderLateAlert(summary, now) {
  const appointments = summary.lateAppointments;
  if (!lateAlert) return;

  lateAlert.hidden = appointments.length === 0;
  if (!appointments.length) {
    latePanelOpen = false;
    if (latePanel) latePanel.hidden = true;
    if (lateList) lateList.innerHTML = "";
    return;
  }

  if (lateAlertTitle) {
    lateAlertTitle.textContent = `${appointments.length} ${appointments.length === 1 ? "cliente em atraso" : "clientes em atraso"} hoje`;
  }
  if (lateAlertDescription) {
    lateAlertDescription.textContent = `Existem atendimentos agendados há pelo menos ${LATE_APPOINTMENT_TOLERANCE_MINUTES} minutos que ainda não tiveram chegada registrada.`;
  }
  renderLateList(appointments, now);
  if (latePanel) latePanel.hidden = !latePanelOpen;
}

function renderFittingsList(fittings) {
  if (!fittingsList) return;
  fittingsList.innerHTML = "";
  if (!fittings.length) {
    const empty = document.createElement("p");
    empty.className = "fittings-empty";
    empty.textContent = "Nenhum encaixe disponível hoje.";
    fittingsList.appendChild(empty);
    return;
  }
  fittings.forEach((fitting) => {
    const item = document.createElement("article");
    item.className = "fitting-workspace-item";
    item.dataset.fittingId = fitting.id;
    const time = document.createElement("strong");
    time.textContent = fitting.time;
    const barber = document.createElement("span");
    barber.textContent = fitting.barberName;
    const duration = document.createElement("span");
    duration.textContent = `${fitting.duration} min úteis`;
    const origin = document.createElement("small");
    origin.textContent = `Origem: ${fitting.origin}`;
    const action = document.createElement("button");
    action.type = "button";
    action.className = "btn btn-primary btn-sm fitting-book-action";
    action.textContent = "AGENDAR ENCAIXE";
    action.addEventListener("click", () => openFitting(fitting));
    item.append(time, barber, duration, origin, action);
    fittingsList.appendChild(item);
  });
}

function renderFittingsPanel(fittings) {
  const hasFittings = fittings.length > 0;
  if (fittingsAction) fittingsAction.hidden = !hasFittings;
  if (fittingsCount) {
    fittingsCount.textContent = `(${fittings.length})`;
    fittingsCount.setAttribute("aria-label", `${fittings.length} encaixes`);
  }
  if (fittingsSummaryCount) {
    fittingsSummaryCount.textContent = fittings.length
      ? `${fittings.length} ${fittings.length === 1 ? "encaixe disponível" : "encaixes disponíveis"}`
      : "Nenhum encaixe disponível";
  }
  renderFittingsList(fittings);
}

async function openFitting(fitting) {
  const today = dataLocalHoje();
  const now = new Date();
  const candidateSlots = (professional, duration) => horariosCandidatos(professional, today, duration);
  const stillValid = fittingIsStillValid({
    fitting,
    appointments: todayAppointmentsSource,
    professionals: todayProfessionals,
    today,
    now,
    candidateSlots,
    blocks: todayBlocks,
  });
  if (!stillValid) {
    if (fittingsFeedback) fittingsFeedback.textContent = "Este encaixe não está mais disponível.";
    renderTodayOperation();
    return;
  }

  const prefill = fittingPrefill(fitting);
  if (typeof window.adminOpenNewAppointment !== "function") {
    if (fittingsFeedback) fittingsFeedback.textContent = "Não foi possível abrir o fluxo de Novo Agendamento.";
    return;
  }
  if (fittingsFeedback) fittingsFeedback.textContent = "";
  await window.adminOpenNewAppointment(prefill);
}

function renderTodayOperation() {
  const now = new Date();
  const today = dataLocalHoje();
  const summary = buildTodayOperationSummary({
    appointments: todayAppointmentsSource,
    professionals: todayProfessionals,
    today,
    now,
    candidateSlots: (professional, duration) => horariosCandidatos(professional, today, duration),
    blocks: todayBlocks,
  });

  if (appointmentsKpi) appointmentsKpi.textContent = String(summary.appointmentsToday.length);
  if (appointmentsKpiState) appointmentsKpiState.textContent = "Somente hoje · sem cancelados";
  if (clientsKpi) clientsKpi.textContent = String(summary.customersServedToday);
  if (clientsKpiState) clientsKpiState.textContent = "Somente concluídos hoje";
  if (fittingsKpi) fittingsKpi.textContent = String(summary.fittings.length);
  if (fittingsKpiState) fittingsKpiState.textContent = summary.fittings.length
    ? "Horários liberados hoje"
    : "Nenhum horário liberado";
  if (nextKpi) {
    nextKpi.classList.add("today-next-list");
    nextKpi.innerHTML = summary.nextAppointments
      .map((item) => `<span class="today-next-item"><span>${escapeHtml(item.barberName)}</span><time>${escapeHtml(item.time)}</time></span>`)
      .join("");
    nextKpi.setAttribute(
      "aria-label",
      summary.nextAppointments.map((item) => `${item.barberName} ${item.time}`).join(", ") || "Nenhum próximo atendimento hoje",
    );
  }
  if (nextKpiState) nextKpiState.textContent = "Hoje · próximo horário por profissional";
  renderLateAlert(summary, now);
  renderFittingsPanel(summary.fittings);
}

function syncAvailableKpis() {
  if (professionalsLimit && professionalsKpi) {
    const match = professionalsLimit.textContent.match(/^(\d+)/);
    if (match) professionalsKpi.textContent = match[1];
  }
}

window.addEventListener("admin:barbers-loaded", (event) => {
  todayProfessionals = event.detail?.professionals || [];
  renderTodayOperation();
});

window.addEventListener("admin:agenda-rendered", (event) => {
  todayActionsById = new Map(Object.entries(event.detail?.actionsByAppointment || {}));
  todayBlocks = Array.isArray(event.detail?.blocks) ? event.detail.blocks : [];
  const incoming = Array.isArray(event.detail?.allAppointments)
    ? event.detail.allAppointments
    : event.detail?.appointments;
  if (Array.isArray(incoming)) {
    mergeTodayAppointments(incoming);
  }
  renderTodayOperation();
});

lateAlertAction?.addEventListener("click", () => {
  latePanelOpen = true;
  if (latePanel) {
    latePanel.hidden = false;
    latePanel.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }
});

latePanelClose?.addEventListener("click", () => {
  latePanelOpen = false;
  if (latePanel) latePanel.hidden = true;
});

syncAvailableKpis();
renderTodayOperation();

if (professionalsLimit) {
  const kpiObserver = new MutationObserver(syncAvailableKpis);
  kpiObserver.observe(professionalsLimit, { characterData: true, childList: true, subtree: true });
}

// Keep one explicit navigation state for keyboard and assistive technology.
syncSidebarState(document.querySelector(".admin-sidebar [data-view].active")?.dataset.view || "overview");
