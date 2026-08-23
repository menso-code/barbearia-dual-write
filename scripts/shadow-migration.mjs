#!/usr/bin/env node
/**
 * Migração V2 com duas entradas protegidas:
 * - padrão: produção (somente leitura) -> homologação;
 * - MIGRATION_ENVIRONMENT=production: cutover dentro de produção.
 *
 * O modo padrão falha fechado fora de `teste-483f6`. O modo de produção
 * exige confirmação exclusiva, mantém tenancy.mode=legacy e suporta rollback
 * apenas enquanto o estado migrado permanecer exatamente intacto.
 *
 * Modos:
 *   node scripts/shadow-migration.mjs --self-test
 *   node scripts/shadow-migration.mjs --dry-run
 *   node scripts/shadow-migration.mjs --apply --confirm SHADOW_MIGRATION_HML_APPROVED
 *   node scripts/shadow-migration.mjs --validate
 *   node scripts/production-cutover.mjs --rollback --confirm PRODUCTION_CUTOVER_ROLLBACK_APPROVED
 *   node scripts/production-cutover.mjs --sync-current --confirm PRODUCTION_V2_INCREMENTAL_SYNC_APPROVED
 *   node scripts/production-cutover.mjs --sync-reconciliation --confirm PRODUCTION_V2_RECONCILIATION_SYNC_APPROVED
 *
 * Credenciais (arquivos fora do repositório):
 *   SHADOW_SOURCE_CREDENTIALS = conta somente leitura de barber-a01e7
 *   SHADOW_TARGET_CREDENTIALS = conta temporária de escrita de teste-483f6
 */

import { createHash, createSign } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PRODUCTION_CUTOVER = process.env.MIGRATION_ENVIRONMENT === "production";
const SOURCE_PROJECT = "barber-a01e7";
const TARGET_PROJECT = PRODUCTION_CUTOVER ? "barber-a01e7" : "teste-483f6";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const TENANT_SLUG = "antunes";
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const SOURCE_ROOT = `projects/${SOURCE_PROJECT}/databases/(default)/documents`;
const TARGET_ROOT = `projects/${TARGET_PROJECT}/databases/(default)/documents`;
const SOURCE_URL = `https://firestore.googleapis.com/v1/${SOURCE_ROOT}`;
const TARGET_URL = `https://firestore.googleapis.com/v1/${TARGET_ROOT}`;
const TARGET_COMMIT_URL = `https://firestore.googleapis.com/v1/projects/${TARGET_PROJECT}/databases/(default)/documents:commit`;
const CONFIRMATION = PRODUCTION_CUTOVER
  ? "PRODUCTION_CUTOVER_V2_APPROVED"
  : "SHADOW_MIGRATION_HML_APPROVED";
const ROLLBACK_CONFIRMATION = "PRODUCTION_CUTOVER_ROLLBACK_APPROVED";
const INCREMENTAL_SYNC_CONFIRMATION = "PRODUCTION_V2_INCREMENTAL_SYNC_APPROVED";
const RECONCILIATION_SYNC_CONFIRMATION = "PRODUCTION_V2_RECONCILIATION_SYNC_APPROVED";
// Base operacional atualizada após os quatro atendimentos transacionais
// documentados na Fase v2.2; os cinco registros legacy_unresolved continuam fora.
const EXPECTED_OPERATIONAL_APPOINTMENTS = 52;

const COLLECTIONS = [
  "admins", "vinculos_barbeiro", "clientes", "barbeiros", "servicos",
  "agendamentos", "ocupacoes", "bloqueios", "configuracoes",
  "fechamentos_globais", "planos_assinatura", "solicitacoes_assinatura",
  "historico_assinaturas",
];

const COLLECTION_MAP = new Map([
  ["clientes", "clientes"],
  ["barbeiros", "barbeiros"],
  ["servicos", "servicos"],
  ["agendamentos", "agendamentos"],
  ["ocupacoes", "ocupacoes"],
  ["bloqueios", "bloqueios"],
  ["configuracoes", "configuracoes"],
  ["fechamentos_globais", "fechamentos"],
  ["planos_assinatura", "planos_assinatura"],
  ["solicitacoes_assinatura", "assinaturas"],
  ["historico_assinaturas", "historico_assinaturas"],
]);

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, validate: false, rollback: false, syncCurrent: false, syncReconciliation: false, selfTest: false, confirm: "" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--validate") args.validate = true;
    else if (arg === "--rollback") args.rollback = true;
    else if (arg === "--sync-current") args.syncCurrent = true;
    else if (arg === "--sync-reconciliation") args.syncReconciliation = true;
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--confirm") args.confirm = argv[++i] || "";
    else if (arg.startsWith("--confirm=")) args.confirm = arg.slice(10);
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  const modes = [args.dryRun, args.apply, args.validate, args.rollback, args.syncCurrent, args.syncReconciliation, args.selfTest].filter(Boolean).length;
  if (modes !== 1) throw new Error("Escolha exatamente um modo: --dry-run, --apply, --validate, --rollback, --sync-current, --sync-reconciliation ou --self-test.");
  if (args.apply && args.confirm !== CONFIRMATION) {
    throw new Error(`Aplicação exige --confirm ${CONFIRMATION}.`);
  }
  if (args.rollback && (!PRODUCTION_CUTOVER || args.confirm !== ROLLBACK_CONFIRMATION)) {
    throw new Error(`Rollback exige modo de produção e --confirm ${ROLLBACK_CONFIRMATION}.`);
  }
  if (args.syncCurrent && (!PRODUCTION_CUTOVER || args.confirm !== INCREMENTAL_SYNC_CONFIRMATION)) {
    throw new Error(`Sincronização incremental exige produção e --confirm ${INCREMENTAL_SYNC_CONFIRMATION}.`);
  }
  if (args.syncReconciliation && (!PRODUCTION_CUTOVER || args.confirm !== RECONCILIATION_SYNC_CONFIRMATION)) {
    throw new Error(`Reconciliação incremental exige produção e --confirm ${RECONCILIATION_SYNC_CONFIRMATION}.`);
  }
  return args;
}

function assertProjectBoundary() {
  if (SOURCE_PROJECT !== "barber-a01e7") throw new Error("Origem inesperada: execução bloqueada.");
  if (PRODUCTION_CUTOVER) {
    if (TARGET_PROJECT !== "barber-a01e7") throw new Error("Destino de produção inesperado: execução bloqueada.");
  } else {
    if (TARGET_PROJECT !== "teste-483f6") throw new Error("Destino de homologação inesperado: execução bloqueada.");
    if (SOURCE_PROJECT === TARGET_PROJECT) throw new Error("Origem e destino não podem coincidir na Shadow Migration.");
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

async function accessToken(credentialPath, expectedProject, label) {
  if (!credentialPath) throw new Error(`Defina a credencial ${label}.`);
  const account = JSON.parse(await readFile(credentialPath, "utf8"));
  if (account.project_id !== expectedProject) {
    throw new Error(`${label} pertence a ${account.project_id || "projeto desconhecido"}; esperado: ${expectedProject}.`);
  }
  if (!account.client_email || !account.private_key) throw new Error(`${label} inválida.`);
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: FIRESTORE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Falha na autenticação ${label}: ${data.error_description || data.error || response.status}`);
  return data.access_token;
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`${response.status}: ${body.error?.message || "Falha no Firestore"}`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function listCollection(rootUrl, collection, token) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${rootUrl}/${encodeURIComponent(collection)}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await requestJson(url, token, { method: "GET" });
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return documents;
}

async function getDocument(name, token) {
  try {
    return await requestJson(`https://firestore.googleapis.com/v1/${name}`, token, { method: "GET" });
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

function decodeValue(value) {
  if (value == null) return value;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "referenceValue")) return value.referenceValue;
  if (Object.hasOwn(value, "bytesValue")) return value.bytesValue;
  if (Object.hasOwn(value, "geoPointValue")) return value.geoPointValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(decodeValue);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decodeValue(item)]),
  );
  return undefined;
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") return {
    mapValue: { fields: Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).map(([k, v]) => [k, encodeValue(v)])) },
  };
  throw new Error(`Tipo não suportado: ${typeof value}`);
}

function decoded(document) {
  return {
    id: String(document.name || "").split("/").at(-1),
    ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, value]) => [key, decodeValue(value)])),
  };
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonical(value[key])]),
  );
  return value;
}

function fieldsEqual(left, right) {
  return JSON.stringify(canonical(left || {})) === JSON.stringify(canonical(right || {}));
}

function archivedLegacyAppointment(document) {
  const item = decoded(document);
  return item.status === "legacy_unresolved"
    && item.arquivado_legado === true
    && item.excluir_migracao === true
    && typeof item.motivo_arquivamento === "string"
    && item.motivo_arquivamento.length > 0;
}

function targetName(collection, id) {
  return `${TARGET_ROOT}/barbearias/${TENANT_ID}/${collection}/${id}`;
}

function writePlanItem(name, fields, source = "generated") {
  return { name, fields: canonical(fields), source };
}

function addRole(members, uid, role, barberId = "") {
  if (!uid) return;
  const key = String(uid);
  const current = members.get(key) || { papeis: new Set(), barbeiro_ids: new Set() };
  current.papeis.add(role);
  if (barberId) current.barbeiro_ids.add(barberId);
  members.set(key, current);
}

function identityFields(item) {
  const allowed = ["nome", "nome_completo", "email", "foto_url", "photoURL", "criado_em", "created_at"];
  return Object.fromEntries(allowed.filter((key) => item[key] !== undefined).map((key) => [key, encodeValue(item[key])]));
}

function buildProjection(source) {
  const plan = [];
  const excluded = [];
  const members = new Map();
  const identities = new Map();

  for (const [legacy, target] of COLLECTION_MAP) {
    for (const document of source[legacy] || []) {
      if (legacy === "agendamentos" && archivedLegacyAppointment(document)) {
        excluded.push({ id: decoded(document).id, reason: decoded(document).motivo_arquivamento });
        continue;
      }
      plan.push(writePlanItem(targetName(target, decoded(document).id), document.fields || {}, `${legacy}/${decoded(document).id}`));
    }
  }

  for (const document of source.clientes || []) {
    const item = decoded(document);
    addRole(members, item.id, "CLIENTE");
    identities.set(item.id, { ...(identities.get(item.id) || {}), ...identityFields(item) });
  }
  for (const document of source.admins || []) {
    const item = decoded(document);
    addRole(members, item.id, "ADMIN");
    identities.set(item.id, { ...(identities.get(item.id) || {}), ...identityFields(item) });
  }
  for (const document of source.barbeiros || []) {
    const item = decoded(document);
    if (!item.uid_usuario) continue;
    addRole(members, item.uid_usuario, "BARBEIRO", item.id);
    identities.set(String(item.uid_usuario), { ...(identities.get(String(item.uid_usuario)) || {}), ...identityFields(item) });
  }

  for (const [uid, member] of members) {
    if (member.barbeiro_ids.size > 1) throw new Error(`UID ${uid} aponta para mais de um barbeiro: revisão manual obrigatória.`);
    const barberId = [...member.barbeiro_ids][0];
    const data = {
      uid,
      papeis: [...member.papeis].sort(),
      ativo: true,
      ...(barberId ? { barbeiro_id: barberId } : {}),
      origem_migracao: "legacy-antunes-v1",
    };
    plan.push(writePlanItem(`${TARGET_ROOT}/barbearias/${TENANT_ID}/membros/${uid}`,
      Object.fromEntries(Object.entries(data).map(([k, v]) => [k, encodeValue(v)])), "generated/member"));
    plan.push(writePlanItem(`${TARGET_ROOT}/usuarios/${uid}`, {
      uid: encodeValue(uid),
      ...(identities.get(uid) || {}),
      origem_migracao: encodeValue("legacy-antunes-v1"),
    }, "generated/identity"));
  }

  plan.push(writePlanItem(`${TARGET_ROOT}/barbearias/${TENANT_ID}`, {
    tenant_id: encodeValue(TENANT_ID),
    nome: encodeValue("Barbearia Antunes"),
    slug: encodeValue(TENANT_SLUG),
    logo: encodeValue(""),
    ativa: encodeValue(true),
    status: encodeValue("ACTIVE"),
    plano: encodeValue(PRODUCTION_CUTOVER ? "ATUAL" : "HOMOLOGACAO"),
    dominio: encodeValue(PRODUCTION_CUTOVER ? "barber-a01e7.web.app" : "teste-483f6.web.app"),
    timezone: encodeValue("America/Sao_Paulo"),
    schema: encodeValue(2),
    ambiente: encodeValue(PRODUCTION_CUTOVER ? "PRODUCAO" : "HOMOLOGACAO"),
  }, "generated/tenant"));
  plan.push(writePlanItem(`${TARGET_ROOT}/system/version`, {
    schema: encodeValue(2),
    tenancy: encodeValue(true),
    mode: encodeValue(PRODUCTION_CUTOVER ? "legacy" : "multi-tenant"),
    environment: encodeValue(PRODUCTION_CUTOVER ? "producao" : "homologacao"),
    tenant_id: encodeValue(TENANT_ID),
  }, "generated/system"));

  const totalBeforeLog = plan.length;
  plan.push(writePlanItem(`${TARGET_ROOT}/migration_logs/${PRODUCTION_CUTOVER ? "tenant-v2-antunes-production" : "tenant-v2-antunes-shadow"}`, {
    migration: encodeValue(PRODUCTION_CUTOVER ? "tenant-v2-production-cutover" : "tenant-v2-shadow-migration"),
    tenant_id: encodeValue(TENANT_ID),
    source_project: encodeValue(SOURCE_PROJECT),
    target_project: encodeValue(TARGET_PROJECT),
    schema: encodeValue(2),
    environment: encodeValue(PRODUCTION_CUTOVER ? "PRODUCAO" : "HOMOLOGACAO"),
    status: encodeValue("SUCCESS"),
    idempotent: encodeValue(true),
    documents_projected: encodeValue(totalBeforeLog + 1),
    legacy_unresolved_excluded: encodeValue(excluded.length),
  }, "generated/migration-log"));

  const names = new Set();
  for (const item of plan) {
    if (names.has(item.name)) throw new Error(`Documento duplicado na projeção: ${item.name}`);
    names.add(item.name);
  }
  return { plan: plan.sort((a, b) => a.name.localeCompare(b.name)), excluded, members };
}

async function readSource(token) {
  const source = {};
  for (const collection of COLLECTIONS) {
    process.stdout.write(`Lendo origem: ${collection}\n`);
    source[collection] = await listCollection(SOURCE_URL, collection, token);
  }
  return source;
}

async function inspectTarget(plan, token) {
  const missing = [];
  const equal = [];
  const divergent = [];
  for (const item of plan) {
    const existing = await getDocument(item.name, token);
    if (!existing) missing.push(item);
    else if (fieldsEqual(existing.fields, item.fields)) equal.push(item);
    else divergent.push({ name: item.name, source: item.source });
  }
  return { missing, equal, divergent };
}

async function commitCreates(items, token) {
  for (let offset = 0; offset < items.length; offset += 300) {
    const chunk = items.slice(offset, offset + 300);
    await requestJson(TARGET_COMMIT_URL, token, {
      method: "POST",
      body: JSON.stringify({
        writes: chunk.map((item) => ({
          update: { name: item.name, fields: item.fields },
          currentDocument: { exists: false },
        })),
      }),
    });
  }
}

async function commitIncrementalSync(missing, divergent, token) {
  const auditId = `v2-incremental-sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const writes = [
    ...missing.map((item) => ({
      update: { name: item.name, fields: item.fields },
      currentDocument: { exists: false },
    })),
    ...divergent.map(({ item, existing }) => ({
      update: { name: item.name, fields: item.fields },
      currentDocument: { updateTime: existing.updateTime },
    })),
    {
      update: {
        name: `${TARGET_ROOT}/migration_logs/${auditId}`,
        fields: {
          migration: encodeValue("tenant-v2-incremental-sync"),
          tenant_id: encodeValue(TENANT_ID),
          environment: encodeValue("PRODUCAO"),
          status: encodeValue("SUCCESS"),
          source_of_truth: encodeValue("legacy"),
          missing_created: encodeValue(missing.length),
          divergent_reconciled: encodeValue(divergent.length),
          atomic: encodeValue(true),
          idempotent: encodeValue(true),
        },
      },
      currentDocument: { exists: false },
    },
  ];
  if (writes.length > 300) throw new Error("Sincronização incremental excede o limite atômico.");
  await requestJson(TARGET_COMMIT_URL, token, { method: "POST", body: JSON.stringify({ writes }) });
  return { auditId, writes: writes.length };
}

const RECONCILIATION_MISSING_SOURCES = new Set([
  "servicos/LpPMCtctqFH7cPB4xhkr",
  "agendamentos/1OZRgMZpK8Eb8aCfuG07_2026-08-19_11:00",
  "agendamentos/1OZRgMZpK8Eb8aCfuG07_2026-08-19_16:00",
  "agendamentos/fxtjJbFFaZ0i86ZeRKL3_2026-08-19_08:30",
  "ocupacoes/1OZRgMZpK8Eb8aCfuG07_2026-08-19_11:00",
  "ocupacoes/1OZRgMZpK8Eb8aCfuG07_2026-08-19_16:00",
  "ocupacoes/fxtjJbFFaZ0i86ZeRKL3_2026-08-19_08:30",
  "ocupacoes/fxtjJbFFaZ0i86ZeRKL3_2026-08-19_09:00",
  "configuracoes/funcionamento",
]);

const RECONCILIATION_DIVERGENT_SOURCES = new Set([
  "barbeiros/fxtjJbFFaZ0i86ZeRKL3",
  "planos_assinatura/premium",
  "solicitacoes_assinatura/w8VuB0a1vOMRX8tSV0ZA3UrS0BC2_essencial",
]);
// O log canônico do cutover é metadado técnico e não entra na projeção
// operacional do auditor Dual Read (assim como migration_logs dinâmicos).
const RECONCILIATION_ALLOWED_TECHNICAL_DIVERGENCES = new Set(["generated/migration-log"]);

async function assertLegacyMode(token) {
  const version = await getDocument(`${TARGET_ROOT}/system/version`, token);
  if (!version || decodeValue(version.fields?.mode) !== "legacy") {
    throw new Error("Produção não está em system/version.mode = legacy; reconciliação bloqueada.");
  }
}

function assertExactReconciliationScope(targetState) {
  const missingSources = new Set(targetState.missing.map((item) => item.source));
  const divergentSources = new Set(targetState.divergent
    .map((item) => item.source)
    .filter((source) => !RECONCILIATION_ALLOWED_TECHNICAL_DIVERGENCES.has(source)));
  const same = (actual, expected) => actual.size === expected.size && [...expected].every((value) => actual.has(value));
  if (!same(missingSources, RECONCILIATION_MISSING_SOURCES) || !same(divergentSources, RECONCILIATION_DIVERGENT_SOURCES)) {
    throw new Error("Escopo da reconciliação mudou desde o relatório aprovado; nenhuma escrita será realizada.");
  }
}

async function commitReconciliationSync(missing, divergent, token, snapshotSha256) {
  const auditId = `v2-reconciliation-sync-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const writes = [
    ...missing.map((item) => ({ update: { name: item.name, fields: item.fields }, currentDocument: { exists: false } })),
    ...divergent.map(({ item, existing }) => ({ update: { name: item.name, fields: item.fields }, currentDocument: { updateTime: existing.updateTime } })),
    {
      update: {
        name: `${TARGET_ROOT}/migration_logs/${auditId}`,
        fields: {
          migration: encodeValue("tenant-v2-reconciliation-sync"),
          tenant_id: encodeValue(TENANT_ID),
          environment: encodeValue("PRODUCAO"),
          status: encodeValue("SUCCESS"),
          source_of_truth: encodeValue("legacy"),
          missing_created: encodeValue(missing.length),
          divergent_reconciled: encodeValue(divergent.length),
          snapshot_sha256: encodeValue(snapshotSha256),
          atomic: encodeValue(true),
          idempotent: encodeValue(true),
        },
      },
      currentDocument: { exists: false },
    },
  ];
  if (writes.length !== 13) throw new Error(`Quantidade de escritas de reconciliação inesperada: ${writes.length}.`);
  await requestJson(TARGET_COMMIT_URL, token, { method: "POST", body: JSON.stringify({ writes }) });
  return { auditId, writes: writes.length };
}

async function inspectIncrementalDivergences(items, token) {
  return Promise.all(items.map(async (item) => ({ item, existing: await getDocument(item.name, token) })));
}

async function commitRollback(items, token) {
  if (items.length > 300) throw new Error("Rollback excede o limite atômico de 300 documentos.");
  const migrationLog = items.find((item) => item.name.endsWith("/migration_logs/tenant-v2-antunes-production"));
  if (!migrationLog) throw new Error("Log de migração de produção não encontrado no plano de rollback.");
  const rolledBackLog = {
    ...migrationLog.fields,
    status: encodeValue("ROLLED_BACK"),
    rollback_audit_local: encodeValue(true),
  };
  await requestJson(TARGET_COMMIT_URL, token, {
    method: "POST",
    body: JSON.stringify({
      writes: [
        ...items.filter((item) => item !== migrationLog).map((item) => ({
          delete: item.name,
          currentDocument: { exists: true },
        })),
        {
          update: { name: migrationLog.name, fields: rolledBackLog },
          currentDocument: { exists: true },
        },
      ],
    }),
  });
}

function summarizeProjection(source, projection, targetState = null) {
  const sourceCounts = Object.fromEntries(COLLECTIONS.map((key) => [key, source[key]?.length || 0]));
  const targetCounts = {};
  for (const item of projection.plan) {
    const relative = item.name.slice(TARGET_ROOT.length + 1).split("/");
    const key = relative[0] === "barbearias" ? relative[2] || "tenant_root" : relative[0];
    targetCounts[key] = (targetCounts[key] || 0) + 1;
  }
  return {
    source_project: SOURCE_PROJECT,
    target_project: TARGET_PROJECT,
    tenant_id: TENANT_ID,
    source_counts: sourceCounts,
    projected_counts: targetCounts,
    total_projected: projection.plan.length,
    members: projection.members.size,
    legacy_excluded: projection.excluded,
    ...(targetState ? {
      target_state: {
        missing: targetState.missing.length,
        equal: targetState.equal.length,
        divergent: targetState.divergent,
      },
    } : {}),
  };
}

function normalizePriceCents(value) {
  if (typeof value === "number" && Number.isFinite(value)) return Math.round(value * 100);
  const clean = String(value || "").trim().replace(/[^\d,.-]/g, "");
  if (!clean) return null;
  if (clean.includes(",")) {
    const [whole, decimal = ""] = clean.replace(/\./g, "").split(",");
    return Number(whole || 0) * 100 + Number(`${decimal}00`.slice(0, 2));
  }
  const number = Number(clean);
  return Number.isFinite(number) ? Math.round(number * 100) : null;
}

function validateAcceptance(source, projection, targetState) {
  const data = Object.fromEntries(COLLECTIONS.map((key) => [key, (source[key] || []).map(decoded)]));
  const operationalAppointments = data.agendamentos.filter((item) => !(
    item.status === "legacy_unresolved" && item.arquivado_legado === true && item.excluir_migracao === true
  ));
  const byId = (items) => new Map(items.map((item) => [item.id, item]));
  const clients = byId(data.clientes);
  const barbers = byId(data.barbeiros);
  const services = byId(data.servicos);
  const plans = byId(data.planos_assinatura);
  const subscriptions = byId(data.solicitacoes_assinatura);
  const appointments = byId(operationalAppointments);
  const errors = [];

  for (const appointment of operationalAppointments) {
    if (!barbers.has(appointment.barbeiro_id)) errors.push({ type: "AGENDAMENTO_SEM_BARBEIRO", id: appointment.id });
    if (!services.has(appointment.servico_id)) errors.push({ type: "AGENDAMENTO_SEM_SERVICO", id: appointment.id });
    if (appointment.cliente_tipo === "autenticado" && !clients.has(appointment.cliente_id)) {
      errors.push({ type: "AGENDAMENTO_SEM_CLIENTE", id: appointment.id });
    }
  }
  for (const occupancy of data.ocupacoes) {
    if (occupancy.agendamento_id && !appointments.has(occupancy.agendamento_id)) {
      errors.push({ type: "OCUPACAO_SEM_AGENDAMENTO", id: occupancy.id });
    }
  }
  for (const subscription of data.solicitacoes_assinatura) {
    if (!clients.has(subscription.cliente_id)) errors.push({ type: "ASSINATURA_SEM_CLIENTE", id: subscription.id });
    if (!plans.has(subscription.plano_id)) errors.push({ type: "ASSINATURA_SEM_PLANO", id: subscription.id });
    if (subscription.status === "ATIVA" && (!Array.isArray(subscription.servicos_ids) || subscription.servicos_ids.length === 0)) {
      errors.push({ type: "ASSINATURA_ATIVA_SEM_SERVICOS", id: subscription.id });
    }
  }
  for (const history of data.historico_assinaturas) {
    if (!subscriptions.has(history.assinatura_id)) errors.push({ type: "HISTORICO_SEM_ASSINATURA", id: history.id });
    if (!appointments.has(history.agendamento_id)) errors.push({ type: "HISTORICO_SEM_AGENDAMENTO", id: history.id });
  }

  let realizedCents = 0;
  let forecastCents = 0;
  let appointmentsWithoutPrice = 0;
  const noRevenue = new Set(["cancelado", "nao_compareceu", "legacy_unresolved"]);
  for (const appointment of operationalAppointments) {
    const price = normalizePriceCents(appointment.servico_preco ?? services.get(appointment.servico_id)?.preco);
    if (appointment.status === "concluido") {
      if (price === null) appointmentsWithoutPrice += 1; else realizedCents += price;
    } else if (!noRevenue.has(appointment.status)) {
      if (price === null) appointmentsWithoutPrice += 1; else forecastCents += price;
    }
  }

  const credits = { total: 0, utilizados: 0, restantes: 0, reservados: 0 };
  for (const subscription of data.solicitacoes_assinatura) {
    for (const credit of Object.values(subscription.creditos_mensais || {})) {
      if (!credit || typeof credit !== "object") continue;
      for (const key of Object.keys(credits)) credits[key] += Number(credit[key] || 0);
    }
  }

  const memberItems = projection.plan.filter((item) => item.name.includes(`/barbearias/${TENANT_ID}/membros/`));
  const invalidRoles = memberItems.filter((item) => {
    const roles = decodeValue(item.fields.papeis);
    return !Array.isArray(roles) || roles.length === 0 || roles.some((role) => !["ADMIN", "BARBEIRO", "CLIENTE"].includes(role));
  });
  const multipleRoleMembers = memberItems.filter((item) => decodeValue(item.fields.papeis).length > 1).length;
  const targetEquivalent = targetState && targetState.missing.length === 0 && targetState.divergent.length === 0;
  const approved = targetEquivalent
    && errors.length === 0
    && appointmentsWithoutPrice === 0
    && invalidRoles.length === 0
    && operationalAppointments.length === EXPECTED_OPERATIONAL_APPOINTMENTS
    && projection.excluded.length === 5;

  return {
    status: approved ? "APROVADO" : "REPROVADO",
    criteria: {
      target_exactly_equivalent: targetEquivalent,
      operational_appointments: operationalAppointments.length,
      expected_operational_appointments: EXPECTED_OPERATIONAL_APPOINTMENTS,
      legacy_unresolved_excluded: projection.excluded.length,
      expected_legacy_unresolved_excluded: 5,
      invalid_references: errors,
      invalid_role_documents: invalidRoles.map((item) => item.name),
      members_with_multiple_roles: multipleRoleMembers,
      subscriptions_integrity: errors.some((item) => item.type.includes("ASSINATURA")) ? "ERRO" : "OK",
      finance_integrity: appointmentsWithoutPrice === 0 ? "OK" : "ERRO",
      finance: { realized_cents: realizedCents, forecast_cents: forecastCents, appointments_without_price: appointmentsWithoutPrice },
      credits,
      rerun_expected_writes: targetState?.missing.length ?? null,
    },
    recommendation: approved ? "HOMOLOGACAO_DE_DADOS_APROVADA" : "BLOQUEAR_E_CORRIGIR_DIVERGENCIAS",
  };
}

async function saveReport(kind, payload) {
  const reportsDir = path.resolve(
    process.cwd(),
    "reports",
    PRODUCTION_CUTOVER ? "production-cutover" : "shadow-migration",
  );
  await mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const file = path.join(reportsDir, `${kind}-${stamp}.json`);
  const content = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(file, content, "utf8");
  await chmod(file, 0o444).catch(() => {});
  return { file, sha256: createHash("sha256").update(content).digest("hex") };
}

function selfTest() {
  assertProjectBoundary();
  const doc = (collection, id, data) => ({
    name: `${SOURCE_ROOT}/${collection}/${id}`,
    fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, encodeValue(value)])),
  });
  const source = Object.fromEntries(COLLECTIONS.map((key) => [key, []]));
  source.clientes.push(doc("clientes", "uid-overlap", { nome: "Cliente" }));
  source.admins.push(doc("admins", "uid-overlap", { email: "teste@example.invalid" }));
  source.barbeiros.push(doc("barbeiros", "barber-1", { nome: "Profissional", uid_usuario: "uid-overlap" }));
  source.agendamentos.push(doc("agendamentos", "legacy", {
    status: "legacy_unresolved", arquivado_legado: true, excluir_migracao: true,
    motivo_arquivamento: "SEM_VINCULO",
  }));
  const projection = buildProjection(source);
  const member = projection.plan.find((item) => item.name.endsWith("/membros/uid-overlap"));
  const roles = decodeValue(member.fields.papeis);
  if (JSON.stringify(roles) !== JSON.stringify(["ADMIN", "BARBEIRO", "CLIENTE"])) throw new Error("Papéis múltiplos incorretos.");
  if (projection.excluded.length !== 1 || projection.plan.some((item) => item.name.endsWith("/agendamentos/legacy"))) {
    throw new Error("Exclusão legacy incorreta.");
  }
  const names = new Set(projection.plan.map((item) => item.name));
  if (names.size !== projection.plan.length) throw new Error("Projeção não idempotente.");
  console.log("Self-test OK: isolamento, papéis múltiplos, exclusão legacy e IDs determinísticos validados.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  assertProjectBoundary();
  if (args.selfTest) return selfTest();

  const sourceLabel = PRODUCTION_CUTOVER ? "CUTOVER_SOURCE_CREDENTIALS" : "SHADOW_SOURCE_CREDENTIALS";
  const targetLabel = PRODUCTION_CUTOVER ? "CUTOVER_TARGET_CREDENTIALS" : "SHADOW_TARGET_CREDENTIALS";
  const sourceCredential = process.env[sourceLabel];
  const targetCredential = process.env[targetLabel];
  // Tokens efêmeros por impersonação evitam arquivos JSON durante operações de produção.
  const sourceToken = process.env.CUTOVER_SOURCE_ACCESS_TOKEN || await accessToken(sourceCredential, SOURCE_PROJECT, sourceLabel);
  const targetToken = process.env.CUTOVER_TARGET_ACCESS_TOKEN || await accessToken(targetCredential, TARGET_PROJECT, targetLabel);
  const source = await readSource(sourceToken);
  const projection = buildProjection(source);
  const targetState = await inspectTarget(projection.plan, targetToken);
  if (args.syncReconciliation) {
    await assertLegacyMode(targetToken);
    try {
      assertExactReconciliationScope(targetState);
    } catch (error) {
      const report = await saveReport("reconciliation-sync-blocked", {
        kind: "PRODUCTION_V2_RECONCILIATION_SYNC_BLOCKED",
        generated_at: new Date().toISOString(),
        reason: error.message,
        expected: { missing_sources: [...RECONCILIATION_MISSING_SOURCES], divergent_sources: [...RECONCILIATION_DIVERGENT_SOURCES] },
      actual: { missing_sources: targetState.missing.map((item) => item.source), divergent_sources: targetState.divergent.map((item) => item.source) },
      });
      throw new Error(`${error.message} Relatório: ${report.file}`);
    }
    const operationalDivergences = targetState.divergent.filter((entry) => !RECONCILIATION_ALLOWED_TECHNICAL_DIVERGENCES.has(entry.source));
    const divergentPlanItems = operationalDivergences.map((entry) => projection.plan.find((item) => item.name === entry.name));
    const currentDivergent = await inspectIncrementalDivergences(divergentPlanItems, targetToken);
    if (currentDivergent.some(({ existing }) => !existing)) throw new Error("Divergência não encontrada no destino; reconciliação bloqueada.");
    const before = await saveReport("reconciliation-sync-before", {
      kind: "PRODUCTION_V2_RECONCILIATION_SYNC_SNAPSHOT",
      generated_at: new Date().toISOString(),
      mode_guard: "legacy",
      creates: targetState.missing.map((item) => ({ name: item.name, source: item.source, fields: item.fields })),
      updates: currentDivergent.map(({ item, existing }) => ({ name: item.name, source: item.source, before: existing.fields, after: item.fields, update_time: existing.updateTime })),
    });
    const sync = await commitReconciliationSync(targetState.missing, currentDivergent, targetToken, before.sha256);
    await assertLegacyMode(targetToken);
    const afterState = await inspectTarget(projection.plan, targetToken);
    const remainingOperationalDivergences = afterState.divergent.filter((entry) => !RECONCILIATION_ALLOWED_TECHNICAL_DIVERGENCES.has(entry.source));
    const success = afterState.missing.length === 0 && remainingOperationalDivergences.length === 0;
    const after = await saveReport("reconciliation-sync-after", {
      kind: "PRODUCTION_V2_RECONCILIATION_SYNC_RESULT",
      generated_at: new Date().toISOString(),
      status: success ? "APROVADO" : "REPROVADO",
      snapshot_sha256: before.sha256,
      atomic_writes: sync.writes,
      audit_log_id: sync.auditId,
      remaining: { missing: afterState.missing.map((item) => item.source), divergent: remainingOperationalDivergences.map((item) => item.source), technical_divergences_ignored: afterState.divergent.filter((entry) => RECONCILIATION_ALLOWED_TECHNICAL_DIVERGENCES.has(entry.source)).map((item) => item.source) },
    });
    if (!success) throw new Error(`Validação pós-reconciliação falhou. Relatório: ${after.file}`);
    console.log(`Reconciliação incremental APROVADA: 9 criações e 3 atualizações. Relatório: ${after.file}`);
    return;
  }
  if (args.syncCurrent) {
    const allowedDivergentSources = new Set([
      "solicitacoes_assinatura/w8VuB0a1vOMRX8tSV0ZA3UrS0BC2_essencial",
      "generated/migration-log",
    ]);
    const allowedMissingSources = new Set(["agendamentos", "ocupacoes", "historico_assinaturas"]);
    const invalidMissing = targetState.missing.filter((item) => !allowedMissingSources.has(String(item.source).split("/")[0]));
    const invalidDivergent = targetState.divergent.filter((item) => !allowedDivergentSources.has(item.source));
    if (targetState.missing.length !== 7 || targetState.divergent.length !== 2 || invalidMissing.length || invalidDivergent.length) {
      const report = await saveReport("incremental-sync-blocked", {
        kind: "PRODUCTION_V2_INCREMENTAL_SYNC_BLOCKED",
        generated_at: new Date().toISOString(),
        expected: { missing: 7, divergent: 2 },
        ...summarizeProjection(source, projection, targetState),
      });
      throw new Error(`Escopo da sincronização mudou; execução bloqueada. Relatório: ${report.file}`);
    }
    const divergentPlanItems = targetState.divergent.map((entry) => projection.plan.find((item) => item.name === entry.name));
    const currentDivergent = await inspectIncrementalDivergences(divergentPlanItems, targetToken);
    if (currentDivergent.some(({ existing }) => !existing)) throw new Error("Divergência não encontrada no destino; sincronização bloqueada.");
    const before = await saveReport("incremental-sync-before", {
      kind: "PRODUCTION_V2_INCREMENTAL_SYNC_SNAPSHOT",
      generated_at: new Date().toISOString(),
      ...summarizeProjection(source, projection, targetState),
      allowed_missing: targetState.missing.map((item) => ({ name: item.name, source: item.source, fields: item.fields })),
      allowed_divergent: currentDivergent.map(({ item, existing }) => ({ name: item.name, source: item.source, before: existing.fields, after: item.fields, update_time: existing.updateTime })),
    });
    const sync = await commitIncrementalSync(targetState.missing, currentDivergent, targetToken);
    const afterState = await inspectTarget(projection.plan, targetToken);
    const success = afterState.missing.length === 0 && afterState.divergent.length === 0;
    const after = await saveReport("incremental-sync-after", {
      kind: "PRODUCTION_V2_INCREMENTAL_SYNC_RESULT",
      generated_at: new Date().toISOString(),
      status: success ? "APROVADO" : "REPROVADO",
      snapshot_sha256: before.sha256,
      atomic_writes: sync.writes,
      audit_log_id: sync.auditId,
      ...summarizeProjection(source, projection, afterState),
    });
    if (!success) throw new Error(`Validação pós-sincronização falhou. Relatório: ${after.file}`);
    console.log(`Sincronização incremental APROVADA: 7 criações e 2 reconciliações. Relatório: ${after.file}`);
    return;
  }
  if (targetState.divergent.length > 0) {
    const report = await saveReport("blocked-divergence", summarizeProjection(source, projection, targetState));
    throw new Error(`Destino possui ${targetState.divergent.length} divergência(s). Execução bloqueada. Relatório: ${report.file}`);
  }

  if (args.rollback) {
    if (targetState.missing.length > 0 || targetState.equal.length !== projection.plan.length) {
      const report = await saveReport("rollback-blocked", {
        kind: "PRODUCTION_CUTOVER_ROLLBACK_BLOCKED",
        generated_at: new Date().toISOString(),
        reason: "O estado V2 não corresponde exatamente ao snapshot de migração; rollback automático bloqueado.",
        ...summarizeProjection(source, projection, targetState),
      });
      throw new Error(`Rollback bloqueado: estado V2 não está intacto. Relatório: ${report.file}`);
    }
    const rollbackBefore = await saveReport("rollback-before", {
      kind: "PRODUCTION_CUTOVER_ROLLBACK_SNAPSHOT",
      generated_at: new Date().toISOString(),
      ...summarizeProjection(source, projection, targetState),
      documents_to_remove: projection.plan.map((item) => ({ name: item.name, fields: item.fields })),
    });
    await commitRollback(projection.plan, targetToken);
    const rollbackState = await inspectTarget(projection.plan, targetToken);
    const logName = `${TARGET_ROOT}/migration_logs/tenant-v2-antunes-production`;
    const unexpected = rollbackState.equal.filter((item) => item.name !== logName);
    const rollbackLog = await getDocument(logName, targetToken);
    const rollbackOk = unexpected.length === 0
      && rollbackState.divergent.length === 1
      && rollbackState.divergent[0].name === logName
      && decodeValue(rollbackLog?.fields?.status) === "ROLLED_BACK";
    const report = await saveReport("rollback-after", {
      kind: "PRODUCTION_CUTOVER_ROLLBACK_RESULT",
      generated_at: new Date().toISOString(),
      status: rollbackOk ? "APROVADO" : "REPROVADO",
      snapshot_sha256: rollbackBefore.sha256,
      removed_documents: rollbackState.missing.length,
      preserved_migration_log: Boolean(rollbackLog),
    });
    if (!rollbackOk) throw new Error(`Validação do rollback falhou. Relatório: ${report.file}`);
    console.log(`Rollback APROVADO. Log de auditoria preservado. Relatório: ${report.file}`);
    return;
  }

  const before = await saveReport("before", {
    kind: PRODUCTION_CUTOVER ? "PRODUCTION_CUTOVER_SNAPSHOT" : "SHADOW_MIGRATION_SNAPSHOT",
    generated_at: new Date().toISOString(),
    ...summarizeProjection(source, projection, targetState),
    planned_documents: projection.plan.map((item) => ({ name: item.name, source: item.source, fields: item.fields })),
  });
  console.log(`Snapshot: ${before.file}`);
  console.log(`SHA-256: ${before.sha256}`);

  if (args.dryRun) {
    console.log(`Dry-run OK: ${targetState.missing.length} criações, ${targetState.equal.length} já equivalentes, 0 divergências.`);
    return;
  }

  if (args.apply && targetState.missing.length > 0) {
    await commitCreates(targetState.missing, targetToken);
  }
  const afterState = await inspectTarget(projection.plan, targetToken);
  const acceptance = validateAcceptance(source, projection, afterState);
  const success = acceptance.status === "APROVADO";
  const after = await saveReport(args.validate ? "validation" : "after", {
    kind: args.validate
      ? (PRODUCTION_CUTOVER ? "PRODUCTION_CUTOVER_VALIDATION" : "SHADOW_MIGRATION_VALIDATION")
      : (PRODUCTION_CUTOVER ? "PRODUCTION_CUTOVER_RESULT" : "SHADOW_MIGRATION_RESULT"),
    generated_at: new Date().toISOString(),
    status: success ? "APROVADO" : "REPROVADO",
    snapshot_sha256: before.sha256,
    ...summarizeProjection(source, projection, afterState),
    acceptance,
    idempotent_rerun_expected_writes: afterState.missing.length,
  });
  if (!success) throw new Error(`Validação falhou. Relatório: ${after.file}`);
  console.log(`Validação APROVADA: ${projection.plan.length} documentos equivalentes, 0 divergências.`);
  console.log(`Relatório: ${after.file}`);
}

main().catch((error) => {
  console.error(`ERRO: ${error.message}`);
  process.exitCode = 1;
});
