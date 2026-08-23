#!/usr/bin/env node
/**
 * Prévia SOMENTE-LEITURA para saneamento do legado da Barbearia Antunes.
 *
 * Firestore: somente GET listDocuments. Nenhuma correção é executada.
 * Saída: relatório JSON local em reports/.
 *
 * Uso:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS='C:\\caminho\\credencial.json'
 *   node scripts/integrity-repair-preview.mjs
 *
 * Teste local, sem Firebase:
 *   node scripts/integrity-repair-preview.mjs --self-test
 */

import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "barber-a01e7";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const COLECOES = ["barbeiros", "servicos", "agendamentos", "ocupacoes", "planos_assinatura", "solicitacoes_assinatura"];
const STATUS_SEM_OCUPACAO = new Set(["cancelado", "nao_compareceu", "legacy_unresolved"]);

function isLegacyArchived(appointment) {
  return appointment?.status === "legacy_unresolved"
    && appointment?.arquivado_legado === true
    && appointment?.excluir_migracao === true;
}
const INTERVALO_MINUTOS = 30;

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function paraObjeto(value) {
  if (value === undefined || value === null) return value;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "referenceValue")) return value.referenceValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(paraObjeto);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([key, field]) => [key, paraObjeto(field)]),
  );
  return undefined;
}

function documentoRestParaObjeto(documento) {
  return {
    id: String(documento.name || "").split("/").at(-1),
    ...Object.fromEntries(Object.entries(documento.fields || {}).map(([key, field]) => [key, paraObjeto(field)])),
  };
}

function normalizarTexto(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function porId(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function indiceUnicoPorNome(items) {
  const grouped = new Map();
  for (const item of items) {
    const key = normalizarTexto(item.nome);
    if (!key) continue;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key).push(item);
  }
  return grouped;
}

function contextoSeguroDoAgendamento(agendamento) {
  return {
    cliente_id: agendamento.cliente_id || null,
    cliente_nome: agendamento.cliente_nome || null,
    barbeiro_id: agendamento.barbeiro_id || null,
    barbeiro_nome: agendamento.barbeiro_nome || null,
    servico_id: agendamento.servico_id || null,
    servico_nome: agendamento.servico_nome || null,
    data: agendamento.data || null,
    horario: agendamento.horario || null,
    duracao: Number(agendamento.duracao || INTERVALO_MINUTOS),
    status: agendamento.status || null,
    origem: agendamento.origem || null,
  };
}

function paraMinutos(horario) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(horario || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function paraHorario(minutos) {
  return `${String(Math.floor(minutos / 60)).padStart(2, "0")}:${String(minutos % 60).padStart(2, "0")}`;
}

function blocosDoAtendimento(horario, duracao) {
  const inicio = paraMinutos(horario);
  const minutos = Number(duracao || INTERVALO_MINUTOS);
  if (inicio === null || !Number.isFinite(minutos) || minutos <= 0) return [];
  return Array.from({ length: Math.ceil(minutos / INTERVALO_MINUTOS) }, (_, index) => paraHorario(inicio + index * INTERVALO_MINUTOS));
}

function idOcupacao(barbeiroId, data, horario) {
  return `${barbeiroId}_${data}_${horario}`;
}

async function obterTokenDeAcesso() {
  if (process.env.FIRESTORE_ACCESS_TOKEN) return process.env.FIRESTORE_ACCESS_TOKEN;
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error("Defina FIRESTORE_ACCESS_TOKEN ou GOOGLE_APPLICATION_CREDENTIALS.");
  const account = JSON.parse(await readFile(credentialPath, "utf8"));
  if (!account.client_email || !account.private_key) throw new Error("Credencial sem client_email/private_key válidos.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: FIRESTORE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${header}.${payload}.${signature}`,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Falha ao obter token: ${data.error_description || data.error || response.status}`);
  return data.access_token;
}

async function getJson(url, token) {
  const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${token}` } });
  const data = await response.json();
  if (!response.ok) throw new Error(`${response.status}: ${data.error?.message || "Falha ao ler Firestore"}`);
  return data;
}

async function lerColecao(collectionName, token) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE_URL}/${encodeURIComponent(collectionName)}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await getJson(url, token);
    documents.push(...(page.documents || []).map(documentoRestParaObjeto));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function sugestaoReferencia({ tipo, agendamento, entidade, candidatos, field }) {
  const matches = candidatos.get(normalizarTexto(agendamento[field])) || [];
  const sourceField = tipo === "BARBEIRO" ? "barbeiro_id" : "servico_id";
  if (matches.length === 1) {
    return {
      categoria: `AGENDAMENTO_SEM_${tipo}`,
      documento: { colecao: "agendamentos", id: agendamento.id },
      referencia_atual: agendamento[sourceField] || null,
      evidencia: {
        campo_nome: field,
        valor: agendamento[field] || null,
        correspondencia_unica: matches[0].id,
        contexto_agendamento: contextoSeguroDoAgendamento(agendamento),
      },
      sugestao: `Substituir ${sourceField} pela correspondência única encontrada por nome.`,
      correcao_proposta: { [sourceField]: matches[0].id },
      confianca: "ALTA",
      elegivel_para_reparo_automatico: true,
      exige_decisao_manual: false,
    };
  }
  return {
    categoria: `AGENDAMENTO_SEM_${tipo}`,
    documento: { colecao: "agendamentos", id: agendamento.id },
    referencia_atual: agendamento[sourceField] || null,
    evidencia: {
      campo_nome: field,
      valor: agendamento[field] || null,
      candidatos: matches.map((item) => item.id),
      contexto_agendamento: contextoSeguroDoAgendamento(agendamento),
    },
    sugestao: matches.length > 1
      ? `Escolher manualmente um dos ${matches.length} ${entidade} com o mesmo nome.`
      : `Identificar manualmente ${entidade} correto; não houve correspondência única por nome.`,
    correcao_proposta: null,
    confianca: "BAIXA",
    elegivel_para_reparo_automatico: false,
    exige_decisao_manual: true,
  };
}

function analisarIntegridade(source) {
  const issues = [];
  const barbers = porId(source.barbeiros);
  const services = porId(source.servicos);
  const plans = porId(source.planos_assinatura);
  const occupations = porId(source.ocupacoes);
  const occupationsByAppointment = new Map();
  for (const occupation of source.ocupacoes) {
    if (!occupation.agendamento_id) continue;
    if (!occupationsByAppointment.has(occupation.agendamento_id)) occupationsByAppointment.set(occupation.agendamento_id, []);
    occupationsByAppointment.get(occupation.agendamento_id).push(occupation);
  }
  const barbersByName = indiceUnicoPorNome(source.barbeiros);
  const servicesByName = indiceUnicoPorNome(source.servicos);

  for (const appointment of source.agendamentos) {
    if (isLegacyArchived(appointment)) continue;
    const validBarber = barbers.has(appointment.barbeiro_id);
    const validService = services.has(appointment.servico_id);
    if (!validBarber) issues.push(sugestaoReferencia({
      tipo: "BARBEIRO", agendamento: appointment, entidade: "barbeiro", candidatos: barbersByName, field: "barbeiro_nome",
    }));
    if (!validService) issues.push(sugestaoReferencia({
      tipo: "SERVICO", agendamento: appointment, entidade: "serviço", candidatos: servicesByName, field: "servico_nome",
    }));

    if (!STATUS_SEM_OCUPACAO.has(appointment.status) && !occupationsByAppointment.has(appointment.id)) {
      const proposedBarberId = validBarber
        ? appointment.barbeiro_id
        : (barbersByName.get(normalizarTexto(appointment.barbeiro_nome)) || []).length === 1
          ? barbersByName.get(normalizarTexto(appointment.barbeiro_nome))[0].id
          : null;
      const blocks = blocosDoAtendimento(appointment.horario, appointment.duracao);
      const proposedIds = proposedBarberId && appointment.data
        ? blocks.map((time) => idOcupacao(proposedBarberId, appointment.data, time))
        : [];
      const conflicts = proposedIds.filter((id) => occupations.has(id));
      const eligible = Boolean(proposedBarberId && appointment.data && blocks.length && !conflicts.length);
      issues.push({
        categoria: "AGENDAMENTO_ATIVO_SEM_OCUPACAO",
        documento: { colecao: "agendamentos", id: appointment.id },
        referencia_atual: null,
        evidencia: {
          status: appointment.status || null,
          barbeiro_id: appointment.barbeiro_id || null,
          data: appointment.data || null,
          horario: appointment.horario || null,
          duracao: Number(appointment.duracao || INTERVALO_MINUTOS),
          conflitos_com_ocupacoes_existentes: conflicts,
          contexto_agendamento: contextoSeguroDoAgendamento(appointment),
        },
        sugestao: eligible
          ? "Recriar, em execução isolada, os blocos de ocupação determinísticos deste agendamento."
          : "Revisar manualmente barbeiro, data, horário, duração ou conflito antes de recriar ocupações.",
        correcao_proposta: eligible ? proposedIds.map((id, index) => ({
          colecao: "ocupacoes",
          id,
          dados: { barbeiro_id: proposedBarberId, data: appointment.data, horario: blocks[index], agendamento_id: appointment.id },
        })) : null,
        confianca: eligible ? "ALTA" : "BAIXA",
        elegivel_para_reparo_automatico: eligible,
        exige_decisao_manual: !eligible,
      });
    }
  }

  for (const subscription of source.solicitacoes_assinatura) {
    if (subscription.status !== "ATIVA" || (Array.isArray(subscription.servicos_ids) && subscription.servicos_ids.length)) continue;
    const plan = plans.get(subscription.plano_id);
    const serviceIds = Array.isArray(plan?.servicos_ids) ? [...new Set(plan.servicos_ids)] : [];
    const validServiceIds = serviceIds.filter((id) => services.has(id));
    const eligible = Boolean(plan && serviceIds.length && validServiceIds.length === serviceIds.length);
    issues.push({
      categoria: "ASSINATURA_ATIVA_SEM_SERVICOS",
      documento: { colecao: "solicitacoes_assinatura", id: subscription.id },
      referencia_atual: subscription.plano_id || null,
      evidencia: {
        plano_encontrado: Boolean(plan),
        servicos_ids_do_plano: serviceIds,
        servicos_ids_validos: validServiceIds,
      },
      sugestao: eligible
        ? "Copiar os serviceIds válidos do plano vinculado para a assinatura, em execução isolada."
        : "Configurar ou revisar manualmente os serviços do plano antes de reparar a assinatura.",
      correcao_proposta: eligible ? { servicos_ids: validServiceIds } : null,
      confianca: eligible ? "ALTA" : "BAIXA",
      elegivel_para_reparo_automatico: eligible,
      exige_decisao_manual: !eligible,
    });
  }

  return issues.sort((a, b) => `${a.categoria}:${a.documento.id}`.localeCompare(`${b.categoria}:${b.documento.id}`));
}

function montarRelatorio(source, startedAt, finishedAt) {
  const inconsistencies = analisarIntegridade(source);
  const byCategory = inconsistencies.reduce((totals, issue) => {
    totals[issue.categoria] = (totals[issue.categoria] || 0) + 1;
    return totals;
  }, {});
  return {
    ferramenta: "integrity-repair-preview",
    versao: 2,
    projeto: PROJECT_ID,
    modo: "SOMENTE_LEITURA",
    seguranca: {
      operacoes_firestore_permitidas: ["GET listDocuments"],
      operacoes_firestore_de_escrita: 0,
      correcoes_executadas: 0,
      destino_do_relatorio: "arquivo JSON local em reports/",
    },
    iniciado_em: startedAt,
    finalizado_em: finishedAt,
    documentos_lidos: Object.fromEntries(COLECOES.map((name) => [name, source[name].length])),
    catalogos_de_referencia: {
      barbeiros: source.barbeiros.map((item) => ({ id: item.id, nome: item.nome || null, ativo: item.ativo !== false })),
      servicos: source.servicos.map((item) => ({ id: item.id, nome: item.nome || null, ativo: item.ativo !== false })),
    },
    resumo: {
      inconsistencias: inconsistencies.length,
      por_categoria: byCategory,
      elegiveis_para_reparo_automatico: inconsistencies.filter((item) => item.elegivel_para_reparo_automatico).length,
      exigem_decisao_manual: inconsistencies.filter((item) => item.exige_decisao_manual).length,
      recomendacao: inconsistencies.length ? "ANALISAR_MANUALMENTE_ANTES_DE_CRIAR_REPARO" : "REEXECUTAR_DRY_RUN",
    },
    inconsistencias: inconsistencies,
    proximo_passo: "Revisar cada sugestão. Não executar reparos nem iniciar Shadow Migration sem aprovação manual.",
  };
}

async function selfTest() {
  const fixture = Object.fromEntries(COLECOES.map((name) => [name, []]));
  fixture.barbeiros = [{ id: "barber-1", nome: "Lucas Antunes" }];
  fixture.servicos = [{ id: "service-1", nome: "Corte" }];
  fixture.planos_assinatura = [{ id: "plan-1", servicos_ids: ["service-1"] }];
  fixture.solicitacoes_assinatura = [{ id: "subscription-1", status: "ATIVA", plano_id: "plan-1" }];
  fixture.agendamentos = [{
    id: "legacy-appointment", barbeiro_id: "missing", barbeiro_nome: "Lucas Antunes",
    servico_id: "missing", servico_nome: "Corte", data: "2026-08-20", horario: "09:00", duracao: 60, status: "agendado",
  }];
  const report = montarRelatorio(fixture, "test", "test");
  const expected = {
    AGENDAMENTO_ATIVO_SEM_OCUPACAO: 1,
    AGENDAMENTO_SEM_BARBEIRO: 1,
    AGENDAMENTO_SEM_SERVICO: 1,
    ASSINATURA_ATIVA_SEM_SERVICOS: 1,
  };
  if (JSON.stringify(report.resumo.por_categoria) !== JSON.stringify(expected)) {
    throw new Error(`Self-test falhou: ${JSON.stringify(report.resumo.por_categoria)}`);
  }
  if (report.resumo.elegiveis_para_reparo_automatico !== 4 || report.seguranca.operacoes_firestore_de_escrita !== 0) {
    throw new Error("Self-test falhou nas garantias de segurança/elegibilidade.");
  }
  console.log("Self-test APROVADO: 4 inconsistências detectadas, nenhuma escrita Firestore.");
}

async function main() {
  if (process.argv.includes("--self-test")) return selfTest();
  const startedAt = new Date().toISOString();
  const token = await obterTokenDeAcesso();
  const source = Object.fromEntries(await Promise.all(COLECOES.map(async (name) => [name, await lerColecao(name, token)])));
  const report = montarRelatorio(source, startedAt, new Date().toISOString());
  const reportsDir = path.resolve("reports");
  await mkdir(reportsDir, { recursive: true });
  const output = path.join(reportsDir, `integrity-repair-preview-${startedAt.replace(/[:.]/g, "-")}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(`Prévia concluída: ${report.resumo.inconsistencias} inconsistências.`);
  console.log(`Automáticas (proposta): ${report.resumo.elegiveis_para_reparo_automatico}; manuais: ${report.resumo.exigem_decisao_manual}.`);
  console.log(`Relatório local: ${output}`);
}

main().catch((error) => {
  console.error(`Falha na prévia de saneamento: ${error.message}`);
  process.exitCode = 1;
});
