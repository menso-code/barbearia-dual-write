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
const agendaCounter = document.getElementById("agenda-contador");
const professionalsLimit = document.getElementById("limite-barbeiros");
const appointmentsKpi = document.querySelector('[data-kpi="appointments"]');
const professionalsKpi = document.querySelector('[data-kpi="professionals"]');

function syncAvailableKpis() {
  if (agendaCounter && appointmentsKpi) {
    const match = agendaCounter.textContent.match(/\d+/);
    if (match) appointmentsKpi.textContent = match[0];
  }

  if (professionalsLimit && professionalsKpi) {
    const match = professionalsLimit.textContent.match(/^(\d+)/);
    if (match) professionalsKpi.textContent = match[1];
  }
}

syncAvailableKpis();

if (agendaCounter || professionalsLimit) {
  const kpiObserver = new MutationObserver(syncAvailableKpis);
  if (agendaCounter) {
    kpiObserver.observe(agendaCounter, { characterData: true, childList: true, subtree: true });
  }
  if (professionalsLimit) {
    kpiObserver.observe(professionalsLimit, { characterData: true, childList: true, subtree: true });
  }
}

// Keep one explicit navigation state for keyboard and assistive technology.
syncSidebarState(document.querySelector(".admin-sidebar [data-view].active")?.dataset.view || "overview");
