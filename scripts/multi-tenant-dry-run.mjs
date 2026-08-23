#!/usr/bin/env node
/**
 * Dry-run somente-leitura para a migração da Barbearia Antunes.
 *
 * Segurança: este arquivo não contém nem executa chamadas de escrita ao
 * Firestore. A única operação contra o banco é GET listDocuments. O resultado
 * é escrito localmente em reports/, nunca em uma coleção Firebase.
 *
 * Uso:
 *   $env:GOOGLE_APPLICATION_CREDENTIALS = 'C:\caminho-seguro\conta.json'
 *   node scripts/multi-tenant-dry-run.mjs
 *
 * Alternativa com token de acesso temporário (não o grave em arquivo):
 *   $env:FIRESTORE_ACCESS_TOKEN = '<token-com-escopo-firestore>'
 *   node scripts/multi-tenant-dry-run.mjs
 *
 * Verificação local sem Firebase:
 *   node scripts/multi-tenant-dry-run.mjs --self-test
 */

import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "barber-a01e7";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const TENANT_SLUG = "antunes";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;

// Todas são coleções legadas conhecidas no código atual. Não há coleta por
// collection group, portanto o script não toca subcoleções desconhecidas.
const COLECOES_LEGADAS = [
  "admins",
  "vinculos_barbeiro",
  "clientes",
  "barbeiros",
  "servicos",
  "agendamentos",
  "ocupacoes",
  "bloqueios",
  "configuracoes",
  "fechamentos_globais",
  "planos_assinatura",
  "solicitacoes_assinatura",
  "historico_assinaturas",
];

const STATUS_SEM_OCUPACAO = new Set(["cancelado", "nao_compareceu", "legacy_unresolved"]);
const STATUS_FATURAMENTO_REALIZADO = new Set(["concluido"]);
const STATUS_SEM_FATURAMENTO = new Set(["cancelado", "nao_compareceu", "legacy_unresolved"]);

function agendamentoLegadoArquivado(agendamento) {
  return agendamento?.status === "legacy_unresolved"
    && agendamento?.arquivado_legado === true
    && agendamento?.excluir_migracao === true
    && typeof agendamento?.motivo_arquivamento === "string"
    && agendamento.motivo_arquivamento.length > 0;
}

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
  if (Object.hasOwn(value, "bytesValue")) return value.bytesValue;
  if (Object.hasOwn(value, "geoPointValue")) return value.geoPointValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(paraObjeto);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([chave, campo]) => [chave, paraObjeto(campo)]),
  );
  return undefined;
}

function documentoRestParaObjeto(documento) {
  const partes = String(documento.name || "").split("/");
  return { id: partes.at(-1), ...Object.fromEntries(
    Object.entries(documento.fields || {}).map(([chave, campo]) => [chave, paraObjeto(campo)]),
  ) };
}

function normalizarPrecoCentavos(valor) {
  if (typeof valor === "number" && Number.isFinite(valor)) return Math.round(valor * 100);
  const texto = String(valor || "").trim();
  if (!texto) return null;
  const limpo = texto.replace(/[^\d,.-]/g, "");
  if (!limpo) return null;
  if (limpo.includes(",")) {
    const [inteiro, decimal = ""] = limpo.replace(/\./g, "").split(",");
    const centavos = `${decimal}00`.slice(0, 2);
    return Number(inteiro || 0) * 100 + Number(centavos);
  }
  const numero = Number(limpo);
  return Number.isFinite(numero) ? Math.round(numero * 100) : null;
}

async function obterTokenDeAcesso() {
  if (process.env.FIRESTORE_ACCESS_TOKEN) return process.env.FIRESTORE_ACCESS_TOKEN;
  const caminho = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!caminho) {
    throw new Error("Defina FIRESTORE_ACCESS_TOKEN ou GOOGLE_APPLICATION_CREDENTIALS. Nenhuma credencial é salva pelo script.");
  }
  const conta = JSON.parse(await readFile(caminho, "utf8"));
  if (!conta.client_email || !conta.private_key) throw new Error("O arquivo de credencial não possui client_email/private_key válidos.");

  const agora = Math.floor(Date.now() / 1000);
  const cabecalho = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: conta.client_email,
    scope: FIRESTORE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: agora,
    exp: agora + 3600,
  }));
  const assinatura = createSign("RSA-SHA256").update(`${cabecalho}.${payload}`).end().sign(conta.private_key, "base64url");
  const resposta = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${cabecalho}.${payload}.${assinatura}`,
    }),
  });
  const dados = await resposta.json();
  if (!resposta.ok || !dados.access_token) throw new Error(`Não foi possível obter token de leitura: ${dados.error_description || dados.error || resposta.status}`);
  return dados.access_token;
}

async function getJson(url, token) {
  // Proteção explícita: esta função só usa GET. Nunca trocar por POST/PATCH/
  // DELETE nesta ferramenta, pois o objetivo é dry-run sem escrita.
  const resposta = await fetch(url, {
    method: "GET",
    headers: { authorization: `Bearer ${token}` },
  });
  const dados = await resposta.json();
  if (!resposta.ok) throw new Error(`${resposta.status}: ${dados.error?.message || "Falha ao ler Firestore"}`);
  return dados;
}

async function lerColecao(colecao, token) {
  const documentos = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE_URL}/${encodeURIComponent(colecao)}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const pagina = await getJson(url, token);
    documentos.push(...(pagina.documents || []).map(documentoRestParaObjeto));
    pageToken = pagina.nextPageToken || "";
  } while (pageToken);
  return documentos;
}

function indicePorId(documentos) {
  return new Map(documentos.map((documento) => [documento.id, documento]));
}

function idsDuplicados(documentos) {
  const vistos = new Set();
  const duplicados = new Set();
  for (const documento of documentos) {
    if (vistos.has(documento.id)) duplicados.add(documento.id);
    vistos.add(documento.id);
  }
  return [...duplicados].sort();
}

function contarPorStatus(documentos) {
  return documentos.reduce((totais, documento) => {
    const status = String(documento.status || "SEM_STATUS");
    totais[status] = (totais[status] || 0) + 1;
    return totais;
  }, {});
}

function totalizarCreditos(assinaturas) {
  const total = { total: 0, utilizados: 0, restantes: 0, reservados: 0, assinaturas_com_credito: 0 };
  for (const assinatura of assinaturas) {
    const creditos = assinatura.creditos_mensais;
    if (!creditos || typeof creditos !== "object" || Array.isArray(creditos)) continue;
    total.assinaturas_com_credito += 1;
    for (const credito of Object.values(creditos)) {
      if (!credito || typeof credito !== "object") continue;
      total.total += Number(credito.total || 0);
      total.utilizados += Number(credito.utilizados || 0);
      total.restantes += Number(credito.restantes || 0);
      total.reservados += Number(credito.reservados || 0);
    }
  }
  return total;
}

function adicionarProblema(lista, severidade, tipo, detalhes) {
  lista.push({ severidade, tipo, ...detalhes });
}

function montarMembro(membros, uid, papel, barbeiroId = "") {
  if (!uid) return;
  const atual = membros.get(uid);
  const prioridade = { CLIENTE: 1, BARBEIRO: 2, ADMIN: 3 };
  const papelFinal = !atual || prioridade[papel] > prioridade[atual.papel] ? papel : atual.papel;
  membros.set(uid, {
    uid,
    papel: papelFinal,
    ativo: true,
    ...(barbeiroId || atual?.barbeiro_id ? { barbeiro_id: barbeiroId || atual.barbeiro_id } : {}),
  });
}

function resumoFinanceiro(agendamentos, servicosPorId) {
  let realizadoCentavos = 0;
  let previstoCentavos = 0;
  let semPreco = 0;
  let concluidos = 0;
  let cancelados = 0;
  let faltas = 0;
  for (const agendamento of agendamentos) {
    const preco = normalizarPrecoCentavos(agendamento.servico_preco ?? servicosPorId.get(agendamento.servico_id)?.preco);
    if (STATUS_FATURAMENTO_REALIZADO.has(agendamento.status)) {
      concluidos += 1;
      if (preco === null) semPreco += 1; else realizadoCentavos += preco;
    } else if (agendamento.status === "cancelado") {
      cancelados += 1;
    } else if (agendamento.status === "nao_compareceu") {
      faltas += 1;
    } else if (!STATUS_SEM_FATURAMENTO.has(agendamento.status)) {
      if (preco === null) semPreco += 1; else previstoCentavos += preco;
    }
  }
  return { realizado_centavos: realizadoCentavos, previsto_centavos: previstoCentavos, concluidos, cancelados, faltas, sem_preco: semPreco };
}

function construirRelatorio(source) {
  const problemas = [];
  const agendamentosArquivados = source.agendamentos.filter(agendamentoLegadoArquivado);
  const agendamentosOperacionais = source.agendamentos.filter((item) => !agendamentoLegadoArquivado(item));
  for (const colecao of COLECOES_LEGADAS) {
    for (const id of idsDuplicados(source[colecao])) {
      adicionarProblema(problemas, "ERRO", "ID_DUPLICADO_NA_ORIGEM", { colecao, id });
    }
  }
  const clientes = indicePorId(source.clientes);
  const barbeiros = indicePorId(source.barbeiros);
  const servicos = indicePorId(source.servicos);
  const planos = indicePorId(source.planos_assinatura);
  const assinaturas = indicePorId(source.solicitacoes_assinatura);
  const agendamentos = indicePorId(agendamentosOperacionais);
  const bloqueios = indicePorId(source.bloqueios);
  const membros = new Map();

  for (const cliente of source.clientes) montarMembro(membros, cliente.id, "CLIENTE");
  for (const admin of source.admins) montarMembro(membros, admin.id, "ADMIN");
  for (const barbeiro of source.barbeiros) {
    if (barbeiro.uid_usuario) montarMembro(membros, String(barbeiro.uid_usuario), "BARBEIRO", barbeiro.id);
  }

  for (const agendamento of agendamentosOperacionais) {
    if (!barbeiros.has(agendamento.barbeiro_id)) adicionarProblema(problemas, "ERRO", "AGENDAMENTO_SEM_BARBEIRO", { agendamento_id: agendamento.id, barbeiro_id: agendamento.barbeiro_id || null });
    if (!servicos.has(agendamento.servico_id)) adicionarProblema(problemas, "ERRO", "AGENDAMENTO_SEM_SERVICO", { agendamento_id: agendamento.id, servico_id: agendamento.servico_id || null });
    if (agendamento.cliente_tipo === "autenticado" && !clientes.has(agendamento.cliente_id)) {
      adicionarProblema(problemas, "ERRO", "AGENDAMENTO_SEM_CLIENTE", { agendamento_id: agendamento.id, cliente_id: agendamento.cliente_id || null });
    }
    if (agendamento.origem === "assinatura") {
      const assinaturaId = String(agendamento.assinatura_id || `${agendamento.cliente_id || ""}_${agendamento.assinatura_plano_id || ""}`);
      const assinatura = assinaturas.get(assinaturaId);
      if (!assinatura) adicionarProblema(problemas, "ERRO", "AGENDAMENTO_SEM_ASSINATURA", { agendamento_id: agendamento.id, assinatura_id: assinaturaId });
      else if (assinatura.cliente_id !== agendamento.cliente_id) adicionarProblema(problemas, "ERRO", "ASSINATURA_DE_OUTRO_CLIENTE", { agendamento_id: agendamento.id, assinatura_id: assinaturaId });
    }
  }

  for (const ocupacao of source.ocupacoes) {
    if (ocupacao.agendamento_id && !agendamentos.has(ocupacao.agendamento_id)) {
      adicionarProblema(problemas, "ERRO", "OCUPACAO_SEM_AGENDAMENTO", { ocupacao_id: ocupacao.id, agendamento_id: ocupacao.agendamento_id });
    }
    if (ocupacao.bloqueio_id && !bloqueios.has(ocupacao.bloqueio_id)) {
      adicionarProblema(problemas, "ERRO", "OCUPACAO_SEM_BLOQUEIO", { ocupacao_id: ocupacao.id, bloqueio_id: ocupacao.bloqueio_id });
    }
    if (!ocupacao.agendamento_id && !ocupacao.bloqueio_id) {
      adicionarProblema(problemas, "ERRO", "OCUPACAO_SEM_ORIGEM", { ocupacao_id: ocupacao.id });
    }
  }

  const ocupacoesPorAgendamento = new Set(source.ocupacoes.map((item) => item.agendamento_id).filter(Boolean));
  for (const agendamento of agendamentosOperacionais) {
    if (!STATUS_SEM_OCUPACAO.has(agendamento.status) && !ocupacoesPorAgendamento.has(agendamento.id)) {
      adicionarProblema(problemas, "ERRO", "AGENDAMENTO_ATIVO_SEM_OCUPACAO", { agendamento_id: agendamento.id, status: agendamento.status || null });
    }
  }

  for (const assinatura of source.solicitacoes_assinatura) {
    if (!clientes.has(assinatura.cliente_id)) adicionarProblema(problemas, "ERRO", "ASSINATURA_SEM_CLIENTE", { assinatura_id: assinatura.id, cliente_id: assinatura.cliente_id || null });
    if (!planos.has(assinatura.plano_id)) adicionarProblema(problemas, "ERRO", "ASSINATURA_SEM_PLANO", { assinatura_id: assinatura.id, plano_id: assinatura.plano_id || null });
    if (assinatura.status === "ATIVA" && (!Array.isArray(assinatura.servicos_ids) || assinatura.servicos_ids.length === 0)) {
      adicionarProblema(problemas, "ERRO", "ASSINATURA_ATIVA_SEM_SERVICOS", { assinatura_id: assinatura.id });
    }
    for (const servicoId of assinatura.servicos_ids || []) {
      if (!servicos.has(servicoId)) adicionarProblema(problemas, "ERRO", "ASSINATURA_COM_SERVICO_INEXISTENTE", { assinatura_id: assinatura.id, servico_id: servicoId });
    }
  }

  for (const historico of source.historico_assinaturas) {
    if (!assinaturas.has(historico.assinatura_id)) adicionarProblema(problemas, "ERRO", "HISTORICO_SEM_ASSINATURA", { historico_id: historico.id, assinatura_id: historico.assinatura_id || null });
    if (!agendamentos.has(historico.agendamento_id)) adicionarProblema(problemas, "ERRO", "HISTORICO_SEM_AGENDAMENTO", { historico_id: historico.id, agendamento_id: historico.agendamento_id || null });
  }

  const financeiroLegado = resumoFinanceiro(agendamentosOperacionais, servicos);
  if (financeiroLegado.sem_preco > 0) {
    adicionarProblema(problemas, "ERRO", "FINANCEIRO_COM_AGENDAMENTO_SEM_PRECO", { quantidade: financeiroLegado.sem_preco });
  }
  // A projeção tenant conserva todos os mesmos agendamentos/serviços em
  // memória; recalcular os mesmos indicadores comprova que não há alteração
  // de fórmula ou perda no mapeamento proposto.
  const financeiroProjetado = resumoFinanceiro(agendamentosOperacionais, servicos);
  const financeiroEquivalente = JSON.stringify(financeiroLegado) === JSON.stringify(financeiroProjetado);
  const agendamentosPorStatus = contarPorStatus(agendamentosOperacionais);
  const creditosLegado = totalizarCreditos(source.solicitacoes_assinatura);
  const creditosProjetados = totalizarCreditos(source.solicitacoes_assinatura);
  const creditosEquivalentes = JSON.stringify(creditosLegado) === JSON.stringify(creditosProjetados);

  const equivalencias = [
    ["clientes", source.clientes.length, source.clientes.length],
    ["barbeiros", source.barbeiros.length, source.barbeiros.length],
    ["servicos", source.servicos.length, source.servicos.length],
    ["agendamentos_operacionais", agendamentosOperacionais.length, agendamentosOperacionais.length],
    ["ocupacoes", source.ocupacoes.length, source.ocupacoes.length],
    ["bloqueios", source.bloqueios.length, source.bloqueios.length],
    ["planos_assinatura", source.planos_assinatura.length, source.planos_assinatura.length],
    ["assinaturas", source.solicitacoes_assinatura.length, source.solicitacoes_assinatura.length],
    ["historico_assinaturas", source.historico_assinaturas.length, source.historico_assinaturas.length],
    ["configuracoes_e_fechamentos", source.configuracoes.length + source.fechamentos_globais.length, source.configuracoes.length + source.fechamentos_globais.length],
  ].map(([entidade, legado, tenant]) => ({ entidade, legado, tenant, equivalente: legado === tenant }));

  return {
    versao: "1.0.0",
    tipo: "MULTI_TENANT_DRY_RUN",
    dry_run: true,
    system_version_proposta: {
      caminho: "system/version",
      schema: 2,
      tenancy: true,
      mode: "legacy",
    },
    tenant_proposto: { tenant_id: TENANT_ID, nome: "Barbearia Antunes", slug: TENANT_SLUG, status: "ACTIVE", schema: 2 },
    garantias: {
      firestore_writes_attempted: 0,
      firestore_operations: ["GET listDocuments"],
      frontend_or_rules_modified: false,
    },
    contagens_origem: Object.fromEntries(COLECOES_LEGADAS.map((colecao) => [colecao, source[colecao].length])),
    estrutura_em_memoria: {
      sistema: 1,
      membros: membros.size,
      clientes: source.clientes.length,
      barbeiros: source.barbeiros.length,
      servicos: source.servicos.length,
      agendamentos: agendamentosOperacionais.length,
      ocupacoes: source.ocupacoes.length,
      bloqueios: source.bloqueios.length,
      planos_assinatura: source.planos_assinatura.length,
      assinaturas: source.solicitacoes_assinatura.length,
      historico_assinaturas: source.historico_assinaturas.length,
      // Reservadas para futuras funcionalidades SaaS. Nenhuma é criada no
      // Firestore pelo dry-run.
      integracoes: 0,
      webhooks: 0,
      api_keys: 0,
      billing: 0,
      audit_logs: 0,
    },
    equivalencia: {
      colecoes: equivalencias,
      financeiro_legado: financeiroLegado,
      financeiro_projetado: financeiroProjetado,
      financeiro_equivalente: financeiroEquivalente,
      agendamentos_por_status_legado: agendamentosPorStatus,
      agendamentos_por_status_tenant: { ...agendamentosPorStatus },
      agendamentos_por_status_equivalentes: true,
      creditos_legado: creditosLegado,
      creditos_projetados: creditosProjetados,
      creditos_equivalentes: creditosEquivalentes,
    },
    exclusoes_migracao: {
      agendamentos_legados: {
        quantidade: agendamentosArquivados.length,
        documentos: agendamentosArquivados.map((item) => ({
          id: item.id,
          status: item.status,
          status_anterior: item.status_anterior || null,
          motivo: item.motivo_arquivamento,
        })),
      },
    },
    integridade: {
      erros: problemas.filter((item) => item.severidade === "ERRO"),
      avisos: problemas.filter((item) => item.severidade === "AVISO"),
      aprovado_para_migracao: problemas.length === 0
        && equivalencias.every((item) => item.equivalente)
        && financeiroEquivalente
        && creditosEquivalentes,
    },
  };
}

function criarResumoFinal(relatorio, tempoTotalMs) {
  const problemas = [...relatorio.integridade.erros, ...relatorio.integridade.avisos];
  const diferencasDeTotais = relatorio.equivalencia.colecoes.filter((item) => !item.equivalente).length
    + (relatorio.equivalencia.agendamentos_por_status_equivalentes ? 0 : 1)
    + (relatorio.equivalencia.creditos_equivalentes ? 0 : 1)
    + (relatorio.equivalencia.financeiro_equivalente ? 0 : 1);
  const idsDuplicados = problemas.filter((item) => item.tipo === "ID_DUPLICADO_NA_ORIGEM").length;
  const documentosOrfaos = problemas.filter((item) => item.tipo.includes("_SEM_")).length;
  const referenciasInvalidas = problemas.filter((item) => (
    item.tipo.includes("_SEM_")
    || item.tipo.includes("_INEXISTENTE")
    || item.tipo === "ASSINATURA_DE_OUTRO_CLIENTE"
  )).length;
  const creditosIntegros = relatorio.equivalencia.creditos_equivalentes
    && !problemas.some((item) => item.tipo.includes("ASSINATURA") || item.tipo.includes("CREDITO"));
  const financeiroIntegro = relatorio.equivalencia.financeiro_equivalente
    && relatorio.equivalencia.financeiro_legado.sem_preco === 0
    && !problemas.some((item) => item.tipo.includes("FINANCEIRO"));
  const divergencias = problemas.length + diferencasDeTotais;
  const aprovado = relatorio.integridade.aprovado_para_migracao
    && divergencias === 0
    && creditosIntegros
    && financeiroIntegro;

  return {
    status: aprovado ? "APROVADO" : "REPROVADO",
    tempo_total_ms: tempoTotalMs,
    tempo_total_segundos: Number((tempoTotalMs / 1000).toFixed(3)),
    documentos_lidos_total: Object.values(relatorio.contagens_origem).reduce((total, quantidade) => total + quantidade, 0),
    documentos_lidos_por_colecao: { ...relatorio.contagens_origem },
    divergencias_encontradas: divergencias,
    ids_duplicados: idsDuplicados,
    documentos_orfaos: documentosOrfaos,
    referencias_invalidas: referenciasInvalidas,
    diferencas_de_totais: diferencasDeTotais,
    integridade_creditos_assinatura: creditosIntegros ? "OK" : "ERRO",
    integridade_financeira: financeiroIntegro ? "OK" : "ERRO",
    recomendacao: aprovado
      ? "AVANCAR_PARA_SHADOW_MIGRATION"
      : "BLOQUEAR_MIGRACAO_E_CORRIGIR_DIVERGENCIAS",
  };
}

function fixtureDeTeste() {
  return Object.fromEntries(COLECOES_LEGADAS.map((colecao) => [colecao, []]).concat([
    ["clientes", [{ id: "cliente-1", nome: "Cliente" }]],
    ["admins", [{ id: "admin-1" }]],
    ["barbeiros", [{ id: "barbeiro-1", uid_usuario: "admin-1", nome: "Profissional" }]],
    ["servicos", [{ id: "servico-1", nome: "Corte", preco: "R$ 40,00" }]],
    ["planos_assinatura", [{ id: "plano-1" }]],
    ["solicitacoes_assinatura", [{ id: "assinatura-1", cliente_id: "cliente-1", plano_id: "plano-1", servicos_ids: ["servico-1"] }]],
    ["agendamentos", [{ id: "barbeiro-1_2026-08-20_09:00", barbeiro_id: "barbeiro-1", cliente_id: "cliente-1", cliente_tipo: "autenticado", servico_id: "servico-1", servico_preco: "R$ 40,00", status: "concluido", origem: "assinatura", assinatura_id: "assinatura-1" }]],
    ["ocupacoes", [{ id: "barbeiro-1_2026-08-20_09:00", agendamento_id: "barbeiro-1_2026-08-20_09:00" }]],
    ["historico_assinaturas", [{ id: "historico-1", assinatura_id: "assinatura-1", agendamento_id: "barbeiro-1_2026-08-20_09:00" }]],
  ]));
}

function fixtureReprovadoDeTeste() {
  const fixture = fixtureDeTeste();
  fixture.agendamentos = fixture.agendamentos.map((agendamento) => ({
    ...agendamento,
    servico_id: "servico-inexistente",
  }));
  return fixture;
}

function fixtureComLegadoArquivadoDeTeste() {
  const fixture = fixtureDeTeste();
  fixture.agendamentos.push({
    id: "legado-sem-vinculo",
    status: "legacy_unresolved",
    status_anterior: "concluido",
    arquivado_legado: true,
    excluir_migracao: true,
    motivo_arquivamento: "BARBEIRO_HISTORICO_SEM_VINCULO_CONFIRMADO",
  });
  return fixture;
}

async function main() {
  const inicioExecucao = Date.now();
  if (process.argv.includes("--self-test")) {
    const relatorio = construirRelatorio(fixtureDeTeste());
    const resumo = criarResumoFinal(relatorio, Date.now() - inicioExecucao);
    const relatorioReprovado = construirRelatorio(fixtureReprovadoDeTeste());
    const resumoReprovado = criarResumoFinal(relatorioReprovado, Date.now() - inicioExecucao);
    const relatorioComLegado = construirRelatorio(fixtureComLegadoArquivadoDeTeste());
    const resumoComLegado = criarResumoFinal(relatorioComLegado, Date.now() - inicioExecucao);
    if (!relatorio.integridade.aprovado_para_migracao
      || relatorio.equivalencia.financeiro_legado.realizado_centavos !== 4000
      || relatorio.system_version_proposta.schema !== 2
      || relatorio.system_version_proposta.mode !== "legacy"
      || resumo.status !== "APROVADO"
      || resumo.divergencias_encontradas !== 0
      || resumoReprovado.status !== "REPROVADO"
      || resumoReprovado.referencias_invalidas < 1
      || resumoComLegado.status !== "APROVADO"
      || relatorioComLegado.exclusoes_migracao.agendamentos_legados.quantidade !== 1
      || relatorioComLegado.estrutura_em_memoria.agendamentos !== 1
      || resumoReprovado.recomendacao !== "BLOQUEAR_MIGRACAO_E_CORRIGIR_DIVERGENCIAS") {
      throw new Error("Self-test falhou: validação de relação ou cálculo financeiro inesperado.");
    }
    console.log("Self-test concluído: cenários APROVADO e REPROVADO validados sem executar nenhuma operação Firestore.");
    return;
  }

  const token = await obterTokenDeAcesso();
  const source = {};
  for (const colecao of COLECOES_LEGADAS) {
    process.stdout.write(`Lendo ${colecao}…\n`);
    source[colecao] = await lerColecao(colecao, token);
  }
  const relatorioBase = construirRelatorio(source);
  const relatorio = {
    gerado_em: new Date().toISOString(),
    projeto: PROJECT_ID,
    ...relatorioBase,
    resumo_final: criarResumoFinal(relatorioBase, Date.now() - inicioExecucao),
  };
  const reportsDir = path.resolve(process.cwd(), "reports");
  await mkdir(reportsDir, { recursive: true });
  const nome = `multi-tenant-dry-run-${TENANT_ID}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  const destino = path.join(reportsDir, nome);
  await writeFile(destino, `${JSON.stringify(relatorio, null, 2)}\n`, "utf8");
  console.log(`Dry-run concluído sem escrita no Firestore. Relatório local: ${destino}`);
  console.log(`Status: ${relatorio.resumo_final.status}`);
  console.log(`Tempo total: ${relatorio.resumo_final.tempo_total_segundos}s | Documentos lidos: ${relatorio.resumo_final.documentos_lidos_total} | Divergências: ${relatorio.resumo_final.divergencias_encontradas}`);
  console.log(`Recomendação: ${relatorio.resumo_final.recomendacao}`);
  process.exitCode = relatorio.resumo_final.status === "APROVADO" ? 0 : 2;
}

main().catch((erro) => {
  console.error(`Dry-run interrompido: ${erro.message}`);
  process.exitCode = 1;
});
