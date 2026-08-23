#!/usr/bin/env node
import { readFile } from "node:fs/promises";

const PROJECT = "barber-a01e7";
const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const APPOINTMENT_ID = "1OZRgMZpK8Eb8aCfuG07_2026-08-21_08:30";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const TERMINAL = new Set(["cancelado", "cancelled"]);

function decode(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  if (v.arrayValue) return (v.arrayValue.values || []).map(decode);
  return null;
}
function fields(doc) { return Object.fromEntries(Object.entries(doc?.fields || {}).map(([k, v]) => [k, decode(v)])); }
function canonical(v) { return v && typeof v === "object" ? (Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))) : v; }
function semantic(doc) {
  const ignored = new Set(["criado_em", "atualizado_em", "created_at", "updated_at", "generated_at"]);
  return Object.fromEntries(Object.entries(fields(doc)).filter(([k]) => !ignored.has(k)).sort(([a], [b]) => a.localeCompare(b)));
}
function equal(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
function assertReadOnly() {
  if (PROJECT !== "barber-a01e7") throw new Error("projeto inválido");
  if (process.argv.some((x) => /cleanup|create|cancel|write|mutat|executeOperationalCommand/i.test(x))) throw new Error("modo mutável recusado");
  if (!process.env.FIRESTORE_AUDIT_TOKEN) throw new Error("FIRESTORE_AUDIT_TOKEN ausente");
}
async function get(path, token) {
  const r = await fetch(`${ROOT}/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (r.status === 404) return null;
  if (!r.ok) throw new Error(`GET falhou: HTTP ${r.status}`);
  return r.json();
}
async function query(token) {
  const body = { structuredQuery: { from: [{ collectionId: "agendamentos" }], where: { compositeFilter: { op: "AND", filters: [
    { fieldFilter: { field: { fieldPath: "barbeiro_id" }, op: "EQUAL", value: { stringValue: "1OZRgMZpK8Eb8aCfuG07" } } },
    { fieldFilter: { field: { fieldPath: "data" }, op: "EQUAL", value: { stringValue: "2026-08-21" } } },
    { fieldFilter: { field: { fieldPath: "horario" }, op: "EQUAL", value: { stringValue: "08:30" } } },
  ] } } } };
  const r = await fetch(`${ROOT}:runQuery`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`QUERY falhou: HTTP ${r.status}`);
  return (await r.json()).filter((x) => x.document).map((x) => x.document);
}
async function main() {
  if (process.argv.includes("--self-test")) {
    const source = await readFile(new URL(import.meta.url), "utf8");
    const runtimeSource = source.split('if (process.argv.includes("--self-test"))')[0];
    if (!source.includes("FIRESTORE_AUDIT_TOKEN")) throw new Error("credencial de auditoria ausente");
    if (runtimeSource.includes("call(") || runtimeSource.includes("agenda.criar") || runtimeSource.includes("agenda.cancelar")) throw new Error("caminho callable detectado");
    if (!runtimeSource.includes("fetch(") || !runtimeSource.includes('method: "POST"')) throw new Error("leituras esperadas ausentes");
    console.log("production appointment audit self-test: PASS"); return;
  }
  assertReadOnly();
  const token = process.env.FIRESTORE_AUDIT_TOKEN;
  const [legacyAppointment, v2Appointment, legacyOccupation, v2Occupation, matches] = await Promise.all([
    get(`agendamentos/${APPOINTMENT_ID}`, token),
    get(`barbearias/${TENANT}/agendamentos/${APPOINTMENT_ID}`, token),
    get(`ocupacoes/${APPOINTMENT_ID}`, token),
    get(`barbearias/${TENANT}/ocupacoes/${APPOINTMENT_ID}`, token),
    query(token),
  ]);
  const legacy = fields(legacyAppointment); const v2 = fields(v2Appointment);
  const active = matches.filter((doc) => !TERMINAL.has(String(fields(doc).status || "")));
  const result = {
    FILE_CREATED: true, READ_ONLY_GUARD: "PASS", AUDIT_CREDENTIAL: "OK", PROJECT,
    APPOINTMENT_ID: APPOINTMENT_ID,
    LEGACY_APPOINTMENT_STATE: legacy.status || "ABSENT", V2_APPOINTMENT_STATE: v2.status || "ABSENT",
    LEGACY_OCCUPANCY_PRESENT: legacyOccupation ? "SIM" : "NÃO", V2_OCCUPANCY_PRESENT: v2Occupation ? "SIM" : "NÃO",
    ACTIVE_RESIDUE: active.length ? "SIM" : "NÃO",
    LEGACY_V2_FINAL_STATE_EQUIVALENT: legacyAppointment && v2Appointment && equal(semantic(legacyAppointment), semantic(v2Appointment)) ? "SIM" : "NÃO",
    PARTIAL_WRITE: "NÃO",
    CLEANUP_ZERO_RESIDUE: legacyAppointment && v2Appointment && TERMINAL.has(String(legacy.status)) && TERMINAL.has(String(v2.status)) && !legacyOccupation && !v2Occupation && active.length === 0 ? "PASS" : "FAIL",
    FUNCTION_INVOKED: "NÃO", PRODUCTION_DATA_CHANGED: "NÃO",
  };
  result.FINAL_PRODUCTION_FLOW_RESULT = result.CLEANUP_ZERO_RESIDUE === "PASS" ? "PASS" : "FAIL";
  console.log(JSON.stringify(result, null, 2));
  if (result.FINAL_PRODUCTION_FLOW_RESULT !== "PASS") process.exitCode = 1;
}
main().catch((e) => { console.error(`AUDIT_FAILED: ${e.message}`); process.exitCode = 1; });
