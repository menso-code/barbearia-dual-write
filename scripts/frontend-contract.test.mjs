import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const agenda = await read("public/js/agenda.js");
const admin = await read("public/js/admin.js");
const barber = await read("public/js/barber.js");
const hmlAgenda = await read("public-hml/js/agenda.js");
const adminHtml = await read("public/admin.html");
const controlCenter = await read("public/js/admin-control-center.js");
const todayOperation = await read("public/js/admin-today-operation-core.mjs");
const controlCenterCss = await read("public/css/admin-control-center.css");
const agendaV2 = await read("public/js/admin-agenda-v2.js");
const agendaV2Css = await read("public/css/admin-agenda-v2.css");
const pending = await read("public/js/admin-pending.js");
const pendingCss = await read("public/css/admin-pending.css");
const pendingCore = await read("public/js/admin-pending-core.mjs");
const customers = await read("public/js/admin-customers.js");
const customersCore = await read("public/js/admin-customers-core.mjs");
const customersCss = await read("public/css/admin-customers.css");
const studioSettings = await read("public/js/admin-studio-settings.js");
const studioSettingsCore = await read("public/js/admin-studio-settings-core.mjs");
const studioSettingsCss = await read("public/css/admin-studio-settings.css");

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
for (const command of ["cancelar", "concluir", "nao_compareceu"]) {
  assert.match(hmlAgenda, new RegExp(`agenda\\.${command}", \\{ data: \\{ appointmentId: agendamento\\.id \\} \\}`));
}
assert.doesNotMatch(hmlAgenda, /agenda\.(?:cancelar|concluir|nao_compareceu)", \{\s*appointmentId:/);
assert.doesNotMatch(admin, /agenda\.\$\{status\}`, \{\s*appointmentId:/);
assert.doesNotMatch(barber, /agenda\.\$\{status\}`, \{\s*appointmentId:/);

for (const view of ["overview", "agenda", "pendencias", "encaixes", "clientes", "equipe", "servicos", "assinaturas", "funcionamento", "relatorios", "configuracoes"]) {
  assert.match(adminHtml, new RegExp(`data-view="${view}"`), `Control Center view ausente: ${view}`);
}
assert.match(adminHtml, /class="admin-sidebar"/);
assert.match(adminHtml, /GoEstudio/);
assert.match(adminHtml, /id="view-overview"/);
assert.match(adminHtml, /data-view="agenda"[^>]*>Abrir agenda/);
assert.match(adminHtml, /css\/admin-control-center\.css/);
assert.match(adminHtml, /js\/admin-control-center\.js/);
assert.doesNotMatch(adminHtml, /PLACEHOLDER_NOT_CONNECTED/);
assert.match(adminHtml, /data-view="overview"[^>]*aria-current="page"/);
assert.equal(
  [...adminHtml.matchAll(/<button[^>]+data-view="([^"]+)"/g)].filter(([, view]) => view === "relatorios").length,
  1,
  "Financeiro/Relatórios devem compartilhar uma única entrada canônica",
);
assert.match(controlCenter, /MutationObserver/);
assert.match(controlCenter, /aria-current/);
assert.match(controlCenter, /syncSidebarState/);
assert.match(controlCenterCss, /--admin-topbar-height/);
assert.match(controlCenterCss, /top: var\(--admin-topbar-height\)/);
assert.match(controlCenter, /buildTodayOperationSummary/);
assert.match(controlCenter, /lateAlert\.hidden = appointments\.length === 0/);
assert.match(controlCenter, /admin:pending-action/);
assert.match(todayOperation, /appointmentsForToday/);
assert.match(todayOperation, /fittingAppointmentsForToday/);
assert.match(todayOperation, /fittingPrefill/);
assert.match(todayOperation, /fittingIsStillValid/);
assert.match(controlCenter, /horariosCandidatos/);
assert.match(controlCenter, /adminOpenNewAppointment/);
assert.match(controlCenter, /Este encaixe não está mais disponível/);
assert.match(controlCenter, /AGENDAR ENCAIXE/);
assert.match(todayOperation, /LATE_APPOINTMENT_TOLERANCE_MINUTES = 10/);
assert.match(todayOperation, /BLOCKED_BY_DATA_MODEL/);
assert.match(adminHtml, /Próximos atendimentos/);
assert.match(adminHtml, /data-kpi="fittings"/);
assert.doesNotMatch(adminHtml, /data-kpi="occupancy"/);
assert.match(adminHtml, /id="view-encaixes"/);
assert.match(adminHtml, /id="admin-fitting-count"/);
assert.match(adminHtml, /data-view="encaixes"/);
assert.match(adminHtml, /id="overview-late-alert"/);
assert.match(adminHtml, /id="overview-late-panel"/);
assert.match(controlCenterCss, /\.late-overview-alert\[hidden\]/);
assert.match(adminHtml, /css\/admin-agenda-v2\.css/);
assert.match(adminHtml, /js\/admin-agenda-v2\.js/);
assert.match(adminHtml, /data-agenda-view="day-grid"[^>]*aria-pressed="true"/);
assert.match(adminHtml, /data-agenda-view="list"/);
assert.match(adminHtml, /id="agenda-v2-grid"/);
assert.match(adminHtml, /data-agenda-date="previous"/);
assert.match(adminHtml, /data-agenda-date="next"/);
assert.match(adminHtml, /id="agenda-v2-quick-panel"/);
assert.match(adminHtml, /id="clientes-busca"/);
assert.match(adminHtml, /id="clientes-filtro"/);
assert.match(adminHtml, /id="clientes-tabela-corpo"/);
assert.match(adminHtml, /id="clientes-detail-panel"/);
assert.match(adminHtml, /css\/admin-customers\.css/);
assert.match(adminHtml, /js\/admin-customers\.js/);
assert.doesNotMatch(adminHtml, /A área de clientes será conectada em uma fase posterior/);
assert.match(adminHtml, /id="admin-agenda-body"/);
assert.match(adminHtml, /class="admin-establishment-context">Estabelecimento: Barbearia Antunes<\/span>/);
assert.match(adminHtml, /id="modal-operacional-confirmacao"/);
assert.match(adminHtml, /role="dialog"[\s\S]*aria-modal="true"/);
assert.match(adminHtml, /id="btn-operational-confirm"/);
assert.match(admin, /admin:agenda-rendered/);
assert.match(admin, /window\.adminOpenNewAppointment = abrirNovoAgendamento/);
assert.match(admin, /prefill\.barbeiroId/);
assert.match(admin, /prefill\.data/);
assert.match(admin, /prefill\.horario/);
assert.match(admin, /admin:customers-data/);
assert.match(admin, /carregarClientesAdministrativos/);
assert.match(customers, /buildCustomerRecords/);
assert.match(customers, /filterCustomerRecords/);
assert.match(customers, /formatarNumeroWhatsApp/);
assert.match(customersCore, /nextAppointment/);
assert.match(customersCore, /totalAppointments/);
assert.match(customersCore, /noShowCount/);
assert.match(customersCore, /cancellationCount/);
assert.match(customers, /Último concluído/);
assert.match(customers, /Ver histórico/);
assert.doesNotMatch(customers, /Restrição de agendamento|Indisponível neste contrato|não foi aplicada/);
assert.doesNotMatch(customers, /localStorage|sessionStorage/);
assert.match(customersCore, /summarizeSubscription/);
assert.match(customersCss, /@media \(max-width: 767px\)/);
assert.match(customersCss, /clientes-table-wrap[\s\S]*overflow-x: auto/);
assert.match(customersCss, /\.cliente-name[\s\S]*overflow-wrap: anywhere/);
assert.match(customersCss, /\.cliente-detail-history[\s\S]*overflow-y: auto/);
assert.doesNotMatch(customers, /executarComandoOperacional|executeOperationalCommand/);
assert.match(adminHtml, /id="studio-settings-form"/);
assert.match(adminHtml, /id="studio-settings-save"/);
assert.match(adminHtml, /id="studio-settings-discard"/);
assert.match(adminHtml, /<link rel="icon" type="image\/png" href="img\/favicon-round\.png" \/>/);
assert.doesNotMatch(adminHtml, /id="studio-favicon"|id="studio-preview-favicon"|name="favicon"/);
assert.match(studioSettings, /doc\(db, "barbearias", BARBEARIA_ATUAL_ID, "configuracoes", "identidade"\)/);
assert.match(studioSettings, /getDoc\(identityRef\)/);
assert.match(studioSettings, /admin\.estudio\.identidade\.salvar/);
assert.match(studioSettings, /studioSettingsToBackendPayload/);
assert.doesNotMatch(studioSettings, /tenantId\s*:/);
assert.doesNotMatch(studioSettings, /updatedAt\s*:/);
assert.doesNotMatch(studioSettings, /updatedBy\s*:/);
assert.doesNotMatch(studioSettings, /setDoc|addDoc|updateDoc|deleteDoc/);
assert.doesNotMatch(studioSettings, /window\.(?:alert|confirm|prompt)/);
assert.match(studioSettingsCore, /studioIdentityToForm/);
assert.match(studioSettingsCore, /studioSettingsToBackendPayload/);
assert.match(studioSettingsCss, /--studio-primary/);
assert.match(studioSettingsCss, /--studio-accent/);
assert.doesNotMatch(studioSettings, /document\.documentElement/);
assert.match(admin, /admin:barbers-loaded/);
assert.match(admin, /adminAgendaActionDefinitions/);
assert.match(admin, /actionsByAppointment/);
assert.match(admin, /admin:pending-action/);
assert.match(admin, /tr\.dataset\.agendaId = a\.id/);
assert.match(agendaV2, /window\.adminAgendaV2\.setDate/);
assert.match(agendaV2, /data-appointment-id/);
assert.match(agendaV2, /data-quick-action/);
assert.match(agendaV2, /window\.adminAgendaActionDefinitions/);
assert.match(agendaV2, /queueMicrotask/);
assert.match(agendaV2, /selectedAppointmentId/);
assert.doesNotMatch(agendaV2, /executeOperationalCommand|executarComandoOperacional|agenda\.(?:criar|reagendar|cancelar|concluir|nao_compareceu)/);
assert.match(admin, /function anunciarAtualizacaoAgenda/);
assert.match(admin, /function abrirModalOperacional/);
assert.match(admin, /function concluirComConfirmacao/);
assert.match(admin, /Enviar lembrete/);
assert.match(admin, /data-whatsapp/);
assert.match(admin, /btn\.disabled = true/);
assert.match(admin, /await carregarAgenda\(\)/);
assert.doesNotMatch(admin, /window\.location\.reload\(\)/);
for (const functionName of [
  "concluirComConfirmacao",
  "cancelarAgendamentoAdmin",
  "atualizarStatusOperacional",
  "marcarNaoCompareceu",
]) {
  const functionBlock = new RegExp(`(?:function|async function) ${functionName}[\\s\\S]*?(?=\\n(?:function|async function) |\\n(?:document|const|let) )`);
  const match = admin.match(functionBlock);
  assert.ok(match, `função operacional ausente: ${functionName}`);
  assert.doesNotMatch(match[0], /window\.confirm|\bconfirm\(|window\.alert|\balert\(|window\.prompt|\bprompt\(/, `diálogo nativo em ${functionName}`);
}
assert.match(agendaV2Css, /grid-template-columns/);
assert.match(agendaV2Css, /@media \(max-width: 767px\)/);
assert.match(agendaV2Css, /position: sticky/);
for (const token of [
  "--go-bg",
  "--go-surface",
  "--go-surface-raised",
  "--go-border",
  "--go-text",
  "--go-text-muted",
  "--go-primary",
  "--go-primary-hover",
  "--go-primary-active",
  "--go-primary-soft",
  "--go-success",
  "--go-warning",
  "--go-danger",
  "--go-info",
]) {
  assert.match(controlCenterCss, new RegExp(token.replaceAll("-", "\\-")), `token GoEstudio ausente: ${token}`);
}
assert.match(controlCenterCss, /\.admin-control-main\s*\{[\s\S]*max-width: none;[\s\S]*width: 100%;/);
assert.match(agendaV2Css, /\.agenda-v2-grid\s*\{[\s\S]*width: 100%;/);
assert.match(agendaV2Css, /\.agenda-v2-scroll\s*\{[\s\S]*max-width: 100%;[\s\S]*overflow: auto;/);
assert.match(controlCenterCss, /\.admin-page \.status-concluido,[\s\S]*\.admin-page \.status-chegou/);
assert.match(agendaV2Css, /\.agenda-v2-card\[data-status="cliente_chegou"\][\s\S]*--go-success-rgb/);
assert.match(agendaV2Css, /\.agenda-v2-card\[data-status="em_atendimento"\][\s\S]*--go-info-rgb/);
assert.doesNotMatch(agendaV2Css, /#4ab984|#35b779|#043a2c/);
assert.match(adminHtml, /css\/admin-pending\.css/);
assert.match(adminHtml, /js\/admin-pending\.js/);
assert.match(adminHtml, /id="view-pendencias"/);
assert.match(adminHtml, /id="overview-pending-alert"/);
assert.match(pending, /admin:agenda-rendered/);
assert.match(pending, /admin:pending-action/);
assert.match(pendingCore, /NON_TERMINAL_APPOINTMENT_STATUSES/);
assert.match(pendingCore, /new Date\(`\$\{date\}T\$\{time\}`\)/);
assert.match(pendingCss, /@media \(max-width: 767px\)/);
assert.doesNotMatch(pending, /executeOperationalCommand|getDocs|getDoc|window\.(?:confirm|alert|prompt)/);

console.log("frontend contract self-test: PASS");
