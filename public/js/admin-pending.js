import {
  isPendingAppointment,
  pendingDurationLabel,
  PENDING_STATUS_LABELS,
} from "./admin-pending-core.mjs";

const pendingCount = document.getElementById("admin-pending-count");
const overviewAlert = document.getElementById("overview-pending-alert");
const summaryCount = document.getElementById("pending-summary-count");
const pendingList = document.getElementById("pending-list");
const pendingEmpty = document.getElementById("pending-empty");

const state = {
  appointments: [],
  actionsById: new Map(),
};

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]);
}

function formatDate(isoDate) {
  if (!isoDate) return "Data não informada";
  const [year, month, day] = String(isoDate).split("-");
  return `${day}/${month}/${year}`;
}

function pendingAppointments() {
  const now = new Date();
  return state.appointments
    .filter((appointment) => isPendingAppointment(appointment, now))
    .sort((left, right) => `${left.data}T${left.horario}`.localeCompare(`${right.data}T${right.horario}`));
}

function updateCount(count) {
  if (pendingCount) {
    pendingCount.textContent = `(${count})`;
    pendingCount.setAttribute("aria-label", `${count} ${count === 1 ? "pendência" : "pendências"}`);
  }
  if (summaryCount) summaryCount.textContent = `${count} ${count === 1 ? "pendência" : "pendências"}`;
  if (overviewAlert) {
    overviewAlert.hidden = count === 0;
    overviewAlert.textContent = `${count} ${count === 1 ? "atendimento antigo aguardando fechamento" : "atendimentos antigos aguardando fechamento"}`;
  }
}

function actionButton(appointment, action) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `btn btn-sm ${action.attribute === "data-cancelar-agendamento" || action.attribute === "data-falta-agendamento" ? "btn-danger" : "btn-primary"}`;
  button.textContent = action.label;
  button.addEventListener("click", () => {
    window.dispatchEvent(new CustomEvent("admin:pending-action", {
      detail: { appointment, action, button },
    }));
  });
  return button;
}

function renderPendingList() {
  if (!pendingList || !pendingEmpty) return;
  const appointments = pendingAppointments();
  updateCount(appointments.length);
  pendingList.innerHTML = "";
  pendingEmpty.hidden = appointments.length > 0;
  if (!appointments.length) return;

  appointments.forEach((appointment) => {
    const item = document.createElement("article");
    item.className = "pending-item";
    item.dataset.appointmentId = appointment.id;
    const actions = state.actionsById.get(appointment.id) || [];
    const actionsContainer = document.createElement("div");
    actionsContainer.className = "pending-actions";
    actions.forEach((action) => actionsContainer.appendChild(actionButton(appointment, action)));
    item.innerHTML = `<div class="pending-item-main"><div class="pending-item-date"><strong>${escapeHtml(formatDate(appointment.data))}</strong><span>${escapeHtml(appointment.horario || "—")}</span></div><div class="pending-item-person"><strong>${escapeHtml(appointment.cliente_nome || "Cliente sem nome")}</strong><span>${escapeHtml(appointment.barbeiro_nome || "Profissional não informado")}</span></div><div class="pending-item-service"><strong>${escapeHtml(appointment.servico_nome || "Serviço não informado")}</strong><span>${escapeHtml(PENDING_STATUS_LABELS[appointment.status] || appointment.status)}</span></div><div class="pending-item-delay">${escapeHtml(pendingDurationLabel(appointment))}</div></div>`;
    item.appendChild(actionsContainer);
    pendingList.appendChild(item);
  });
}

window.addEventListener("admin:agenda-rendered", (event) => {
  const appointments = event.detail?.allAppointments || event.detail?.appointments || [];
  state.appointments = appointments;
  state.actionsById = new Map(Object.entries(event.detail?.actionsByAppointment || {}));
  renderPendingList();
});

updateCount(0);
