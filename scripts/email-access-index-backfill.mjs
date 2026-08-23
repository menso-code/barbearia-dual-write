#!/usr/bin/env node

import { createHash } from "node:crypto";

const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ALLOWED_PROJECTS = new Set(["teste-483f6", "barber-a01e7"]);

export function normalizeEmail(value) { return String(value ?? "").trim().toLowerCase(); }
export function indexDocId(email) { return createHash("sha256").update(normalizeEmail(email)).digest("hex"); }
export function indexPath(email) { return `barbearias/${TENANT}/email_acesso_index/${indexDocId(email)}`; }
export function fingerprint(email) { return createHash("sha256").update(normalizeEmail(email)).digest("hex").slice(0, 16); }

function args(argv = process.argv) {
  const projectArg = argv.find((value) => value.startsWith("--project="));
  const expectArg = argv.find((value) => value.startsWith("--expect-create-count="));
  const operationArg = argv.find((value) => value.startsWith("--operation="));
  return { project: projectArg ? projectArg.slice("--project=".length) : "", dryRun: argv.includes("--dry-run"), apply: argv.includes("--apply"), confirmHmlWrite: argv.includes("--confirm-hml-write"), confirmProductionRead: argv.includes("--confirm-production-read"), confirmProductionWrite: argv.includes("--confirm-production-write"), operation: operationArg ? operationArg.slice("--operation=".length) : "", expectCreateCount: expectArg ? Number(expectArg.slice("--expect-create-count=".length)) : null, selfTest: argv.includes("--self-test") };
}
function decode(value) {
  if (!value) return null;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.timestampValue !== undefined) return value.timestampValue;
  return null;
}
function fields(document) { return Object.fromEntries(Object.entries(document?.fields || {}).map(([key, value]) => [key, decode(value)])); }
function documentId(document) { return String(document?.name || "").split("/").at(-1); }
function validateArgs(options) {
  if (!options.dryRun && !options.apply) throw new Error("Use --dry-run ou --apply.");
  if (!ALLOWED_PROJECTS.has(options.project)) throw new Error("projeto não permitido");
  if (options.project === "barber-a01e7" && !options.confirmProductionRead) throw new Error("produção exige --confirm-production-read");
  if (options.apply && options.project === "teste-483f6" && !options.confirmHmlWrite) throw new Error("HML apply exige --confirm-hml-write");
  if (options.apply && options.project === "barber-a01e7" && (!options.confirmProductionWrite || options.operation !== "email-access-index-backfill")) throw new Error("produção apply exige --confirm-production-write e --operation=email-access-index-backfill");
  if (options.expectCreateCount !== null && (!Number.isInteger(options.expectCreateCount) || options.expectCreateCount < 0)) throw new Error("--expect-create-count inválido");
}
function classifyBarbers(legacyDocuments, v2Documents, indexDocuments) {
  const legacy = new Map(legacyDocuments.map((doc) => [documentId(doc), { id: documentId(doc), ...fields(doc) }]));
  const v2 = new Map(v2Documents.map((doc) => [documentId(doc), { id: documentId(doc), ...fields(doc) }]));
  const expected = new Map();
  const conflicts = [];
  const rows = [];
  for (const barber of legacy.values()) {
    const email = normalizeEmail(barber.email_acesso);
    const counterpart = v2.get(barber.id);
    if (!email) { rows.push({ barberId: barber.id, classification: "SKIP", reason: "EMAIL_AUSENTE" }); continue; }
    if (!/^\S+@\S+\.\S+$/.test(email)) { rows.push({ barberId: barber.id, classification: "INVALID", reason: "EMAIL_INVALIDO", emailFingerprint: fingerprint(email) }); continue; }
    if (!counterpart || normalizeEmail(counterpart.email_acesso) !== email) {
      rows.push({ barberId: barber.id, classification: "CONFLICT", reason: "LEGADO_V2_EMAIL_DIVERGENTE", emailFingerprint: fingerprint(email) });
      conflicts.push(rows.at(-1)); continue;
    }
    const path = indexPath(email); const docId = indexDocId(email); const prior = expected.get(docId);
    if (prior && prior.barberId !== barber.id) {
      rows.push({ barberId: barber.id, classification: "CONFLICT", reason: "EMAIL_DUPLICADO_NORMALIZADO", emailFingerprint: fingerprint(email), indexDocId: docId, expectedIndexPath: path });
      conflicts.push(rows.at(-1)); continue;
    }
    expected.set(docId, { barberId: barber.id, email });
    const existingIndex = indexDocuments.find((doc) => documentId(doc) === docId);
    if (!existingIndex) rows.push({ barberId: barber.id, classification: "SAFE_TO_BACKFILL", emailFingerprint: fingerprint(email), indexDocId: docId, expectedIndexPath: path });
    else if (fields(existingIndex).barbeiro_id !== barber.id) {
      rows.push({ barberId: barber.id, classification: "CONFLICT", reason: "INDICE_APONTA_OUTRO_BARBEIRO", emailFingerprint: fingerprint(email), indexDocId: docId, expectedIndexPath: path });
      conflicts.push(rows.at(-1));
    } else rows.push({ barberId: barber.id, classification: "NOOP", emailFingerprint: fingerprint(email), indexDocId: docId, expectedIndexPath: path });
  }
  const expectedIds = new Set(expected.keys());
  for (const doc of indexDocuments) if (!expectedIds.has(documentId(doc))) { const row = { indexDocId: documentId(doc), classification: "CONFLICT", reason: "INDICE_ORFAO" }; rows.push(row); conflicts.push(row); }
  for (const [id] of v2) if (!legacy.has(id)) { const row = { barberId: id, classification: "CONFLICT", reason: "BARBEIRO_V2_SEM_LEGADO" }; rows.push(row); conflicts.push(row); }
  return { rows, conflicts, writes: 0 };
}
function encode(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return { integerValue: String(value) };
  return { nullValue: null };
}
export function buildCreateWrites(rows, project = "teste-483f6") {
  return rows.filter((row) => row.classification === "SAFE_TO_BACKFILL").map((row) => ({
    update: {
      name: `projects/${project}/databases/(default)/documents/${row.expectedIndexPath}`,
      fields: { email_acesso: encode(row.normalizedEmail), barbeiro_id: encode(row.barberId), tenant_id: encode(TENANT) },
    },
    currentDocument: { exists: false },
    updateTransforms: [{ fieldPath: "criado_em", setToServerValue: "REQUEST_TIME" }],
  }));
}
function applyGuard(options) {
  if (!options.apply) throw new Error("apply não autorizado");
  if (options.project === "teste-483f6" && options.confirmHmlWrite) return;
  if (options.project === "barber-a01e7" && options.confirmProductionWrite && options.operation === "email-access-index-backfill") return;
  throw new Error("apply não autorizado");
}
async function getDocuments(project, path, token) {
  const root = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents`;
  const response = await fetch(`${root}/${path}?pageSize=1000`, { headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) throw new Error(`leitura HTTP ${response.status}`);
  return (await response.json()).documents || [];
}
async function commitCreates(project, token, rows) {
  const writes = buildCreateWrites(rows, project);
  if (!writes.length) return { created: 0, writes: 0 };
  const response = await fetch(`https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents:commit`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ writes }) });
  if (!response.ok) throw new Error(`commit create-only recusado: HTTP ${response.status}`);
  return { created: writes.length, writes: writes.length };
}
async function inventory(project, token) {
  return Promise.all([
    getDocuments(project, "barbeiros", token),
    getDocuments(project, `barbearias/${TENANT}/barbeiros`, token),
    getDocuments(project, `barbearias/${TENANT}/email_acesso_index`, token),
  ]);
}
function summary(result) {
  return Object.fromEntries([...new Set(result.rows.map((row) => row.classification))].map((kind) => [kind, result.rows.filter((row) => row.classification === kind).length]));
}
async function main() {
  const options = args();
  if (options.selfTest) {
    const a = [{ name: "barbeiros/a", fields: { email_acesso: { stringValue: " A@Example.com " } } }];
    const b = [{ name: "barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/barbeiros/a", fields: { email_acesso: { stringValue: "a@example.com" } } }];
    const report = classifyBarbers(a, b, []);
    if (normalizeEmail(" A@Example.com ") !== "a@example.com" || report.rows[0].classification !== "SAFE_TO_BACKFILL" || report.writes !== 0) throw new Error("self-test básico falhou");
    report.rows[0].normalizedEmail = "a@example.com";
    const writes = buildCreateWrites(report.rows);
    if (writes.length !== 1 || writes[0].currentDocument.exists !== false || writes[0].update.fields.email_acesso.stringValue !== "a@example.com") throw new Error("self-test create-only falhou");
    const duplicate = classifyBarbers([...a, { name: "barbeiros/b", fields: { email_acesso: { stringValue: "a@example.com" } } }], [...b, { name: "barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/barbeiros/b", fields: { email_acesso: { stringValue: "a@example.com" } } }], []);
    if (!duplicate.conflicts.some((item) => item.reason === "EMAIL_DUPLICADO_NORMALIZADO")) throw new Error("self-test duplicidade falhou");
    const divergent = classifyBarbers(a, b, [{ name: `${indexPath("a@example.com")}`, fields: { barbeiro_id: { stringValue: "outro" } } }]);
    if (!divergent.conflicts.some((item) => item.reason === "INDICE_APONTA_OUTRO_BARBEIRO")) throw new Error("self-test índice divergente falhou");
    const orphan = classifyBarbers(a, b, [{ name: "barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/email_acesso_index/deadbeef", fields: { barbeiro_id: { stringValue: "orphan" } } }]);
    if (!orphan.conflicts.some((item) => item.reason === "INDICE_ORFAO")) throw new Error("self-test órfão falhou");
    for (const argv of [["node", "script", "--apply", "--project=teste-483f6"], ["node", "script", "--confirm-hml-write"], ["node", "script", "--apply", "--project=barber-a01e7", "--confirm-hml-write"], ["node", "script", "--apply", "--project=barber-a01e7", "--confirm-production-write"], ["node", "script", "--apply", "--project=barber-a01e7", "--confirm-production-write", "--operation=wrong"], ["node", "script", "--apply", "--project=barber-a01e7", "--confirm-production-write", "--operation=email-access-index-backfill", "--expect-create-count=not-a-number"]]) {
      assertGuardFails(argv);
    }
    const productionApply = args(["node", "script", "--apply", "--project=barber-a01e7", "--confirm-production-read", "--confirm-production-write", "--operation=email-access-index-backfill", "--expect-create-count=1"]);
    validateArgs(productionApply);
    applyGuard(productionApply);
    console.log("email access index backfill self-test: PASS"); return;
  }
  validateArgs(options);
  if (!process.env.FIRESTORE_AUDIT_TOKEN) throw new Error("FIRESTORE_AUDIT_TOKEN ausente");
  if (options.apply) applyGuard(options);
  const token = process.env.FIRESTORE_AUDIT_TOKEN;
  const [legacy, v2, indexes] = await inventory(options.project, token);
  const result = classifyBarbers(legacy, v2, indexes);
  if (options.apply && result.conflicts.length) throw new Error(`precheck global recusado: ${result.conflicts.length} conflito(s)`);
  let effectiveResult = result;
  let effectiveLegacy = legacy;
  if (options.apply) {
    const [latestLegacy, latestV2, latestIndexes] = await inventory(options.project, token);
    effectiveLegacy = latestLegacy;
    effectiveResult = classifyBarbers(latestLegacy, latestV2, latestIndexes);
    if (effectiveResult.conflicts.length) throw new Error(`revalidação global recusada: ${effectiveResult.conflicts.length} conflito(s)`);
    const latestSafeCount = effectiveResult.rows.filter((row) => row.classification === "SAFE_TO_BACKFILL").length;
    if (options.expectCreateCount !== null && latestSafeCount !== options.expectCreateCount) throw new Error(`expectativa de criação divergente: esperado ${options.expectCreateCount}, encontrado ${latestSafeCount}`);
  }
  const safe = effectiveResult.rows.filter((row) => row.classification === "SAFE_TO_BACKFILL");
  for (const row of safe) row.normalizedEmail = normalizeEmail(effectiveLegacy.find((doc) => documentId(doc) === row.barberId)?.fields?.email_acesso?.stringValue);
  const outcome = options.apply ? await commitCreates(options.project, token, safe) : { created: 0, writes: 0 };
  console.log(JSON.stringify({ project: options.project, mode: options.apply ? "apply" : "dry-run", precheck: "PASS", safeToBackfill: safe.length, noop: effectiveResult.rows.filter((row) => row.classification === "NOOP").length, skip: effectiveResult.rows.filter((row) => row.classification === "SKIP").length, conflicts: effectiveResult.conflicts.length, created: outcome.created, writes: outcome.writes, aborted: false }, null, 2));
  if (effectiveResult.conflicts.length) process.exitCode = 2;
}
function assertGuardFails(argv) {
  const options = args(argv);
  try { validateArgs(options); if (options.apply) applyGuard(options); throw new Error("guard não falhou"); } catch (error) { if (error.message === "guard não falhou") throw error; }
}
main().catch((error) => { console.error(`BACKFILL_ABORT: ${error.message}`); process.exitCode = 1; });
