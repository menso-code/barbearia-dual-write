import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { executarComandoOperacional } from "./operational-commands.js";

export const INTERVALO_MINUTOS = 30;
export const LIMITE_ANTECEDENCIA_CLIENTE_DIAS = 10;
const CONFIG_FUNCIONAMENTO = "funcionamento";
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
function fechamentoSemanal(configuracao, data) {
  const dia = new Date(`${data}T12:00:00`).getDay();
  const semanal = configuracao?.dias_fechados_semana || {};
  return semanal[dia] === true || (semanal[dia] === undefined && dia === 0);
}
export async function obterFechamentoGlobal(db, data) {
  if (!data) return { fechado: false, motivo: "" };
  const [configSnap, fechamentoSnap] = await Promise.all([getDoc(doc(db, "configuracoes", CONFIG_FUNCIONAMENTO)), getDoc(doc(db, "fechamentos_globais", data))]);
  if (fechamentoSnap.exists() && fechamentoSnap.data().ativo !== false) return { fechado: true, motivo: fechamentoSnap.data().motivo || "Barbearia fechada" };
  if (fechamentoSemanal(configSnap.exists() ? configSnap.data() : null, data)) return { fechado: true, motivo: "Fechamento semanal" };
  return { fechado: false, motivo: "" };
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
export function horariosCandidatos(barbeiro, data, duracao) {
  const resultado = [];
  for (const periodo of periodosDoBarbeiro(barbeiro, data)) for (let atual = paraMinutos(periodo.inicio); atual + duracao <= paraMinutos(periodo.fim); atual += INTERVALO_MINUTOS) resultado.push(paraHorario(atual));
  return resultado;
}
export function blocosDoAtendimento(horario, duracao) { return Array.from({ length: Math.ceil(Number(duracao || INTERVALO_MINUTOS) / INTERVALO_MINUTOS) }, (_, index) => adicionarMinutos(horario, index * INTERVALO_MINUTOS)); }
export function idOcupacao(barbeiroId, data, horario) { return `${barbeiroId}_${data}_${horario}`; }
export async function horariosDisponiveis(db, { barbeiro, barbeiroId, data, duracao }) {
  if (!barbeiroId || !data || !duracao || (await obterFechamentoGlobal(db, data)).fechado) return [];
  const candidatos = horariosCandidatos(barbeiro, data, Number(duracao));
  const slots = horariosCandidatos(barbeiro, data, INTERVALO_MINUTOS);
  const ocupados = new Set((await Promise.all(slots.map(async (horario) => {
    try { return (await getDoc(doc(db, "ocupacoes", idOcupacao(barbeiroId, data, horario)))).exists() ? horario : ""; }
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
