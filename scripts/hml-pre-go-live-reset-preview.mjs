#!/usr/bin/env node
/** Preview somente leitura do futuro PRE-GO-LIVE RESET HML. */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "teste-483f6";
const FORBIDDEN = "barber-a01e7";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
const MAP = new Map([
  ["clientes", "clientes"], ["barbeiros", "barbeiros"], ["servicos", "servicos"],
  ["agendamentos", "agendamentos"], ["ocupacoes", "ocupacoes"], ["bloqueios", "bloqueios"],
  ["configuracoes", "configuracoes"], ["fechamentos_globais", "fechamentos"],
  ["planos_assinatura", "planos_assinatura"], ["solicitacoes_assinatura", "assinaturas"],
  ["historico_assinaturas", "historico_assinaturas"], ["financeiro", "financeiro"],
]);
const LEGACY = [...MAP.keys(), "admins", "usuarios", "homologacao_mapeamentos", "vinculos_barbeiro"];
const TEST_IDS = new Set(["1OZRgMZpK8Eb8aCfuG07", "fxtjJbFFaZ0i86ZeRKL3"]);
const TEST_MARKER = /teste|test|hml|homolog|smoke|reagendar|cancelar|barbeiro|admin/i;

function lock() {
  if (PROJECT_ID !== "teste-483f6" || PROJECT_ID.includes(FORBIDDEN) || JSON.stringify(process.argv).includes(FORBIDDEN)) throw new Error("ABORT: projeto inválido ou produção detectada.");
  if (!process.env.FIRESTORE_ACCESS_TOKEN) throw new Error("Defina FIRESTORE_ACCESS_TOKEN efêmero somente leitura.");
}
function decode(v) { if (!v) return v; if ("stringValue" in v) return v.stringValue; if ("booleanValue" in v) return v.booleanValue; if ("integerValue" in v) return Number(v.integerValue); if ("timestampValue" in v) return v.timestampValue; if ("arrayValue" in v) return (v.arrayValue.values || []).map(decode); if ("mapValue" in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)])); return null; }
function data(d) { return Object.fromEntries(Object.entries(d.fields || {}).map(([k, v]) => [k, decode(v)])); }
function id(d) { return String(d.name || "").split("/").at(-1); }
function text(d) {
  const values = Object.values(data(d));
  return JSON.stringify(values).slice(0, 4000);
}
async function get(url) { const r = await fetch(url, { headers: { authorization: `Bearer ${process.env.FIRESTORE_ACCESS_TOKEN}` } }); const b = await r.json().catch(() => ({})); if (r.status === 404) return null; if (!r.ok) throw new Error(`${r.status}: ${b.error?.message || "Firestore"}`); return b; }
async function list(collection) { const r = await get(`${API}/${collection}?pageSize=1000`); return r?.documents || []; }
function classify(collection, d) {
  const i = id(d), raw = text(d);
  if (["configuracoes", "fechamentos_globais"].includes(collection)) return { classification: "PRESERVE", reason: "configuração operacional requer preservação; confirmar exceções manualmente" };
  if (collection === "admins") return { classification: "PRESERVE", reason: "Admin real e guarda administrativa" };
  if (collection === "homologacao_mapeamentos") return { classification: "REVIEW_REQUIRED", reason: "identidade HML; remover somente após confirmar contas de Go-Live" };
  if (collection === "barbeiros" && TEST_IDS.has(i)) return { classification: "REMOVE_TEST_DATA", reason: "barbeiro classificado anteriormente como HML_TEST_CHANGE" };
  if (["agendamentos", "ocupacoes", "bloqueios", "historico_assinaturas", "financeiro"].includes(collection)) return TEST_MARKER.test(raw) ? { classification: "REMOVE_TEST_DATA", reason: "massa operacional marcada como teste/HML" } : { classification: "REVIEW_REQUIRED", reason: "operação sem marcador inequívoco; preservar até revisão" };
  if (["solicitacoes_assinatura", "planos_assinatura", "servicos"].includes(collection)) return TEST_MARKER.test(raw) ? { classification: "REMOVE_TEST_DATA", reason: "registro contém marcador de teste/HML" } : { classification: "PRESERVE", reason: "catálogo/solicitação sem marcador inequívoco de teste" };
  if (collection === "clientes" || collection === "usuarios" || collection === "vinculos_barbeiro") return TEST_MARKER.test(raw) ? { classification: "REMOVE_TEST_DATA", reason: "identidade marcada como teste/HML" } : { classification: "REVIEW_REQUIRED", reason: "identidade sem prova suficiente para remoção" };
  return { classification: "REVIEW_REQUIRED", reason: "coleção fora da regra segura" };
}
async function main() {
  lock(); const rows = []; const byCollection = {};
  for (const c of LEGACY) { const docs = await list(c); byCollection[c] = docs.length; for (const d of docs) { const result = classify(c, d); rows.push({ collection: c, id: id(d), classification: result.classification, reason: result.reason, v2_path: MAP.has(c) ? `barbearias/${TENANT_ID}/${MAP.get(c)}/${id(d)}` : null }); } }
  const counts = Object.fromEntries(["PRESERVE", "REMOVE_TEST_DATA", "REVIEW_REQUIRED"].map(k => [k, rows.filter(x => x.classification === k).length]));
  const report = { kind: "HML_PRE_GO_LIVE_RESET_PREVIEW", generated_at: new Date().toISOString(), project_id: PROJECT_ID, tenant_id: TENANT_ID, firestore_methods: ["GET", "LIST"], writes: 0, counts, collection_totals: byCollection, items: rows, expected_after_future_reset: { agendamentos_test: 0, ocupacoes_test: 0, assinaturas_test: 0, creditos_test: 0, financeiro_test: 0, real_configuration_preserved: true, real_catalog_preserved: true, real_identities_preserved: true }, future_mechanism: { snapshot: "imutável, somente após aprovação, com hashes e IDs", application: "allowlist explícita, idempotente, legado+V2 na mesma operação", validation: "reconciliação GET/LIST pós-reset e integridade referencial", rollback: "restauração somente a partir do snapshot aprovado, nunca automática" }, applied: false, gate: "PREVIEW_ONLY_AWAITING_EXPLICIT_RESET_AUTHORIZATION" };
  const dir = path.resolve("reports", "dual-write"); await mkdir(dir, { recursive: true }); const file = path.join(dir, `PRE_GO_LIVE_RESET_PREVIEW_${report.generated_at.replace(/[:.]/g, "-")}.json`); await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8"); console.log(JSON.stringify({ file, project_id: PROJECT_ID, counts, writes: 0, applied: false }, null, 2));
}
main().catch(e => { console.error(`PREVIEW INTERROMPIDO: ${e.message}`); process.exitCode = 1; });
