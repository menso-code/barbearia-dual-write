#!/usr/bin/env node
/**
 * Reconciliação HML somente leitura.
 *
 * Travas: projeto fixo teste-483f6; nenhuma API de escrita; nenhum fallback
 * para produção. O token deve ser efêmero e fornecido por FIRESTORE_ACCESS_TOKEN.
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "teste-483f6";
const FORBIDDEN_PROJECT = "barber-a01e7";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
const COLLECTIONS = new Map([
  ["clientes", "clientes"], ["barbeiros", "barbeiros"], ["servicos", "servicos"],
  ["agendamentos", "agendamentos"], ["ocupacoes", "ocupacoes"], ["bloqueios", "bloqueios"],
  ["configuracoes", "configuracoes"], ["fechamentos_globais", "fechamentos"],
  ["planos_assinatura", "planos_assinatura"], ["solicitacoes_assinatura", "assinaturas"],
  ["historico_assinaturas", "historico_assinaturas"], ["financeiro", "financeiro"],
]);
const LEGACY_COLLECTIONS = [...COLLECTIONS.keys(), "admins", "vinculos_barbeiro", "usuarios"];

function assertLocked() {
  if (PROJECT_ID !== "teste-483f6") throw new Error("ABORT: projeto HML inválido.");
  if (PROJECT_ID.includes(FORBIDDEN_PROJECT) || ROOT.includes(FORBIDDEN_PROJECT) || JSON.stringify(process.argv).includes(FORBIDDEN_PROJECT)) {
    throw new Error("ABORT: referência a projeto de produção detectada.");
  }
  if (!process.env.FIRESTORE_ACCESS_TOKEN) throw new Error("Defina FIRESTORE_ACCESS_TOKEN com token efêmero somente leitura.");
}

function decode(value) {
  if (value == null) return value;
  if ("nullValue" in value) return null;
  if ("stringValue" in value) return value.stringValue;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return value.doubleValue;
  if ("timestampValue" in value) return value.timestampValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decode);
  if ("mapValue" in value) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decode(v)]));
  return undefined;
}
function fields(document) { return Object.fromEntries(Object.entries(document?.fields || {}).map(([k, v]) => [k, decode(v)])); }
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
}
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function id(document) { return String(document.name || "").split("/").at(-1); }
function legacyPath(collection, documentId) { return `${API}/${collection}/${encodeURIComponent(documentId)}`; }
function v2Path(collection, documentId) { return `${API}/barbearias/${TENANT_ID}/${collection}/${encodeURIComponent(documentId)}`; }

async function get(url) {
  const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${process.env.FIRESTORE_ACCESS_TOKEN}` } });
  const body = await response.json().catch(() => ({}));
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`GET ${response.status}: ${body.error?.message || "Firestore"}`);
  return body;
}
async function list(collectionPath) {
  const result = [];
  let pageToken = "";
  do {
    const suffix = pageToken ? `?pageSize=1000&pageToken=${encodeURIComponent(pageToken)}` : "?pageSize=1000";
    const url = `${API}/${collectionPath}${suffix}`;
    const page = await get(url);
    result.push(...(page?.documents || []));
    pageToken = page?.nextPageToken || "";
  } while (pageToken);
  return result;
}

async function main() {
  assertLocked();
  const legacy = {};
  for (const collection of LEGACY_COLLECTIONS) legacy[collection] = await list(collection);
  const totals = {};
  const equivalent = [], missing = [], divergent = [], v2Only = [];
  for (const [legacyCollection, v2Collection] of COLLECTIONS) {
    const source = legacy[legacyCollection] || [];
    const v2Docs = await list(`barbearias/${TENANT_ID}/${v2Collection}`);
    const v2ById = Object.fromEntries(v2Docs.map((doc) => [id(doc), doc]));
    const legacyIds = new Set(source.map(id));
    const bucket = { legacy: source.length, v2: v2Docs.length, equivalent: 0, missing_v2: 0, divergent: 0, extra_v2: 0 };
    for (const doc of source) {
      const other = v2ById[id(doc)];
      if (!other) { bucket.missing_v2++; missing.push({ collection: legacyCollection, id: id(doc) }); continue; }
      if (same(fields(doc), fields(other))) { bucket.equivalent++; equivalent.push(`${legacyCollection}/${id(doc)}`); }
      else { bucket.divergent++; divergent.push({ collection: legacyCollection, id: id(doc) }); }
    }
    for (const doc of v2Docs) if (!legacyIds.has(id(doc))) { bucket.extra_v2++; v2Only.push({ collection: v2Collection, id: id(doc) }); }
    totals[legacyCollection] = bucket;
  }
  const occupancy = { orphan_legacy: [], orphan_v2: [], inconsistent: [] };
  const subscriptions = { inconsistent: [], duplicate_credits: [] };
  const finance = { inconsistent: [], status: "NOT_DETERMINED" };
  const report = {
    kind: "HML_DUAL_WRITE_RECONCILIATION_READ_ONLY", generated_at: new Date().toISOString(),
    project_id: PROJECT_ID, tenant_id: TENANT_ID, firestore_methods: ["GET", "LIST"], writes: 0,
    totals, summary: { legacy: Object.values(totals).reduce((n, x) => n + x.legacy, 0), v2: Object.values(totals).reduce((n, x) => n + x.v2, 0), equivalent: equivalent.length, missing_v2: missing.length, divergent: divergent.length, extra_v2: v2Only.length },
    missing_v2: missing, divergent, extra_v2: v2Only, integrity: { occupancy, subscriptions, finance },
    gate: missing.length || divergent.length || v2Only.length ? "DUAL_WRITE_BLOQUEADO" : "DUAL_WRITE_HOMOLOGADO",
    known_pending: "agenda.criar — prova explícita de reexecução com o mesmo requestId pendente de evidência.",
  };
  const dir = path.resolve("reports", "dual-write"); await mkdir(dir, { recursive: true });
  const output = path.join(dir, `hml-dual-write-reconciliation-${report.generated_at.replace(/[:.]/g, "-")}.json`);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({ output, project_id: PROJECT_ID, summary: report.summary, gate: report.gate, writes: 0 }, null, 2));
}

main().catch((error) => { console.error(`AUDITORIA INTERROMPIDA: ${error.message}`); process.exitCode = 1; });
