#!/usr/bin/env node

/*
 * Lote 2 HML — preparação offline.
 *
 * O modo remoto existe apenas atrás de --batch2 + confirmação explícita HML.
 * Esta rodada valida somente o código local; o modo remoto não é invocado.
 */

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

export const PROJECT = "teste-483f6";
export const PRODUCTION_PROJECT = "barber-a01e7";
export const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
export const REGION = "southamerica-east1";
export const BARBER_ID = "YMJrJJ58I6N9bMl4jsgy";
export const CALLABLE_NAME = "executeOperationalCommand";
export const CALLABLE = `https://${REGION}-${PROJECT}.cloudfunctions.net/${CALLABLE_NAME}`;
export const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,120}$/;

const BATCH2_COMMANDS = new Set([
  "cliente.atualizar-perfil",
  "assinatura.solicitar",
  "bloqueio.criar",
  "bloqueio.remover",
  "agenda.criar",
  "agenda.cancelar",
  "agenda.reagendar",
  "admin.assinatura.cancelar",
]);

const MUTATING_COMMANDS = new Set([
  "cliente.atualizar-perfil",
  "assinatura.solicitar",
  "bloqueio.criar",
  "bloqueio.remover",
  "agenda.criar",
  "agenda.cancelar",
  "agenda.reagendar",
  // Cleanup operacional da fixture criada por assinatura.solicitar.
  "admin.assinatura.cancelar",
]);

let credentialState = { admin: null, client: null };
let remoteAccessed = false;

export function clearCredentials() {
  for (const key of ["admin", "client"]) {
    const session = credentialState[key];
    if (session) {
      session.idToken = "";
      session.refreshToken = "";
      session.localId = "";
    }
    credentialState[key] = null;
  }
}

export function parseArgs(argv = process.argv) {
  return {
    project: argv.find((value) => value.startsWith("--project="))?.slice(10) || "",
    adminAuth: argv.find((value) => value.startsWith("--auth-admin="))?.slice(13) || "",
    clientAuth: argv.find((value) => value.startsWith("--auth-client="))?.slice(14) || "",
    confirm: argv.includes("--confirm-hml-write"),
    batch2: argv.includes("--batch2"),
    selfTest: argv.includes("--self-test"),
  };
}

export function guardBatch2Options(opts) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === PRODUCTION_PROJECT) throw new Error("production is forbidden");
  if (opts.adminAuth !== "interactive" || opts.clientAuth !== "interactive") {
    throw new Error("both interactive auth modes are required");
  }
  if (!opts.confirm) throw new Error("--confirm-hml-write is required");
  if (!opts.batch2) throw new Error("--batch2 is required");
  return true;
}

export function isAllowedCommand(command) {
  return BATCH2_COMMANDS.has(command);
}

export function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function newRequestId(prefix, runId = randomUUID().replaceAll("-", "")) {
  const requestId = `${prefix}-${runId}`;
  if (!REQUEST_ID_PATTERN.test(requestId)) throw new Error("generated request ID is invalid");
  return requestId;
}

export function validRequestId(value) {
  return REQUEST_ID_PATTERN.test(String(value || ""));
}

export function validateRequestId(value) {
  if (!validRequestId(value)) throw new Error("invalid request ID");
  return value;
}

export function cleanupRequestId(prefix, runId) {
  return newRequestId(`hml-lote2-${prefix}-cleanup`, runId);
}

export function buildCallableEnvelope(command, payload, requestId) {
  if (!isAllowedCommand(command)) throw new Error("command is outside Lote 2");
  if (!validRequestId(requestId)) throw new Error("invalid request ID");
  return {
    data: {
      command,
      requestId,
      ...(payload || {}),
    },
  };
}

function decodeJwt(token) {
  const segments = String(token || "").trim().split(".");
  if (segments.length !== 3) return null;
  try {
    const payload = segments[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(segments[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

export function validateIdToken(idToken, localId, expectedProject = PROJECT) {
  const claims = decodeJwt(idToken);
  if (!claims || claims.aud !== expectedProject) throw new Error("ID token project mismatch");
  if (claims.sub !== localId) throw new Error("ID token subject mismatch");
  if (!(Number(claims.exp) > Math.floor(Date.now() / 1000))) throw new Error("ID token expired");
  return { aud: claims.aud, sub: claims.sub, notExpired: true };
}

function authConfig() {
  const source = readFileSync(new URL("../public-hml/js/firebase-config.js", import.meta.url), "utf8");
  const apiKey = source.match(/"apiKey"\s*:\s*"([^"]+)"/)?.[1] || "";
  const projectId = source.match(/"projectId"\s*:\s*"([^"]+)"/)?.[1] || "";
  if (projectId !== PROJECT || !apiKey) throw new Error("HML Auth configuration unavailable");
  return { apiKey, projectId };
}

export async function authenticateInteractive({ label, email, password, request = fetch, apiKey = authConfig().apiKey }) {
  if (!email?.trim() || !password) throw new Error(`${label} credentials are required`);
  remoteAccessed = true;
  const response = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
  });
  const body = await response.json();
  if (!response.ok || !body.idToken || !body.localId) throw new Error(`${label} authentication failed`);
  const session = { idToken: String(body.idToken).trim(), refreshToken: String(body.refreshToken || ""), localId: String(body.localId) };
  validateIdToken(session.idToken, session.localId);
  return session;
}

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    let value = "";
    process.stdout.write(label);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") {
        cleanup();
        reject(new Error("interactive authentication cancelled"));
      } else if (text === "\r" || text === "\n") {
        cleanup();
        process.stdout.write("\n");
        resolve(value);
      } else {
        value += text;
      }
    };
    const cleanup = () => {
      stdin.off("data", onData);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
    };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8");
    stdin.resume();
    stdin.on("data", onData);
  });
}

async function interactiveSession(label) {
  let email = await promptSecret(`${label} e-mail: `);
  let password = await promptSecret(`${label} senha: `);
  try {
    return await authenticateInteractive({ label, email, password });
  } finally {
    email = null;
    password = null;
  }
}

function decodeFirestoreValue(value) {
  if (value?.stringValue !== undefined) return value.stringValue;
  if (value?.booleanValue !== undefined) return value.booleanValue;
  if (value?.integerValue !== undefined) return Number(value.integerValue);
  if (value?.doubleValue !== undefined) return Number(value.doubleValue);
  if (value?.timestampValue !== undefined) return value.timestampValue;
  if (value?.arrayValue) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (value?.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decodeFirestoreValue(item)]));
  return null;
}

function firestoreFields(doc) {
  return Object.fromEntries(Object.entries(doc?.fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function normalizedStatus(value) {
  return value?.fields ? firestoreFields(value).status : value?.status;
}

function decodedFields(value) {
  return value?.fields ? firestoreFields(value) : (value || {});
}

async function auditGet(path, token, request = fetch) {
  remoteAccessed = true;
  const response = await request(`${FIRESTORE_ROOT}/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) {
    const error = new Error(`audit GET HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return response.json();
}

async function auditList(collection, token, request = fetch) {
  remoteAccessed = true;
  const response = await request(`${FIRESTORE_ROOT}/${collection}?pageSize=1000`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return [];
  if (!response.ok) {
    const error = new Error(`audit LIST HTTP ${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return (await response.json()).documents || [];
}

function assertNoUndefined(value, path = "query") {
  if (value === undefined) throw new Error(`undefined query value: ${path}`);
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoUndefined(item, `${path}[${index}]`));
    return;
  }
  if (value && typeof value === "object") {
    Object.entries(value).forEach(([key, item]) => assertNoUndefined(item, `${path}.${key}`));
  }
}

function assertFirestoreValue(value) {
  const supported = ["nullValue", "booleanValue", "integerValue", "doubleValue", "timestampValue", "stringValue", "bytesValue", "referenceValue", "geoPointValue", "arrayValue", "mapValue"];
  if (!value || typeof value !== "object" || !supported.some((key) => Object.prototype.hasOwnProperty.call(value, key))) {
    throw new Error("invalid Firestore filter value");
  }
  assertNoUndefined(value, "filter.value");
}

export function buildAuditStructuredQuery(collectionId, filters = [], { orderBy = [], limit } = {}) {
  if (!String(collectionId || "") || String(collectionId).includes("/")) throw new Error("invalid query collection");
  const normalizedFilters = filters.map((entry) => {
    if (!Array.isArray(entry) || entry.length !== 2 || !String(entry[0] || "")) throw new Error("invalid query filter");
    const [field, value] = entry;
    assertFirestoreValue(value);
    return { fieldFilter: { field: { fieldPath: String(field) }, op: "EQUAL", value } };
  });
  const structuredQuery = { from: [{ collectionId: String(collectionId) }] };
  if (normalizedFilters.length === 1) structuredQuery.where = normalizedFilters[0];
  if (normalizedFilters.length > 1) structuredQuery.where = { compositeFilter: { op: "AND", filters: normalizedFilters } };
  if (orderBy.length) {
    structuredQuery.orderBy = orderBy.map((entry) => {
      const fieldPath = typeof entry === "string" ? entry : entry?.fieldPath;
      const direction = typeof entry === "string" ? "ASCENDING" : (entry?.direction || "ASCENDING");
      if (!fieldPath || !["ASCENDING", "DESCENDING"].includes(direction)) throw new Error("invalid query orderBy");
      return { field: { fieldPath: String(fieldPath) }, direction };
    });
  }
  if (limit !== undefined) {
    if (!Number.isInteger(limit) || limit <= 0) throw new Error("invalid query limit");
    structuredQuery.limit = limit;
  }
  assertNoUndefined(structuredQuery);
  return structuredQuery;
}

function safeFirestoreErrorMessage(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .replace(/[^\x20-\x7E]+/g, " ")
    .slice(0, 180);
}

async function readResponseJson(response) {
  if (typeof response.text === "function") {
    const raw = await response.text();
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  if (typeof response.json === "function") return response.json();
  return {};
}

export async function auditQuery(collectionId, filters, token, request = fetch, options = {}) {
  remoteAccessed = true;
  const structuredQuery = buildAuditStructuredQuery(collectionId, filters, options);
  const stage = options.stage || (collectionId === "agendamentos" ? "SLOT_SELECTION" : "AUDIT_QUERY");
  const response = await request(`${FIRESTORE_ROOT}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery }),
  });
  const body = await readResponseJson(response);
  if (!response.ok) {
    const firestoreError = body?.error || {};
    console.log(JSON.stringify({
      AUDIT_QUERY_STAGE: stage,
      COLLECTION_ID: String(collectionId),
      QUERY_FILTER_FIELDS: filters.map(([field]) => String(field)),
      QUERY_ORDER_FIELDS: (options.orderBy || []).map((entry) => String(typeof entry === "string" ? entry : entry?.fieldPath || "")),
      HTTP_STATUS: response.status,
      FIRESTORE_ERROR_STATUS: String(firestoreError.status || ""),
      FIRESTORE_ERROR_MESSAGE_SAFE: safeFirestoreErrorMessage(firestoreError.message),
    }));
    const error = new Error(`audit QUERY HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.firestoreStatus = String(firestoreError.status || "");
    error.firestoreMessageSafe = safeFirestoreErrorMessage(firestoreError.message);
    throw error;
  }
  return (Array.isArray(body) ? body : []).filter((item) => item.document).map((item) => item.document);
}

async function callOperational(command, payload, requestId, token, request = fetch) {
  remoteAccessed = true;
  const response = await request(CALLABLE, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildCallableEnvelope(command, payload, requestId)),
  });
  const body = await response.json();
  if (!response.ok || body?.error) {
    const error = new Error(body?.error?.message || `callable HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.code = body?.error?.status || "";
    throw error;
  }
  const result = body?.result ?? body?.data;
  if (!result || typeof result !== "object") throw new Error("invalid callable response");
  return result;
}

function roles(doc) {
  const value = firestoreFields(doc).papeis;
  return Array.isArray(value) ? value.map(String) : [];
}

async function resolveOperationalUid(authUid, token, read = auditGet) {
  const mapping = await read(`homologacao_mapeamentos/${authUid}`, token);
  const data = firestoreFields(mapping);
  if (!mapping || data.ativo !== true || data.tenant_id !== TENANT || !data.uid_producao_referencia) {
    throw new Error("HML identity mapping invalid");
  }
  return String(data.uid_producao_referencia);
}

async function proveAdminIdentity(session, read = auditGet) {
  const operationalUid = await resolveOperationalUid(session.localId, session.idToken, read);
  const admin = await read(`admins/${operationalUid}`, session.idToken);
  const member = await read(`barbearias/${TENANT}/membros/${operationalUid}`, session.idToken);
  if (!admin || !member || !roles(member).includes("ADMIN")) throw new Error("ADMIN identity not proven");
  return { proven: true, authUid: session.localId, operationalUid, tenant: TENANT };
}

async function proveClientIdentity(session, read = auditGet) {
  const operationalUid = await resolveOperationalUid(session.localId, session.idToken, read);
  const profile = await read(`clientes/${operationalUid}`, session.idToken);
  const member = await read(`barbearias/${TENANT}/membros/${operationalUid}`, session.idToken);
  const memberRoles = roles(member);
  if (!profile || !member || !memberRoles.includes("CLIENTE") || memberRoles.includes("ADMIN") || memberRoles.includes("BARBEIRO")) {
    throw new Error("CLIENT identity not proven");
  }
  return { proven: true, authUid: session.localId, operationalUid, tenant: TENANT, isAdmin: false, isBarber: false };
}

const VOLATILE_FIELDS = new Set([
  "criado_em", "atualizado_em", "solicitado_em", "termos_aceitos_em", "cancelada_em", "reagendado_em",
  "cancelado_em", "reagendado_em", "ultima_reserva_em", "ultima_liberacao_em", "reservado_em",
]);

function stableSemanticValue(value) {
  if (Array.isArray(value)) return value.map(stableSemanticValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableSemanticValue(value[key])]));
}

function semanticDocument(doc, fields = null) {
  const value = firestoreFields(doc);
  for (const field of VOLATILE_FIELDS) delete value[field];
  if (fields) return stableSemanticValue(Object.fromEntries(fields.filter((field) => Object.prototype.hasOwnProperty.call(value, field)).map((field) => [field, value[field]])));
  return stableSemanticValue(value);
}

function equivalentByDocument(left, right, fields = null) {
  return Boolean(left && right) && JSON.stringify(semanticDocument(left, fields)) === JSON.stringify(semanticDocument(right, fields));
}

export function clientProfileEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

export function subscriptionEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

export function blockEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

export function appointmentEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

export function occupancyEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

export function semanticEquivalent(left, right) {
  return equivalentByDocument(left, right);
}

function pathPair(collection, id) {
  const v2Collection = { clientes: "clientes", solicitacoes_assinatura: "assinaturas", bloqueios: "bloqueios", agendamentos: "agendamentos", ocupacoes: "ocupacoes" }[collection];
  return { legacy: `${collection}/${id}`, v2: `barbearias/${TENANT}/${v2Collection}/${id}` };
}

async function readPair(collection, id, token, read = auditGet) {
  const paths = pathPair(collection, id);
  return { legacy: await read(paths.legacy, token), v2: await read(paths.v2, token) };
}

async function findEligiblePlan(token, list = auditList) {
  const plans = (await list("planos_assinatura", token));
  const eligible = plans.find((item) => {
    const value = firestoreFields(item);
    return value.ativo === true && Number(value.preco_centavos) > 0 && Array.isArray(value.servicos_ids) && value.servicos_ids.length > 0;
  });
  const plan = eligible ? firestoreFields(eligible) : null;
  if (!plan) throw new Error("no eligible HML plan");
  const id = String(plan.id || String(eligible.name || "").split("/").at(-1));
  if (!id) throw new Error("eligible plan has no stable ID");
  return { id, ...plan };
}

function minutesOf(time) {
  const [hour, minute] = String(time).split(":").map(Number);
  return hour * 60 + minute;
}

function timeOf(total) {
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function dateAfterDays(days) {
  const value = new Date();
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

export async function auditSlotCandidate({ barberId, date, time, token, read = auditGet }) {
  const appointmentId = `${barberId}_${date}_${time}`;
  const [legacyAppointment, v2Appointment, legacyOccupation, v2Occupation, legacyBlock, v2Block] = await Promise.all([
    read(`agendamentos/${appointmentId}`, token),
    read(`barbearias/${TENANT}/agendamentos/${appointmentId}`, token),
    read(`ocupacoes/${appointmentId}`, token),
    read(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, token),
    read(`bloqueios/${appointmentId}`, token),
    read(`barbearias/${TENANT}/bloqueios/${appointmentId}`, token),
  ]);
  return {
    appointmentId,
    date,
    time,
    legacyAppointment,
    v2Appointment,
    legacyOccupation,
    v2Occupation,
    legacyBlock,
    v2Block,
    legacyAppointmentPresent: Boolean(legacyAppointment),
    v2AppointmentPresent: Boolean(v2Appointment),
    legacyOccupationPresent: Boolean(legacyOccupation),
    v2OccupationPresent: Boolean(v2Occupation),
    blockPresent: Boolean(legacyBlock || v2Block),
    safe: !legacyAppointment && !v2Appointment && !legacyOccupation && !v2Occupation && !legacyBlock && !v2Block,
  };
}

function emitSlotCollision(stage, slot) {
  console.log(JSON.stringify({
    SLOT_COLLISION_STAGE: stage,
    COLLISION_DATE: slot.date,
    COLLISION_TIME: slot.time,
    LEGACY_APPOINTMENT_CONFLICT: slot.legacyAppointmentPresent,
    V2_APPOINTMENT_CONFLICT: slot.v2AppointmentPresent,
    LEGACY_OCCUPANCY_CONFLICT: slot.legacyOccupationPresent,
    V2_OCCUPANCY_CONFLICT: slot.v2OccupationPresent,
    BLOCK_CONFLICT: slot.blockPresent,
  }));
}

function assertSlotIsFree(slot, stage, errorMessage) {
  if (!slot.safe) {
    emitSlotCollision(stage, slot);
    throw new Error(errorMessage);
  }
  return true;
}

export async function findAvailableSlot({ barberId, serviceId, token, read = auditGet, query = auditQuery, excluded = [] }) {
  const barber = firestoreFields(await read(`barbeiros/${barberId}`, token));
  const service = firestoreFields(await read(`servicos/${serviceId}`, token));
  if (!barber.ativo || !service.ativo) throw new Error("barber or service unavailable");
  if (Number(service.duracao || 30) !== 30) throw new Error("Lote 2 requires a 30-minute service fixture");
  const config = firestoreFields(await read("configuracoes/funcionamento", token));
  for (let offset = 1; offset <= 21; offset += 1) {
    const dateObject = dateAfterDays(offset);
    const date = dateObject.toISOString().slice(0, 10);
    const day = dateObject.getUTCDay();
    if (config.dias_fechados_semana?.[day] === true) continue;
    for (const period of config.periodos_semana?.[day] || []) {
      for (let cursor = minutesOf(period.inicio); cursor + 30 <= minutesOf(period.fim); cursor += 30) {
      const time = timeOf(cursor);
      if (excluded.some((item) => item.date === date && item.time === time)) continue;
      const appointments = await query("agendamentos", [["barbeiro_id", { stringValue: barberId }], ["data", { stringValue: date }]], token);
      const occupiedAppointment = appointments.some((item) => {
        const data = firestoreFields(item);
        return data.horario === time && !["cancelado", "nao_compareceu"].includes(data.status);
      });
      const slot = await auditSlotCandidate({ barberId, date, time, token, read });
      if (!occupiedAppointment && slot.safe) return { barberId, serviceId, date, time };
      }
    }
  }
  throw new Error("no safe HML slot available");
}

async function auditAppointment(appointmentId, token, read = auditGet) {
  const pair = await readPair("agendamentos", appointmentId, token, read);
  const legacy = firestoreFields(pair.legacy);
  const v2 = firestoreFields(pair.v2);
  const oldOccupation = await read(`ocupacoes/${appointmentId}`, token);
  const newOccupation = await read(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, token);
  return { ...pair, legacyDoc: pair.legacy, v2Doc: pair.v2, legacy, v2, oldOccupation, newOccupation, equivalent: appointmentEquivalent(pair.legacy, pair.v2), occupationEquivalent: occupancyEquivalent(oldOccupation, newOccupation) };
}

function assertRebookTarget(appointment, { barberId, clientId, serviceId, date, time }) {
  for (const projection of [appointment.legacy, appointment.v2]) {
    const value = decodedFields(projection);
    assert(value.barbeiro_id === barberId, "REBOOK_BARBER_MISMATCH");
    assert(value.cliente_id === clientId, "REBOOK_CLIENT_MISMATCH");
    assert(value.servico_id === serviceId, "REBOOK_SERVICE_MISMATCH");
    assert(value.data === date && value.horario === time, "REBOOK_TARGET_SLOT_MISMATCH");
    assert(value.status === "agendado", "REBOOK_TARGET_STATUS_MISMATCH");
  }
}

function safeError(error) {
  return { httpStatus: Number(error?.httpStatus || 0), code: String(error?.code || ""), message: String(error?.message || "").slice(0, 180) };
}

async function callStage(stage, command, payload, requestId, token, call = callOperational) {
  try {
    const response = await call(command, payload, requestId, token);
    const actor = command.startsWith("admin.") || command.startsWith("bloqueio.") || command === "agenda.reagendar" ? "ADMIN" : "CLIENT";
    console.log(JSON.stringify({ BATCH_STAGE: stage, COMMAND: command, ACTOR: actor, REQUEST_ID_PRESENT: true, REQUEST_ID_LENGTH: requestId.length, REQUEST_ID_FINGERPRINT: fingerprint(requestId), RESPONSE_KEYS: Object.keys(response || {}).sort() }));
    return response;
  } catch (error) {
    const safe = safeError(error);
    console.log(JSON.stringify({ BATCH_STAGE: stage, COMMAND: command, HTTP_STATUS: safe.httpStatus, CALLABLE_CODE: safe.code, MESSAGE_SAFE: safe.message }));
    throw error;
  }
}

async function replayPair({ stage, command, payload, requestId, token, fields, call }) {
  const first = await callStage(`${stage}_FIRST`, command, payload, requestId, token, call);
  const second = await callStage(`${stage}_REPLAY`, command, payload, requestId, token, call);
  assertReplay(first, second, fields);
  return { first, second };
}

function addMinutes(time, amount) {
  const [hour, minute] = String(time).split(":").map(Number);
  const total = hour * 60 + minute + amount;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

function chooseRestorableProfileField(profile) {
  const data = firestoreFields(profile);
  // Preferir campos textuais já existentes. Se o campo não existia, não há
  // operação operacional para removê-lo novamente; nesse caso o preflight aborta.
  for (const field of ["nome", "telefone", "observacoes", "periodo_preferido", "data_nascimento"]) {
    if (typeof data[field] === "string") return { field, previous: data[field] };
  }
  throw new Error("PROFILE_RESTORE_UNAVAILABLE");
}

function assertProfileSecurity(profile, clientId) {
  const data = firestoreFields(profile);
  if (data.uid && data.uid !== clientId) throw new Error("CLIENT_UID_CHANGED");
  if (data.tenant_id && data.tenant_id !== TENANT) throw new Error("CLIENT_TENANT_CHANGED");
  const rolesValue = Array.isArray(data.papeis) ? data.papeis.map(String) : [];
  if (rolesValue.includes("ADMIN") || rolesValue.includes("BARBEIRO")) throw new Error("CLIENT_PRIVILEGE_ESCALATION");
}

async function auditBlock(blockId, barberId, date, time, token, read = auditGet) {
  const pair = await readPair("bloqueios", blockId, token, read);
  const occupationId = `${barberId}_${date}_${time}`;
  const legacyOccupation = await read(`ocupacoes/${occupationId}`, token);
  const v2Occupation = await read(`barbearias/${TENANT}/ocupacoes/${occupationId}`, token);
  return {
    ...pair,
    equivalent: blockEquivalent(pair.legacy, pair.v2),
    legacyOccupation,
    v2Occupation,
    occupationEquivalent: occupancyEquivalent(legacyOccupation, v2Occupation),
  };
}

async function auditSubscription(subscriptionId, token, read = auditGet) {
  const pair = await readPair("solicitacoes_assinatura", subscriptionId, token, read);
  const status = firestoreFields(pair.legacy).status || firestoreFields(pair.v2).status || "";
  return { ...pair, status, equivalent: subscriptionEquivalent(pair.legacy, pair.v2), remoteReadCompleted: true };
}

const SUBSCRIPTION_ACTIVE_STATUSES = new Set(["PENDENTE", "ATIVA"]);
const SUBSCRIPTION_TERMINAL_STATUSES = new Set(["CANCELADA", "RECUSADA", "EXPIRADA"]);

export function classifySubscriptionFixture({ subscriptionId, legacy, v2, remoteReadCompleted = false } = {}) {
  const base = {
    subscriptionIdPresent: Boolean(subscriptionId),
    legacyPresent: Boolean(legacy),
    v2Present: Boolean(v2),
    legacyStatus: normalizedStatus(legacy) || "",
    v2Status: normalizedStatus(v2) || "",
    remoteReadCompleted: remoteReadCompleted === true,
  };
  if (!base.subscriptionIdPresent) return { ...base, safe: false, collision: false, reason: "SUBSCRIPTION_ID_MISSING" };
  if (!base.remoteReadCompleted) return { ...base, safe: false, collision: false, reason: "REMOTE_READ_REQUIRED" };
  if (!base.legacyPresent && !base.v2Present) return { ...base, safe: true, collision: false, reason: "ABSENT" };
  if (base.legacyPresent !== base.v2Present) return { ...base, safe: false, collision: false, reason: "PROJECTION_INCONSISTENT" };
  if (!subscriptionEquivalent(legacy, v2)) return { ...base, safe: false, collision: false, reason: "PROJECTION_INCONSISTENT" };
  if (SUBSCRIPTION_ACTIVE_STATUSES.has(base.legacyStatus) || SUBSCRIPTION_ACTIVE_STATUSES.has(base.v2Status)) {
    return { ...base, safe: false, collision: true, reason: "ACTIVE_OR_PENDING" };
  }
  if (SUBSCRIPTION_TERMINAL_STATUSES.has(base.legacyStatus) && SUBSCRIPTION_TERMINAL_STATUSES.has(base.v2Status)) {
    return { ...base, safe: true, collision: false, reason: "HISTORICAL_TERMINAL" };
  }
  return { ...base, safe: false, collision: false, reason: "UNKNOWN_STATUS" };
}

export async function runBatch2Remote({ adminSession, clientSession, adminIdentity, clientIdentity, read = auditGet, list = auditList, query = auditQuery, call = callOperational }) {
  const runId = randomUUID().replaceAll("-", "");
  const plan = buildBatch2Plan({ runId, clientId: clientIdentity.operationalUid });
  const state = {
    profile: { changed: false, field: "", previous: "", initialLegacy: null, initialV2: null },
    subscription: { touched: false, id: "" },
    block: { touched: false, id: "", barberId: "", date: "", time: "", removed: false },
    appointment: { touched: false, oldId: "", newId: "", oldDate: "", oldTime: "", newDate: "", newTime: "", removed: false },
  };
  const outcome = { preflight: "PASS", profile: null, subscription: null, block: null, rebook: null, cleanup: { attempted: [], failures: [] } };
  const cleanupError = (command, error) => outcome.cleanup.failures.push({ command, error: safeError(error) });

  // O try/finally envolve todo o ciclo antes da primeira mutação. Estados são
  // marcados antes da chamada para cobrir commit remoto seguido de erro HTTP.
  try {
    const profile = await read(`clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
    const profileV2 = await read(`barbearias/${TENANT}/clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
    assert(profile, "CLIENT_PROFILE_MISSING");
    assert(profileV2 && clientProfileEquivalent(profile, profileV2), "CLIENT_PROFILE_LEGACY_V2_MISMATCH");
    assertProfileSecurity(profile, clientIdentity.operationalUid);
    const restorable = chooseRestorableProfileField(profile);
    state.profile.field = restorable.field;
    state.profile.previous = restorable.previous;
    state.profile.initialLegacy = profile;
    state.profile.initialV2 = profileV2;

    const planRecord = await findEligiblePlan(adminSession.idToken, list);
    const subscriptionId = `${clientIdentity.operationalUid}_${planRecord.id}`;
    state.subscription.id = subscriptionId;
    const existingSubscription = await auditSubscription(subscriptionId, adminSession.idToken, read);
    const subscriptionPreflight = classifySubscriptionFixture({
      subscriptionId,
      legacy: existingSubscription.legacy,
      v2: existingSubscription.v2,
      remoteReadCompleted: existingSubscription.remoteReadCompleted,
    });
    console.log(JSON.stringify({
      SUBSCRIPTION_PREFLIGHT: {
        REMOTE_READ_COMPLETED: subscriptionPreflight.remoteReadCompleted,
        SUBSCRIPTION_ID_PRESENT: subscriptionPreflight.subscriptionIdPresent,
        SUBSCRIPTION_ID_LENGTH: String(subscriptionId).length,
        SUBSCRIPTION_ID_FINGERPRINT: fingerprint(subscriptionId),
        LEGACY_PRESENT: subscriptionPreflight.legacyPresent,
        V2_PRESENT: subscriptionPreflight.v2Present,
        LEGACY_STATUS: subscriptionPreflight.legacyStatus,
        V2_STATUS: subscriptionPreflight.v2Status,
        EQUIVALENT: existingSubscription.equivalent,
        COLLISION_CLASS: subscriptionPreflight.reason,
      },
    }));
    if (!subscriptionPreflight.safe) {
      throw new Error(subscriptionPreflight.collision ? "SUBSCRIPTION_FIXTURE_COLLISION" : "SUBSCRIPTION_FIXTURE_INCONSISTENT");
    }

    const blockSlot = await findAvailableSlot({ barberId: BARBER_ID, serviceId: String(planRecord.servicos_ids[0]), token: adminSession.idToken, read, query });
    const blockId = `${BARBER_ID}_${blockSlot.date}_${blockSlot.time}`;
    state.block = { touched: false, id: blockId, barberId: BARBER_ID, date: blockSlot.date, time: blockSlot.time, removed: false };
    const existingBlock = await auditBlock(blockId, BARBER_ID, blockSlot.date, blockSlot.time, adminSession.idToken, read);
    if (existingBlock.legacy || existingBlock.v2 || existingBlock.legacyOccupation || existingBlock.v2Occupation) throw new Error("BLOCK_FIXTURE_COLLISION");

    const appointmentSlot = await findAvailableSlot({ barberId: BARBER_ID, serviceId: String(planRecord.servicos_ids[0]), token: adminSession.idToken, read, query, excluded: [blockSlot] });
    const oldId = `${BARBER_ID}_${appointmentSlot.date}_${appointmentSlot.time}`;
    state.appointment = { touched: false, oldId, newId: "", oldDate: appointmentSlot.date, oldTime: appointmentSlot.time, newDate: "", newTime: "", removed: false };
    const existingAppointment = await auditSlotCandidate({ barberId: BARBER_ID, date: appointmentSlot.date, time: appointmentSlot.time, token: adminSession.idToken, read });
    assertSlotIsFree(existingAppointment, "APPOINTMENT_OLD_SLOT_PREFLIGHT", "APPOINTMENT_FIXTURE_COLLISION");
    const targetSlot = await findAvailableSlot({ barberId: BARBER_ID, serviceId: String(planRecord.servicos_ids[0]), token: adminSession.idToken, read, query, excluded: [blockSlot, appointmentSlot] });
    const newId = `${BARBER_ID}_${targetSlot.date}_${targetSlot.time}`;
    state.appointment.newId = newId;
    state.appointment.newDate = targetSlot.date;
    state.appointment.newTime = targetSlot.time;
    const existingTarget = await auditSlotCandidate({ barberId: BARBER_ID, date: targetSlot.date, time: targetSlot.time, token: adminSession.idToken, read });
    assertSlotIsFree(existingTarget, "APPOINTMENT_NEW_SLOT_PREFLIGHT", "REBOOK_TARGET_COLLISION");
    for (const requestId of [plan.profile.requestId, plan.subscription.requestId, plan.block.create, plan.block.remove, plan.appointment.create, plan.appointment.rebook, plan.appointment.cleanup]) {
      validateRequestId(requestId);
    }

    const updateMarker = `L2-${runId.slice(0, 10)}`;
    state.profile.changed = true;
    const profilePair = await replayPair({ stage: "CLIENT_UPDATE", command: "cliente.atualizar-perfil", payload: clientUpdatePayload({ [state.profile.field]: updateMarker }), requestId: plan.profile.requestId, token: clientSession.idToken, fields: ["clientId"], call });
    const updatedProfile = await read(`clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
    const updatedProfileV2 = await read(`barbearias/${TENANT}/clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
    assertProfileSecurity(updatedProfile, clientIdentity.operationalUid);
    assert(updatedProfileV2 && clientProfileEquivalent(updatedProfile, updatedProfileV2), "CLIENT_PROFILE_LEGACY_V2_MISMATCH");
    outcome.profile = { first: profilePair.first, replay: profilePair.second, sameClientId: profilePair.first.clientId === clientIdentity.operationalUid, legacyV2: true };

    state.subscription.touched = true;
    const subscriptionPair = await replayPair({ stage: "SUBSCRIPTION", command: "assinatura.solicitar", payload: subscriptionPayload(planRecord.id), requestId: plan.subscription.requestId, token: clientSession.idToken, fields: ["subscriptionId"], call });
    assert(subscriptionPair.first.subscriptionId === subscriptionId, "SUBSCRIPTION_ID_UNEXPECTED");
    const subscriptionAfter = await auditSubscription(subscriptionId, adminSession.idToken, read);
    assert(subscriptionAfter.legacy && subscriptionAfter.v2 && subscriptionAfter.equivalent && subscriptionAfter.status === "PENDENTE", "SUBSCRIPTION_LEGACY_V2_MISMATCH");
    outcome.subscription = { first: subscriptionPair.first, replay: subscriptionPair.second, legacyV2: subscriptionAfter.equivalent, oneLogicalRequest: true };

    state.block.touched = true;
    const blockPayload = blockCreatePayload({ barberId: BARBER_ID, date: blockSlot.date, start: blockSlot.time, end: addMinutes(blockSlot.time, 30), reason: "Lote 2 HML" });
    const blockPair = await replayPair({ stage: "BLOCK_CREATE", command: "bloqueio.criar", payload: blockPayload, requestId: plan.block.create, token: adminSession.idToken, fields: ["blockId"], call });
    assert(blockPair.first.blockId === blockId, "BLOCK_ID_UNEXPECTED");
    const blockAfter = await auditBlock(blockId, BARBER_ID, blockSlot.date, blockSlot.time, adminSession.idToken, read);
    assert(blockAfter.legacy && blockAfter.v2 && blockAfter.equivalent && blockAfter.legacyOccupation && blockAfter.v2Occupation && blockAfter.occupationEquivalent, "BLOCK_LEGACY_V2_MISMATCH");
    const blockRemoved = await callStage("BLOCK_REMOVE", "bloqueio.remover", blockRemovePayload(blockId), plan.block.remove, adminSession.idToken, call);
    state.block.removed = true;
    const blockFinal = await auditBlock(blockId, BARBER_ID, blockSlot.date, blockSlot.time, adminSession.idToken, read);
    assert(!blockFinal.legacy && !blockFinal.v2 && !blockFinal.legacyOccupation && !blockFinal.v2Occupation, "BLOCK_RESIDUE");
    outcome.block = { first: blockPair.first, replay: blockPair.second, remove: blockRemoved, legacyV2: blockAfter.equivalent, zeroResidue: true };

    state.appointment.touched = true;
    const createPayload = appointmentCreatePayload({ clientId: clientIdentity.operationalUid, barberId: BARBER_ID, serviceId: String(planRecord.servicos_ids[0]), date: appointmentSlot.date, time: appointmentSlot.time });
    const created = await callStage("APPOINTMENT_CREATE", "agenda.criar", createPayload, plan.appointment.create, clientSession.idToken, call);
    assert(created.appointmentId === oldId, "APPOINTMENT_ID_UNEXPECTED");
    // O cleanup deve usar o identificador retornado pela operação, não apenas
    // o ID calculado pelo slot. A igualdade é validada acima e o valor real é
    // retido até o finally para cobrir respostas pós-commit.
    state.appointment.oldId = String(created.appointmentId);
    const rebookPayload = appointmentRebookPayload({ appointmentId: oldId, serviceId: String(planRecord.servicos_ids[0]), date: targetSlot.date, time: targetSlot.time });
    const rebookPair = await replayPair({ stage: "REBOOK", command: "agenda.reagendar", payload: rebookPayload, requestId: plan.appointment.rebook, token: adminSession.idToken, fields: ["appointmentId", "replacedAppointmentId"], call });
    assert(rebookPair.first.replacedAppointmentId === oldId && rebookPair.first.appointmentId === newId, "REBOOK_LOGICAL_ID_MISMATCH");
    const oldAfter = await auditAppointment(oldId, adminSession.idToken, read);
    const newAfter = await auditAppointment(newId, adminSession.idToken, read);
    assert(normalizedStatus(oldAfter.legacy) === "cancelado" && normalizedStatus(oldAfter.v2) === "cancelado" && !oldAfter.oldOccupation && !oldAfter.newOccupation, "OLD_SLOT_NOT_RELEASED");
    assert(newAfter.legacy?.status === "agendado" && newAfter.oldOccupation && newAfter.newOccupation && newAfter.equivalent && newAfter.occupationEquivalent, "NEW_SLOT_NOT_RESERVED");
    assertRebookTarget(newAfter, {
      barberId: BARBER_ID,
      clientId: clientIdentity.operationalUid,
      serviceId: String(planRecord.servicos_ids[0]),
      date: targetSlot.date,
      time: targetSlot.time,
    });
    outcome.rebook = { first: rebookPair.first, replay: rebookPair.second, oldSlotReleased: true, newSlotReserved: true, sameLogicalAppointmentId: true, legacyV2: newAfter.equivalent };
    return outcome;
  } finally {
    if (state.appointment.touched) {
      try {
        const candidates = [...new Set([state.appointment.newId, state.appointment.oldId].filter(Boolean))];
        for (const candidate of candidates) {
          const current = await auditAppointment(candidate, adminSession.idToken, read);
        const activeAppointment = [current.legacy, current.v2].some((item) => item && !["cancelado", "nao_compareceu"].includes(normalizedStatus(item)));
        if (activeAppointment) {
            const cleanupId = candidate === state.appointment.newId ? plan.appointment.cleanup : cleanupRequestId("appointment-old", plan.runId);
            await callStage("APPOINTMENT_CLEANUP", "agenda.cancelar", appointmentCancelPayload(candidate), cleanupId, clientSession.idToken, call);
            outcome.cleanup.attempted.push("agenda.cancelar");
          }
        }
        state.appointment.removed = true;
      } catch (error) {
        cleanupError("agenda.cancelar", error);
      }
    }
    if (state.subscription.touched) {
      try {
        const current = await auditSubscription(state.subscription.id, adminSession.idToken, read);
        if ((current.legacy || current.v2) && ["PENDENTE", "ATIVA"].includes(current.status)) {
          await callStage("SUBSCRIPTION_CLEANUP", "admin.assinatura.cancelar", { data: { id: state.subscription.id, motivo: "Lote 2 HML cleanup" } }, cleanupRequestId("subscription", plan.runId), adminSession.idToken, call);
          outcome.cleanup.attempted.push("admin.assinatura.cancelar");
        }
      } catch (error) {
        cleanupError("admin.assinatura.cancelar", error);
      }
    }
    if (state.block.touched && !state.block.removed) {
      try {
        const current = await auditBlock(state.block.id, state.block.barberId, state.block.date, state.block.time, adminSession.idToken, read);
        if (current.legacy || current.v2 || current.legacyOccupation || current.v2Occupation) {
          await callStage("BLOCK_CLEANUP", "bloqueio.remover", blockRemovePayload(state.block.id), cleanupRequestId("block", plan.runId), adminSession.idToken, call);
          outcome.cleanup.attempted.push("bloqueio.remover");
        }
      } catch (error) {
        cleanupError("bloqueio.remover", error);
      }
    }
    if (state.profile.changed) {
      try {
        await callStage("CLIENT_PROFILE_RESTORE", "cliente.atualizar-perfil", clientUpdatePayload({ [state.profile.field]: state.profile.previous }), newRequestId("hml-lote2-profile-restore", plan.runId), clientSession.idToken, call);
        outcome.cleanup.attempted.push("cliente.atualizar-perfil");
      } catch (error) {
        cleanupError("cliente.atualizar-perfil", error);
      }
    }
    try {
      const appointment = state.appointment.newId ? await auditAppointment(state.appointment.newId, adminSession.idToken, read) : null;
      const oldAppointment = state.appointment.oldId ? await auditAppointment(state.appointment.oldId, adminSession.idToken, read) : null;
      const subscription = state.subscription.id ? await auditSubscription(state.subscription.id, adminSession.idToken, read) : null;
      const block = state.block.id ? await auditBlock(state.block.id, state.block.barberId, state.block.date, state.block.time, adminSession.idToken, read) : null;
      const appointmentActive = [appointment, oldAppointment].some((item) => [item?.legacy, item?.v2].some((doc) => doc && !["cancelado", "nao_compareceu"].includes(normalizedStatus(doc))));
      const appointmentOccupancy = [appointment, oldAppointment].some((item) => item?.oldOccupation || item?.newOccupation);
      const subscriptionActive = [subscription?.legacy, subscription?.v2].some((doc) => doc && ["PENDENTE", "ATIVA"].includes(normalizedStatus(doc)));
      const finalProfileDoc = await read(`clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
      const finalProfileV2Doc = await read(`barbearias/${TENANT}/clientes/${clientIdentity.operationalUid}`, clientSession.idToken);
      const finalProfile = firestoreFields(finalProfileDoc);
      outcome.cleanup.finalProfileEqualsInitial = finalProfile[state.profile.field] === state.profile.previous
        && clientProfileEquivalent(finalProfileDoc, finalProfileV2Doc)
        && clientProfileEquivalent(finalProfileDoc, state.profile.initialLegacy)
        && clientProfileEquivalent(finalProfileV2Doc, state.profile.initialV2);
      outcome.cleanup.zeroResidue = !appointmentActive && !appointmentOccupancy && !subscriptionActive && !block?.legacy && !block?.v2 && !block?.legacyOccupation && !block?.v2Occupation && outcome.cleanup.finalProfileEqualsInitial;
    } catch (error) {
      cleanupError("final-audit", error);
      outcome.cleanup.zeroResidue = false;
    }
  }
}

export function clientUpdatePayload(changes) {
  return { data: { ...changes } };
}

export function subscriptionPayload(planId) {
  return { planId: String(planId) };
}

export function blockCreatePayload({ barberId, date, start, end, reason }) {
  return { data: { barbeiro_id: barberId, data: date, inicio: start, fim: end, motivo: reason } };
}

export function blockRemovePayload(blockId) {
  return { blockId: String(blockId) };
}

export function appointmentCreatePayload({ clientId, barberId, serviceId, date, time }) {
  return { data: { cliente_id: clientId, barbeiro_id: barberId, servico_id: serviceId, data: date, horario: time, origem: "cliente" } };
}

export function appointmentRebookPayload({ appointmentId, serviceId, date, time }) {
  return { appointmentId, data: { servico_id: serviceId, data: date, horario: time } };
}

export function appointmentCancelPayload(appointmentId) {
  return { data: { appointmentId } };
}

export function buildBatch2Plan({ runId = randomUUID().replaceAll("-", ""), clientId = "CLIENT_OPERATIONAL_UID", barberId = BARBER_ID, serviceId = "SERVICE_FIXTURE_ID", planId = "PLAN_FIXTURE_ID" } = {}) {
  const appointmentCreate = newRequestId("hml-lote2-appointment", runId);
  const appointmentCleanup = cleanupRequestId("appointment", runId);
  const rebook = newRequestId("hml-lote2-rebook", runId);
  const blockCreate = newRequestId("hml-lote2-block", runId);
  const blockRemove = cleanupRequestId("block", runId);
  const subscription = newRequestId("hml-lote2-subscription", runId);
  const clientUpdate = newRequestId("hml-lote2-client-update", runId);
  return {
    project: PROJECT,
    tenant: TENANT,
    runId,
    clientId,
    barberId,
    serviceId,
    planId,
    profile: { command: "cliente.atualizar-perfil", requestId: clientUpdate },
    subscription: { command: "assinatura.solicitar", requestId: subscription, cleanup: "admin.assinatura.cancelar" },
    block: { create: blockCreate, remove: blockRemove },
    appointment: { create: appointmentCreate, rebook, cleanup: appointmentCleanup },
  };
}

export function classifyCleanupAvailability({ subscriptionCancelSupported = false } = {}) {
  return {
    profile: "RESTORE_ONLY_IF_OPERATIONAL_COMMAND_SUPPORTS_IT",
    subscription: subscriptionCancelSupported ? "admin.assinatura.cancelar" : "UNAVAILABLE",
    block: "bloqueio.remover",
    appointment: "agenda.cancelar",
  };
}

export function canStartBatch2({ project, adminIdentity, clientIdentity, cleanupAvailability }) {
  if (project !== PROJECT) return { ok: false, reason: "HML_PROJECT_REQUIRED" };
  if (!adminIdentity?.proven || adminIdentity.tenant !== TENANT) return { ok: false, reason: "ADMIN_NOT_PROVEN" };
  if (!clientIdentity?.proven || clientIdentity.tenant !== TENANT) return { ok: false, reason: "CLIENT_NOT_PROVEN" };
  if (adminIdentity.authUid === clientIdentity.authUid || adminIdentity.operationalUid === clientIdentity.operationalUid) {
    return { ok: false, reason: "IDENTITIES_NOT_DISTINCT" };
  }
  if (clientIdentity.isAdmin || clientIdentity.isBarber) return { ok: false, reason: "CLIENT_PRIVILEGED" };
  if (cleanupAvailability?.subscription !== "admin.assinatura.cancelar") return { ok: false, reason: "SUBSCRIPTION_CLEANUP_UNAVAILABLE" };
  return { ok: true };
}

export function assertZeroResidue(audit) {
  const residue = [
    audit?.activeAppointment,
    audit?.oldOccupancy,
    audit?.newOccupancy,
    audit?.block,
    audit?.blockOccupancy,
    audit?.subscription,
  ].some(Boolean);
  if (residue) throw new Error("ZERO_RESIDUE_FAILED");
  return true;
}

export function assertReplay(first, second, fields = []) {
  if (first?.duplicate !== false || second?.duplicate !== true) throw new Error("IDEMPOTENCY_FAILED");
  for (const field of fields) {
    if (first?.[field] !== second?.[field]) throw new Error(`REPLAY_FIELD_MISMATCH:${field}`);
  }
  return true;
}

export function safeTelemetry({ command, requestId, actor, result } = {}) {
  return {
    command,
    actor,
    requestIdPresent: Boolean(requestId),
    requestIdLength: String(requestId || "").length,
    requestIdFingerprint: requestId ? fingerprint(requestId) : "",
    resultKeys: result && typeof result === "object" ? Object.keys(result).sort() : [],
  };
}

export function assertMutationPolicy(command, path = "callable") {
  if (!MUTATING_COMMANDS.has(command)) throw new Error("command is not an approved mutation");
  if (path !== "callable") throw new Error("mutations must use executeOperationalCommand");
  return true;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertThrows(fn, message) {
  try {
    fn();
    throw new Error("expected failure");
  } catch (error) {
    if (error.message === "expected failure") throw new Error(message);
  }
}

async function assertRejects(fn, message) {
  try {
    await fn();
    throw new Error("expected failure");
  } catch (error) {
    if (error.message === "expected failure") throw new Error(message);
  }
}

async function selfTest() {
  assertThrows(() => guardBatch2Options(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write", "--batch2"])), "production must be rejected");
  assertThrows(() => guardBatch2Options(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--batch2"])), "confirmation guard failed");
  assert(guardBatch2Options(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write", "--batch2"])) === true, "HML batch2 guard failed");
  assert(canStartBatch2({ project: PROJECT, adminIdentity: { proven: true, tenant: TENANT, authUid: "a", operationalUid: "a" }, clientIdentity: { proven: true, tenant: TENANT, authUid: "c", operationalUid: "c" }, cleanupAvailability: classifyCleanupAvailability({ subscriptionCancelSupported: true }) }).ok === true, "subscription cleanup guard failed");
  assert(canStartBatch2({ project: PROJECT, adminIdentity: { proven: true, tenant: TENANT, authUid: "a", operationalUid: "a" }, clientIdentity: { proven: true, tenant: TENANT, authUid: "c", operationalUid: "c" }, cleanupAvailability: classifyCleanupAvailability() }).reason === "SUBSCRIPTION_CLEANUP_UNAVAILABLE", "missing cleanup guard failed");

  const runId = "0123456789abcdef0123456789abcdef";
  const plan = buildBatch2Plan({ runId });
  assert(plan.project === PROJECT, "plan project mismatch");
  assert(Object.values(plan.appointment).filter((value) => typeof value === "string").every(validRequestId), "appointment request ID invalid");
  assert(plan.appointment.create !== plan.appointment.cleanup, "create and cleanup IDs must differ");
  assert(!plan.appointment.cleanup.includes("appointment-x"), "appointment ID must not enter cleanup request ID");

  const wireCases = [
    ["cliente.atualizar-perfil", clientUpdatePayload({ observacoes: "fixture" })],
    ["assinatura.solicitar", subscriptionPayload("plan-x")],
    ["bloqueio.criar", blockCreatePayload({ barberId: "barber-x", date: "2026-09-01", start: "08:30", end: "09:30", reason: "fixture" })],
    ["bloqueio.remover", blockRemovePayload("block-x")],
    ["agenda.criar", appointmentCreatePayload({ clientId: "client-x", barberId: "barber-x", serviceId: "service-x", date: "2026-09-01", time: "08:30" })],
    ["agenda.reagendar", appointmentRebookPayload({ appointmentId: "appointment-x", serviceId: "service-x", date: "2026-09-02", time: "09:00" })],
    ["agenda.cancelar", appointmentCancelPayload("appointment-x")],
    ["admin.assinatura.cancelar", { data: { id: "subscription-x", motivo: "Lote 2 HML cleanup" } }],
  ];
  for (const [command, payload] of wireCases) {
    assertMutationPolicy(command);
    const envelope = buildCallableEnvelope(command, payload, newRequestId("hml-lote2-wire", runId));
    assert(envelope.data.command === command, `${command} command missing`);
    assert(envelope.data.requestId, `${command} request ID missing`);
    const nestedData = envelope.data.data;
    const looksLikeDuplicateEnvelope = nestedData && Object.keys(nestedData).length === 1 && Object.prototype.hasOwnProperty.call(nestedData, "data") && nestedData.data && typeof nestedData.data === "object";
    assert(!looksLikeDuplicateEnvelope, `${command} duplicate data envelope`);
  }
  const blockCreateEnvelope = buildCallableEnvelope("bloqueio.criar", blockCreatePayload({ barberId: "barber-x", date: "2026-09-01", start: "08:30", end: "09:00", reason: "fixture" }), plan.block.create);
  assert(blockCreateEnvelope.data.data.barbeiro_id === "barber-x" && blockCreateEnvelope.data.data.data === "2026-09-01" && blockCreateEnvelope.data.data.inicio === "08:30" && blockCreateEnvelope.data.data.fim === "09:00", "block create wire contract failed");
  const blockRemoveEnvelope = buildCallableEnvelope("bloqueio.remover", blockRemovePayload("block-x"), plan.block.remove);
  assert(blockRemoveEnvelope.data.blockId === "block-x" && blockRemoveEnvelope.data.data === undefined, "block remove wire contract failed");
  const rebookEnvelope = buildCallableEnvelope("agenda.reagendar", appointmentRebookPayload({ appointmentId: "appointment-x", serviceId: "service-x", date: "2026-09-02", time: "09:00" }), plan.appointment.rebook);
  assert(rebookEnvelope.data.appointmentId === "appointment-x"
    && rebookEnvelope.data.data.appointmentId === undefined
    && rebookEnvelope.data.data.servico_id === "service-x"
    && rebookEnvelope.data.data.data === "2026-09-02"
    && rebookEnvelope.data.data.horario === "09:00"
    && rebookEnvelope.data.data.data.data === undefined, "rebook wire contract failed");
  const subscriptionCancelEnvelope = buildCallableEnvelope("admin.assinatura.cancelar", { data: { id: "subscription-x", motivo: "Lote 2 HML cleanup" } }, cleanupRequestId("subscription", runId));
  assert(subscriptionCancelEnvelope.data.data.id === "subscription-x" && subscriptionCancelEnvelope.data.data.motivo === "Lote 2 HML cleanup", "subscription cancel wire contract failed");
  let capturedQuery;
  const queryResponse = await auditQuery("agendamentos", [["barbeiro_id", { stringValue: "barber-x" }], ["data", { stringValue: "2026-09-01" }]], "AUDIT_TOKEN", async (_url, init) => {
    capturedQuery = JSON.parse(init.body);
    return { ok: true, status: 200, text: async () => "[]" };
  });
  assert(Array.isArray(queryResponse) && queryResponse.length === 0, "query response parsing failed");
  const structuredQuery = capturedQuery.structuredQuery;
  assert(structuredQuery.from.length === 1 && structuredQuery.from[0].collectionId === "agendamentos", "query parent/collection shape invalid");
  assert(structuredQuery.where.compositeFilter.op === "AND", "composite query operator invalid");
  assert(structuredQuery.where.compositeFilter.filters.every((item) => item.fieldFilter.op === "EQUAL" && item.fieldFilter.value?.stringValue), "composite fieldFilter shape invalid");
  assert(structuredQuery.where.compositeFilter.filters.every((item) => !Object.prototype.hasOwnProperty.call(item, "op") && !Object.prototype.hasOwnProperty.call(item, "value")), "composite filter leaked fields outside fieldFilter");
  assert(!JSON.stringify(structuredQuery).includes("undefined"), "query serialized undefined");
  assert(buildAuditStructuredQuery("agendamentos", [["data", { stringValue: "2026-09-01" }]], { orderBy: ["horario"], limit: 1 }).orderBy[0].field.fieldPath === "horario", "orderBy serialization failed");
  await assertRejects(() => auditQuery("agendamentos", [["data", { stringValue: undefined }]], "AUDIT_TOKEN", async () => ({ ok: true, status: 200, text: async () => "[]" })), "undefined query value accepted");
  const queryOriginalLog = console.log;
  let queryTelemetry = "";
  try {
    console.log = (value) => { queryTelemetry = String(value); };
    await assertRejects(() => auditQuery("agendamentos", [["barbeiro_id", { stringValue: "barber-x" }], ["data", { stringValue: "2026-09-01" }]], "SECRET_AUDIT_TOKEN", async () => ({
      ok: false,
      status: 400,
      text: async () => JSON.stringify({ error: { status: "INVALID_ARGUMENT", message: "Invalid structured query" } }),
    })), "HTTP 400 query failure was not propagated");
  } finally {
    console.log = queryOriginalLog;
  }
  const parsedQueryTelemetry = JSON.parse(queryTelemetry);
  assert(parsedQueryTelemetry.AUDIT_QUERY_STAGE === "SLOT_SELECTION", "query stage telemetry missing");
  assert(parsedQueryTelemetry.COLLECTION_ID === "agendamentos", "query collection telemetry missing");
  assert(parsedQueryTelemetry.QUERY_FILTER_FIELDS.join(",") === "barbeiro_id,data", "query filter telemetry missing");
  assert(parsedQueryTelemetry.HTTP_STATUS === 400 && parsedQueryTelemetry.FIRESTORE_ERROR_STATUS === "INVALID_ARGUMENT", "query error telemetry missing");
  assert(!queryTelemetry.includes("SECRET_AUDIT_TOKEN") && !queryTelemetry.includes("barber-x"), "query telemetry leaked secret or value");
  assert(JSON.stringify(appointmentCreatePayload({ clientId: "client-x", barberId: "barber-x", serviceId: "service-x", date: "2026-09-01", time: "08:30" })).includes("cliente_id"), "client ID missing from appointment payload");
  assertReplay({ duplicate: false, clientId: "c" }, { duplicate: true, clientId: "c" }, ["clientId"]);
  assertThrows(() => assertReplay({ duplicate: false }, { duplicate: false }), "invalid replay accepted");
  assertZeroResidue({ activeAppointment: false, oldOccupancy: false, newOccupancy: false, block: false, blockOccupancy: false, subscription: false });
  assertThrows(() => assertZeroResidue({ subscription: true }), "residue not detected");
  assert(safeTelemetry({ command: "agenda.criar", actor: "CLIENT", requestId: "opaque-request-id", result: { appointmentId: "sensitive" } }).requestIdFingerprint, "safe telemetry missing");
  assert(!JSON.stringify(safeTelemetry({ command: "agenda.criar", actor: "CLIENT", requestId: "opaque-request-id", result: { appointmentId: "sensitive" } })).includes("sensitive"), "PII leaked in telemetry");
  assertThrows(() => assertMutationPolicy("agenda.criar", "firestore-direct"), "direct Firestore mutation accepted");
  assert(new Set(Object.values(plan).flatMap((value) => value && typeof value === "object" ? Object.values(value) : [])).size > 5, "plan is incomplete");

  const valueForFirestore = (value) => {
    if (typeof value === "boolean") return { booleanValue: value };
    if (typeof value === "number") return { integerValue: String(value) };
    if (Array.isArray(value)) return { arrayValue: { values: value.map(valueForFirestore) } };
    if (value && typeof value === "object") return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, valueForFirestore(item)])) } };
    return { stringValue: String(value ?? "") };
  };
  const mockDoc = (path, data) => ({ name: `projects/${PROJECT}/databases/(default)/documents/${path}`, fields: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, valueForFirestore(value)])) });
  const absentSubscription = classifySubscriptionFixture({ subscriptionId: "client-x_plan-x", remoteReadCompleted: true });
  assert(absentSubscription.safe && absentSubscription.reason === "ABSENT", "new local plan was treated as a subscription collision");
  const beforeRemoteRead = classifySubscriptionFixture({ subscriptionId: "client-x_plan-x" });
  assert(!beforeRemoteRead.safe && beforeRemoteRead.collision === false && beforeRemoteRead.reason === "REMOTE_READ_REQUIRED", "remote collision was inferred without read evidence");
  const terminalSubscription = mockDoc("subscription/terminal", { status: "CANCELADA", cliente_id: "client-x", plano_id: "plan-x" });
  const terminalResult = classifySubscriptionFixture({ subscriptionId: "client-x_plan-x", legacy: terminalSubscription, v2: terminalSubscription, remoteReadCompleted: true });
  assert(terminalResult.safe && terminalResult.reason === "HISTORICAL_TERMINAL", "terminal subscription was incorrectly blocked");
  const pendingSubscription = mockDoc("subscription/pending", { status: "PENDENTE", cliente_id: "client-x", plano_id: "plan-x" });
  const pendingResult = classifySubscriptionFixture({ subscriptionId: "client-x_plan-x", legacy: pendingSubscription, v2: pendingSubscription, remoteReadCompleted: true });
  assert(!pendingResult.safe && pendingResult.collision && pendingResult.reason === "ACTIVE_OR_PENDING", "active subscription collision was not blocked");
  const inconsistentResult = classifySubscriptionFixture({ subscriptionId: "client-x_plan-x", legacy: terminalSubscription, remoteReadCompleted: true });
  assert(!inconsistentResult.safe && inconsistentResult.reason === "PROJECTION_INCONSISTENT", "single projection was accepted");
  const comparatorLeft = mockDoc("legacy/x", { status: "PENDENTE", cliente_id: "client-x", plano_id: "plan-x", criado_em: "t1", nested: { b: 2, a: 1 } });
  const comparatorRight = mockDoc("v2/x", { nested: { a: 1, b: 2 }, plano_id: "plan-x", cliente_id: "client-x", status: "PENDENTE", criado_em: "t2" });
  assert(clientProfileEquivalent(comparatorLeft, comparatorRight), "client comparator is order-sensitive");
  assert(subscriptionEquivalent(comparatorLeft, comparatorRight), "subscription comparator is order-sensitive");
  assert(blockEquivalent(comparatorLeft, comparatorRight), "block comparator is order-sensitive");
  assert(appointmentEquivalent(comparatorLeft, comparatorRight), "appointment comparator is order-sensitive");
  assert(occupancyEquivalent(comparatorLeft, comparatorRight), "occupancy comparator is order-sensitive");
  const allRequestIds = [
    plan.profile.requestId,
    plan.subscription.requestId,
    plan.block.create,
    plan.block.remove,
    plan.appointment.create,
    plan.appointment.rebook,
    plan.appointment.cleanup,
    cleanupRequestId("subscription", runId),
    cleanupRequestId("appointment-old", runId),
    newRequestId("hml-lote2-profile-restore", runId),
  ];
  assert(allRequestIds.every(validRequestId), "request ID contract failed");
  assert(new Set(allRequestIds).size === allRequestIds.length, "operation request IDs are not distinct");
  const openPeriods = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ inicio: "08:00", fim: "18:00" }]]));
  const makeSlotRead = (occupiedKeys, occupyAll = false) => async (path) => {
    if (path === "barbeiros/barber-x") return mockDoc(path, { ativo: true });
    if (path === "servicos/service-x") return mockDoc(path, { ativo: true, duracao: 30 });
    if (path === "configuracoes/funcionamento") return mockDoc(path, { dias_fechados_semana: {}, periodos_semana: openPeriods });
    const isSlotPath = /(?:^|\/)\/(?:agendamentos|ocupacoes|bloqueios)\//.test(`/${path}/`) || path.includes("/agendamentos/") || path.includes("/ocupacoes/") || path.includes("/bloqueios/");
    if (isSlotPath && (occupyAll || occupiedKeys.some((key) => path.includes(`_${key.date}_${key.time}`)))) return mockDoc(path, { status: "agendado" });
    return null;
  };
  const firstSlotDate = dateAfterDays(1).toISOString().slice(0, 10);
  const firstSlot = { date: firstSlotDate, time: "08:00" };
  const secondSlot = { date: firstSlotDate, time: "08:30" };
  const queryNoAppointments = async () => [];
  const selectedAfterFirst = await findAvailableSlot({ barberId: "barber-x", serviceId: "service-x", token: "AUDIT", read: makeSlotRead([firstSlot]), query: queryNoAppointments });
  assert(!(selectedAfterFirst.date === firstSlot.date && selectedAfterFirst.time === firstSlot.time), "occupied old slot was selected");
  const selectedAfterTwo = await findAvailableSlot({ barberId: "barber-x", serviceId: "service-x", token: "AUDIT", read: makeSlotRead([firstSlot, secondSlot]), query: queryNoAppointments });
  assert(!(selectedAfterTwo.date === firstSlot.date && [firstSlot.time, secondSlot.time].includes(selectedAfterTwo.time)), "occupied second slot was selected");
  const selectedWithExclusion = await findAvailableSlot({ barberId: "barber-x", serviceId: "service-x", token: "AUDIT", read: makeSlotRead([]), query: queryNoAppointments, excluded: [firstSlot] });
  assert(!(selectedWithExclusion.date === firstSlot.date && selectedWithExclusion.time === firstSlot.time), "excluded slot was selected");
  await assertRejects(() => findAvailableSlot({ barberId: "barber-x", serviceId: "service-x", token: "AUDIT", read: makeSlotRead([], true), query: queryNoAppointments }), "no-safe-slot guard failed");
  const makeMockDeps = (failure = "") => {
    const documents = new Map();
    const results = new Map();
    const callCounts = new Map();
    const callLog = [];
    const failureSpec = typeof failure === "string" ? { command: failure, occurrence: 1 } : (failure || {});
    const v2Collection = { clientes: "clientes", solicitacoes_assinatura: "assinaturas", bloqueios: "bloqueios", agendamentos: "agendamentos", ocupacoes: "ocupacoes" };
    const putPair = (collection, id, data) => {
      documents.set(`${collection}/${id}`, mockDoc(`${collection}/${id}`, data));
      documents.set(`barbearias/${TENANT}/${v2Collection[collection]}/${id}`, mockDoc(`barbearias/${TENANT}/${v2Collection[collection]}/${id}`, data));
    };
    const removePair = (collection, id) => {
      documents.delete(`${collection}/${id}`);
      documents.delete(`barbearias/${TENANT}/${v2Collection[collection]}/${id}`);
    };
    putPair("clientes", "client-x", { uid: "client-x", nome: "Fixture Client" });
    documents.set(`barbeiros/${BARBER_ID}`, mockDoc(`barbeiros/${BARBER_ID}`, { ativo: true }));
    documents.set("servicos/service-x", mockDoc("servicos/service-x", { ativo: true, duracao: 30 }));
    documents.set("configuracoes/funcionamento", mockDoc("configuracoes/funcionamento", { dias_fechados_semana: {}, periodos_semana: { 0: [{ inicio: "08:00", fim: "18:00" }], 1: [{ inicio: "08:00", fim: "18:00" }], 2: [{ inicio: "08:00", fim: "18:00" }], 3: [{ inicio: "08:00", fim: "18:00" }], 4: [{ inicio: "08:00", fim: "18:00" }], 5: [{ inicio: "08:00", fim: "18:00" }], 6: [{ inicio: "08:00", fim: "18:00" }] } }));
    const planDoc = mockDoc("planos_assinatura/plan-x", { ativo: true, preco_centavos: 1000, servicos_ids: ["service-x"] });
    const read = async (path) => documents.get(path) || null;
    const list = async (collection) => collection === "planos_assinatura" ? [planDoc] : [];
    const query = async (collection, filters) => {
      if (collection !== "agendamentos") return [];
      return [...documents.entries()].filter(([path]) => path.startsWith("agendamentos/")).map(([, doc]) => doc).filter((doc) => {
        const data = firestoreFields(doc);
        return filters.every(([field, expected]) => data[field] === expected.stringValue);
      });
    };
    const call = async (command, payload, requestId) => {
      const occurrence = (callCounts.get(command) || 0) + 1;
      callCounts.set(command, occurrence);
      callLog.push({ command, payload: JSON.parse(JSON.stringify(payload)), requestId });
      if (command === failureSpec.command && occurrence === Number(failureSpec.occurrence || 1)) throw Object.assign(new Error("injected offline failure"), { httpStatus: 500, code: "internal" });
      if (results.has(requestId)) return { ...results.get(requestId), duplicate: true };
      let result;
      if (command === "cliente.atualizar-perfil") {
        for (const path of ["clientes/client-x", `barbearias/${TENANT}/clientes/client-x`]) {
          const current = firestoreFields(documents.get(path));
          documents.set(path, mockDoc(path, { ...current, ...payload.data }));
        }
        result = { clientId: "client-x", updated: Object.keys(payload.data).sort() };
      } else if (command === "assinatura.solicitar") {
        putPair("solicitacoes_assinatura", "client-x_plan-x", { cliente_id: "client-x", plano_id: payload.planId, status: "PENDENTE" });
        result = { subscriptionId: "client-x_plan-x", status: "PENDENTE" };
      } else if (command === "admin.assinatura.cancelar") {
        for (const path of ["solicitacoes_assinatura/client-x_plan-x", `barbearias/${TENANT}/assinaturas/client-x_plan-x`]) {
          const current = firestoreFields(documents.get(path));
          documents.set(path, mockDoc(path, { ...current, status: "CANCELADA" }));
        }
        result = { subscriptionId: "client-x_plan-x", status: "CANCELADA" };
      } else if (command === "bloqueio.criar") {
        const data = payload.data;
        const id = `${data.barbeiro_id}_${data.data}_${data.inicio}`;
        putPair("bloqueios", id, data);
        putPair("ocupacoes", id, { barbeiro_id: data.barbeiro_id, data: data.data, horario: data.inicio, bloqueio_id: id });
        result = { blockId: id, slots: 1 };
      } else if (command === "bloqueio.remover") {
        const id = payload.blockId;
        const block = firestoreFields(documents.get(`bloqueios/${id}`));
        removePair("bloqueios", id);
        removePair("ocupacoes", `${block.barbeiro_id}_${block.data}_${block.inicio}`);
        result = { blockId: id };
      } else if (command === "agenda.criar") {
        const data = payload.data;
        const id = `${data.barbeiro_id}_${data.data}_${data.horario}`;
        putPair("agendamentos", id, { ...data, status: "agendado", duracao: 30 });
        putPair("ocupacoes", id, { barbeiro_id: data.barbeiro_id, data: data.data, horario: data.horario, agendamento_id: id });
        result = { appointmentId: id, slots: 1 };
      } else if (command === "agenda.reagendar") {
        const data = payload.data;
        const old = firestoreFields(documents.get(`agendamentos/${payload.appointmentId}`));
        const id = `${old.barbeiro_id}_${data.data}_${data.horario}`;
        putPair("agendamentos", payload.appointmentId, { ...old, status: "cancelado", reagendado_para: id });
        removePair("ocupacoes", `${old.barbeiro_id}_${old.data}_${old.horario}`);
        putPair("agendamentos", id, { ...old, data: data.data, horario: data.horario, status: "agendado", reagendado_de: payload.appointmentId });
        putPair("ocupacoes", id, { barbeiro_id: old.barbeiro_id, data: data.data, horario: data.horario, agendamento_id: id });
        result = { appointmentId: id, replacedAppointmentId: payload.appointmentId, slots: 1 };
      } else if (command === "agenda.cancelar") {
        const id = payload.data.appointmentId;
        const old = firestoreFields(documents.get(`agendamentos/${id}`));
        putPair("agendamentos", id, { ...old, status: "cancelado" });
        removePair("ocupacoes", `${old.barbeiro_id}_${old.data}_${old.horario}`);
        result = { appointmentId: id, status: "cancelado" };
      } else {
        throw new Error(`mock command unsupported: ${command}`);
      }
      results.set(requestId, result);
      return { ...result, duplicate: false };
    };
    return {
      read,
      list,
      query,
      call,
      callLog,
      hasActiveFixtures() {
        const activeAppointment = [...documents.entries()].some(([path, doc]) => {
          if (!(path.startsWith("agendamentos/") || path.includes("/agendamentos/"))) return false;
          return !["cancelado", "nao_compareceu"].includes(firestoreFields(doc).status);
        });
        const activeSubscription = [...documents.entries()].some(([path, doc]) => {
          if (!(path.startsWith("solicitacoes_assinatura/") || path.includes("/assinaturas/"))) return false;
          return ["PENDENTE", "ATIVA"].includes(firestoreFields(doc).status);
        });
        const blockOrOccupation = [...documents.keys()].some((path) => path.startsWith("bloqueios/") || path.startsWith("ocupacoes/") || path.includes("/bloqueios/") || path.includes("/ocupacoes/"));
        return activeAppointment || activeSubscription || blockOrOccupation;
      },
    };
  };
  const originalLog = console.log;
  console.log = () => {};
  let mockResult;
  let mockDeps;
  try {
    mockDeps = makeMockDeps();
    mockResult = await runBatch2Remote({
      adminSession: { localId: "admin-auth", idToken: "ADMIN_TOKEN" },
      clientSession: { localId: "client-auth", idToken: "CLIENT_TOKEN" },
      adminIdentity: { proven: true, tenant: TENANT, authUid: "admin-auth", operationalUid: "admin-x" },
      clientIdentity: { proven: true, tenant: TENANT, authUid: "client-auth", operationalUid: "client-x", isAdmin: false, isBarber: false },
      ...mockDeps,
    });
  } finally {
    console.log = originalLog;
  }
  assert(mockResult.profile && mockResult.subscription && mockResult.block && mockResult.rebook, "remote orchestration mock did not complete");
  assert(mockResult.preflight === "PASS"
    && mockResult.profile.legacyV2 === true
    && mockResult.subscription.legacyV2 === true
    && mockResult.block.legacyV2 === true
    && mockResult.block.zeroResidue === true
    && mockResult.rebook.oldSlotReleased === true
    && mockResult.rebook.newSlotReserved === true
    && mockResult.rebook.sameLogicalAppointmentId === true
    && mockResult.rebook.legacyV2 === true,
  "full offline dry journey assertions failed");
  assert(mockResult.cleanup.zeroResidue === true && mockResult.cleanup.failures.length === 0, "mock finally cleanup failed");
  for (const command of ["cliente.atualizar-perfil", "assinatura.solicitar", "bloqueio.criar", "agenda.reagendar"]) {
    const pair = mockDeps.callLog.filter((entry) => entry.command === command).slice(0, 2);
    assert(pair.length === 2 && pair[0].requestId === pair[1].requestId && JSON.stringify(pair[0].payload) === JSON.stringify(pair[1].payload), `${command} replay wire changed`);
  }
  const failureCases = [
    ["cliente.atualizar-perfil", 1],
    ["cliente.atualizar-perfil", 2],
    ["assinatura.solicitar", 1],
    ["assinatura.solicitar", 2],
    ["bloqueio.criar", 1],
    ["bloqueio.criar", 2],
    ["bloqueio.remover", 1],
    ["agenda.criar", 1],
    ["agenda.reagendar", 1],
    ["agenda.reagendar", 2],
  ];
  for (const [command, occurrence] of failureCases) {
    const deps = makeMockDeps({ command, occurrence });
    try {
      await runBatch2Remote({
        adminSession: { localId: "admin-auth", idToken: "ADMIN_TOKEN" },
        clientSession: { localId: "client-auth", idToken: "CLIENT_TOKEN" },
        adminIdentity: { proven: true, tenant: TENANT, authUid: "admin-auth", operationalUid: "admin-x" },
        clientIdentity: { proven: true, tenant: TENANT, authUid: "client-auth", operationalUid: "client-x", isAdmin: false, isBarber: false },
        ...deps,
      });
      throw new Error(`injected failure was not raised: ${command}:${occurrence}`);
    } catch (error) {
      assert(error.message === "injected offline failure", `failure stage was not preserved: ${command}:${occurrence}`);
    }
    assert(deps.hasActiveFixtures() === false, `finally did not clean ${command}:${occurrence}`);
  }
  const cleanupFailureDeps = makeMockDeps({ command: "agenda.cancelar", occurrence: 1 });
  const cleanupFailureResult = await runBatch2Remote({
    adminSession: { localId: "admin-auth", idToken: "ADMIN_TOKEN" },
    clientSession: { localId: "client-auth", idToken: "CLIENT_TOKEN" },
    adminIdentity: { proven: true, tenant: TENANT, authUid: "admin-auth", operationalUid: "admin-x" },
    clientIdentity: { proven: true, tenant: TENANT, authUid: "client-auth", operationalUid: "client-x", isAdmin: false, isBarber: false },
    ...cleanupFailureDeps,
  });
  assert(cleanupFailureResult.cleanup.zeroResidue === false && cleanupFailureResult.cleanup.failures.length > 0, "cleanup failure was silently accepted");
  const failureDeps = makeMockDeps({ command: "agenda.reagendar", occurrence: 1 });
  try {
    await runBatch2Remote({
      adminSession: { localId: "admin-auth", idToken: "ADMIN_TOKEN" },
      clientSession: { localId: "client-auth", idToken: "CLIENT_TOKEN" },
      adminIdentity: { proven: true, tenant: TENANT, authUid: "admin-auth", operationalUid: "admin-x" },
      clientIdentity: { proven: true, tenant: TENANT, authUid: "client-auth", operationalUid: "client-x", isAdmin: false, isBarber: false },
      ...failureDeps,
    });
    throw new Error("injected failure was not raised");
  } catch (error) {
    assert(error.message === "injected offline failure", "failure stage was not preserved");
  }
  const createdCall = failureDeps.callLog.find((entry) => entry.command === "agenda.criar");
  const createdData = createdCall?.payload?.data || {};
  const createdAppointmentId = `${createdData.barbeiro_id}_${createdData.data}_${createdData.horario}`;
  const rebookFailureCleanup = failureDeps.callLog.filter((entry) => entry.command === "agenda.cancelar");
  assert(rebookFailureCleanup.length >= 1 && rebookFailureCleanup.some((entry) => entry.payload?.data?.appointmentId === createdAppointmentId), "rebook failure cleanup did not retain the created appointment ID");
  assert(failureDeps.hasActiveFixtures() === false, "finally did not clean the injected failure path");
  console.log("hml batch2 offline self-test: PASS");
}

export async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.selfTest) return selfTest();
  guardBatch2Options(opts);
  try {
    credentialState.admin = await interactiveSession("ADMIN HML");
    credentialState.client = await interactiveSession("CLIENT HML");
    const adminIdentity = await proveAdminIdentity(credentialState.admin);
    const clientIdentity = await proveClientIdentity(credentialState.client);
    const start = canStartBatch2({
      project: opts.project,
      adminIdentity,
      clientIdentity,
      cleanupAvailability: classifyCleanupAvailability({ subscriptionCancelSupported: true }),
    });
    if (!start.ok) throw new Error(`ABORT_BEFORE_MUTATION:${start.reason}`);
    const result = await runBatch2Remote({
      adminSession: credentialState.admin,
      clientSession: credentialState.client,
      adminIdentity,
      clientIdentity,
    });
    if (!result.cleanup.zeroResidue || result.cleanup.failures.length) throw new Error("CLEANUP_FAILED");
    console.log(JSON.stringify({
      PROJECT,
      BATCH2: "PASS",
      CLIENT_UPDATE: Boolean(result.profile),
      SUBSCRIPTION_REQUEST: Boolean(result.subscription),
      BLOCK_CREATE: Boolean(result.block),
      REAGENDAR: Boolean(result.rebook),
      CLEANUP: result.cleanup,
      PRODUCTION_ACCESSED: "NÃO",
    }));
  } finally {
    clearCredentials();
  }
}

if (process.argv[1]?.toLowerCase().endsWith("hml-command-batch2-test.mjs")) {
  main().catch((error) => {
    console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: { message: String(error.message || "").slice(0, 180) }, NETWORK_ACCESSED: remoteAccessed ? "SIM" : "NÃO", HML_ACCESSED: remoteAccessed ? "SIM" : "NÃO", PRODUCTION_ACCESSED: "NÃO" }));
    process.exitCode = 1;
  });
}
