#!/usr/bin/env node
/**
 * Reparador controlado das 19 inconsistências determinísticas aprovadas.
 *
 * Uma categoria por execução:
 *   node scripts/integrity-repair.mjs --category barbeiros --dry-run
 *   node scripts/integrity-repair.mjs --category ocupacoes --dry-run
 *   node scripts/integrity-repair.mjs --category assinatura-servicos --dry-run
 *
 * Escrita real exige confirmação explícita e credencial com permissão:
 *   node scripts/integrity-repair.mjs --category barbeiros --apply --confirm REPAIR_LEGACY_APPROVED
 *
 * Rollback usa o relatório local produzido pela aplicação original:
 *   node scripts/integrity-repair.mjs --rollback reports/<arquivo>.json --apply --confirm ROLLBACK_LEGACY_APPROVED
 *
 * Os cinco documentos manuais só podem ser alterados pela categoria explícita
 * `arquivamento-legado`, após decisão humana documentada.
 */

import { createHash, createSign, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const PROJECT_ID = "barber-a01e7";
const DOCUMENT_ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const BASE_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents`;
const COMMIT_URL = `https://firestore.googleapis.com/v1/projects/${PROJECT_ID}/databases/(default)/documents:commit`;
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";
const INTERVALO_MINUTOS = 30;
const CATEGORIES = new Set(["barbeiros", "ocupacoes", "assinatura-servicos", "arquivamento-legado"]);
const STATUS_SEM_OCUPACAO = new Set(["cancelado", "nao_compareceu"]);

const APPROVED_BARBER_APPOINTMENTS = new Set([
  "o0z2rcpKcyOFWrveBrs8_2026-08-15_15:00",
  "o0z2rcpKcyOFWrveBrs8_2026-08-20_18:30",
  "o0z2rcpKcyOFWrveBrs8_2026-08-28_18:30",
]);

const APPROVED_OCCUPANCY_APPOINTMENTS = new Set([
  "3SPyrJwVWulSjl9t7ati_2026-08-14_11:00",
  "3SPyrJwVWulSjl9t7ati_2026-08-14_14:00",
  "3SPyrJwVWulSjl9t7ati_2026-08-14_15:30",
  "3SPyrJwVWulSjl9t7ati_2026-08-14_16:00",
  "3SPyrJwVWulSjl9t7ati_2026-08-14_17:00",
  "3SPyrJwVWulSjl9t7ati_2026-08-29_16:30",
  "fxtjJbFFaZ0i86ZeRKL3_2026-08-13_09:00",
  "fxtjJbFFaZ0i86ZeRKL3_2026-08-13_09:30",
  "fxtjJbFFaZ0i86ZeRKL3_2026-08-14_09:00",
  "fxtjJbFFaZ0i86ZeRKL3_2026-08-29_16:00",
  "fxtjJbFFaZ0i86ZeRKL3_2026-09-22_18:00",
  "fxtjJbFFaZ0i86ZeRKL3_2026-10-21_18:00",
  "fxtjJbFFaZ0i86ZeRKL3_2026-10-29_15:30",
  "o0z2rcpKcyOFWrveBrs8_2026-08-15_15:00",
  "o0z2rcpKcyOFWrveBrs8_2026-08-20_18:30",
]);

const APPROVED_SUBSCRIPTIONS = new Set([
  "8kNHqfge6HW6euLvNB3NXRvfw8s2_essencial",
]);

const MANUAL_BLOCKLIST = new Set([
  "agendamentos/l4ua45UlpyS6TfewN2E1_2026-08-13_14:00",
  "agendamentos/l4ua45UlpyS6TfewN2E1_2026-08-29_18:30",
  "agendamentos/l4ua45UlpyS6TfewN2E1_2026-09-23_13:30",
  "agendamentos/l4ua45UlpyS6TfewN2E1_2026-09-23_18:00",
  "agendamentos/teste",
]);

const LEGACY_ARCHIVE_REASONS = new Map([
  ["l4ua45UlpyS6TfewN2E1_2026-08-13_14:00", "BARBEIRO_HISTORICO_SEM_VINCULO_CONFIRMADO"],
  ["l4ua45UlpyS6TfewN2E1_2026-08-29_18:30", "BARBEIRO_HISTORICO_SEM_VINCULO_CONFIRMADO"],
  ["l4ua45UlpyS6TfewN2E1_2026-09-23_13:30", "BARBEIRO_HISTORICO_SEM_VINCULO_CONFIRMADO"],
  ["l4ua45UlpyS6TfewN2E1_2026-09-23_18:00", "BARBEIRO_HISTORICO_SEM_VINCULO_CONFIRMADO"],
  ["teste", "DOCUMENTO_DE_TESTE_SEM_REFERENCIAS_OPERACIONAIS"],
]);

const LEGACY_ARCHIVE_FIELDS = [
  "status",
  "status_anterior",
  "arquivado_legado",
  "excluir_migracao",
  "motivo_arquivamento",
  "decisao_resolucao",
  "arquivado_em",
];

const COLLECTIONS = ["barbeiros", "servicos", "agendamentos", "ocupacoes", "planos_assinatura", "solicitacoes_assinatura"];

function parseArgs(argv) {
  const args = { dryRun: false, apply: false, selfTest: false, category: "", confirm: "", rollback: "" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg === "--apply") args.apply = true;
    else if (arg === "--self-test") args.selfTest = true;
    else if (arg === "--category") args.category = argv[++index] || "";
    else if (arg.startsWith("--category=")) args.category = arg.slice("--category=".length);
    else if (arg === "--confirm") args.confirm = argv[++index] || "";
    else if (arg.startsWith("--confirm=")) args.confirm = arg.slice("--confirm=".length);
    else if (arg === "--rollback") args.rollback = argv[++index] || "";
    else if (arg.startsWith("--rollback=")) args.rollback = arg.slice("--rollback=".length);
    else throw new Error(`Argumento desconhecido: ${arg}`);
  }
  return args;
}

function validateArgs(args) {
  if (args.selfTest) return;
  if (args.dryRun === args.apply) throw new Error("Escolha exatamente um modo: --dry-run ou --apply.");
  if (args.rollback) {
    if (args.category) throw new Error("Rollback recebe a categoria do relatório; não use --category.");
    if (!args.apply || args.confirm !== "ROLLBACK_LEGACY_APPROVED") {
      throw new Error("Rollback exige --apply --confirm ROLLBACK_LEGACY_APPROVED.");
    }
    return;
  }
  if (!CATEGORIES.has(args.category)) throw new Error(`Categoria inválida. Use: ${[...CATEGORIES].join(", ")}.`);
  if (args.apply && args.confirm !== "REPAIR_LEGACY_APPROVED") {
    throw new Error("Aplicação exige --confirm REPAIR_LEGACY_APPROVED.");
  }
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function decodeValue(value) {
  if (value === undefined || value === null) return value;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return value.doubleValue;
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "referenceValue")) return value.referenceValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(decodeValue);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(
    Object.entries(value.mapValue.fields || {}).map(([key, field]) => [key, decodeValue(field)]),
  );
  return undefined;
}

function encodeValue(value) {
  if (value === null) return { nullValue: null };
  if (value instanceof Date) return { timestampValue: value.toISOString() };
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") return {
    mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) },
  };
  throw new Error(`Valor Firestore não suportado: ${typeof value}`);
}

function encodeFields(data) {
  return Object.fromEntries(Object.entries(data).filter(([, value]) => value !== undefined).map(([key, value]) => [key, encodeValue(value)]));
}

function decodeDocument(document) {
  return {
    id: String(document.name || "").split("/").at(-1),
    _name: document.name,
    _updateTime: document.updateTime,
    ...Object.fromEntries(Object.entries(document.fields || {}).map(([key, field]) => [key, decodeValue(field)])),
  };
}

function normalizeText(value) {
  return String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, " ").trim().toLowerCase();
}

function indexById(items) {
  return new Map(items.map((item) => [item.id, item]));
}

function uniqueNameIndex(items) {
  const result = new Map();
  for (const item of items.filter((entry) => entry.ativo !== false)) {
    const key = normalizeText(item.nome);
    if (!key) continue;
    if (!result.has(key)) result.set(key, []);
    result.get(key).push(item);
  }
  return result;
}

function toMinutes(time) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(time || ""));
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

function toTime(minutes) {
  return `${String(Math.floor(minutes / 60)).padStart(2, "0")}:${String(minutes % 60).padStart(2, "0")}`;
}

function appointmentBlocks(time, duration) {
  const start = toMinutes(time);
  const minutes = Number(duration || INTERVALO_MINUTOS);
  if (start === null || !Number.isFinite(minutes) || minutes <= 0) return [];
  return Array.from({ length: Math.ceil(minutes / INTERVALO_MINUTOS) }, (_, index) => toTime(start + index * INTERVALO_MINUTOS));
}

function occupationId(barberId, date, time) {
  return `${barberId}_${date}_${time}`;
}

function sameValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function documentName(collection, id) {
  return `${DOCUMENT_ROOT}/${collection}/${id}`;
}

async function accessToken() {
  if (process.env.FIRESTORE_ACCESS_TOKEN) return process.env.FIRESTORE_ACCESS_TOKEN;
  const credentialPath = process.env.GOOGLE_APPLICATION_CREDENTIALS;
  if (!credentialPath) throw new Error("Defina FIRESTORE_ACCESS_TOKEN ou GOOGLE_APPLICATION_CREDENTIALS.");
  const account = JSON.parse(await readFile(credentialPath, "utf8"));
  if (!account.client_email || !account.private_key) throw new Error("Credencial sem client_email/private_key válidos.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iss: account.client_email, scope: FIRESTORE_SCOPE, aud: "https://oauth2.googleapis.com/token", iat: now, exp: now + 3600 }));
  const signature = createSign("RSA-SHA256").update(`${header}.${payload}`).end().sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: `${header}.${payload}.${signature}` }),
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

async function readCollection(collection, token) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${BASE_URL}/${encodeURIComponent(collection)}`);
    url.searchParams.set("pageSize", "1000");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await getJson(url, token);
    documents.push(...(page.documents || []).map(decodeDocument));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return documents;
}

async function readDocument(collection, id, token) {
  try {
    return decodeDocument(await getJson(`${BASE_URL}/${encodeURIComponent(collection)}/${encodeURIComponent(id)}`, token));
  } catch (error) {
    if (String(error.message).startsWith("404:")) return null;
    throw error;
  }
}

async function readSource(token) {
  return Object.fromEntries(await Promise.all(COLLECTIONS.map(async (collection) => [collection, await readCollection(collection, token)])));
}

function assertNotManual(collection, id) {
  if (MANUAL_BLOCKLIST.has(`${collection}/${id}`)) throw new Error(`BLOQUEADO_MANUALMENTE: ${collection}/${id}`);
}

function updateChange(collection, document, field, after) {
  return {
    kind: "update",
    collection,
    id: document.id,
    update_time: document._updateTime,
    fields: {
      [field]: { before_present: Object.hasOwn(document, field), before: document[field] ?? null, after },
    },
  };
}

function updateFieldsChange(collection, document, afterFields) {
  return {
    kind: "update",
    collection,
    id: document.id,
    update_time: document._updateTime,
    fields: Object.fromEntries(Object.entries(afterFields).map(([field, after]) => [field, {
      before_present: Object.hasOwn(document, field),
      before: document[field] ?? null,
      after,
    }])),
  };
}

function createChange(collection, id, data) {
  return { kind: "create", collection, id, data, expected_after: data };
}

function planBarbers(source) {
  const appointments = indexById(source.agendamentos);
  const barbers = indexById(source.barbeiros);
  const byName = uniqueNameIndex(source.barbeiros);
  const changes = [];
  const alreadyApplied = [];
  for (const appointmentId of APPROVED_BARBER_APPOINTMENTS) {
    assertNotManual("agendamentos", appointmentId);
    const appointment = appointments.get(appointmentId);
    if (!appointment) throw new Error(`AGENDAMENTO_APROVADO_AUSENTE: ${appointmentId}`);
    const matches = byName.get(normalizeText(appointment.barbeiro_nome)) || [];
    if (matches.length !== 1) throw new Error(`BARBEIRO_NAO_UNICO: ${appointmentId}`);
    const target = matches[0];
    if (appointment.barbeiro_id === target.id) {
      alreadyApplied.push(`agendamentos/${appointmentId}`);
      continue;
    }
    if (barbers.has(appointment.barbeiro_id)) throw new Error(`BARBEIRO_ATUAL_VALIDO_DIVERGENTE: ${appointmentId}`);
    changes.push(updateChange("agendamentos", appointment, "barbeiro_id", target.id));
  }
  return { changes, alreadyApplied };
}

function planOccupations(source) {
  const appointments = indexById(source.agendamentos);
  const barbers = indexById(source.barbeiros);
  const occupations = indexById(source.ocupacoes);
  const changes = [];
  const alreadyApplied = [];
  for (const appointmentId of APPROVED_OCCUPANCY_APPOINTMENTS) {
    assertNotManual("agendamentos", appointmentId);
    const appointment = appointments.get(appointmentId);
    if (!appointment) throw new Error(`AGENDAMENTO_APROVADO_AUSENTE: ${appointmentId}`);
    if (STATUS_SEM_OCUPACAO.has(appointment.status)) throw new Error(`STATUS_NAO_OCUPA_AGENDA: ${appointmentId}`);
    if (!barbers.has(appointment.barbeiro_id)) throw new Error(`EXECUTE_REPARO_BARBEIROS_PRIMEIRO: ${appointmentId}`);
    if (!appointment.data || !appointment.horario) throw new Error(`DATA_OU_HORARIO_INVALIDO: ${appointmentId}`);
    const blocks = appointmentBlocks(appointment.horario, appointment.duracao);
    if (!blocks.length) throw new Error(`DURACAO_INVALIDA: ${appointmentId}`);

    const competing = source.agendamentos.filter((other) => other.id !== appointment.id
      && other.barbeiro_id === appointment.barbeiro_id
      && other.data === appointment.data
      && !STATUS_SEM_OCUPACAO.has(other.status)
      && appointmentBlocks(other.horario, other.duracao).some((block) => blocks.includes(block)));
    if (competing.length) throw new Error(`CONFLITO_ENTRE_AGENDAMENTOS: ${appointmentId} -> ${competing.map((item) => item.id).join(",")}`);

    const expected = blocks.map((time) => ({
      id: occupationId(appointment.barbeiro_id, appointment.data, time),
      data: { barbeiro_id: appointment.barbeiro_id, data: appointment.data, horario: time, agendamento_id: appointment.id },
    }));
    const existing = expected.map((item) => occupations.get(item.id)).filter(Boolean);
    if (existing.length === expected.length) {
      const allCorrect = expected.every((item) => {
        const current = occupations.get(item.id);
        return current.agendamento_id === item.data.agendamento_id
          && current.barbeiro_id === item.data.barbeiro_id
          && current.data === item.data.data
          && current.horario === item.data.horario;
      });
      if (!allCorrect) throw new Error(`OCUPACAO_EXISTENTE_DIVERGENTE: ${appointmentId}`);
      alreadyApplied.push(...expected.map((item) => `ocupacoes/${item.id}`));
      continue;
    }
    if (existing.length) throw new Error(`OCUPACAO_PARCIAL_EXISTENTE: ${appointmentId}`);
    for (const item of expected) changes.push(createChange("ocupacoes", item.id, item.data));
  }
  return { changes, alreadyApplied };
}

function planSubscriptionServices(source) {
  const subscriptions = indexById(source.solicitacoes_assinatura);
  const plans = indexById(source.planos_assinatura);
  const services = indexById(source.servicos);
  const changes = [];
  const alreadyApplied = [];
  for (const subscriptionId of APPROVED_SUBSCRIPTIONS) {
    const subscription = subscriptions.get(subscriptionId);
    if (!subscription) throw new Error(`ASSINATURA_APROVADA_AUSENTE: ${subscriptionId}`);
    if (subscription.status !== "ATIVA") throw new Error(`ASSINATURA_NAO_ATIVA: ${subscriptionId}`);
    const plan = plans.get(subscription.plano_id);
    if (!plan) throw new Error(`PLANO_INEXISTENTE: ${subscriptionId}`);
    const serviceIds = Array.isArray(plan.servicos_ids) ? [...new Set(plan.servicos_ids)] : [];
    if (!serviceIds.length || serviceIds.some((id) => !services.has(id))) throw new Error(`SERVICOS_DO_PLANO_INVALIDOS: ${subscriptionId}`);
    if (sameValue(subscription.servicos_ids, serviceIds)) {
      alreadyApplied.push(`solicitacoes_assinatura/${subscriptionId}`);
      continue;
    }
    if (Array.isArray(subscription.servicos_ids) && subscription.servicos_ids.length) {
      throw new Error(`ASSINATURA_JA_POSSUI_SERVICOS_DIVERGENTES: ${subscriptionId}`);
    }
    changes.push(updateChange("solicitacoes_assinatura", subscription, "servicos_ids", serviceIds));
  }
  return { changes, alreadyApplied };
}

function planLegacyArchive(source) {
  const appointments = indexById(source.agendamentos);
  const changes = [];
  const alreadyApplied = [];
  for (const [appointmentId, reason] of LEGACY_ARCHIVE_REASONS) {
    const appointment = appointments.get(appointmentId);
    if (!appointment) throw new Error(`AGENDAMENTO_MANUAL_AUSENTE: ${appointmentId}`);
    const archivedAt = appointment.arquivado_em || new Date().toISOString();
    const expected = {
      status: "legacy_unresolved",
      status_anterior: appointment.status_anterior || appointment.status || null,
      arquivado_legado: true,
      excluir_migracao: true,
      motivo_arquivamento: reason,
      decisao_resolucao: "ARQUIVAR_SEM_VINCULO_OPERACIONAL",
      arquivado_em: archivedAt,
    };
    const matches = Object.entries(expected).every(([field, value]) => sameValue(appointment[field], value));
    if (matches) {
      alreadyApplied.push(`agendamentos/${appointmentId}`);
      continue;
    }
    if (appointment.arquivado_legado || appointment.excluir_migracao || appointment.status === "legacy_unresolved") {
      throw new Error(`ARQUIVAMENTO_PARCIAL_OU_DIVERGENTE: ${appointmentId}`);
    }
    changes.push(updateFieldsChange("agendamentos", appointment, expected));
  }
  return { changes, alreadyApplied };
}

function buildPlan(category, source) {
  if (category === "barbeiros") return planBarbers(source);
  if (category === "ocupacoes") return planOccupations(source);
  if (category === "assinatura-servicos") return planSubscriptionServices(source);
  if (category === "arquivamento-legado") return planLegacyArchive(source);
  throw new Error(`Categoria não suportada: ${category}`);
}

function updateWrite(change) {
  const fields = {};
  const fieldPaths = [];
  for (const [field, values] of Object.entries(change.fields)) {
    fieldPaths.push(field);
    if (values.after !== undefined) fields[field] = encodeValue(values.after);
  }
  return {
    update: { name: documentName(change.collection, change.id), fields },
    updateMask: { fieldPaths },
    currentDocument: { updateTime: change.update_time },
  };
}

function createWrite(change, executedAt) {
  const appliedData = { ...change.data, criado_em: new Date(executedAt) };
  return {
    update: { name: documentName(change.collection, change.id), fields: encodeFields(appliedData) },
    currentDocument: { exists: false },
  };
}

function migrationLogWrite(logId, data) {
  return {
    update: { name: documentName("migration_logs", logId), fields: encodeFields(data) },
    currentDocument: { exists: false },
  };
}

async function commitWrites(writes, token) {
  const response = await fetch(COMMIT_URL, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify({ writes }),
  });
  const data = await response.json();
  if (!response.ok) {
    const diagnostic = {
      http_status: response.status,
      status: data.error?.status || null,
      message: data.error?.message || null,
      details: data.error?.details || [],
    };
    throw new Error(`COMMIT_FALHOU: ${JSON.stringify(diagnostic)}`);
  }
  return data;
}

async function saveLocalReport(report) {
  const reportsDir = path.resolve("reports");
  await mkdir(reportsDir, { recursive: true });
  const filename = `integrity-repair-${report.mode.toLowerCase()}-${report.category}-${report.started_at.replace(/[:.]/g, "-")}.json`;
  const output = path.join(reportsDir, filename);
  await writeFile(output, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return output;
}

async function writeOnceReadOnly(filePath, content) {
  await writeFile(filePath, content, { encoding: "utf8", flag: "wx" });
  try {
    await chmod(filePath, 0o444);
  } catch {
    // O hash independente continua detectando qualquer modificação mesmo em
    // sistemas que não aplicam o bit POSIX de somente leitura.
  }
}

async function savePreExecutionSnapshot(category, plan, source, startedAt, executionId) {
  const dateDirectory = startedAt.slice(0, 10);
  const snapshotDirectory = path.resolve("reports", "repair-snapshots", dateDirectory);
  await mkdir(snapshotDirectory, { recursive: true });
  const sourceIndexes = Object.fromEntries(COLLECTIONS.map((collection) => [collection, indexById(source[collection])]));
  const snapshot = {
    tool: "integrity-repair",
    evidence: "PRE_EXECUTION_SNAPSHOT",
    immutable_write_once: true,
    project: PROJECT_ID,
    category,
    execution_id: executionId,
    captured_at: startedAt,
    targets: plan.changes.map((change) => {
      const current = sourceIndexes[change.collection]?.get(change.id);
      return {
        collection: change.collection,
        id: change.id,
        existed_before: Boolean(current),
        update_time_before: current?._updateTime || null,
        document_before: current ? withoutMetadata(current) : null,
      };
    }),
  };
  const content = `${JSON.stringify(snapshot, null, 2)}\n`;
  const hash = createHash("sha256").update(content).digest("hex");
  const snapshotPath = path.join(snapshotDirectory, `${category}-before-${executionId}.json`);
  const hashPath = `${snapshotPath}.sha256`;
  await writeOnceReadOnly(snapshotPath, content);
  await writeOnceReadOnly(hashPath, `${hash}  ${path.basename(snapshotPath)}\n`);
  return { path: snapshotPath, sha256: hash, hash_path: hashPath, target_count: snapshot.targets.length };
}

async function saveValidationReport(validation) {
  const reportsDir = path.resolve("reports");
  await mkdir(reportsDir, { recursive: true });
  const output = path.join(reportsDir, `integrity-repair-validation-${validation.category}-${validation.execution_id}.json`);
  await writeOnceReadOnly(output, `${JSON.stringify(validation, null, 2)}\n`);
  return output;
}

function withoutMetadata(document) {
  return Object.fromEntries(Object.entries(document).filter(([key]) => !key.startsWith("_")));
}

function materializeChanges(changes, executedAt) {
  return changes.map((change) => change.kind === "create" ? {
    ...change,
    expected_after: { ...change.expected_after, criado_em: executedAt },
  } : change);
}

async function validateAppliedChanges(category, executionId, changes, token, startedAt) {
  const results = [];
  for (const change of changes) {
    const current = await readDocument(change.collection, change.id, token);
    const expected = change.kind === "update"
      ? Object.fromEntries(Object.entries(change.fields).map(([field, values]) => [field, values.after]))
      : change.expected_after;
    const observed = current
      ? Object.fromEntries(Object.keys(expected).map((field) => [field, current[field] ?? null]))
      : null;
    results.push({
      collection: change.collection,
      id: change.id,
      exists_after: Boolean(current),
      expected,
      observed,
      matches: Boolean(current) && sameValue(observed, expected),
    });
  }
  const success = results.length === changes.length && results.every((item) => item.matches);
  return {
    tool: "integrity-repair",
    evidence: "POST_EXECUTION_VALIDATION",
    project: PROJECT_ID,
    category,
    execution_id: executionId,
    started_at: startedAt,
    validated_at: new Date().toISOString(),
    status: success ? "SUCCESS" : "FALHA",
    expected_documents: changes.length,
    validated_documents: results.filter((item) => item.matches).length,
    results,
    release_next_category: success,
  };
}

function logStatusWrite(logId, currentLog, status, validation, validationPath) {
  return {
    update: {
      name: currentLog._name,
      fields: encodeFields({
        status,
        validation_status: validation.status,
        validation_report: validationPath,
        validated_at: validation.validated_at,
        validated_documents: validation.validated_documents,
        expected_documents: validation.expected_documents,
        release_next_category: validation.release_next_category,
      }),
    },
    updateMask: { fieldPaths: ["status", "validation_status", "validation_report", "validated_at", "validated_documents", "expected_documents", "release_next_category"] },
    currentDocument: { updateTime: currentLog._updateTime },
  };
}

async function applyPlan(category, plan, token, startedAt, executionId, snapshot) {
  const executedAt = new Date().toISOString();
  const logId = `integrity-repair-${category}-${executionId}`;
  const appliedChanges = materializeChanges(plan.changes, executedAt);
  const writes = appliedChanges.map((change) => change.kind === "update" ? updateWrite(change) : createWrite(change, executedAt));
  const log = {
    migration: "legacy-integrity-repair",
    category,
    status: "APPLIED_PENDING_VALIDATION",
    execution_id: executionId,
    started_at: startedAt,
    finished_at: executedAt,
    documents_written: appliedChanges.length,
    changes: appliedChanges,
    snapshot_path: snapshot.path,
    snapshot_sha256: snapshot.sha256,
    rollback_available: true,
  };
  writes.push(migrationLogWrite(logId, log));
  const result = await commitWrites(writes, token);
  const validation = await validateAppliedChanges(category, executionId, appliedChanges, token, startedAt);
  const validationPath = await saveValidationReport(validation);
  const currentLog = await readDocument("migration_logs", logId, token);
  if (!currentLog || currentLog.status !== "APPLIED_PENDING_VALIDATION") throw new Error("MIGRATION_LOG_PENDENTE_NAO_ENCONTRADO");
  await commitWrites([logStatusWrite(logId, currentLog, validation.status, validation, validationPath)], token);
  return {
    logId,
    executedAt,
    commitTime: result.commitTime || null,
    changes: appliedChanges,
    validation,
    validationPath,
  };
}

function rollbackPatchWrite(change, current) {
  const fields = {};
  const fieldPaths = [];
  for (const [field, values] of Object.entries(change.fields)) {
    if (!sameValue(current[field], values.after)) throw new Error(`ROLLBACK_ESTADO_DIVERGENTE: ${change.collection}/${change.id}.${field}`);
    fieldPaths.push(field);
    if (values.before_present) fields[field] = encodeValue(values.before);
  }
  return {
    update: { name: current._name, fields },
    updateMask: { fieldPaths },
    currentDocument: { updateTime: current._updateTime },
  };
}

function rollbackDeleteWrite(change, current) {
  if (!current) throw new Error(`ROLLBACK_DOCUMENTO_AUSENTE: ${change.collection}/${change.id}`);
  for (const [field, expected] of Object.entries(change.expected_after || {})) {
    if (!sameValue(current[field], expected)) throw new Error(`ROLLBACK_ESTADO_DIVERGENTE: ${change.collection}/${change.id}.${field}`);
  }
  return { delete: current._name, currentDocument: { updateTime: current._updateTime } };
}

function validateRollbackScope(original) {
  if (!original.migration_log_id || !Array.isArray(original.changes)) throw new Error("Relatório de aplicação incompleto.");
  for (const change of original.changes) {
    if (original.category === "barbeiros") {
      if (change.kind !== "update" || change.collection !== "agendamentos" || !APPROVED_BARBER_APPOINTMENTS.has(change.id)
        || JSON.stringify(Object.keys(change.fields || {})) !== JSON.stringify(["barbeiro_id"])) {
        throw new Error(`ROLLBACK_FORA_DO_ESCOPO_APROVADO: ${change.collection}/${change.id}`);
      }
      assertNotManual(change.collection, change.id);
    } else if (original.category === "ocupacoes") {
      if (change.kind !== "create" || change.collection !== "ocupacoes"
        || !APPROVED_OCCUPANCY_APPOINTMENTS.has(change.data?.agendamento_id)
        || change.id !== occupationId(change.data?.barbeiro_id, change.data?.data, change.data?.horario)) {
        throw new Error(`ROLLBACK_FORA_DO_ESCOPO_APROVADO: ${change.collection}/${change.id}`);
      }
      assertNotManual("agendamentos", change.data.agendamento_id);
    } else if (original.category === "assinatura-servicos") {
      if (change.kind !== "update" || change.collection !== "solicitacoes_assinatura" || !APPROVED_SUBSCRIPTIONS.has(change.id)
        || JSON.stringify(Object.keys(change.fields || {})) !== JSON.stringify(["servicos_ids"])) {
        throw new Error(`ROLLBACK_FORA_DO_ESCOPO_APROVADO: ${change.collection}/${change.id}`);
      }
    } else if (original.category === "arquivamento-legado") {
      if (change.kind !== "update" || change.collection !== "agendamentos" || !LEGACY_ARCHIVE_REASONS.has(change.id)
        || !sameValue(Object.keys(change.fields || {}), LEGACY_ARCHIVE_FIELDS)) {
        throw new Error(`ROLLBACK_FORA_DO_ESCOPO_APROVADO: ${change.collection}/${change.id}`);
      }
    } else {
      throw new Error(`Categoria de rollback não permitida: ${original.category}`);
    }
  }
}

async function performRollback(reportPath, token) {
  const original = JSON.parse(await readFile(path.resolve(reportPath), "utf8"));
  if (original.mode !== "APPLY" || original.status !== "SUCCESS" || !CATEGORIES.has(original.category)) {
    throw new Error("Relatório não representa uma aplicação válida e concluída.");
  }
  validateRollbackScope(original);
  const remoteLog = await readDocument("migration_logs", original.migration_log_id, token);
  if (!remoteLog || remoteLog.status !== "SUCCESS" || remoteLog.category !== original.category
    || !sameValue(remoteLog.changes, original.changes)) {
    throw new Error("ROLLBACK_LOG_NAO_CONFERE_COM_MIGRATION_LOGS");
  }
  const source = await readSource(token);
  const indexes = Object.fromEntries(COLLECTIONS.map((collection) => [collection, indexById(source[collection])]));
  const writes = original.changes.map((change) => {
    if (!indexes[change.collection]) throw new Error(`Coleção não permitida no rollback: ${change.collection}`);
    const current = indexes[change.collection].get(change.id);
    if (change.kind === "update") {
      if (!current) throw new Error(`ROLLBACK_DOCUMENTO_AUSENTE: ${change.collection}/${change.id}`);
      return rollbackPatchWrite(change, current);
    }
    if (change.kind === "create") return rollbackDeleteWrite(change, current);
    throw new Error(`Tipo de alteração inválido: ${change.kind}`);
  });
  const now = new Date().toISOString();
  const rollbackLogId = `integrity-rollback-${original.category}-${now.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
  writes.push(migrationLogWrite(rollbackLogId, {
    migration: "legacy-integrity-repair-rollback",
    category: original.category,
    status: "SUCCESS",
    original_log_id: original.migration_log_id,
    started_at: now,
    finished_at: now,
    documents_written: original.changes.length,
  }));
  const result = await commitWrites(writes, token);
  const rollbackReport = {
    tool: "integrity-repair",
    mode: "ROLLBACK",
    status: "SUCCESS",
    category: original.category,
    migration_log_id: rollbackLogId,
    original_log_id: original.migration_log_id,
    started_at: now,
    finished_at: new Date().toISOString(),
    commit_time: result.commitTime || null,
    changes: original.changes,
  };
  const output = await saveLocalReport(rollbackReport);
  console.log(`Rollback concluído: ${output}`);
}

function selfTest() {
  if (documentName("agendamentos", "abc") !== "projects/barber-a01e7/databases/(default)/documents/agendamentos/abc") {
    throw new Error("Self-test falhou no nome canônico de documento do commit.");
  }
  const source = Object.fromEntries(COLLECTIONS.map((collection) => [collection, []]));
  source.barbeiros = [
    { id: "new-barber", nome: "Barber Unique", ativo: true },
    { id: "3SPyrJwVWulSjl9t7ati", nome: "Barber A", ativo: true },
    { id: "fxtjJbFFaZ0i86ZeRKL3", nome: "Barber B", ativo: true },
    { id: "1OZRgMZpK8Eb8aCfuG07", nome: "Barber C", ativo: true },
  ];
  source.servicos = [{ id: "service-1", nome: "Corte" }];
  source.planos_assinatura = [{ id: "plan-1", servicos_ids: ["service-1"] }];
  source.solicitacoes_assinatura = [{ id: [...APPROVED_SUBSCRIPTIONS][0], status: "ATIVA", plano_id: "plan-1", _updateTime: "test" }];
  source.agendamentos = [...APPROVED_BARBER_APPOINTMENTS].map((id) => ({
    id, barbeiro_id: "old-barber", barbeiro_nome: "Barber Unique", status: "cancelado", _updateTime: "test",
  }));
  const barberPlan = planBarbers(source);
  source.agendamentos = [...APPROVED_OCCUPANCY_APPOINTMENTS].map((id) => {
    const match = /_(\d{4}-\d{2}-\d{2})_(\d{2}:\d{2})$/.exec(id);
    const barberId = id.startsWith("o0z2rcpKcyOFWrveBrs8_") ? "1OZRgMZpK8Eb8aCfuG07" : id.split("_")[0];
    return { id, barbeiro_id: barberId, data: match[1], horario: match[2], duracao: 30, status: "agendado" };
  });
  const occupationPlan = planOccupations(source);
  const subscriptionPlan = planSubscriptionServices(source);
  source.agendamentos = [...LEGACY_ARCHIVE_REASONS].map(([id], index) => ({
    id,
    status: index === 0 ? "concluido" : "cancelado",
    _updateTime: "test",
  }));
  const archivePlan = planLegacyArchive(source);
  if (barberPlan.changes.length !== 3 || occupationPlan.changes.length !== 15 || subscriptionPlan.changes.length !== 1
    || archivePlan.changes.length !== 5) {
    throw new Error("Self-test falhou nas categorias aprovadas.");
  }
  if (MANUAL_BLOCKLIST.size !== 5 || LEGACY_ARCHIVE_REASONS.size !== 5 || APPROVED_OCCUPANCY_APPOINTMENTS.size !== 15) {
    throw new Error("Self-test falhou no escopo fechado.");
  }
  console.log("Self-test APROVADO: escopo 3 + 15 + 1 e arquivamento manual exato de 5 documentos.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  validateArgs(args);
  if (args.selfTest) return selfTest();
  const token = await accessToken();
  if (args.rollback) return performRollback(args.rollback, token);

  const startedAt = new Date().toISOString();
  const source = await readSource(token);
  const plan = buildPlan(args.category, source);
  const report = {
    tool: "integrity-repair",
    version: 1,
    project: PROJECT_ID,
    mode: args.dryRun ? "DRY_RUN" : "APPLY",
    status: args.dryRun ? "PREVIEW" : "PENDING",
    category: args.category,
    started_at: startedAt,
    finished_at: null,
    approved_scope: { barbeiros: 3, ocupacoes: 15, "assinatura-servicos": 1, "arquivamento-legado": 5 },
    changes: plan.changes,
    already_applied: plan.alreadyApplied,
    firestore_writes: 0,
  };

  if (args.apply && plan.changes.length) {
    const executionId = `${startedAt.replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const snapshot = await savePreExecutionSnapshot(args.category, plan, source, startedAt, executionId);
    const applied = await applyPlan(args.category, plan, token, startedAt, executionId, snapshot);
    report.status = applied.validation.status;
    report.migration_log_id = applied.logId;
    report.commit_time = applied.commitTime;
    report.execution_id = executionId;
    report.snapshot = snapshot;
    report.validation = {
      status: applied.validation.status,
      report: applied.validationPath,
      expected_documents: applied.validation.expected_documents,
      validated_documents: applied.validation.validated_documents,
      release_next_category: applied.validation.release_next_category,
    };
    report.changes = applied.changes;
    report.firestore_writes = plan.changes.length + 2;
  } else if (args.apply) {
    report.status = "NO_CHANGES_IDEMPOTENT";
  }
  report.finished_at = new Date().toISOString();
  const output = await saveLocalReport(report);
  console.log(`${report.mode} ${report.status}: ${plan.changes.length} alteração(ões), ${plan.alreadyApplied.length} já aplicada(s).`);
  console.log(`Relatório local: ${output}`);
  if (report.status === "FALHA") {
    console.error("Validação pós-execução falhou. A próxima categoria permanece bloqueada.");
    process.exitCode = 2;
  }
}

main().catch((error) => {
  console.error(`Integrity repair interrompido sem continuar: ${error.message}`);
  process.exitCode = 1;
});
