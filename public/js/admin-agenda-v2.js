const grid = document.getElementById("agenda-v2-grid");
const emptyState = document.getElementById("agenda-v2-empty");
const quickPanel = document.getElementById("agenda-v2-quick-panel");
const selectedDateLabel = document.querySelector("[data-agenda-selected-date]");
const professionalPicker = document.querySelector("[data-agenda-professional-picker]");
const agendaListElements = [
  document.querySelector(".agenda-table-wrap"),
  document.getElementById("admin-agenda-cards"),
  document.getElementById("agenda-paginacao"),
].filter(Boolean);

const state = {
  view: "day-grid",
  selectedDate: toIsoDate(new Date()),
  appointments: [],
  professionals: [],
  mobileProfessionalId: "",
  selectedAppointmentId: "",
};

const STATUS_LABELS = {
  agendado: "Agendado",
  cliente_chegou: "Cliente chegou",
  em_atendimento: "Em atendimento",
  concluido: "Concluído",
  cancelado: "Cancelado",
  nao_compareceu: "Não compareceu",
};

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function shiftDate(isoDate, days) {
  const date = new Date(`${isoDate}T12:00:00`);
  date.setDate(date.getDate() + days);
  return toIsoDate(date);
}

function escapeHtml(value) {
  return String(value || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatDate(isoDate) {
  return new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "2-digit",
    month: "long",
    year: "numeric",
  }).format(new Date(`${isoDate}T12:00:00`));
}

function formatTimeMinutes(value) {
  const match = String(value || "").match(/^(\d{1,2}):(\d{2})/);
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

function timeLabel(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function initials(name) {
  return String(name || "?")
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join("")
    .toUpperCase();
}

function appointmentProfessionals() {
  const result = new Map(
    state.professionals.map((professional) => [
      professional.id,
      {
        id: professional.id,
        name: professional.nome || "Profissional",
        photo: professional.foto || "",
      },
    ]),
  );
  state.appointments.forEach((appointment) => {
    if (!appointment.barbeiro_id || result.has(appointment.barbeiro_id)) return;
    result.set(appointment.barbeiro_id, {
      id: appointment.barbeiro_id,
      name: appointment.barbeiro_nome || "Profissional",
      photo: "",
    });
  });
  return [...result.values()].filter((professional) => professional.name);
}

function selectedDayAppointments() {
  return state.appointments.filter((appointment) => appointment.data === state.selectedDate);
}

function timeRange(appointments) {
  const times = appointments
    .map((appointment) => formatTimeMinutes(appointment.horario))
    .filter((value) => value !== null);
  if (!times.length) return [];
  const start = Math.floor(Math.min(...times) / 30) * 30;
  const end = Math.ceil((Math.max(...times) + 30) / 30) * 30;
  return Array.from({ length: Math.max(1, (end - start) / 30) }, (_, index) => start + index * 30);
}

function renderProfessionalPicker(professionals) {
  if (!professionalPicker) return;
  if (!professionals.some((professional) => professional.id === state.mobileProfessionalId)) {
    state.mobileProfessionalId = professionals[0]?.id || "";
  }
  professionalPicker.innerHTML = professionals
    .map((professional) => `<button class="btn btn-ghost btn-sm${professional.id === state.mobileProfessionalId ? " is-active" : ""}" type="button" data-mobile-professional="${escapeHtml(professional.id)}" aria-pressed="${professional.id === state.mobileProfessionalId}">${escapeHtml(professional.name)}</button>`)
    .join("");
}

function renderGrid() {
  if (!grid) return;
  const professionals = appointmentProfessionals();
  const appointments = selectedDayAppointments();
  const slots = timeRange(appointments);
  renderProfessionalPicker(professionals);

  grid.style.setProperty("--agenda-column-count", String(Math.max(1, professionals.length)));
  grid.dataset.mobileBarberId = state.mobileProfessionalId;
  grid.innerHTML = "";

  if (!professionals.length || !slots.length) {
    emptyState?.removeAttribute("hidden");
    return;
  }
  emptyState?.setAttribute("hidden", "");

  const columnById = new Map(professionals.map((professional, index) => [professional.id, index]));
  const slotByTime = new Map(slots.map((slot, index) => [slot, index]));
  const header = document.createElement("div");
  header.className = "agenda-v2-corner";
  header.setAttribute("role", "columnheader");
  header.setAttribute("aria-hidden", "true");
  grid.appendChild(header);

  professionals.forEach((professional) => {
    const element = document.createElement("div");
    element.className = "agenda-v2-professional-head";
    element.setAttribute("role", "columnheader");
    element.dataset.barberCol = professional.id;
    element.classList.toggle("is-mobile-active", professional.id === state.mobileProfessionalId);
    element.innerHTML = `<span class="agenda-v2-professional-avatar">${professional.photo ? `<img src="${escapeHtml(professional.photo)}" alt="" />` : escapeHtml(initials(professional.name))}</span><span class="agenda-v2-professional-name">${escapeHtml(professional.name)}</span>`;
    grid.appendChild(element);
  });

  slots.forEach((slot, slotIndex) => {
    const label = document.createElement("div");
    label.className = "agenda-v2-time-label";
    label.setAttribute("role", "rowheader");
    label.textContent = timeLabel(slot);
    grid.appendChild(label);
    professionals.forEach((professional) => {
      const cell = document.createElement("div");
      cell.className = "agenda-v2-slot";
      cell.setAttribute("role", "gridcell");
      cell.dataset.barberCol = professional.id;
      cell.dataset.slotIndex = String(slotIndex);
      cell.dataset.slot = String(slot);
      cell.classList.toggle("is-mobile-active", professional.id === state.mobileProfessionalId);
      grid.appendChild(cell);
    });
  });

  appointments.forEach((appointment) => {
    const professionalIndex = columnById.get(appointment.barbeiro_id);
    const slotIndex = slotByTime.get(Math.floor((formatTimeMinutes(appointment.horario) || slots[0]) / 30) * 30);
    if (professionalIndex === undefined || slotIndex === undefined) return;
    const cell = [...grid.querySelectorAll(".agenda-v2-slot")].find(
      (candidate) => candidate.dataset.barberCol === appointment.barbeiro_id && Number(candidate.dataset.slotIndex) === slotIndex,
    );
    if (!cell) return;
    const card = document.createElement("button");
    card.type = "button";
    card.className = "agenda-v2-card";
    card.dataset.appointmentId = appointment.id;
    card.dataset.status = appointment.status || "agendado";
    card.setAttribute("aria-label", `${appointment.cliente_nome || "Cliente"}, ${appointment.horario || "horário não informado"}, ${STATUS_LABELS[appointment.status] || "Agendado"}`);
    card.innerHTML = `<span class="agenda-v2-card-client">${escapeHtml(appointment.cliente_nome || "Cliente sem nome")}</span><span class="agenda-v2-card-service">${escapeHtml(appointment.servico_nome || "Serviço não informado")} · ${escapeHtml(appointment.horario || "—")}</span><span class="agenda-v2-card-status">${escapeHtml(STATUS_LABELS[appointment.status] || "Agendado")}</span>`;
    cell.appendChild(card);
  });
}

function findAppointment(id) {
  return state.appointments.find((appointment) => appointment.id === id) || null;
}

function findOriginalAction(row, attribute, id) {
  if (attribute === "data-whatsapp") return row?.querySelector(`[${attribute}]`) || null;
  return [...(row?.querySelectorAll(`[${attribute}]`) || [])].find((button) => button.getAttribute(attribute) === id);
}

function actionDefinitions(appointment) {
  return window.adminAgendaActionDefinitions?.(appointment) || [];
}

function openQuickPanel(appointment) {
  if (!quickPanel) return;
  state.selectedAppointmentId = appointment.id;
  const row = [...document.querySelectorAll("[data-agenda-id]")].find((candidate) => candidate.dataset.agendaId === appointment.id);
  quickPanel.hidden = false;
  quickPanel.innerHTML = `<div class="agenda-v2-quick-head"><div><span class="eyebrow">Operações rápidas</span><h3>${escapeHtml(appointment.cliente_nome || "Cliente sem nome")}</h3></div><button class="btn btn-ghost btn-sm agenda-v2-quick-close" type="button" data-close-quick-panel aria-label="Fechar operações rápidas">×</button></div><dl class="agenda-v2-quick-details"><div><dt>Contato</dt><dd>${escapeHtml(appointment.cliente_whatsapp || "Não informado")}</dd></div><div><dt>Profissional</dt><dd>${escapeHtml(appointment.barbeiro_nome || "Não informado")}</dd></div><div><dt>Serviço</dt><dd>${escapeHtml(appointment.servico_nome || "Não informado")}</dd></div><div><dt>Horário</dt><dd>${escapeHtml(appointment.horario || "Não informado")}</dd></div><div><dt>Status</dt><dd>${escapeHtml(STATUS_LABELS[appointment.status] || "Agendado")}</dd></div></dl><div class="agenda-v2-quick-actions">${actionDefinitions(appointment).map((action) => `<button class="btn ${action.label === "Cancelar" || action.label === "Não compareceu" ? "btn-danger" : "btn-primary"} btn-sm" type="button" data-quick-action="${escapeHtml(action.attribute)}">${escapeHtml(action.label)}</button>`).join("") || '<p class="limit-note">Nenhuma ação disponível para este estado.</p>'}</div>`;
  quickPanel.querySelector("[data-close-quick-panel]")?.addEventListener("click", closeQuickPanel);
  quickPanel.querySelectorAll("[data-quick-action]").forEach((button) => {
    button.addEventListener("click", () => {
      const original = findOriginalAction(row, button.dataset.quickAction, appointment.id);
      original?.click();
    });
  });
}

function closeQuickPanel() {
  if (!quickPanel) return;
  quickPanel.hidden = true;
  quickPanel.innerHTML = "";
  state.selectedAppointmentId = "";
}

function setAgendaView(view) {
  state.view = view === "list" ? "list" : "day-grid";
  document.querySelectorAll("[data-agenda-view]").forEach((button) => {
    const active = button.dataset.agendaView === state.view;
    button.classList.toggle("is-active", active);
    button.setAttribute("aria-pressed", String(active));
  });
  document.querySelector("[data-agenda-v2-workspace]")?.toggleAttribute("hidden", state.view === "list");
  agendaListElements.forEach((element) => element.toggleAttribute("hidden", state.view !== "list"));
}

function setDate(date) {
  state.selectedDate = date;
  selectedDateLabel && (selectedDateLabel.textContent = formatDate(date));
  closeQuickPanel();
  if (window.adminAgendaV2?.setDate) window.adminAgendaV2.setDate(date);
  else renderGrid();
}

document.querySelectorAll("[data-agenda-view]").forEach((button) => button.addEventListener("click", () => setAgendaView(button.dataset.agendaView)));
document.querySelector("[data-agenda-date=previous]")?.addEventListener("click", () => setDate(shiftDate(state.selectedDate, -1)));
document.querySelector("[data-agenda-date=today]")?.addEventListener("click", () => setDate(toIsoDate(new Date())));
document.querySelector("[data-agenda-date=next]")?.addEventListener("click", () => setDate(shiftDate(state.selectedDate, 1)));
professionalPicker?.addEventListener("click", (event) => {
  const button = event.target.closest?.("[data-mobile-professional]");
  if (!button) return;
  state.mobileProfessionalId = button.dataset.mobileProfessional;
  renderGrid();
});
grid?.addEventListener("click", (event) => {
  const card = event.target.closest?.("[data-appointment-id]");
  if (!card) return;
  const appointment = findAppointment(card.dataset.appointmentId);
  if (appointment) openQuickPanel(appointment);
});

window.addEventListener("admin:barbers-loaded", (event) => {
  state.professionals = event.detail?.professionals || [];
  renderGrid();
});
window.addEventListener("admin:agenda-rendered", (event) => {
  const selectedAppointmentId = state.selectedAppointmentId;
  state.appointments = event.detail?.appointments || [];
  if (event.detail?.date) state.selectedDate = event.detail.date;
  selectedDateLabel && (selectedDateLabel.textContent = formatDate(state.selectedDate));
  renderGrid();
  if (selectedAppointmentId) {
    queueMicrotask(() => {
      const updatedAppointment = findAppointment(selectedAppointmentId);
      if (updatedAppointment) openQuickPanel(updatedAppointment);
      else closeQuickPanel();
    });
  }
});

selectedDateLabel && (selectedDateLabel.textContent = formatDate(state.selectedDate));
setAgendaView("day-grid");
renderGrid();
