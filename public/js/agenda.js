import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { executarComandoOperacional } from "./operational-commands.js";
import { tenantContextIsReady } from "./tenant-context.js";

export const INTERVALO_MINUTOS = 30;
export const LIMITE_ANTECEDENCIA_CLIENTE_DIAS = 10;
const V2_COLLECTIONS = Object.freeze({
  ocupacoes: "ocupacoes",
});
const AVAILABILITY_MESSAGES = Object.freeze({
  CLOSED: "Barbearia fechada",
  OUTSIDE_BUSINESS_HOURS: "Fora do horário de funcionamento",
  NO_AVAILABILITY: "Sem disponibilidade nesta data",
  AVAILABLE: "",
});

function requireTenantScope(tenantContext) {
  if (!tenantContextIsReady(tenantContext)) throw new Error("TENANT_CONTEXT_NOT_READY");
  return tenantContext;
}

function tenantDocument(db, tenantContext, collectionName, id) {
  const context = requireTenantScope(tenantContext);
  return doc(db, "barbearias", context.tenantId, collectionName, id);
}

export function createTenantScopedAgenda(tenantContext) {
  const context = requireTenantScope(tenantContext);
  const scope = { tenantContext: context };
  return Object.freeze({
    obterFechamentoGlobal: (db, data) => obterFechamentoGlobal(db, data, scope),
    horariosDisponiveis: (db, options) => horariosDisponiveis(db, options, scope),
    criarAgendamento,
    reagendarAgendamento,
    concluirAgendamento,
    cancelarAgendamento,
    marcarNaoComparecimento,
    liberarAgendamento,
    criarBloqueio,
    removerBloqueio,
  });
}
const pad = (value) => String(value).padStart(2, "0");
function formatarDataLocal(data) { return `${data.getFullYear()}-${pad(data.getMonth() + 1)}-${pad(data.getDate())}`; }
export function dataLocalHoje() { return formatarDataLocal(new Date()); }
export function limitesDataAgendamentoCliente(hoje = dataLocalHoje()) {
  const [ano, mes, dia] = hoje.split("-").map(Number);
  return { min: hoje, max: formatarDataLocal(new Date(ano, mes - 1, dia + LIMITE_ANTECEDENCIA_CLIENTE_DIAS)) };
}
export function dataDentroDaJanelaDoCliente(data, hoje = dataLocalHoje()) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(data || ""))) return false;
  const [ano, mes, dia] = data.split("-").map(Number);
  const parsed = new Date(ano, mes - 1, dia);
  if (parsed.getFullYear() !== ano || parsed.getMonth() !== mes - 1 || parsed.getDate() !== dia) return false;
  const { min, max } = limitesDataAgendamentoCliente(hoje);
  return data >= min && data <= max;
}
export async function obterFechamentoGlobal(_db, data, { tenantContext } = {}) {
  const context = requireTenantScope(tenantContext);
  if (!data) return { fechado: false, motivo: "" };
  const availability = await executarComandoOperacional("agenda.disponibilidade.obter", {
    data: { data, slug: context.slug },
  });
  if (
    availability?.data !== data
    || typeof availability?.closed !== "boolean"
    || !Array.isArray(availability?.effectiveOpenPeriods)
    || !Object.hasOwn(AVAILABILITY_MESSAGES, availability?.publicMessageCode)
  ) {
    throw new Error("AVAILABILITY_RESPONSE_INVALID");
  }
  return {
    fechado: availability.closed,
    motivo: AVAILABILITY_MESSAGES[availability.publicMessageCode],
    periodosEfetivos: availability.effectiveOpenPeriods,
    codigoPublico: availability.publicMessageCode,
  };
}
export function paraMinutos(horario) { const [hora, minuto] = String(horario).split(":").map(Number); return hora * 60 + minuto; }
export function paraHorario(minutos) { return `${pad(Math.floor(minutos / 60))}:${pad(minutos % 60)}`; }
export function adicionarMinutos(horario, minutos) { return paraHorario(paraMinutos(horario) + Number(minutos || 0)); }
function periodosPadrao(data) {
  const dia = new Date(`${data}T12:00:00`).getDay();
  if (dia === 0) return [];
  return [{ inicio: "08:30", fim: "12:00" }, { inicio: "13:00", fim: dia <= 4 ? "19:30" : "20:30" }];
}
export function periodosDoBarbeiro(barbeiro, data) {
  const configuracao = barbeiro?.horarios_trabalho?.[new Date(`${data}T12:00:00`).getDay()];
  return configuracao === false ? [] : Array.isArray(configuracao) ? configuracao : periodosPadrao(data);
}
function intersectarPeriodos(periodosGlobais, periodosPessoais) {
  const resultado = [];
  for (const global of periodosGlobais) for (const pessoal of periodosPessoais) {
    const inicio = Math.max(paraMinutos(global.inicio), paraMinutos(pessoal.inicio));
    const fim = Math.min(paraMinutos(global.fim), paraMinutos(pessoal.fim));
    if (fim > inicio) resultado.push({ inicio: paraHorario(inicio), fim: paraHorario(fim) });
  }
  return resultado;
}
function periodosEfetivosDoBarbeiro(barbeiro, data, periodosGlobais) {
  if (!Array.isArray(periodosGlobais)) return periodosDoBarbeiro(barbeiro, data);
  const configuracao = barbeiro?.horarios_trabalho?.[new Date(`${data}T12:00:00`).getDay()];
  if (configuracao === false) return [];
  return Array.isArray(configuracao) ? intersectarPeriodos(periodosGlobais, configuracao) : periodosGlobais;
}
export function horariosCandidatos(barbeiro, data, duracao, periodosGlobais) {
  const resultado = [];
  for (const periodo of periodosEfetivosDoBarbeiro(barbeiro, data, periodosGlobais)) for (let atual = paraMinutos(periodo.inicio); atual + duracao <= paraMinutos(periodo.fim); atual += INTERVALO_MINUTOS) resultado.push(paraHorario(atual));
  return resultado;
}
export function blocosDoAtendimento(horario, duracao) { return Array.from({ length: Math.ceil(Number(duracao || INTERVALO_MINUTOS) / INTERVALO_MINUTOS) }, (_, index) => adicionarMinutos(horario, index * INTERVALO_MINUTOS)); }
export function idOcupacao(barbeiroId, data, horario) { return `${barbeiroId}_${data}_${horario}`; }
function atendimentoDentroDosPeriodos(horario, duracao, periodos) {
  if (!Array.isArray(periodos)) return true;
  const inicio = paraMinutos(horario);
  const fim = inicio + Number(duracao);
  return periodos.some((periodo) => inicio >= paraMinutos(periodo.inicio) && fim <= paraMinutos(periodo.fim));
}
export async function horariosDisponiveis(db, { barbeiro, barbeiroId, data, duracao, disponibilidadeGlobal }, { tenantContext } = {}) {
  const context = requireTenantScope(tenantContext);
  if (!barbeiroId || !data || !duracao) return [];
  const disponibilidade = disponibilidadeGlobal || await obterFechamentoGlobal(db, data, { tenantContext: context });
  if (disponibilidade.fechado) return [];
  const candidatos = horariosCandidatos(barbeiro, data, Number(duracao), disponibilidade.periodosEfetivos)
    .filter((horario) => atendimentoDentroDosPeriodos(horario, duracao, disponibilidade.periodosEfetivos));
  const slots = horariosCandidatos(barbeiro, data, INTERVALO_MINUTOS, disponibilidade.periodosEfetivos);
  const ocupados = new Set((await Promise.all(slots.map(async (horario) => {
    try {
      const occupationRef = tenantDocument(db, context, V2_COLLECTIONS.ocupacoes, idOcupacao(barbeiroId, data, horario));
      return (await getDoc(occupationRef)).exists() ? horario : "";
    }
    catch (erro) { if (erro?.code === "permission-denied") return horario; throw erro; }
  }))).filter(Boolean));
  const agora = new Date();
  return candidatos.filter((horario) => !(data === dataLocalHoje() && paraMinutos(horario) <= agora.getHours() * 60 + agora.getMinutes()) && !blocosDoAtendimento(horario, duracao).some((slot) => ocupados.has(slot)));
}
export async function criarAgendamento(_db, dados) {
  if (dados.limiteAntecedenciaCliente && !dataDentroDaJanelaDoCliente(dados.data)) throw new Error("DATA_FORA_DA_JANELA");
  return (await executarComandoOperacional("agenda.criar", { data: dados })).appointmentId;
}
export async function reagendarAgendamento(_db, agendamento, dados) {
  return executarComandoOperacional("agenda.reagendar", { appointmentId: agendamento.id, data: dados });
}
export async function concluirAgendamento(_db, agendamento) { return executarComandoOperacional("agenda.concluir", { data: { appointmentId: agendamento.id } }); }
export async function cancelarAgendamento(_db, agendamento) { return executarComandoOperacional("agenda.cancelar", { data: { appointmentId: agendamento.id } }); }
export async function marcarNaoComparecimento(_db, agendamento) { return executarComandoOperacional("agenda.nao_compareceu", { data: { appointmentId: agendamento.id } }); }
export async function liberarAgendamento(_db, agendamento, status) { return executarComandoOperacional(status === "cancelado" ? "agenda.cancelar" : "agenda.nao_compareceu", { data: { appointmentId: agendamento.id } }); }
export async function criarBloqueio(_db, dados) { return (await executarComandoOperacional("bloqueio.criar", { data: dados })).blockId; }
export async function removerBloqueio(_db, bloqueio) { return executarComandoOperacional("bloqueio.remover", { blockId: bloqueio.id }); }
