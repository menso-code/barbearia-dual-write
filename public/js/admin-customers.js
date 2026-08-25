import {
  buildCustomerRecords,
  filterCustomerRecords,
  statusLabel,
} from "./admin-customers-core.mjs";
import { formatarNumeroWhatsApp, normalizarNumeroWhatsApp } from "./whatsapp.js";

const state = {
  source: null,
  records: [],
  search: "",
  filter: "all",
  selectedId: "",
};

const escapeHtml = (value) => String(value ?? "")
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#039;");

function formatDate(value) {
  const date = String(value || "");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return "Data não informada";
  return date.split("-").reverse().join("/");
}

function subscriptionLabel(customer) {
  const { status, planName } = customer.subscription;
  return status === "SEM ASSINATURA"
    ? "Sem assinatura"
    : `${status}${planName ? ` · ${planName}` : ""}`;
}

function renderEmpty(message, detail = "") {
  const body = document.getElementById("clientes-tabela-corpo");
  const cards = document.getElementById("clientes-cards");
  const html = `<div class="empty-state"><h3>${escapeHtml(message)}</h3><p>${escapeHtml(detail)}</p></div>`;
  body.innerHTML = `<tr><td colspan="5">${html}</td></tr>`;
  cards.innerHTML = html;
}

function renderAppointmentCell(appointment, emptyLabel) {
  if (!appointment) return `<span class="cliente-muted">${emptyLabel}</span>`;
  return `<span class="cliente-date"><strong>${formatDate(appointment.data)}</strong><span>${escapeHtml(appointment.horario || "Horário não informado")} · ${escapeHtml(statusLabel(appointment.status))}</span></span>`;
}

function renderSubscriptionCell(customer) {
  return `<span class="cliente-subscription"><span class="cliente-subscription-status" data-status="${escapeHtml(customer.subscription.status)}">${escapeHtml(customer.subscription.status)}</span><span class="cliente-muted">${escapeHtml(customer.subscription.planName || "")}</span></span>`;
}

function renderDetailAppointment(appointment, emptyLabel) {
  if (!appointment) return `<span class="cliente-detail-empty">${escapeHtml(emptyLabel)}</span>`;
  return `<span class="cliente-detail-value"><strong>${escapeHtml(formatDate(appointment.data))}</strong><span>${escapeHtml(appointment.horario || "Horário não informado")}</span></span>`;
}

function renderTable(records) {
  const body = document.getElementById("clientes-tabela-corpo");
  body.innerHTML = records.map((customer) => `
    <tr>
      <td>
        <button class="cliente-row-button" type="button" data-customer-id="${escapeHtml(customer.id)}">
          <span class="cliente-name">${escapeHtml(customer.name)}</span>
          <span class="cliente-phone">${escapeHtml(customer.phone ? formatarNumeroWhatsApp(customer.phone) : "Telefone não cadastrado")}</span>
        </button>
      </td>
      <td>${renderAppointmentCell(customer.nextAppointment, "Nenhum próximo horário")}</td>
      <td>${renderAppointmentCell(customer.lastAppointment, "Nenhum atendimento concluído")}</td>
      <td><span class="cliente-total">${customer.totalAppointments}</span></td>
      <td>${renderSubscriptionCell(customer)}</td>
    </tr>`).join("");
}

function renderCards(records) {
  const cards = document.getElementById("clientes-cards");
  cards.innerHTML = records.map((customer) => `
    <article class="cliente-card">
      <div class="cliente-card-head">
        <button class="cliente-row-button" type="button" data-customer-id="${escapeHtml(customer.id)}">
          <span class="cliente-name">${escapeHtml(customer.name)}</span>
          <span class="cliente-phone">${escapeHtml(customer.phone ? formatarNumeroWhatsApp(customer.phone) : "Telefone não cadastrado")}</span>
        </button>
        ${renderSubscriptionCell(customer)}
      </div>
      <div class="cliente-card-meta"><span>Próximo</span><strong>${escapeHtml(customer.nextAppointment ? `${formatDate(customer.nextAppointment.data)} · ${customer.nextAppointment.horario || "Horário não informado"}` : "Nenhum")}</strong></div>
      <div class="cliente-card-meta"><span>Atendimentos</span><strong>${customer.totalAppointments}</strong></div>
    </article>`).join("");
}

function renderDetail(customer) {
  const panel = document.getElementById("clientes-detail-panel");
  if (!customer) {
    panel.hidden = true;
    panel.innerHTML = "";
    return;
  }

  panel.hidden = false;
  const whatsapp = normalizarNumeroWhatsApp(customer.phone);
  panel.innerHTML = `
    <div class="cliente-detail-head">
      <div><span class="eyebrow">Cliente</span><h3>${escapeHtml(customer.name)}</h3><p class="cliente-detail-contact">${escapeHtml(customer.phone ? formatarNumeroWhatsApp(customer.phone) : "Telefone não cadastrado")}</p></div>
      <button class="btn btn-ghost btn-sm cliente-detail-close" type="button" data-close-customer aria-label="Fechar detalhes do cliente">×</button>
    </div>
    <dl class="cliente-detail-stats">
      <div><dt>Próximo atendimento</dt><dd>${renderDetailAppointment(customer.nextAppointment, "Nenhum")}</dd></div>
      <div><dt>Último concluído</dt><dd>${renderDetailAppointment(customer.lastAppointment, "Nenhum atendimento concluído")}</dd></div>
      <div><dt>Total de atendimentos</dt><dd>${customer.totalAppointments}</dd></div>
      <div><dt>Não compareceu</dt><dd>${customer.noShowCount}</dd></div>
      <div><dt>Cancelamentos</dt><dd>${customer.cancellationCount}</dd></div>
      <div><dt>Assinatura</dt><dd>${escapeHtml(subscriptionLabel(customer))}</dd></div>
    </dl>
    <div class="cliente-detail-actions" aria-label="Ações do cliente">
      ${whatsapp ? `<a class="btn btn-ghost btn-sm" href="https://wa.me/${escapeHtml(whatsapp)}" target="_blank" rel="noopener noreferrer">WhatsApp</a>` : '<span class="cliente-muted">WhatsApp indisponível</span>'}
      <button class="btn btn-ghost btn-sm" type="button" data-show-customer-history>Ver histórico</button>
    </div>
    <span class="cliente-detail-history-title" id="cliente-detail-history-title">Histórico de atendimentos</span>
    <div class="cliente-detail-history" tabindex="-1" aria-labelledby="cliente-detail-history-title">
      ${customer.appointments.length
        ? customer.appointments.map((appointment) => `<article class="cliente-history-item"><strong>${escapeHtml(formatDate(appointment.data))} · ${escapeHtml(appointment.horario || "Horário não informado")}</strong><span>${escapeHtml(statusLabel(appointment.status))}${appointment.servico_nome ? ` · ${escapeHtml(appointment.servico_nome)}` : ""}</span></article>`).join("")
        : '<p class="cliente-muted">Nenhum atendimento registrado.</p>'}
    </div>`;

  panel.querySelector("[data-close-customer]")?.addEventListener("click", () => {
    state.selectedId = "";
    renderDetail(null);
  });
  panel.querySelector("[data-show-customer-history]")?.addEventListener("click", () => {
    const history = panel.querySelector(".cliente-detail-history");
    history?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    history?.focus({ preventScroll: true });
  });
}

function bindSelection() {
  document.querySelectorAll("[data-customer-id]").forEach((button) => {
    button.addEventListener("click", () => {
      state.selectedId = button.dataset.customerId || "";
      renderDetail(state.records.find((customer) => customer.id === state.selectedId));
    });
  });
}

function render() {
  const records = filterCustomerRecords(state.records, {
    search: state.search,
    filter: state.filter,
  });
  const counter = document.getElementById("clientes-contador");
  if (!state.source) {
    counter.textContent = "Carregando clientes…";
    return;
  }
  counter.textContent = state.source.complete
    ? `${records.length} de ${state.records.length} cliente${state.records.length === 1 ? "" : "s"}`
    : "Dados parciais — total indisponível";
  if (!records.length) {
    renderEmpty(
      state.search || state.filter !== "all" ? "Nenhum cliente encontrado" : "Nenhum cliente cadastrado",
      state.search || state.filter !== "all" ? "Tente ajustar a busca ou o filtro." : "Os clientes aparecerão aqui quando houver cadastros.",
    );
    renderDetail(null);
    return;
  }
  renderTable(records);
  renderCards(records);
  bindSelection();
  renderDetail(state.records.find((customer) => customer.id === state.selectedId));
}

function applySource(detail) {
  state.source = detail;
  state.records = buildCustomerRecords(detail);
  render();
}

document.getElementById("clientes-busca")?.addEventListener("input", (event) => {
  state.search = event.target.value;
  render();
});

document.getElementById("clientes-filtro")?.addEventListener("change", (event) => {
  state.filter = event.target.value;
  render();
});

window.addEventListener("admin:customers-data", (event) => applySource(event.detail));
if (window.adminCustomersSourceSnapshot) applySource(window.adminCustomersSourceSnapshot);
