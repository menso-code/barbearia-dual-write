import { auth, db } from "./firebase-config.js";
import { obterUidOperacionalComPrimeiroVinculo } from "./homologation-identity.js?v=2026082015";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { collection, getDocs, onSnapshot, orderBy, query, where } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { blocosDoAtendimento, createTenantScopedAgenda, dataLocalHoje, horariosCandidatos, paraHorario, paraMinutos } from "./agenda.js";
import { executarComandoOperacional } from "./operational-commands.js";
import { initializeTenantContext, tenantContextIsReady } from "./tenant-context.js";
import { renderTenantAccessGate, resolveTenantPageAccess } from "./tenant-membership-gate.js";
import { abrirWhatsAppLembrete, buildReminderMessage, formatarNumeroWhatsApp, normalizarNumeroWhatsApp } from "./whatsapp.js";

let tenantContext = null;
let tenantAgenda = null;
let barbeiroAtual = null;
let servicos = [];
let agendamentos = [];
let bloqueios = [];
let cancelarAgendaListener = null;
let cancelarBloqueioListener = null;
let agendaListenerGeneration = 0;
let barberAuthGeneration = 0;
let barberInterfaceMounted = false;
let remarcacaoAtual = null;
let horarioPreferido = "";
let lembreteAtual = null;
const agendaEstado = { periodo: "hoje", mostrarCancelados: false };
const mapaAgendamentos = new Map();
const mapaBloqueios = new Map();
let fechamentosGlobais = new Map();

const $ = (seletor) => document.querySelector(seletor);
const pad = (valor) => String(valor).padStart(2, "0");
const hoje = () => dataLocalHoje();
const somarDias = (data, dias) => { const d = new Date(`${data}T12:00:00`); d.setDate(d.getDate() + dias); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const dataBr = (data) => String(data || "").split("-").reverse().join("/");
const escapar = (valor) => String(valor ?? "").replace(/[&<>"]/g, (char) => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;" }[char]));
const statusRotulo = (value) => ({ agendado:"Agendado", cliente_chegou:"Cliente chegou", em_atendimento:"Em atendimento", concluido:"Concluído", cancelado:"Cancelado", nao_compareceu:"Não compareceu" }[value] || "Agendado");
const statusClasse = (value) => value === "concluido" ? "status-concluido" : value === "cancelado" ? "status-cancelado" : value === "nao_compareceu" ? "status-falta" : value === "cliente_chegou" ? "status-chegou" : value === "em_atendimento" ? "status-atendimento" : "status-agendado";

function tenantCollection(name) {
  if (!tenantContextIsReady(tenantContext)) throw new Error("TENANT_CONTEXT_NOT_READY");
  return collection(db, "barbearias", tenantContext.tenantId, name);
}

function pararAgendaListeners() {
  agendaListenerGeneration += 1;
  cancelarAgendaListener?.();
  cancelarBloqueioListener?.();
  cancelarAgendaListener = null;
  cancelarBloqueioListener = null;
}

function currentBarberBootstrap(user, generation) {
  return generation === barberAuthGeneration && auth.currentUser?.uid === user.uid;
}

function bloquear(texto) {
  if (texto) $("#barber-locked-message").textContent = texto;
  $("#barber-locked").style.display = "flex";
}

function datasDoPeriodo() {
  if (agendaEstado.periodo === "amanha") return [somarDias(hoje(), 1)];
  if (agendaEstado.periodo === "semana") return Array.from({ length: 7 }, (_, indice) => somarDias(hoje(), indice));
  return [hoje()];
}

function montarInterface() {
  const cabecalho = $(".section-head");
  const novo = document.createElement("button");
  novo.className = "btn btn-primary";
  novo.id = "barber-new-booking";
  novo.type = "button";
  novo.textContent = "+ Novo agendamento";
  $("#barber-refresh").classList.replace("btn-primary", "btn-ghost");
  cabecalho.appendChild(novo);

  const ocupacao = document.createElement("article");
  ocupacao.className = "resumo-card";
  ocupacao.innerHTML = '<span class="rotulo">Ocupação do dia</span><span class="valor" id="metric-ocupacao">0%</span>';
  $(".barber-metrics").appendChild(ocupacao);

  const agenda = $(".barber-day");
  const controles = document.createElement("div");
  controles.className = "barber-agenda-controls";
  controles.innerHTML = '<div class="agenda-periods" role="group" aria-label="Período da agenda"><button class="active" type="button" data-barber-periodo="hoje">Hoje</button><button type="button" data-barber-periodo="amanha">Amanhã</button><button type="button" data-barber-periodo="semana">Semana</button></div><div class="barber-agenda-secondary"><label class="barber-checkbox"><input type="checkbox" id="barber-show-cancelled"> Mostrar cancelados</label><button class="btn btn-ghost btn-sm" type="button" id="barber-block-time">Bloquear horário</button></div>';
  agenda.insertBefore(controles, agenda.querySelector("h3"));

  document.body.insertAdjacentHTML("beforeend", `
    <div class="modal-backdrop" id="barber-booking-modal"><div class="modal"><span class="eyebrow">Minha agenda</span><h3 id="barber-booking-title">Novo agendamento</h3><div id="barber-booking-msg" class="msg"></div><form id="barber-booking-form"><div class="field"><label for="barber-booking-client">Cliente</label><input id="barber-booking-client" required placeholder="Nome do cliente"></div><div class="field"><label for="barber-booking-phone">WhatsApp (opcional)</label><input id="barber-booking-phone" inputmode="tel" placeholder="(11) 99999-9999"></div><div class="field"><label>Barbeiro</label><input id="barber-booking-barber" disabled></div><div class="field"><label for="barber-booking-service">Serviço</label><select id="barber-booking-service" required><option value="">Selecione</option></select></div><div class="grid-2"><div class="field"><label for="barber-booking-date">Data</label><input id="barber-booking-date" type="date" required></div><div class="field"><label for="barber-booking-time">Horário</label><select id="barber-booking-time" required><option value="">Escolha serviço e data</option></select></div></div><div class="modal-actions"><button class="btn btn-ghost btn-block" type="button" data-close-booking>Cancelar</button><button class="btn btn-primary btn-block" type="submit">Confirmar agendamento</button></div></form></div></div>
    <div class="modal-backdrop" id="barber-block-modal"><div class="modal"><span class="eyebrow">Disponibilidade</span><h3>Bloquear horário</h3><div id="barber-block-msg" class="msg"></div><form id="barber-block-form"><div class="field"><label for="barber-block-date">Data</label><input id="barber-block-date" type="date" required></div><div class="grid-2"><div class="field"><label for="barber-block-start">Início</label><select id="barber-block-start" required></select></div><div class="field"><label for="barber-block-end">Fim</label><select id="barber-block-end" required></select></div></div><div class="field"><label for="barber-block-reason">Motivo</label><select id="barber-block-reason"><option>Almoço</option><option>Compromisso</option><option>Pausa</option><option>Outro</option></select></div><div class="modal-actions"><button class="btn btn-ghost btn-block" type="button" data-close-block>Cancelar</button><button class="btn btn-primary btn-block" type="submit">Bloquear horário</button></div></form></div></div>
    <div class="modal-backdrop" id="barber-complete-modal"><div class="modal modal-confirmation"><span class="eyebrow">Finalizar atendimento</span><h3>Concluir atendimento?</h3><p>Na próxima etapa, esta confirmação abrirá a comanda com valor e forma de pagamento presencial.</p><dl class="completion-details" id="barber-complete-details"></dl><div class="modal-actions"><button class="btn btn-ghost btn-block" type="button" data-close-complete>Voltar</button><button class="btn btn-primary btn-block" type="button" id="barber-confirm-complete">Confirmar conclusão</button></div></div></div>`);

  document.body.insertAdjacentHTML("beforeend", '<div class="modal-backdrop" id="barber-reminder-modal"><div class="modal modal-confirmation"><span class="eyebrow">Enviar lembrete</span><h3>Confirmar conversa</h3><dl class="completion-details"><div><dt>Cliente</dt><dd id="barber-reminder-client"></dd></div><div><dt>WhatsApp</dt><dd id="barber-reminder-phone"></dd></div><div><dt>Mensagem</dt><dd id="barber-reminder-message" class="barber-reminder-preview"></dd></div></dl><div class="modal-actions"><button class="btn btn-ghost btn-block" type="button" id="barber-close-reminder">Cancelar</button><button class="btn btn-primary btn-block" type="button" id="barber-open-reminder">Abrir WhatsApp</button></div></div></div>');

  novo.addEventListener("click", () => abrirAgendamento());
  $("#barber-refresh").addEventListener("click", () => assinarAgenda());
  controles.querySelectorAll("[data-barber-periodo]").forEach((botao) => botao.addEventListener("click", () => {
    agendaEstado.periodo = botao.dataset.barberPeriodo;
    controles.querySelectorAll("[data-barber-periodo]").forEach((item) => item.classList.toggle("active", item === botao));
    assinarAgenda();
  }));
  $("#barber-show-cancelled").addEventListener("change", (evento) => { agendaEstado.mostrarCancelados = evento.target.checked; renderizarAgenda(); });
  $("#barber-block-time").addEventListener("click", () => abrirBloqueio());
  $("[data-close-booking]").addEventListener("click", () => fecharModal("#barber-booking-modal"));
  $("[data-close-block]").addEventListener("click", () => fecharModal("#barber-block-modal"));
  $("[data-close-complete]").addEventListener("click", () => fecharModal("#barber-complete-modal"));
  $("#barber-close-reminder").addEventListener("click", () => fecharModal("#barber-reminder-modal"));
  $("#barber-open-reminder").addEventListener("click", () => {
    if (lembreteAtual && abrirWhatsAppLembrete(lembreteAtual)) fecharModal("#barber-reminder-modal");
  });
  $("#barber-booking-service").addEventListener("change", atualizarHorariosAgendamento);
  $("#barber-booking-date").addEventListener("change", atualizarHorariosAgendamento);
  $("#barber-booking-form").addEventListener("submit", confirmarAgendamento);
  $("#barber-block-date").addEventListener("change", preencherHorasBloqueio);
  $("#barber-block-form").addEventListener("submit", confirmarBloqueio);
  $("#barber-confirm-complete").addEventListener("click", concluirAtendimento);
  $("#barber-timeline").addEventListener("click", tratarAcaoTimeline);
}

function fecharModal(seletor) { $(seletor).classList.remove("show"); }
function mostrarMensagem(seletor, texto, tipo = "err") { const el = $(seletor); el.textContent = texto; el.className = `msg show ${tipo}`; }

async function carregarServicos() {
  const snap = await getDocs(tenantCollection("servicos"));
  servicos = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
}

async function assinarAgenda() {
  pararAgendaListeners();
  const generation = agendaListenerGeneration;
  const datas = datasDoPeriodo();
  try {
    const estados = await Promise.all(datas.map(async (data) => [data, await tenantAgenda.obterFechamentoGlobal(db, data)]));
    fechamentosGlobais = new Map(estados);
  } catch (erro) {
    console.error("Falha ao consultar funcionamento da barbearia.", erro);
    fechamentosGlobais = new Map();
  }
  if (generation !== agendaListenerGeneration) return;
  const inicio = datas[0];
  const fim = datas[datas.length - 1];
  const agendaQuery = query(tenantCollection("agendamentos"), where("barbeiro_id", "==", barbeiroAtual.id), where("data", ">=", inicio), where("data", "<=", fim), orderBy("data"), orderBy("horario"));
  const bloqueioQuery = query(tenantCollection("bloqueios"), where("barbeiro_id", "==", barbeiroAtual.id), where("data", ">=", inicio), where("data", "<=", fim), orderBy("data"), orderBy("inicio"));
  cancelarAgendaListener = onSnapshot(agendaQuery, (snap) => { if (generation !== agendaListenerGeneration) return; agendamentos = snap.docs.map((item) => ({ id:item.id, ...item.data() })); renderizarAgenda(); }, (erro) => { if (generation === agendaListenerGeneration) mostrarErroAgenda(erro); });
  cancelarBloqueioListener = onSnapshot(bloqueioQuery, (snap) => { if (generation !== agendaListenerGeneration) return; bloqueios = snap.docs.map((item) => ({ id:item.id, ...item.data() })); renderizarAgenda(); }, (erro) => { if (generation === agendaListenerGeneration) mostrarErroAgenda(erro); });
}

function mostrarErroAgenda(erro) {
  console.error("Falha ao atualizar agenda do barbeiro.", erro);
  $("#barber-timeline").innerHTML = '<div class="empty-state"><h3>Não foi possível carregar a agenda</h3><p>Atualize a página ou tente novamente.</p></div>';
}

function ocupadoNoDia(data) {
  const slots = new Set();
  agendamentos.filter((item) => item.data === data && !["cancelado", "nao_compareceu"].includes(item.status)).forEach((item) => blocosDoAtendimento(item.horario, item.duracao || 30).forEach((slot) => slots.add(slot)));
  bloqueios.filter((item) => item.data === data).forEach((item) => blocosDoAtendimento(item.inicio, item.duracao || (paraMinutos(item.fim) - paraMinutos(item.inicio))).forEach((slot) => slots.add(slot)));
  return slots;
}

function atualizarMetricas() {
  const data = datasDoPeriodo()[0];
  const fechamento = fechamentosGlobais.get(data);
  const itens = agendamentos.filter((item) => item.data === data);
  const ativos = itens.filter((item) => ["agendado", "cliente_chegou", "em_atendimento"].includes(item.status));
  $("#metric-total").textContent = itens.filter((item) => item.status !== "cancelado").length;
  $("#metric-concluidos").textContent = itens.filter((item) => item.status === "concluido").length;
  $("#metric-restantes").textContent = ativos.length;
  const agora = `${hoje()}T${new Date().toTimeString().slice(0,5)}`;
  const proximo = agendamentos.filter((item) => ["agendado", "cliente_chegou", "em_atendimento"].includes(item.status) && `${item.data}T${item.horario}` >= agora).sort((a,b) => `${a.data}${a.horario}`.localeCompare(`${b.data}${b.horario}`))[0];
  $("#metric-proximo").innerHTML = fechamento?.fechado ? `<small>Barbearia fechada${fechamento.motivo ? `<br>${escapar(fechamento.motivo)}` : ""}</small>` : proximo ? `<span>${escapar(proximo.horario)}</span><small>${escapar(proximo.cliente_nome || "Cliente")}<br>${escapar(proximo.servico_nome || "Serviço")}</small>` : '<small>Agenda finalizada</small>';
  const candidatos = horariosCandidatos(barbeiroAtual, data, 30);
  $("#metric-ocupacao").textContent = fechamento?.fechado ? "0%" : candidatos.length ? `${Math.round((ocupadoNoDia(data).size / candidatos.length) * 100)}%` : "0%";
}

function acoesDoAgendamento(item) {
  if (!["agendado", "cliente_chegou", "em_atendimento"].includes(item.status)) return "";
  const principal = item.status === "agendado" ? "Cliente chegou" : item.status === "cliente_chegou" ? "Iniciar atendimento" : "Concluir";
  const acao = item.status === "agendado" ? "chegada" : item.status === "cliente_chegou" ? "iniciar" : "concluir";
  const lembrete = ["agendado", "cliente_chegou"].includes(item.status) && normalizarNumeroWhatsApp(item.cliente_whatsapp)
    ? `<button class="btn btn-ghost btn-sm" data-timeline-action="lembrete" data-id="${item.id}">Lembrete</button>` : "";
  return `<div class="barber-slot-actions"><button class="btn btn-primary btn-sm" data-timeline-action="${acao}" data-id="${item.id}">${principal}</button><details class="agenda-actions-menu"><summary aria-label="Mais ações">⋮</summary><div><button class="btn btn-ghost btn-sm" data-timeline-action="reagendar" data-id="${item.id}">Reagendar</button>${lembrete}<button class="btn btn-danger btn-sm" data-timeline-action="falta" data-id="${item.id}">Não compareceu</button><button class="btn btn-danger btn-sm" data-timeline-action="cancelar" data-id="${item.id}">Cancelar</button></div></details></div>`;
}

function cardAgendamento(item) {
  const tempo = item.status === "em_atendimento" && item.started_at?.toDate ? `<span class="barber-elapsed">Em atendimento desde ${item.started_at.toDate().toLocaleTimeString("pt-BR", { hour:"2-digit", minute:"2-digit" })}</span>` : "";
  return `<article class="barber-slot barber-slot-booked"><time>${escapar(item.horario)}</time><div class="barber-slot-content"><span class="status-pill ${statusClasse(item.status)}">${statusRotulo(item.status)}</span><strong>${escapar(item.cliente_nome || "Cliente")}</strong><p>${escapar(item.servico_nome || "Serviço")}</p>${tempo}${acoesDoAgendamento(item)}</div></article>`;
}

function cardBloqueio(item) {
  return `<article class="barber-slot barber-slot-blocked"><time>${escapar(item.inicio)}</time><div class="barber-slot-content"><span class="status-pill status-falta">Bloqueado</span><strong>${escapar(item.motivo || "Bloqueado")}</strong><p>Até ${escapar(item.fim)}</p><div class="barber-slot-actions"><button class="btn btn-ghost btn-sm" data-timeline-action="desbloquear" data-block-id="${item.id}">Desbloquear</button></div></div></article>`;
}

function cardLivre(data, horario, encerrado) {
  return `<article class="barber-slot barber-slot-free"><time>${horario}</time><div class="barber-slot-content"><span class="status-pill ${encerrado ? "status-falta" : "status-agendado"}">${encerrado ? "Encerrado" : "Livre"}</span><strong>${encerrado ? "Horário já passou" : "Disponível para agendar"}</strong>${encerrado ? "" : `<div class="barber-slot-actions"><button class="btn btn-ghost btn-sm" data-timeline-action="agendar" data-date="${data}" data-time="${horario}">+ Agendar</button></div>`}</div></article>`;
}

function renderizarDia(data) {
  const fechamento = fechamentosGlobais.get(data);
  const titulo = data === hoje() ? "Hoje" : data === somarDias(hoje(), 1) ? "Amanhã" : dataBr(data);
  if (fechamento?.fechado) {
    return `<section class="barber-day-group"><h4>${titulo}</h4><div class="empty-state"><h3>Barbearia fechada</h3><p>${escapar(fechamento.motivo || "Não há disponibilidade para este dia.")}</p></div></section>`;
  }
  const reservas = agendamentos.filter((item) => item.data === data);
  const porInicio = new Map(reservas.map((item) => [item.horario, item]));
  const bloqueiosInicio = new Map(bloqueios.filter((item) => item.data === data).map((item) => [item.inicio, item]));
  const horarios = horariosCandidatos(barbeiroAtual, data, 30);
  let ocupadoAte = -1;
  const agoraMinutos = new Date().getHours() * 60 + new Date().getMinutes();
  const cards = [];
  horarios.forEach((horario) => {
    const minuto = paraMinutos(horario);
    const reserva = porInicio.get(horario);
    const bloqueio = bloqueiosInicio.get(horario);
    if (reserva && (agendaEstado.mostrarCancelados || !["cancelado", "nao_compareceu"].includes(reserva.status))) {
      cards.push(cardAgendamento(reserva));
      if (!["cancelado", "nao_compareceu"].includes(reserva.status)) ocupadoAte = Math.max(ocupadoAte, minuto + Number(reserva.duracao || 30));
      return;
    }
    if (bloqueio) { cards.push(cardBloqueio(bloqueio)); ocupadoAte = Math.max(ocupadoAte, paraMinutos(bloqueio.fim)); return; }
    if (minuto < ocupadoAte) return;
    cards.push(cardLivre(data, horario, data === hoje() && minuto <= agoraMinutos));
  });
  return `<section class="barber-day-group"><h4>${titulo}</h4>${cards.join("") || '<div class="empty-state">Sem horários configurados para este dia.</div>'}</section>`;
}

function renderizarAgenda() {
  if (!barbeiroAtual) return;
  mapaAgendamentos.clear(); agendamentos.forEach((item) => mapaAgendamentos.set(item.id, item));
  mapaBloqueios.clear(); bloqueios.forEach((item) => mapaBloqueios.set(item.id, item));
  atualizarMetricas();
  $("#barber-timeline").innerHTML = datasDoPeriodo().map(renderizarDia).join("");
}

function abrirAgendamento({ data = datasDoPeriodo()[0], horario = "", remarcacao = null } = {}) {
  remarcacaoAtual = remarcacao;
  horarioPreferido = horario;
  $("#barber-booking-form").reset();
  $("#barber-booking-msg").className = "msg";
  $("#barber-booking-title").textContent = remarcacao ? "Reagendar atendimento" : "Novo agendamento";
  $("#barber-booking-barber").value = barbeiroAtual.nome || "Meu painel";
  $("#barber-booking-date").min = hoje();
  $("#barber-booking-date").value = data;
  const select = $("#barber-booking-service");
  select.innerHTML = '<option value="">Selecione</option>';
  servicos.forEach((servico) => select.add(new Option(`${servico.nome} — ${servico.duracao || 30} min`, servico.id)));
  if (remarcacao) {
    $("#barber-booking-client").value = remarcacao.cliente_nome || "";
    $("#barber-booking-phone").value = remarcacao.cliente_whatsapp || "";
    select.value = remarcacao.servico_id || "";
  }
  $("#barber-booking-modal").classList.add("show");
  atualizarHorariosAgendamento();
}

async function atualizarHorariosAgendamento() {
  const horarioSelect = $("#barber-booking-time");
  const servico = servicos.find((item) => item.id === $("#barber-booking-service").value);
  const data = $("#barber-booking-date").value;
  horarioSelect.innerHTML = '<option value="">Carregando horários…</option>';
  if (!servico || !data) { horarioSelect.innerHTML = '<option value="">Escolha serviço e data</option>'; return; }
  try {
    const fechamento = await tenantAgenda.obterFechamentoGlobal(db, data);
    if (fechamento.fechado) {
      horarioSelect.innerHTML = '<option value="">Barbearia fechada neste dia</option>';
      mostrarMensagem("#barber-booking-msg", `Barbearia fechada neste dia.${fechamento.motivo ? ` ${fechamento.motivo}.` : ""}`);
      return;
    }
    const horarios = await tenantAgenda.horariosDisponiveis(db, { barbeiro: barbeiroAtual, barbeiroId: barbeiroAtual.id, data, duracao: servico.duracao || 30 });
    horarioSelect.innerHTML = `<option value="">${horarios.length ? "Selecione" : "Nenhum horário disponível"}</option>`;
    horarios.forEach((hora) => horarioSelect.add(new Option(hora, hora)));
    if (horarioPreferido && horarios.includes(horarioPreferido)) horarioSelect.value = horarioPreferido;
    horarioPreferido = "";
  } catch (erro) { console.error(erro); horarioSelect.innerHTML = '<option value="">Não foi possível consultar horários</option>'; }
}

async function confirmarAgendamento(evento) {
  evento.preventDefault();
  const servico = servicos.find((item) => item.id === $("#barber-booking-service").value);
  const dados = { cliente_nome: $("#barber-booking-client").value.trim(), cliente_whatsapp: $("#barber-booking-phone").value.replace(/\D/g, ""), data: $("#barber-booking-date").value, horario: $("#barber-booking-time").value };
  if (!dados.cliente_nome || !servico || !dados.data || !dados.horario) return mostrarMensagem("#barber-booking-msg", "Preencha todos os campos obrigatórios.");
  const botao = evento.target.querySelector("button[type=submit]");
  botao.disabled = true;
  try {
    const comando = { ...dados, cliente_id:"", cliente_tipo:"presencial", barbeiro_id:barbeiroAtual.id, barbeiro_nome:barbeiroAtual.nome, barbeiro:barbeiroAtual, servico_id:servico.id, servico_nome:servico.nome, servico_preco:servico.preco || "", duracao:servico.duracao || 30, criado_por:auth.currentUser.uid, criado_por_tipo:"barbeiro", origem:"painel_barbeiro" };
    if (remarcacaoAtual) await tenantAgenda.reagendarAgendamento(db, remarcacaoAtual, comando);
    else await tenantAgenda.criarAgendamento(db, comando);
    mostrarMensagem("#barber-booking-msg", remarcacaoAtual ? "Atendimento reagendado com sucesso." : "Agendamento criado com sucesso.", "ok");
    setTimeout(() => fecharModal("#barber-booking-modal"), 550);
  } catch (erro) {
    console.error("Falha ao criar agendamento do barbeiro.", erro);
    mostrarMensagem("#barber-booking-msg", erro.message === "BARBEARIA_FECHADA" ? "A barbearia está fechada nesta data." : erro.message === "HORARIO_OCUPADO" ? "Este horário acabou de ficar indisponível." : "Não foi possível criar o agendamento.");
  } finally { botao.disabled = false; }
}

function preencherHorasBloqueio() {
  const data = $("#barber-block-date").value;
  const horas = horariosCandidatos(barbeiroAtual, data, 30);
  const inicio = $("#barber-block-start"); const fim = $("#barber-block-end");
  inicio.innerHTML = '<option value="">Selecione</option>'; fim.innerHTML = '<option value="">Selecione</option>';
  horas.forEach((hora) => inicio.add(new Option(hora, hora)));
  [...new Set(horas.map((hora) => paraHorario(paraMinutos(hora) + 30)))].forEach((hora) => fim.add(new Option(hora, hora)));
}

function abrirBloqueio() {
  $("#barber-block-form").reset();
  $("#barber-block-msg").className = "msg";
  $("#barber-block-date").min = hoje();
  $("#barber-block-date").value = datasDoPeriodo()[0];
  preencherHorasBloqueio();
  $("#barber-block-modal").classList.add("show");
}

async function confirmarBloqueio(evento) {
  evento.preventDefault();
  const dados = { barbeiro_id:barbeiroAtual.id, barbeiro:barbeiroAtual, data:$("#barber-block-date").value, inicio:$("#barber-block-start").value, fim:$("#barber-block-end").value, motivo:$("#barber-block-reason").value };
  const botao = evento.target.querySelector("button[type=submit]");
  botao.disabled = true;
  try {
    await tenantAgenda.criarBloqueio(db, dados);
    mostrarMensagem("#barber-block-msg", "Horário bloqueado com sucesso.", "ok");
    setTimeout(() => fecharModal("#barber-block-modal"), 500);
  } catch (erro) {
    const mensagem = erro.message === "HORARIO_OCUPADO" ? "Há um agendamento ou bloqueio nesse período." : erro.message === "BLOQUEIO_FORA_DO_EXPEDIENTE" ? "Escolha um horário dentro do expediente." : "Confira início e fim do bloqueio.";
    mostrarMensagem("#barber-block-msg", mensagem);
  } finally { botao.disabled = false; }
}

async function atualizarStatus(item, status) {
  const mensagens = { cliente_chegou:"Registrar chegada do cliente?", em_atendimento:"Iniciar este atendimento?" };
  if (!confirm(mensagens[status])) return;
  await executarComandoOperacional(`agenda.${status}`, { data: { appointmentId: item.id } });
}

let atendimentoParaConcluir = null;
function abrirConclusao(item) {
  atendimentoParaConcluir = item;
  $("#barber-complete-details").innerHTML = `<div><dt>Cliente</dt><dd>${escapar(item.cliente_nome || "Cliente")}</dd></div><div><dt>Serviço</dt><dd>${escapar(item.servico_nome || "Serviço")}</dd></div><div><dt>Horário</dt><dd>${escapar(dataBr(item.data))} às ${escapar(item.horario)}</dd></div>`;
  $("#barber-complete-modal").classList.add("show");
}
async function concluirAtendimento() {
  if (!atendimentoParaConcluir) return;
  const botao = $("#barber-confirm-complete"); botao.disabled = true;
  try { await tenantAgenda.concluirAgendamento(db, atendimentoParaConcluir); fecharModal("#barber-complete-modal"); }
  catch (erro) { alert(erro.message === "CREDITO_INDISPONIVEL" ? "Não há crédito disponível nesta assinatura." : erro.message === "ASSINATURA_SEM_VINCULO" ? "Este agendamento de assinatura não possui vínculo de crédito válido." : "Não foi possível concluir o atendimento."); console.error(erro); }
  finally { botao.disabled = false; atendimentoParaConcluir = null; }
}

function abrirPreviewLembrete(agendamento) {
  // O item vem exclusivamente do listener filtrado pelo barbeiro atual.
  if (agendamento.barbeiro_id !== barbeiroAtual.id || !normalizarNumeroWhatsApp(agendamento.cliente_whatsapp)) return;
  lembreteAtual = agendamento;
  $("#barber-reminder-client").textContent = agendamento.cliente_nome || "Cliente";
  $("#barber-reminder-phone").textContent = formatarNumeroWhatsApp(agendamento.cliente_whatsapp);
  $("#barber-reminder-message").textContent = buildReminderMessage(agendamento);
  $("#barber-reminder-modal").classList.add("show");
}

async function tratarAcaoTimeline(evento) {
  const botao = evento.target.closest("[data-timeline-action]");
  if (!botao) return;
  const acao = botao.dataset.timelineAction;
  const item = mapaAgendamentos.get(botao.dataset.id);
  try {
    if (acao === "agendar") return abrirAgendamento({ data:botao.dataset.date, horario:botao.dataset.time });
    if (acao === "desbloquear") { const bloqueio = mapaBloqueios.get(botao.dataset.blockId); if (bloqueio && confirm("Desbloquear este horário?")) await tenantAgenda.removerBloqueio(db, bloqueio); return; }
    if (!item) return;
    if (acao === "lembrete") return abrirPreviewLembrete(item);
    if (acao === "chegada") await atualizarStatus(item, "cliente_chegou");
    if (acao === "iniciar") await atualizarStatus(item, "em_atendimento");
    if (acao === "concluir") abrirConclusao(item);
    if (acao === "reagendar") abrirAgendamento({ data:item.data, remarcacao:item });
    if (acao === "falta" && confirm(`Marcar como não compareceu? Este atendimento não contará para fidelidade.${item.origem === "assinatura" ? " Um crédito da assinatura será consumido." : ""}`)) await tenantAgenda.marcarNaoComparecimento(db, item);
    if (acao === "cancelar" && confirm("Cancelar este agendamento?")) await tenantAgenda.cancelarAgendamento(db, item);
  } catch (erro) { console.error("Falha na ação da agenda.", erro); alert(erro.code === "permission-denied" ? "Você não possui permissão para esta ação." : "Não foi possível concluir esta ação."); }
}

$("[data-logout]")?.addEventListener("click", async () => { await signOut(auth); location.replace("index.html"); });

async function iniciarPainelBarbeiro() {
  const resolvedTenantContext = await initializeTenantContext();
  if (!tenantContextIsReady(resolvedTenantContext)) {
    bloquear("Este estabelecimento não está disponível.");
    return;
  }
  tenantContext = resolvedTenantContext;
  tenantAgenda = createTenantScopedAgenda(tenantContext);

  onAuthStateChanged(auth, async (user) => {
    const generation = ++barberAuthGeneration;
    pararAgendaListeners();
    if (!user) {
      location.replace("index.html");
      return;
    }
    try {
      const access = await resolveTenantPageAccess(user, "BARBEIRO");
      if (!currentBarberBootstrap(user, generation)) return;
      if (!renderTenantAccessGate({
        access,
        shell: $("#barber-shell"),
        lockedScreen: $("#barber-locked"),
        lockedMessage: $("#barber-locked-message"),
      })) return;
      const uidOperacional = await obterUidOperacionalComPrimeiroVinculo(user);
      if (!currentBarberBootstrap(user, generation)) return;
      const snap = await getDocs(query(tenantCollection("barbeiros"), where("uid_usuario", "==", uidOperacional)));
      if (!currentBarberBootstrap(user, generation)) return;
      if (snap.empty) {
        return bloquear("Esta conta ainda não está vinculada a um barbeiro. Peça a um administrador para vincular o UID da conta no painel administrativo.");
      }
      barbeiroAtual = { id:snap.docs[0].id, ...snap.docs[0].data() };
      $("#barber-title").textContent = `Olá, ${barbeiroAtual.nome || "barbeiro"}`;
      $("#barber-shell").style.display = "block";
      if (!barberInterfaceMounted) {
        montarInterface();
        barberInterfaceMounted = true;
      }
      await carregarServicos();
      if (!currentBarberBootstrap(user, generation)) return;
      assinarAgenda();
    } catch (erro) {
      pararAgendaListeners();
      if (!currentBarberBootstrap(user, generation)) return;
      console.error("Falha ao validar painel do barbeiro.", erro);
      bloquear(erro.code === "permission-denied" ? "Não foi possível validar a autorização desta conta." : undefined);
    }
  });
}

iniciarPainelBarbeiro().catch((erro) => {
  pararAgendaListeners();
  console.error("Falha ao iniciar contexto do barbeiro.", erro);
  bloquear("Este estabelecimento não está disponível.");
});
