#!/usr/bin/env node
/**
 * Planejador de espelhamento V2 -> legado para HOMOLOGAÇÃO.
 *
 * Segurança por desenho:
 * - projeto e tenant são fixos para teste-483f6;
 * - esta versão só faz leituras GET e grava relatórios locais;
 * - --apply é deliberadamente bloqueado;
 * - nenhuma credencial é lida, criada ou persistida pelo script.
 */
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const PROJECT_ID = "teste-483f6";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
const REPORT_DIR = resolve("reports", "hml-legacy-seed");

const PROJECTIONS = [
  { key: "barbeiros", source: "barbeiros", target: "barbeiros", scope: "catalogo" },
  { key: "servicos", source: "servicos", target: "servicos", scope: "catalogo" },
  { key: "configuracoes", source: "configuracoes", target: "configuracoes", scope: "catalogo" },
  { key: "fechamentos", source: "fechamentos", target: "fechamentos_globais", scope: "catalogo" },
  { key: "clientes", source: "clientes", target: "clientes", scope: "operacional" },
  { key: "agendamentos", source: "agendamentos", target: "agendamentos", scope: "operacional" },
  { key: "ocupacoes", source: "ocupacoes", target: "ocupacoes", scope: "operacional" },
  { key: "bloqueios", source: "bloqueios", target: "bloqueios", scope: "operacional" },
  { key: "planos_assinatura", source: "planos_assinatura", target: "planos_assinatura", scope: "operacional" },
  { key: "assinaturas", source: "assinaturas", target: "solicitacoes_assinatura", scope: "operacional" },
  { key: "historico_assinaturas", source: "historico_assinaturas", target: "historico_assinaturas", scope: "operacional" },
];

function usage(message = "") {
  if (message) console.error(`Erro: ${message}\n`);
  console.error("Uso: node scripts/hml-legacy-seed.mjs [--scope catalogo|operacional|todos] [--self-test]");
  process.exit(1);
}

function parseArgs(argv) {
  const args = { scope: "catalogo", selfTest: false };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--self-test") args.selfTest = true;
    else if (value === "--scope") args.scope = argv[++index];
    else if (value === "--apply") usage("--apply não existe nesta ferramenta de prévia. Nenhuma escrita é permitida.");
    else usage(`argumento desconhecido: ${value}`);
  }
  if (!["catalogo", "operacional", "todos"].includes(args.scope)) usage("--scope deve ser catalogo, operacional ou todos");
  return args;
}

function decodeValue(value) {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return undefined;
}

function decodeFields(fields) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function documentId(document) {
  return document.name.split("/").at(-1);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}

function fingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex");
}

function safeIdHash(id) {
  return createHash("sha256").update(id).digest("hex").slice(0, 16);
}

async function firestoreGet(path, token) {
  const response = await fetch(`${API}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`Leitura Firestore falhou (${response.status}) em ${path}`);
  return response.json();
}

async function listCollection(path, token) {
  const documents = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `?pageToken=${encodeURIComponent(pageToken)}` : "";
    const payload = await firestoreGet(`${path}${suffix}`, token);
    documents.push(...(payload.documents || []));
    pageToken = payload.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function selectProjections(scope) {
  return PROJECTIONS.filter((projection) => scope === "todos" || projection.scope === scope);
}

function compareDocuments(sourceDocuments, legacyDocuments) {
  const legacyById = new Map(legacyDocuments.map((document) => [documentId(document), document]));
  const sourceIds = new Set(sourceDocuments.map(documentId));
  const sourceRows = sourceDocuments.map((source) => {
    const id = documentId(source);
    const legacy = legacyById.get(id);
    const sourceFields = decodeFields(source.fields || {});
    if (!legacy) return {
      id_hash: safeIdHash(id),
      state: "AUSENTE",
      classification: "CRIAR_SEED",
      source_hash: fingerprint(sourceFields),
    };
    const legacyFields = decodeFields(legacy.fields || {});
    const equivalent = fingerprint(sourceFields) === fingerprint(legacyFields);
    return {
      id_hash: safeIdHash(id),
      state: equivalent ? "EQUIVALENTE" : "DIVERGENTE",
      classification: equivalent ? "JA_EQUIVALENTE" : "DIVERGENTE_BLOQUEAR",
      source_hash: fingerprint(sourceFields),
      legacy_hash: fingerprint(legacyFields),
    };
  });
  const legacyOnlyRows = legacyDocuments
    .filter((legacy) => !sourceIds.has(documentId(legacy)))
    .map((legacy) => ({
      id_hash: safeIdHash(documentId(legacy)),
      state: "SOMENTE_LEGADO",
      classification: "IGNORAR",
      legacy_hash: fingerprint(decodeFields(legacy.fields || {})),
    }));
  return [...sourceRows, ...legacyOnlyRows];
}

async function buildPlan(scope, token) {
  const collections = [];
  for (const projection of selectProjections(scope)) {
    const sourcePath = `barbearias/${TENANT_ID}/${projection.source}`;
    const [sourceDocuments, legacyDocuments] = await Promise.all([listCollection(sourcePath, token), listCollection(projection.target, token)]);
    const rows = compareDocuments(sourceDocuments, legacyDocuments);
    const counts = rows.reduce((total, row) => ({ ...total, [row.state]: total[row.state] + 1 }), {
      EQUIVALENTE: 0,
      AUSENTE: 0,
      DIVERGENTE: 0,
      SOMENTE_LEGADO: 0,
    });
    collections.push({
      collection: projection.key,
      v2_path: sourcePath,
      legacy_target: projection.target,
      source_documents: sourceDocuments.length,
      legacy_documents: legacyDocuments.length,
      ...counts,
      documents: rows,
      actions: rows.filter((row) => row.classification !== "JA_EQUIVALENTE"),
    });
  }
  const totals = collections.reduce((total, item) => ({
    source_documents: total.source_documents + item.source_documents,
    legacy_documents: total.legacy_documents + item.legacy_documents,
    EQUIVALENTE: total.EQUIVALENTE + item.EQUIVALENTE,
    AUSENTE: total.AUSENTE + item.AUSENTE,
    DIVERGENTE: total.DIVERGENTE + item.DIVERGENTE,
    SOMENTE_LEGADO: total.SOMENTE_LEGADO + item.SOMENTE_LEGADO,
  }), { source_documents: 0, legacy_documents: 0, EQUIVALENTE: 0, AUSENTE: 0, DIVERGENTE: 0, SOMENTE_LEGADO: 0 });
  return { generated_at: new Date().toISOString(), project_id: PROJECT_ID, tenant_id: TENANT_ID, scope, mode: "PLAN_ONLY", totals, collections };
}

async function writeReports(plan) {
  await mkdir(REPORT_DIR, { recursive: true });
  const stamp = plan.generated_at.replace(/[:.]/g, "-");
  const base = resolve(REPORT_DIR, `hml-legacy-seed-plan-${stamp}`);
  const markdown = [
    "# Plano de espelhamento legado — Homologação", "",
    "Este relatório é somente leitura. Nenhum documento foi gravado.", "",
    `- Projeto: \`${plan.project_id}\``, `- Tenant: \`${plan.tenant_id}\``, `- Escopo: \`${plan.scope}\``, `- Gerado em: ${plan.generated_at}`,
    `- Fonte V2: ${plan.totals.source_documents} documentos`, `- Legado HML: ${plan.totals.legacy_documents} documentos`, `- Já equivalentes: ${plan.totals.EQUIVALENTE}`, `- Criar seed: ${plan.totals.AUSENTE}`, `- Divergentes bloqueados: ${plan.totals.DIVERGENTE}`, `- Somente legado (ignorar): ${plan.totals.SOMENTE_LEGADO}`, "",
    "## Coleções", "", "| Coleção V2 | Destino legado HML | V2 | Legado | Já equivalentes | Criar seed | Divergente bloquear | Ignorar |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...plan.collections.map((item) => `| ${item.collection} | ${item.legacy_target} | ${item.source_documents} | ${item.legacy_documents} | ${item.EQUIVALENTE} | ${item.AUSENTE} | ${item.DIVERGENTE} | ${item.SOMENTE_LEGADO} |`), "",
    "## Classificação", "", "- `CRIAR_SEED`: existe na V2 e está ausente no legado HML; candidato a espelhamento futuro.", "- `JA_EQUIVALENTE`: hashes canônicos iguais; não requer ação.", "- `DIVERGENTE_BLOQUEAR`: mesmo ID, conteúdo diferente; nunca sobrescrever automaticamente.", "- `IGNORAR`: existe apenas no legado HML; não apagar nem alterar durante o seed V2 → legado.", "",
    "Os IDs foram ofuscados por hash no JSON detalhado. Esta ferramenta não possui modo de escrita; qualquer aplicação futura exigirá autorização explícita, snapshot e validação pós-execução.", "",
  ].join("\n");
  await Promise.all([writeFile(`${base}.json`, `${JSON.stringify(plan, null, 2)}\n`, "utf8"), writeFile(`${base}.md`, markdown, "utf8")]);
  return base;
}

function selfTest() {
  const source = [{ name: `${ROOT}/barbearias/${TENANT_ID}/barbeiros/b1`, fields: { ativo: { booleanValue: true } } }];
  const same = [{ name: `${ROOT}/barbeiros/b1`, fields: { ativo: { booleanValue: true } } }];
  const changed = [{ name: `${ROOT}/barbeiros/b1`, fields: { ativo: { booleanValue: false } } }];
  if (compareDocuments(source, same)[0].state !== "EQUIVALENTE" || compareDocuments(source, changed)[0].state !== "DIVERGENTE" || compareDocuments(source, [])[0].state !== "AUSENTE") throw new Error("self-test falhou");
  console.log("Self-test aprovado: planejador é somente leitura e classifica equivalência corretamente.");
}

const args = parseArgs(process.argv.slice(2));
if (args.selfTest) selfTest();
else {
  const token = process.env.HML_LEGACY_SEED_ACCESS_TOKEN;
  if (!token) usage("defina HML_LEGACY_SEED_ACCESS_TOKEN com token temporário e limitado do projeto teste-483f6");
  else {
    const plan = await buildPlan(args.scope, token);
    const base = await writeReports(plan);
    console.log(`Plano gerado: ${base}.{md,json}`);
    console.log(`Ausentes: ${plan.totals.AUSENTE}; divergentes: ${plan.totals.DIVERGENTE}; nenhuma escrita foi realizada.`);
  }
}
