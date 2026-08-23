#!/usr/bin/env node
/**
 * Reconciliação detalhada e SOMENTE LEITURA entre o legado e a projeção V2.
 *
 * Segurança: todas as chamadas ao Firestore neste arquivo usam GET. O único
 * arquivo criado é um relatório local em reports/dual-read/. Não há commit,
 * batch, PATCH, POST ou DELETE para o Firestore.
 *
 * Uso (credencial com datastore.entities.get e datastore.entities.list):
 *   $env:GOOGLE_APPLICATION_CREDENTIALS='C:\\caminho-seguro\\leitura.json'
 *   node scripts/dual-read-reconciliation.mjs
 *
 * Alternativa sem arquivo local:
 *   $env:FIRESTORE_ACCESS_TOKEN='<token-somente-leitura>'
 *   node scripts/dual-read-reconciliation.mjs
 */

import { createSign } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "barber-a01e7";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const BASELINE_AT = "2026-08-18T05:07:26.392Z";
const SCOPE = "https://www.googleapis.com/auth/datastore";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const BASE_URL = `https://firestore.googleapis.com/v1/${ROOT}`;
const LEGACY = [
  "admins", "vinculos_barbeiro", "clientes", "barbeiros", "servicos",
  "agendamentos", "ocupacoes", "bloqueios", "configuracoes",
  "fechamentos_globais", "planos_assinatura", "solicitacoes_assinatura",
  "historico_assinaturas",
];
const MAP = new Map([
  ["clientes", "clientes"], ["barbeiros", "barbeiros"], ["servicos", "servicos"],
  ["agendamentos", "agendamentos"], ["ocupacoes", "ocupacoes"], ["bloqueios", "bloqueios"],
  ["configuracoes", "configuracoes"], ["fechamentos_globais", "fechamentos"],
  ["planos_assinatura", "planos_assinatura"], ["solicitacoes_assinatura", "assinaturas"],
  ["historico_assinaturas", "historico_assinaturas"],
]);
const SENSITIVE_KEY = /(^|_)(nome|email|telefone|phone|whatsapp|foto|photo|endereco|address)(_|$)/i;

function base64Url(value) { return Buffer.from(value).toString("base64url"); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  return value;
}
function equal(left, right) { return JSON.stringify(canonical(left || {})) === JSON.stringify(canonical(right || {})); }
function decode(value) {
  if (value == null) return value;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "referenceValue")) return value.referenceValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(decode);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decode(item)]));
  return undefined;
}
function encode(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encode) } };
  if (value && typeof value === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encode(item)])) } };
  throw new Error(`Tipo não suportado: ${typeof value}`);
}
function docId(document) { return String(document.name || "").split("/").at(-1); }
function archived(document) {
  const item = Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decode(value)]));
  return item.status === "legacy_unresolved" && item.arquivado_legado === true && item.excluir_migracao === true && typeof item.motivo_arquivamento === "string" && item.motivo_arquivamento.length > 0;
}
function tenantPath(collection, id) { return `${ROOT}/barbearias/${TENANT_ID}/${collection}/${id}`; }
function identityFields(item) {
  const allowed = ["nome", "nome_completo", "email", "foto_url", "photoURL", "criado_em", "created_at"];
  return Object.fromEntries(allowed.filter((key) => item[key] !== undefined).map((key) => [key, encode(item[key])]));
}
function redacted(value, key = "") {
  if (SENSITIVE_KEY.test(key)) return "[REDACTED]";
  if (Array.isArray(value)) return value.map((item) => redacted(item));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, redacted(item, childKey)]));
  return value;
}
function fieldDiff(expected, actual) {
  const keys = new Set([...Object.keys(expected || {}), ...Object.keys(actual || {})]);
  return [...keys].sort().flatMap((key) => equal(expected?.[key], actual?.[key]) ? [] : [{
    field: key,
    legacy: redacted(decode(expected?.[key]), key),
    v2: redacted(decode(actual?.[key]), key),
  }]);
}
function classify(source, updateTime) {
  if (updateTime && new Date(updateTime) > new Date(BASELINE_AT)) {
    return { classification: "ALTERACAO_OPERACIONAL_APOS_CUTOVER", recommendation: "REQUER_SINCRONIZACAO_INCREMENTAL" };
  }
  if (String(source).startsWith("generated/")) {
    return { classification: "INCONCLUSIVA", recommendation: "REQUER_DECISAO_MANUAL" };
  }
  return { classification: "INCONCLUSIVA", recommendation: "RECONCILIACAO_AUTOMATICA_POSSIVEL_APOS_REVISAO" };
}

async function token() {
  if (process.env.FIRESTORE_ACCESS_TOKEN) return process.env.FIRESTORE_ACCESS_TOKEN;
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error("Defina GOOGLE_APPLICATION_CREDENTIALS ou FIRESTORE_ACCESS_TOKEN de somente leitura.");
  const account = JSON.parse(await readFile(credentialPath, "utf8"));
  if (account.project_id !== PROJECT_ID || !account.client_email || !account.private_key) throw new Error("A credencial não é uma conta válida de leitura do projeto barber-a01e7.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: account.client_email, scope: SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const assertion = `${header}.${payload}.${createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(account.private_key, "base64url")}`;
  const response = await fetch("https://oauth2.googleapis.com/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion }) });
  const result = await response.json();
  if (!response.ok || !result.access_token) throw new Error(`Não foi possível obter token de leitura: ${result.error_description || result.error || response.status}`);
  return result.access_token;
}
async function get(url, accessToken) {
  const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${accessToken}` } });
  const result = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`${response.status}: ${result.error?.message || "Falha ao ler Firestore"}`);
  return result;
}
async function list(collection, accessToken) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE_URL}/${collection.split("/").map(encodeURIComponent).join("/")}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await get(url, accessToken);
    documents.push(...(page?.documents || []));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return documents;
}

function projection(source) {
  const expected = new Map();
  const members = new Map();
  const identities = new Map();
  const add = (name, fields, sourceRef, updateTime = null) => expected.set(name, { name, fields: canonical(fields), source: sourceRef, updateTime });
  for (const [legacy, target] of MAP) for (const document of source.get(legacy) || []) {
    if (legacy === "agendamentos" && archived(document)) continue;
    add(tenantPath(target, docId(document)), document.fields || {}, `${legacy}/${docId(document)}`, document.updateTime);
  }
  const addRole = (uid, role, barberId = "") => {
    if (!uid) return;
    const current = members.get(String(uid)) || { roles: new Set(), barberIds: new Set(), latest: null };
    current.roles.add(role); if (barberId) current.barberIds.add(barberId); members.set(String(uid), current);
  };
  for (const document of source.get("clientes") || []) { const item = Object.fromEntries(Object.entries(document.fields || {}).map(([k, v]) => [k, decode(v)])); addRole(docId(document), "CLIENTE"); identities.set(docId(document), { ...(identities.get(docId(document)) || {}), ...identityFields(item) }); }
  for (const document of source.get("admins") || []) { const item = Object.fromEntries(Object.entries(document.fields || {}).map(([k, v]) => [k, decode(v)])); addRole(docId(document), "ADMIN"); identities.set(docId(document), { ...(identities.get(docId(document)) || {}), ...identityFields(item) }); }
  for (const document of source.get("barbeiros") || []) { const item = Object.fromEntries(Object.entries(document.fields || {}).map(([k, v]) => [k, decode(v)])); if (item.uid_usuario) { addRole(item.uid_usuario, "BARBEIRO", docId(document)); identities.set(String(item.uid_usuario), { ...(identities.get(String(item.uid_usuario)) || {}), ...identityFields(item) }); } }
  for (const [uid, member] of members) {
    const barberId = [...member.barberIds][0];
    add(`${ROOT}/barbearias/${TENANT_ID}/membros/${uid}`, Object.fromEntries(Object.entries({ uid, papeis: [...member.roles].sort(), ativo: true, ...(barberId ? { barbeiro_id: barberId } : {}), origem_migracao: "legacy-antunes-v1" }).map(([k, v]) => [k, encode(v)])), "generated/member");
    add(`${ROOT}/usuarios/${uid}`, { uid: encode(uid), ...(identities.get(uid) || {}), origem_migracao: encode("legacy-antunes-v1") }, "generated/identity");
  }
  add(`${ROOT}/barbearias/${TENANT_ID}`, Object.fromEntries(Object.entries({ tenant_id: TENANT_ID, nome: "Barbearia Antunes", slug: "antunes", logo: "", ativa: true, status: "ACTIVE", plano: "ATUAL", dominio: "barber-a01e7.web.app", timezone: "America/Sao_Paulo", schema: 2, ambiente: "PRODUCAO" }).map(([k, v]) => [k, encode(v)])), "generated/tenant");
  return expected;
}

async function main() {
  const startedAt = new Date();
  const accessToken = await token();
  const source = new Map();
  for (const collection of LEGACY) source.set(collection, await list(collection, accessToken));
  const expected = projection(source);
  const missing = [], divergent = [], equivalent = [];
  for (const item of expected.values()) {
    const actual = await get(`https://firestore.googleapis.com/v1/${item.name}`, accessToken);
    if (!actual) missing.push({ collection: item.name.split("/").at(-2), path: item.name, id: item.name.split("/").at(-1), tenant_id: TENANT_ID, source: item.source, legacy_update_time: item.updateTime || null, ...classify(item.source, item.updateTime) });
    else if (!equal(item.fields, actual.fields || {})) divergent.push({ collection: item.name.split("/").at(-2), path: item.name, id: item.name.split("/").at(-1), tenant_id: TENANT_ID, source: item.source, legacy_update_time: item.updateTime || null, v2_update_time: actual.updateTime || null, fields_different: fieldDiff(item.fields, actual.fields || {}), ...classify(item.source, item.updateTime) });
    else equivalent.push(item.name);
  }
  const scopes = ["usuarios", `barbearias/${TENANT_ID}/membros`, ...new Set([...MAP.values()].map((collection) => `barbearias/${TENANT_ID}/${collection}`))];
  const unexpected = [];
  for (const scope of scopes) for (const document of await list(scope, accessToken)) if (!expected.has(document.name)) unexpected.push({ collection: scope.split("/").at(-1), path: document.name, id: docId(document), tenant_id: TENANT_ID, classification: "INCONCLUSIVA", recommendation: "REQUER_DECISAO_MANUAL" });
  const report = {
    kind: "DUAL_READ_RECONCILIATION_READ_ONLY", generated_at: new Date().toISOString(), project_id: PROJECT_ID, tenant_id: TENANT_ID,
    baseline_equivalence_at: BASELINE_AT, firestore_operations: ["GET"], firestore_writes: 0,
    summary: { expected: expected.size, equivalent: equivalent.length, missing: missing.length, divergent: divergent.length, unexpected: unexpected.length, status: missing.length || divergent.length || unexpected.length ? "RECONCILIATION_REQUIRED" : "EQUIVALENT" },
    missing, divergent, unexpected,
    recommendation: "Nenhuma sincronização deve ser executada até a revisão humana deste relatório.",
    elapsed_ms: Date.now() - startedAt.getTime(),
  };
  const dir = path.join("reports", "dual-read"); await mkdir(dir, { recursive: true });
  const stamp = report.generated_at.replace(/[:.]/g, "-"); const jsonPath = path.join(dir, `dual-read-reconciliation-${stamp}.json`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  const markdownPath = path.join(dir, "DUAL_READ_RECONCILIATION_REPORT.md");
  const listItems = (items) => items.length ? items.map((item) => `- \`${item.path}\` — ${item.classification}; ${item.recommendation}.`).join("\n") : "- Nenhum.";
  await writeFile(markdownPath, `# Reconciliação do Dual Read — Produção\n\nGerado em: ${report.generated_at}\n\n## Garantias\n\n- Operações no Firestore: somente GET.\n- Escritas no Firestore: 0.\n- Nenhuma flag, Rule, frontend ou deploy foi alterado.\n\n## Resultado\n\n| Esperados | Equivalentes | Ausentes | Divergentes | Extras V2 |\n| ---: | ---: | ---: | ---: | ---: |\n| ${report.summary.expected} | ${report.summary.equivalent} | ${report.summary.missing} | ${report.summary.divergent} | ${report.summary.unexpected} |\n\n## Ausentes na V2\n\n${listItems(missing)}\n\n## Divergentes\n\n${listItems(divergent)}\n\n## Extras na V2\n\n${listItems(unexpected)}\n\n## Próxima decisão\n\n${report.recommendation}\n`, "utf8");
  console.log(`Reconciliação somente leitura concluída. JSON: ${jsonPath}`); console.log(`Resumo: ${JSON.stringify(report.summary)}`);
}

main().catch((error) => { console.error(`ERRO: ${error.message}`); process.exitCode = 1; });
