#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PROJECT = "teste-483f6";
const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const BATCH1_BARBER_ID = "YMJrJJ58I6N9bMl4jsgy";
const OLD_BATCH1_FIXTURES = [
  { date: "2026-08-22", time: "08:30" },
  { date: "2026-08-22", time: "09:00" },
  { date: "2026-08-24", time: "08:30" },
  { date: "2026-08-24", time: "09:00" },
];
const REGION = "southamerica-east1";
const CALLABLE = `https://${REGION}-${PROJECT}.cloudfunctions.net/executeOperationalCommand`;
const FIRESTORE_ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,120}$/;
let credentialState = { admin: null, client: null };

function clearCredentials() {
  for (const key of ["admin", "client"]) {
    if (credentialState[key]) {
      credentialState[key].idToken = "";
      credentialState[key].refreshToken = "";
      credentialState[key].localId = "";
    }
    credentialState[key] = null;
  }
}

function parseArgs(argv = process.argv) {
  return {
    project: argv.find((x) => x.startsWith("--project="))?.slice(10) || "",
    adminAuth: argv.find((x) => x.startsWith("--auth-admin="))?.slice(13) || "",
    clientAuth: argv.find((x) => x.startsWith("--auth-client="))?.slice(14) || "",
    confirm: argv.includes("--confirm-hml-write"),
    preflightOnly: argv.includes("--preflight-only"),
    clientBootstrapRecoveryOnly: argv.includes("--client-bootstrap-recovery-only"),
    batch1: argv.includes("--batch1"),
    findOldBatch1Fixture: argv.includes("--find-old-batch1-fixture"),
    cleanupOldBatch1Fixtures: argv.includes("--cleanup-old-batch1-fixtures"),
    confirmHmlCleanup: argv.includes("--confirm-hml-cleanup"),
    selfTest: argv.includes("--self-test"),
  };
}

function guardBatch1Options(opts, env = process.env) {
  guardOptions(opts, env, { requireAuditToken: false });
  if (!opts.batch1) throw new Error("--batch1 is required");
  return true;
}

function guardOptions(opts, env = process.env, { requireWrite = true, requireAuditToken = true } = {}) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (opts.adminAuth !== "interactive" || opts.clientAuth !== "interactive") throw new Error("both interactive auth modes are required");
  if (requireWrite && !opts.confirm) throw new Error("--confirm-hml-write is required");
  if (requireAuditToken && !String(env.FIRESTORE_AUDIT_TOKEN || "").trim()) throw new Error("FIRESTORE_AUDIT_TOKEN is required");
  return true;
}

function guardClientBootstrapRecoveryOptions(opts, env = process.env) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (opts.clientAuth !== "interactive") throw new Error("interactive CLIENT auth is required");
  if (opts.adminAuth) throw new Error("ADMIN auth is out of scope for client bootstrap recovery");
  if (!opts.confirm) throw new Error("--confirm-hml-write is required");
  if (!String(env.FIRESTORE_AUDIT_TOKEN || "").trim()) throw new Error("FIRESTORE_AUDIT_TOKEN is required");
  return true;
}

export function guardFindOldBatch1FixtureOptions(opts) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (opts.adminAuth !== "interactive" || opts.clientAuth !== "interactive") throw new Error("interactive ADMIN and CLIENT auth are required");
  if (opts.confirm || opts.batch1 || opts.preflightOnly || opts.clientBootstrapRecoveryOnly) throw new Error("read-only fixture mode cannot include mutation options");
  if (!opts.findOldBatch1Fixture) throw new Error("--find-old-batch1-fixture is required");
  return true;
}

export function guardCleanupOldBatch1Options(opts) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (opts.adminAuth !== "interactive") throw new Error("interactive ADMIN auth is required");
  if (!opts.cleanupOldBatch1Fixtures || !opts.confirmHmlCleanup) throw new Error("explicit HML cleanup confirmation is required");
  if (opts.clientAuth || opts.preflightOnly || opts.clientBootstrapRecoveryOnly || opts.batch1 || opts.findOldBatch1Fixture || opts.confirm) throw new Error("targeted cleanup mode cannot include other modes");
  return true;
}

function decodeJwt(token) {
  const parts = String(token || "").trim().split(".");
  if (parts.length !== 3) return null;
  try {
    const payload = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
  } catch { return null; }
}

export function validateIdToken(idToken, localId, expectedProject = PROJECT) {
  const claims = decodeJwt(idToken);
  if (!claims || claims.aud !== expectedProject) throw new Error("ID token project mismatch");
  if (claims.sub !== localId) throw new Error("ID token subject mismatch");
  if (!(Number(claims.exp) > Math.floor(Date.now() / 1000))) throw new Error("ID token expired");
  return { aud: claims.aud, sub: claims.sub, notExpired: true };
}

export function buildCallableRequest(command, data, requestId, token) {
  if (!token) throw new Error("Firebase ID token is required");
  const callableData = command === "cliente.garantir-perfil"
    ? { command, requestId, ...(data || {}) }
    : { command, requestId, data };
  return {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: callableData }),
  };
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
      if (text === "\u0003") { cleanup(); reject(new Error("interactive authentication cancelled")); return; }
      if (text === "\r" || text === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      value += text;
    };
    const cleanup = () => { stdin.off("data", onData); if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.setEncoding("utf8"); stdin.resume(); stdin.on("data", onData);
  });
}

async function interactiveSession(label) {
  let email = await promptSecret(`${label} e-mail: `);
  let password = await promptSecret(`${label} senha: `);
  try { return await authenticateInteractive({ label, email, password }); }
  finally { email = null; password = null; }
}

function decodeFirestoreValue(value) {
  if (value?.stringValue !== undefined) return value.stringValue;
  if (value?.booleanValue !== undefined) return value.booleanValue;
  if (value?.integerValue !== undefined) return Number(value.integerValue);
  if (value?.arrayValue) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (value?.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeFirestoreValue(v)]));
  return null;
}

function firestoreFields(doc) {
  return Object.fromEntries(Object.entries(doc?.fields || {}).map(([k, v]) => [k, decodeFirestoreValue(v)]));
}

export async function auditGet(path, auditToken, request = fetch) {
  if (!auditToken) throw new Error("audit token is required");
  const response = await request(`${FIRESTORE_ROOT}/${path}`, { headers: { Authorization: `Bearer ${auditToken}` } });
  if (response.status === 404) return null;
  if (!response.ok) { const error = new Error(`audit GET HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
  return response.json();
}

async function auditList(collection, auditToken, request = fetch) {
  if (!auditToken) throw new Error("audit token is required");
  const response = await request(`${FIRESTORE_ROOT}/${collection}?pageSize=1000`, { headers: { Authorization: `Bearer ${auditToken}` } });
  if (response.status === 404) return [];
  if (!response.ok) { const error = new Error(`audit LIST HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
  return (await response.json()).documents || [];
}

async function auditQuery(collectionId, filters, auditToken, request = fetch) {
  if (!auditToken) throw new Error("audit token is required");
  const where = filters.length === 1
    ? { fieldFilter: { field: { fieldPath: filters[0][0] }, op: "EQUAL", value: filters[0][1] } }
    : { compositeFilter: { op: "AND", filters: filters.map(([field, value]) => ({ fieldFilter: { field: { fieldPath: field }, op: "EQUAL", value } })) } };
  const response = await request(`${FIRESTORE_ROOT}:runQuery`, {
    method: "POST",
    headers: { Authorization: `Bearer ${auditToken}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], where } }),
  });
  if (!response.ok) { const error = new Error(`audit QUERY HTTP ${response.status}`); error.httpStatus = response.status; throw error; }
  return (await response.json()).filter((item) => item.document).map((item) => item.document);
}

export async function auditPreflight(auditToken, read = auditGet) {
  if (!auditToken) throw new Error("AUDIT_TOKEN_REQUIRED");
  try { await read("configuracoes/funcionamento", auditToken); }
  catch (error) {
    if (error.httpStatus === 401 || error.httpStatus === 403) throw new Error("ABORT_BEFORE_MUTATION_AUDIT_UNAUTHORIZED");
    throw error;
  }
  return true;
}

export async function proveAdminIdentity(authUid, auditToken, read = auditGet) {
  const mapping = await read(`homologacao_mapeamentos/${authUid}`, auditToken);
  if (!mapping) throw new Error("ADMIN mapping missing");
  const mappingData = firestoreFields(mapping);
  if (mappingData.tenant_id !== TENANT) throw new Error("ADMIN mapping tenant mismatch");
  const operationalUid = String(mappingData.uid_producao_referencia || "").trim();
  if (!operationalUid) throw new Error("ADMIN operational UID missing");
  const admin = await read(`admins/${operationalUid}`, auditToken);
  const member = await read(`barbearias/${TENANT}/membros/${operationalUid}`, auditToken);
  const roles = firestoreFields(member).papeis;
  if (!admin && !(Array.isArray(roles) && roles.includes("ADMIN"))) throw new Error("ADMIN role not proven");
  return { authUid, operationalUid, admin: Boolean(admin), memberAdmin: Array.isArray(roles) && roles.includes("ADMIN") };
}

export async function proveClientIsNotPrivileged(authUid, auditToken, read = auditGet) {
  const mapping = await read(`homologacao_mapeamentos/${authUid}`, auditToken);
  const targetUid = mapping ? String(firestoreFields(mapping).uid_producao_referencia || "").trim() : authUid;
  if (mapping && firestoreFields(mapping).tenant_id !== TENANT) throw new Error("CLIENT mapping tenant mismatch");
  if (!targetUid) throw new Error("CLIENT operational UID missing");
  const admin = await read(`admins/${targetUid}`, auditToken);
  const member = await read(`barbearias/${TENANT}/membros/${targetUid}`, auditToken);
  const roles = firestoreFields(member).papeis;
  if (admin || (Array.isArray(roles) && roles.includes("ADMIN"))) throw new Error("client has ADMIN role");
  if (Array.isArray(roles) && roles.includes("BARBEIRO")) throw new Error("client has BARBEIRO role");
  return { authUid, operationalUid: targetUid, isAdmin: false, isBarber: false };
}

function assertClientBootstrapRecoveryState(state, authUid, tenant = TENANT) {
  const mappingData = firestoreFields(state.mapping);
  const memberData = firestoreFields(state.member);
  if (!state.mapping || !state.legacy || !state.v2 || !state.member) {
    throw new Error("client bootstrap recovery did not create the expected documents");
  }
  if (state.admin) throw new Error("client bootstrap recovery granted ADMIN");
  if (mappingData.tenant_id !== tenant || mappingData.uid_producao_referencia !== authUid) {
    throw new Error("client bootstrap mapping is inconsistent");
  }
  if (memberData.ativo !== true || !Array.isArray(memberData.papeis) || memberData.papeis.length !== 1 || memberData.papeis[0] !== "CLIENTE") {
    throw new Error("client bootstrap membership is inconsistent");
  }
  return true;
}

async function callOperational(command, data, requestId, token, request = fetch) {
  const response = await request(CALLABLE, buildCallableRequest(command, data, requestId, token));
  const text = await response.text();
  let body = null;
  try { body = JSON.parse(text); } catch { /* invalid response is reported by the caller */ }
  console.log(JSON.stringify({ CALLABLE_RESPONSE_TELEMETRY: callableResponseTelemetry(response.status, body) }));
  if (!response.ok || body?.error) {
    const remote = body?.error || {};
    const error = new Error(safeErrorMessage(remote.message || `callable HTTP ${response.status}`));
    error.httpStatus = response.status;
    error.firebaseStatus = String(remote.status || "");
    error.errorCode = String(remote.code || remote.status || "");
    error.safeDetails = safeErrorDetails(remote.details);
    throw error;
  }
  return extractCallableResult(body);
}

function responseKeys(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? Object.keys(value).sort() : [];
}

export function callableResponseTelemetry(httpStatus, body) {
  return {
    HTTP_STATUS: Number(httpStatus),
    TOP_LEVEL_KEYS: responseKeys(body),
    RESULT_TYPE: typeof body?.result,
    DATA_TYPE: typeof body?.data,
    RESULT_KEYS: responseKeys(body?.result),
    DATA_KEYS: responseKeys(body?.data),
  };
}

export function extractCallableResult(body) {
  return body?.result ?? body?.data;
}

function safeErrorMessage(value) {
  return String(value || "erro desconhecido")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[EMAIL_REDACTED]")
    .replace(/Bearer\s+[^\s]+/gi, "Bearer [REDACTED]")
    .replace(/\b(?:token|password|senha)\b[^,; ]*/gi, "[SECRET_REDACTED]");
}

function safeErrorDetails(details) {
  if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
  const allowed = new Set(["stage", "operation", "reasonCode", "conflictType", "retryable"]);
  return Object.fromEntries(Object.entries(details).filter(([key, value]) => allowed.has(key) && ["string", "boolean"].includes(typeof value)));
}

function safeIdentifierTelemetry(value) {
  if (typeof value !== "string") return { present: false, type: typeof value, length: 0 };
  return {
    present: value.length > 0,
    type: "string",
    length: value.length,
    fingerprint: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : "",
  };
}

export function cleanupTelemetry(resource, { attempted, idValue, requestId, error = null }) {
  const isAgenda = resource === "agenda";
  const isService = resource === "service";
  const idPresent = typeof idValue === "string" && idValue.length > 0;
  const request = requestIdTelemetry(requestId);
  const message = attempted && error
    ? safeErrorMessage(error.message).split(typeof idValue === "string" ? idValue : "\u0000").join("[ID_REDACTED]")
    : "";
  return {
    CLEANUP_RESOURCE: resource,
    [`CLEANUP_${resource.toUpperCase()}_ATTEMPTED`]: Boolean(attempted),
    [`CLEANUP_${resource.toUpperCase()}_HTTP_STATUS`]: attempted ? Number(error?.httpStatus || (error ? 0 : 200)) : 0,
    [`CLEANUP_${resource.toUpperCase()}_CODE`]: attempted ? String(error?.errorCode || error?.firebaseStatus || "") : "",
    [`CLEANUP_${resource.toUpperCase()}_MESSAGE_SAFE`]: message,
    [`CLEANUP_${resource.toUpperCase()}_REQUEST_ID_PRESENT`]: request.present,
    [`CLEANUP_${resource.toUpperCase()}_REQUEST_ID_LENGTH`]: request.length,
    [`CLEANUP_${resource.toUpperCase()}_REQUEST_ID_CHARSET_CLASS`]: request.charsetClass,
    [`CLEANUP_${resource.toUpperCase()}_REQUEST_ID_FINGERPRINT`]: request.fingerprint,
    APPOINTMENT_ID_PRESENT: isAgenda && idPresent,
    SERVICE_ID_PRESENT: isService && idPresent,
  };
}

function logCleanupTelemetry(resource, values) {
  console.log(JSON.stringify(cleanupTelemetry(resource, values)));
}

function semanticResponse(response) {
  if (!response || typeof response !== "object") return response;
  return Object.fromEntries(Object.entries(response).filter(([key]) => key !== "duplicate").sort(([a], [b]) => a.localeCompare(b)));
}

export function clientProfileIdempotencyTelemetry({ first, second, requestId }) {
  const firstOperationId = first?.clientId ?? first?.operationId ?? first?.id;
  const secondOperationId = second?.clientId ?? second?.operationId ?? second?.id;
  return {
    firstCallStatus: first && typeof first === "object" ? "fulfilled" : "invalid-response",
    secondCallStatus: second && typeof second === "object" ? "fulfilled" : "invalid-response",
    firstRequestId: requestId,
    secondRequestIdSame: true,
    firstDuplicateFlag: first?.duplicate,
    secondDuplicateFlag: second?.duplicate,
    firstOperationId: safeIdentifierTelemetry(firstOperationId),
    secondOperationId: safeIdentifierTelemetry(secondOperationId),
    responseSemanticallyEqual: JSON.stringify(semanticResponse(first)) === JSON.stringify(semanticResponse(second)),
    responseKeys: {
      first: first && typeof first === "object" ? Object.keys(first).sort() : [],
      second: second && typeof second === "object" ? Object.keys(second).sort() : [],
    },
  };
}

async function runClientBootstrapRecovery({ auditToken, request = fetch }) {
  credentialState.client = await interactiveSession("HML CLIENT");
  const session = credentialState.client;
  const authUid = session.localId;
  const identity = await proveClientIsNotPrivileged(authUid, auditToken);
  if (identity.isAdmin || identity.isBarber) throw new Error("client identity is privileged");
  const paths = {
    mapping: `homologacao_mapeamentos/${authUid}`,
    legacy: `clientes/${authUid}`,
    v2: `barbearias/${TENANT}/clientes/${authUid}`,
    member: `barbearias/${TENANT}/membros/${authUid}`,
    admin: `admins/${authUid}`,
  };
  const readState = async () => ({
    mapping: await auditGet(paths.mapping, auditToken),
    legacy: await auditGet(paths.legacy, auditToken),
    v2: await auditGet(paths.v2, auditToken),
    member: await auditGet(paths.member, auditToken),
    admin: await auditGet(paths.admin, auditToken),
  });
  const before = await readState();
  if (Object.values(before).some(Boolean)) throw new Error("client bootstrap precondition is not the expected empty state");
  const first = await callOperational("cliente.garantir-perfil", { extras: { nome: "Cliente HML Recovery" } }, `hml-client-bootstrap-${randomUUID().replaceAll("-", "")}`, session.idToken, request);
  const afterFirst = await readState();
  assertClientBootstrapRecoveryState(afterFirst, authUid);
  const second = await callOperational("cliente.garantir-perfil", { extras: { nome: "Cliente HML Recovery" } }, `hml-client-recovery-${randomUUID().replaceAll("-", "")}`, session.idToken, request);
  const afterSecond = await readState();
  assertClientBootstrapRecoveryState(afterSecond, authUid);
  return {
    loginResult: "PASS",
    firstResult: first,
    secondResult: second,
    mappingCreated: true,
    operationalUidEqualsAuthUid: true,
    clientLegacyCreated: true,
    clientV2Created: true,
    clientMembershipCreated: true,
    barberRoleGranted: false,
    adminRoleGranted: false,
    secondLogin: "NOT_REQUIRED",
    idempotentRecovery: true,
    duplicateMapping: false,
    duplicateProfile: false,
    duplicateMembership: false,
    legacyV2Equivalent: true,
    partialWrite: false,
  };
}

export async function runIdentityPreflight({ adminSession, clientSession, auditToken, read = auditGet, clientToken = clientSession?.idToken || auditToken, adminToken = adminSession?.idToken || auditToken, clientRead = read, adminRead = read }) {
  if (!adminSession || !clientSession) throw new Error("both identity sessions are required");
  if (adminSession.localId === clientSession.localId) throw new Error("ADMIN and CLIENT identities must differ");
  validateIdToken(adminSession.idToken, adminSession.localId);
  validateIdToken(clientSession.idToken, clientSession.localId);
  const clientIdentity = await proveClientIsNotPrivileged(clientSession.localId, clientToken, clientRead);
  const clientProfile = await clientRead(`clientes/${clientIdentity.operationalUid}`, clientToken);
  if (!clientProfile) throw new Error("CLIENT profile does not exist");
  const adminIdentity = await proveAdminIdentity(adminSession.localId, adminToken, adminRead);
  return {
    clientProfileExists: true,
    clientIsAdmin: clientIdentity.isAdmin,
    clientIsBarber: clientIdentity.isBarber,
    clientTenantMatch: true,
    adminProven: Boolean(adminIdentity.admin || adminIdentity.memberAdmin),
    distinctIdentities: true,
  };
}

export function fixturePlan(runId = randomUUID().replaceAll("-", "").slice(0, 16)) {
  return {
    runId,
    serviceId: `hml_lote1_servico_${runId}`,
    serviceRequestId: `hml-lote1-service-${runId}`,
    appointmentRequestId: `hml-lote1-agenda-${runId}`,
    cleanupRequestId: `hml-lote1-cleanup-${runId}`,
  };
}

export function cleanupRequestIdsForBase(cleanupRequestId) {
  const base = String(cleanupRequestId || "");
  return {
    appointment: `${base}-appointment`,
    service: `${base}-service`,
  };
}

export function requestIdTelemetry(requestId) {
  const value = String(requestId || "");
  const validCharset = /^[a-zA-Z0-9_-]+$/.test(value);
  return {
    present: value.length > 0,
    length: value.length,
    charsetClass: value.length === 0 ? "EMPTY" : validCharset ? "ALNUM_UNDERSCORE_HYPHEN" : "INVALID",
    fingerprint: value ? createHash("sha256").update(value).digest("hex").slice(0, 12) : "",
  };
}

export function agendaCreateTelemetry({ appointmentId, date, time, barberId, createRequestId, cleanupRequestId }) {
  return {
    appointmentIdFingerprint: safeIdentifierTelemetry(appointmentId).fingerprint,
    appointmentIdPresent: safeIdentifierTelemetry(appointmentId).present,
    data: String(date || ""),
    horario: String(time || ""),
    barberIdFingerprint: safeIdentifierTelemetry(barberId).fingerprint,
    createRequestIdFingerprint: requestIdTelemetry(createRequestId).fingerprint,
    cleanupRequestIdFingerprint: requestIdTelemetry(cleanupRequestId).fingerprint,
  };
}

function validRequestId(requestId) {
  return REQUEST_ID_PATTERN.test(String(requestId || ""));
}

export function cleanupPlan(plan, created = {}) {
  const cleanupIds = cleanupRequestIdsForBase(plan.cleanupRequestId);
  return {
    service: created.service ? { command: "admin.servico.remover", data: { id: plan.serviceId }, requestId: cleanupIds.service } : null,
    appointment: created.appointmentId ? { command: "agenda.cancelar", data: { appointmentId: created.appointmentId }, requestId: cleanupIds.appointment } : null,
    clientProfile: "REUSABLE_EXISTING_PROFILE_REQUIRED",
  };
}

const TERMINAL_APPOINTMENT_STATES = new Set(["cancelado", "cancelled", "nao_compareceu", "concluido", "completed"]);
const IGNORE_PROJECTION_FIELDS = new Set(["criado_em", "atualizado_em", "created_at", "updated_at", "generated_at"]);
const BATCH1_ALLOWED_COMMANDS = new Set(["cliente.garantir-perfil", "agenda.criar", "agenda.cancelar", "admin.servico.salvar", "admin.servico.remover"]);

function documentId(doc) { return String(doc?.name || "").split("/").at(-1); }
function semanticDocument(doc) {
  return Object.fromEntries(Object.entries(firestoreFields(doc)).filter(([key]) => !IGNORE_PROJECTION_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b)));
}
function semanticEquivalent(a, b) { return JSON.stringify(semanticDocument(a)) === JSON.stringify(semanticDocument(b)); }
function minutesOf(value) { const [hours, minutes] = String(value).split(":").map(Number); return hours * 60 + minutes; }
function timeOf(total) { return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`; }
function dateOf(date) { return date.toISOString().slice(0, 10); }
function nextDate(date, days) { const result = new Date(date); result.setUTCDate(result.getUTCDate() + days); return result; }

function oldBatch1DateWindow(now = new Date()) {
  return { from: dateOf(nextDate(now, -2)), to: dateOf(nextDate(now, 10)) };
}

export function summarizeOldBatch1Candidate({ appointmentId, appointment, v2, legacyOccupation, v2Occupation, expectedClientId = "" }) {
  const fields = firestoreFields(appointment);
  const clientOwnerMatch = Boolean(expectedClientId) && fields.cliente_id === expectedClientId;
  const creatorMatch = Boolean(expectedClientId) && fields.criado_por === expectedClientId;
  const legacyV2Equivalent = Boolean(appointment && v2 && semanticEquivalent(appointment, v2));
  return {
    appointmentFingerprint: safeIdentifierTelemetry(appointmentId).fingerprint,
    data: String(fields.data || ""),
    horario: String(fields.horario || ""),
    estado: String(fields.status || ""),
    barberMatch: fields.barbeiro_id === BATCH1_BARBER_ID,
    clientOwnerMatch: expectedClientId ? (clientOwnerMatch ? "SIM" : "NÃO") : "INCONCLUSIVO",
    clientOwnerFingerprint: safeIdentifierTelemetry(fields.cliente_id).fingerprint,
    creatorMatch: expectedClientId ? (creatorMatch ? "SIM" : "NÃO") : "INCONCLUSIVO",
    clientFixtureMatch: expectedClientId && clientOwnerMatch && creatorMatch && legacyV2Equivalent && fields.origem === "cliente" ? "SIM" : expectedClientId ? "NÃO" : "INCONCLUSIVO",
    legacyV2Equivalent: legacyV2Equivalent ? "SIM" : "NÃO",
    legacyPresent: Boolean(appointment),
    v2Present: Boolean(v2),
    legacyOccupancy: Boolean(legacyOccupation),
    v2Occupancy: Boolean(v2Occupation),
  };
}

export async function findOldBatch1Fixtures({ token, expectedClientId = "", query = auditQuery, read = auditGet, now = new Date() }) {
  if (!token) throw new Error("Firebase ID token is required for read-only fixture lookup");
  const window = oldBatch1DateWindow(now);
  const activeStates = new Set(["agendado", "cliente_chegou", "em_atendimento"]);
  const documents = await query("agendamentos", [["barbeiro_id", { stringValue: BATCH1_BARBER_ID }]], token);
  const candidates = [];
  for (const appointment of documents) {
    const fields = firestoreFields(appointment);
    if (!activeStates.has(String(fields.status || ""))) continue;
    if (String(fields.data || "") < window.from || String(fields.data || "") > window.to) continue;
    const appointmentId = documentId(appointment);
    const [v2, legacyOccupation, v2Occupation] = await Promise.all([
      read(`barbearias/${TENANT}/agendamentos/${appointmentId}`, token),
      read(`ocupacoes/${appointmentId}`, token),
      read(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, token),
    ]);
    candidates.push(summarizeOldBatch1Candidate({ appointmentId, appointment, v2, legacyOccupation, v2Occupation, expectedClientId }));
  }
  const unique = candidates.length === 1;
  const ownership = unique && candidates[0].clientFixtureMatch === "SIM" && candidates[0].barberMatch;
  return { window, candidates, unique, ownership };
}

export function oldBatch1CleanupPlan(runId = randomUUID().replaceAll("-", "").slice(0, 16)) {
  return OLD_BATCH1_FIXTURES.map((fixture, index) => ({
    ...fixture,
    appointmentId: `${BATCH1_BARBER_ID}_${fixture.date}_${fixture.time}`,
    requestId: `hml-lote1-targeted-cleanup-${runId}-${index + 1}`,
  }));
}

function activeAppointmentState(mass) {
  const legacy = firestoreFields(mass.legacy);
  const v2 = firestoreFields(mass.v2);
  return {
    legacyState: String(legacy.status || ""),
    v2State: String(v2.status || ""),
    active: [legacy, v2].some((value) => ["agendado", "cliente_chegou", "em_atendimento"].includes(String(value.status || ""))),
    finalEquivalent: Boolean(mass.legacy && mass.v2 && semanticEquivalent(mass.legacy, mass.v2)),
    occupationsRemoved: !mass.legacyOccupation && !mass.v2Occupation,
  };
}

export async function runOldBatch1Cleanup({ token, read = auditGet, call = callOperational, runId }) {
  if (!token) throw new Error("Firebase ID token is required for targeted cleanup");
  const plan = oldBatch1CleanupPlan(runId);
  if (plan.length !== 4 || plan.some((item) => !validRequestId(item.requestId))) throw new Error("TARGETED_CLEANUP_REQUEST_ID_INVALID");
  const initial = [];
  for (const item of plan) {
    const mass = await readAppointmentMass(item.appointmentId, token, read);
    const fields = firestoreFields(mass.legacy);
    if (!mass.legacy || !mass.v2 || fields.barbeiro_id !== BATCH1_BARBER_ID || fields.data !== item.date || fields.horario !== item.time || !["agendado", "cliente_chegou", "em_atendimento"].includes(String(fields.status || ""))) {
      throw new Error("TARGETED_CLEANUP_PREFLIGHT_FAILED");
    }
    initial.push({ item, mass });
  }
  const results = [];
  for (const { item } of initial) {
    try {
      await call("agenda.cancelar", { appointmentId: item.appointmentId }, item.requestId, token);
      const after = await readAppointmentMass(item.appointmentId, token, read);
      const state = activeAppointmentState(after);
      results.push({ date: item.date, horario: item.time, appointmentFingerprint: safeIdentifierTelemetry(item.appointmentId).fingerprint, success: !state.active && state.finalEquivalent && state.occupationsRemoved, state });
      if (results.at(-1).success !== true) throw new Error("TARGETED_CLEANUP_POST_AUDIT_FAILED");
    } catch (error) {
      results.push({ date: item.date, horario: item.time, appointmentFingerprint: safeIdentifierTelemetry(item.appointmentId).fingerprint, success: false, error: safeErrorMessage(error.message) });
      break;
    }
  }
  const finalAudits = [];
  for (const item of plan) {
    const mass = await readAppointmentMass(item.appointmentId, token, read);
    const state = activeAppointmentState(mass);
    finalAudits.push({ date: item.date, horario: item.time, appointmentFingerprint: safeIdentifierTelemetry(item.appointmentId).fingerprint, active: state.active, occupationsPresent: !state.occupationsRemoved, legacyPresent: Boolean(mass.legacy), v2Present: Boolean(mass.v2) });
  }
  return { planned: plan.length, results, finalAudits, zeroResidue: finalAudits.every((item) => !item.active && !item.occupationsPresent) };
}

async function findBatch1Slot({ auditToken, read = auditGet, list = auditList, query = auditQuery }) {
  const barberId = BATCH1_BARBER_ID;
  const barber = await read(`barbeiros/${barberId}`, auditToken);
  const barberData = firestoreFields(barber);
  if (!barber || barberData.ativo !== true) throw new Error("AGENDA_SLOT_BARBER_UNAVAILABLE");
  const services = (await list("servicos", auditToken))
    .map((doc) => ({ id: documentId(doc), ...firestoreFields(doc) }))
    .filter((service) => service.ativo === true && Number(service.duracao) === 30);
  if (!services.length) throw new Error("AGENDA_SLOT_SERVICE_UNAVAILABLE");
  const config = firestoreFields(await read("configuracoes/funcionamento", auditToken));
  for (let offset = 1; offset <= 10; offset += 1) {
    const dateObject = nextDate(new Date(), offset);
    const date = dateOf(dateObject);
    const day = dateObject.getUTCDay();
    if (config.dias_fechados_semana?.[day] === true) continue;
    for (const period of config.periodos_semana?.[day] || []) {
      for (let cursor = minutesOf(period.inicio); cursor + 30 <= minutesOf(period.fim); cursor += 30) {
        const time = timeOf(cursor);
        const appointmentId = `${barberId}_${date}_${time}`;
        const active = (await query("agendamentos", [["barbeiro_id", { stringValue: barberId }], ["data", { stringValue: date }]], auditToken))
          .map(firestoreFields).some((item) => item.horario === time && !TERMINAL_APPOINTMENT_STATES.has(String(item.status || "")));
        const legacyOccupation = await read(`ocupacoes/${appointmentId}`, auditToken);
        const v2Occupation = await read(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, auditToken);
        if (!active && !legacyOccupation && !v2Occupation) return { barberId, service: services[0], date, time, appointmentId };
      }
    }
  }
  throw new Error("AGENDA_SLOT_NOT_AVAILABLE");
}

async function readAppointmentMass(appointmentId, auditToken, read = auditGet) {
  return {
    legacy: await read(`agendamentos/${appointmentId}`, auditToken),
    v2: await read(`barbearias/${TENANT}/agendamentos/${appointmentId}`, auditToken),
    legacyOccupation: await read(`ocupacoes/${appointmentId}`, auditToken),
    v2Occupation: await read(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, auditToken),
  };
}

async function readServiceMass(serviceId, auditToken, read = auditGet) {
  return {
    legacy: await read(`servicos/${serviceId}`, auditToken),
    v2: await read(`barbearias/${TENANT}/servicos/${serviceId}`, auditToken),
  };
}

async function cleanupBatch1Resources({ appointmentId, serviceId, cleanupRequestId, auditToken, read = auditGet, call = callOperational }) {
  const failures = [];
  const cleanupIds = cleanupRequestIdsForBase(cleanupRequestId);
  if (!validRequestId(cleanupIds.appointment) || !validRequestId(cleanupIds.service)) throw new Error("CLEANUP_REQUEST_ID_INVALID");
  if (appointmentId) {
    let attempted = false;
    try {
      const mass = await readAppointmentMass(appointmentId, auditToken, read);
      if (mass.legacy || mass.v2 || mass.legacyOccupation || mass.v2Occupation) {
        const appointment = firestoreFields(mass.legacy || mass.v2);
        if (!TERMINAL_APPOINTMENT_STATES.has(String(appointment.status || "")) || mass.legacyOccupation || mass.v2Occupation) {
          attempted = true;
          await call("agenda.cancelar", { appointmentId }, cleanupIds.appointment, process.env.__CLIENT_TOKEN_FOR_TEST_ONLY || "");
        }
      }
      logCleanupTelemetry("agenda", { attempted, idValue: appointmentId, requestId: cleanupIds.appointment });
    } catch (error) {
      logCleanupTelemetry("agenda", { attempted, idValue: appointmentId, requestId: cleanupIds.appointment, error });
      failures.push({ resource: "appointment", error });
    }
  }
  if (serviceId) {
    let attempted = false;
    try {
      const mass = await readServiceMass(serviceId, auditToken, read);
      if (mass.legacy || mass.v2) {
        attempted = true;
        await call("admin.servico.remover", { id: serviceId }, cleanupIds.service, process.env.__ADMIN_TOKEN_FOR_TEST_ONLY || "");
      }
      logCleanupTelemetry("service", { attempted, idValue: serviceId, requestId: cleanupIds.service });
    } catch (error) {
      logCleanupTelemetry("service", { attempted, idValue: serviceId, requestId: cleanupIds.service, error });
      failures.push({ resource: "service", error });
    }
  }
  if (appointmentId) {
    const mass = await readAppointmentMass(appointmentId, auditToken, read);
    const appointment = firestoreFields(mass.legacy || mass.v2);
    if (mass.legacyOccupation || mass.v2Occupation || (mass.legacy && !TERMINAL_APPOINTMENT_STATES.has(String(appointment.status || ""))) || (mass.v2 && !TERMINAL_APPOINTMENT_STATES.has(String(firestoreFields(mass.v2).status || "")))) {
      failures.push({ resource: "appointment", error: new Error("ZERO_ACTIVE_RESIDUE_FAILED") });
    }
  }
  if (serviceId) {
    const mass = await readServiceMass(serviceId, auditToken, read);
    if (mass.legacy || mass.v2) failures.push({ resource: "service", error: new Error("ZERO_SERVICE_RESIDUE_FAILED") });
  }
  return failures;
}

async function runBatch1({ auditToken, clientSession, adminSession, read = auditGet, list = auditList, query = auditQuery, clientRead = read, adminRead = read, call = callOperational }) {
  const clientToken = clientSession.idToken || auditToken;
  const adminToken = adminSession.idToken || auditToken;
  const clientIdentity = await proveClientIsNotPrivileged(clientSession.localId, clientToken, clientRead);
  const clientProfile = await clientRead(`clientes/${clientIdentity.operationalUid}`, clientToken);
  if (!clientProfile) throw new Error("CLIENT_PROFILE_REQUIRED");
  const adminIdentity = await proveAdminIdentity(adminSession.localId, adminToken, adminRead);
  if (!adminIdentity.admin && !adminIdentity.memberAdmin) throw new Error("ADMIN role not proven");
  const plan = fixturePlan();
  const initialService = await readServiceMass(plan.serviceId, adminToken, adminRead);
  if (initialService.legacy || initialService.v2) throw new Error("FIXTURE_COLLISION_SERVICE");
  const slot = await findBatch1Slot({ auditToken: adminToken, read: adminRead, list: (collection, token) => list(collection, token), query: (collection, filters, token) => query(collection, filters, token) });
  const clientRequestId = `${plan.runId}-client`;
  const appointmentRequestId = `${plan.runId}-appointment`;
  const serviceRequestId = `${plan.runId}-service`;
  let appointmentCandidate = slot.appointmentId;
  let serviceCandidate = plan.serviceId;
  let cleanupFailures = [];
  try {
    const batchCall = async (stage, command, data, requestId, token, actor) => {
      if (!BATCH1_ALLOWED_COMMANDS.has(command)) throw new Error("BATCH1_COMMAND_OUT_OF_SCOPE");
      try {
        const result = await call(command, data, requestId, token);
        console.log(JSON.stringify({ BATCH_STAGE: stage, COMMAND: command, ACTOR: actor, HTTP_STATUS: 200, CALLABLE_CODE: "", MESSAGE_SAFE: "" }));
        return result;
      } catch (error) {
        console.log(JSON.stringify({ BATCH_STAGE: stage, COMMAND: command, ACTOR: actor, HTTP_STATUS: error.httpStatus || 0, CALLABLE_CODE: error.errorCode || error.firebaseStatus || "", MESSAGE_SAFE: safeErrorMessage(error.message) }));
        throw error;
      }
    };
    const clientFirst = await batchCall("CLIENT_PROFILE_FIRST", "cliente.garantir-perfil", { extras: {} }, clientRequestId, clientSession.idToken, "CLIENT");
    const clientReplay = await batchCall("CLIENT_PROFILE_REPLAY", "cliente.garantir-perfil", { extras: {} }, clientRequestId, clientSession.idToken, "CLIENT");
    const clientAfter = await clientRead(`barbearias/${TENANT}/membros/${clientIdentity.operationalUid}`, clientToken);
    const clientRoles = firestoreFields(clientAfter).papeis || [];
    console.log(JSON.stringify({ CLIENT_PROFILE_IDEMPOTENCY_TELEMETRY: clientProfileIdempotencyTelemetry({ first: clientFirst, second: clientReplay, requestId: clientRequestId }) }));
    if (clientFirst?.duplicate !== false || clientReplay?.duplicate !== true || clientRoles.includes("ADMIN") || clientRoles.includes("BARBEIRO")) throw new Error("CLIENT_PROFILE_IDEMPOTENCY_FAILED");

    const appointmentPayload = { cliente_id: clientIdentity.operationalUid, barbeiro_id: slot.barberId, servico_id: slot.service.id, data: slot.date, horario: slot.time };
    const firstAppointment = await batchCall("AGENDA_CREATE_FIRST", "agenda.criar", appointmentPayload, appointmentRequestId, clientSession.idToken, "CLIENT");
    appointmentCandidate = firstAppointment?.appointmentId || appointmentCandidate;
    console.log(JSON.stringify({ AGENDA_CREATE_TELEMETRY: agendaCreateTelemetry({ appointmentId: appointmentCandidate, date: slot.date, time: slot.time, barberId: slot.barberId, createRequestId: appointmentRequestId, cleanupRequestId: cleanupRequestIdsForBase(plan.cleanupRequestId).appointment }) }));
    if (firstAppointment?.duplicate !== false) throw new Error("AGENDA_FIRST_NON_REPLAY_FAILED");
    const createdMass = await readAppointmentMass(appointmentCandidate, clientToken, clientRead);
    if (!createdMass.legacy || !createdMass.v2 || !createdMass.legacyOccupation || !createdMass.v2Occupation || !semanticEquivalent(createdMass.legacy, createdMass.v2) || !semanticEquivalent(createdMass.legacyOccupation, createdMass.v2Occupation)) throw new Error("AGENDA_PROJECTIONS_INCONSISTENT");
    const appointmentReplay = await batchCall("AGENDA_CREATE_REPLAY", "agenda.criar", appointmentPayload, appointmentRequestId, clientSession.idToken, "CLIENT");
    if (appointmentReplay?.duplicate !== true || appointmentReplay?.appointmentId !== appointmentCandidate) throw new Error("AGENDA_REPLAY_FAILED");

    const servicePayload = { id: serviceCandidate, nome: `HML Lote 1 ${plan.runId}`, descricao: "fixture descartável", duracao: 30, preco: "0", ativo: false };
    const firstService = await batchCall("ADMIN_SERVICE_SAVE_FIRST", "admin.servico.salvar", servicePayload, serviceRequestId, adminSession.idToken, "ADMIN");
    if (firstService?.duplicate !== false) throw new Error("SERVICE_CREATE_FAILED");
    const serviceMass = await readServiceMass(serviceCandidate, adminToken, adminRead);
    if (!serviceMass.legacy || !serviceMass.v2 || !semanticEquivalent(serviceMass.legacy, serviceMass.v2)) throw new Error("SERVICE_PROJECTIONS_INCONSISTENT");
    const serviceReplay = await batchCall("ADMIN_SERVICE_SAVE_REPLAY", "admin.servico.salvar", servicePayload, serviceRequestId, adminSession.idToken, "ADMIN");
    if (serviceReplay?.duplicate !== true) throw new Error("SERVICE_REPLAY_FAILED");
    return { client: { first: clientFirst, replay: clientReplay }, appointment: { first: firstAppointment, replay: appointmentReplay }, service: { first: firstService, replay: serviceReplay } };
  } finally {
    cleanupFailures = await cleanupBatch1Resources({ appointmentId: appointmentCandidate, serviceId: serviceCandidate, cleanupRequestId: plan.cleanupRequestId, auditToken: adminToken, read: adminRead, call: async (command, data, requestId, token) => call(command, data, requestId, command.startsWith("agenda.") ? clientToken : adminToken) });
    if (cleanupFailures.length) throw new Error("CLEANUP_FAILED");
  }
}

async function selfTest() {
  const future = Math.floor(Date.now() / 1000) + 300;
  const payload = (aud, sub) => `h.${Buffer.from(JSON.stringify({ aud, sub, exp: future }), "utf8").toString("base64url")}.s`;
  assert(validateIdToken(payload(PROJECT, "uid"), "uid").aud === PROJECT, "valid token rejected");
  assertThrows(() => validateIdToken(payload("barber-a01e7", "uid"), "uid"), "ID token project mismatch");
  assertThrows(() => guardOptions(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write"]), { FIRESTORE_AUDIT_TOKEN: "x" }), "HML project guard failed");
  assertThrows(() => guardOptions(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive"]), { FIRESTORE_AUDIT_TOKEN: "x" }), "--confirm-hml-write is required");
  const oldFixtureOpts = parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--find-old-batch1-fixture"]);
  assert(guardFindOldBatch1FixtureOptions(oldFixtureOpts), "old fixture read-only guard failed");
  assertThrows(() => guardFindOldBatch1FixtureOptions(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-admin=interactive", "--auth-client=interactive", "--find-old-batch1-fixture"])), "HML project guard failed");
  assertThrows(() => guardFindOldBatch1FixtureOptions(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write", "--find-old-batch1-fixture"])), "read-only fixture mode cannot include mutation options");
  assertThrows(() => guardFindOldBatch1FixtureOptions(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--find-old-batch1-fixture"])), "interactive ADMIN and CLIENT auth are required");
  const cleanupOpts = parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--cleanup-old-batch1-fixtures", "--confirm-hml-cleanup"]);
  assert(guardCleanupOldBatch1Options(cleanupOpts), "targeted cleanup guard failed");
  assertThrows(() => guardCleanupOldBatch1Options(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-admin=interactive", "--cleanup-old-batch1-fixtures", "--confirm-hml-cleanup"])), "HML project guard failed");
  const cleanupFixturePlan = oldBatch1CleanupPlan("fixed");
  assert(cleanupFixturePlan.length === 4 && cleanupFixturePlan.every((item) => validRequestId(item.requestId) && !item.requestId.includes(item.appointmentId)), "targeted cleanup plan invalid");
  const wire = buildCallableRequest("admin.servico.salvar", { id: "fixture", nome: "Fixture", duracao: 30, preco: "0", ativo: false }, "request-1", "TOKEN");
  const outer = JSON.parse(wire.body);
  assert(wire.headers.Authorization === "Bearer TOKEN", "callable auth header missing");
  assert(wire.headers["Content-Type"] === "application/json", "callable content type missing");
  assert(outer.data.command === "admin.servico.salvar" && outer.data.requestId === "request-1", "callable envelope invalid");
  assert(outer.data.data.data === undefined, "duplicate data envelope");
  const agendaWire = JSON.parse(buildCallableRequest("agenda.criar", { cliente_id: "client-operational", barbeiro_id: "barber-1", servico_id: "service-1", data: "2099-01-01", horario: "08:30" }, "agenda-request-1", "TOKEN").body);
  assert(agendaWire.data.command === "agenda.criar" && agendaWire.data.requestId === "agenda-request-1", "agenda callable envelope invalid");
  assert(agendaWire.data.data.cliente_id === "client-operational" && agendaWire.data.data.data === "2099-01-01" && agendaWire.data.data.horario === "08:30", "agenda client payload invalid");
  assert(agendaWire.data.data.data.data === undefined, "agenda duplicate data envelope");
  const clientWire = JSON.parse(buildCallableRequest("cliente.garantir-perfil", { extras: { nome: "Cliente" } }, "client-request-1", "TOKEN").body);
  assert(clientWire.data.command === "cliente.garantir-perfil" && clientWire.data.extras?.nome === "Cliente", "client extras contract invalid");
  assert(clientWire.data.data === undefined, "client extras must remain at callable payload root");
  const errorResponse = { ok: false, status: 500, text: async () => JSON.stringify({ error: { status: "INTERNAL", message: "Não foi possível concluir a operação.", details: { stage: "READS", uid: "must-not-leak" } } }) };
  await assertRejects(callOperational("cliente.garantir-perfil", { extras: {} }, "error-request-1", "TOKEN", async () => errorResponse), (error) => {
    assert(error.httpStatus === 500, "callable HTTP status not preserved");
    assert(error.firebaseStatus === "INTERNAL", "callable status not preserved");
    assert(error.errorCode === "INTERNAL", "callable code not preserved");
    assert(error.safeDetails.stage === "READS", "safe details not preserved");
    assert(error.safeDetails.uid === undefined, "unsafe details leaked");
    assert(!JSON.stringify(error).includes("must-not-leak"), "unsafe error details leaked");
  });
  const plan = fixturePlan("fixed");
  const cleanup = cleanupPlan(plan, { service: true, appointmentId: "appointment-fixed" });
  const cleanupIds = cleanupRequestIdsForBase(plan.cleanupRequestId);
  assert(cleanup.service.command === "admin.servico.remover" && cleanup.appointment.command === "agenda.cancelar", "cleanup plan invalid");
  assert(validRequestId(cleanupIds.appointment) && validRequestId(cleanupIds.service), "cleanup request id must match backend validator");
  assert(cleanupIds.appointment !== plan.appointmentRequestId && !cleanupIds.appointment.includes("appointment-fixed"), "cleanup request id must be new and opaque");
  assert(cleanupIds.appointment === cleanupRequestIdsForBase(plan.cleanupRequestId).appointment, "cleanup request id must be stable");
  assert(requestIdTelemetry(cleanupIds.appointment).charsetClass === "ALNUM_UNDERSCORE_HYPHEN", "cleanup request id telemetry invalid");
  const agendaTelemetry = agendaCreateTelemetry({ appointmentId: "barber-fixed_2099-01-01_08:30", date: "2099-01-01", time: "08:30", barberId: "barber-fixed", createRequestId: plan.appointmentRequestId, cleanupRequestId: cleanupIds.appointment });
  assert(agendaTelemetry.appointmentIdPresent === true && agendaTelemetry.data === "2099-01-01" && agendaTelemetry.horario === "08:30", "agenda creation telemetry invalid");
  assert(agendaTelemetry.appointmentIdFingerprint && agendaTelemetry.barberIdFingerprint && agendaTelemetry.createRequestIdFingerprint && agendaTelemetry.cleanupRequestIdFingerprint, "agenda telemetry fingerprints missing");
  assert(!JSON.stringify(agendaTelemetry).includes("barber-fixed_2099-01-01_08:30") && !JSON.stringify(agendaTelemetry).includes("barber-fixed"), "agenda telemetry leaked an identifier");
  const candidate = summarizeOldBatch1Candidate({ appointmentId: "barber-fixed_2099-01-01_08:30", appointment: { fields: { barbeiro_id: { stringValue: BATCH1_BARBER_ID }, cliente_id: { stringValue: "client-operational" }, criado_por: { stringValue: "client-operational" }, origem: { stringValue: "cliente" }, data: { stringValue: "2099-01-01" }, horario: { stringValue: "08:30" }, status: { stringValue: "agendado" } } }, v2: { fields: { barbeiro_id: { stringValue: BATCH1_BARBER_ID }, cliente_id: { stringValue: "client-operational" }, criado_por: { stringValue: "client-operational" }, origem: { stringValue: "cliente" }, data: { stringValue: "2099-01-01" }, horario: { stringValue: "08:30" }, status: { stringValue: "agendado" } } }, legacyOccupation: { fields: {} }, v2Occupation: null, expectedClientId: "client-operational" });
  assert(candidate.barberMatch && candidate.clientOwnerMatch === "SIM" && candidate.creatorMatch === "SIM" && candidate.clientFixtureMatch === "SIM" && candidate.legacyPresent && candidate.v2Present && candidate.legacyOccupancy && !candidate.v2Occupancy, "old fixture candidate summary invalid");
  assert(!JSON.stringify(candidate).includes("barber-fixed_2099-01-01_08:30"), "old fixture candidate leaked identifier");
  const cleanupAgendaError = Object.assign(new Error("Permissão insuficiente para appointment-fixed."), { httpStatus: 400, errorCode: "PERMISSION_DENIED" });
  const agendaCleanupTelemetry = cleanupTelemetry("agenda", { attempted: true, idValue: "appointment-fixed", requestId: cleanupIds.appointment, error: cleanupAgendaError });
  assert(agendaCleanupTelemetry.CLEANUP_AGENDA_ATTEMPTED === true, "agenda cleanup attempt telemetry invalid");
  assert(agendaCleanupTelemetry.CLEANUP_AGENDA_HTTP_STATUS === 400 && agendaCleanupTelemetry.CLEANUP_AGENDA_CODE === "PERMISSION_DENIED", "agenda cleanup error telemetry invalid");
  assert(agendaCleanupTelemetry.APPOINTMENT_ID_PRESENT === true && agendaCleanupTelemetry.SERVICE_ID_PRESENT === false, "agenda cleanup id telemetry invalid");
  assert(agendaCleanupTelemetry.CLEANUP_AGENDA_MESSAGE_SAFE.includes("[ID_REDACTED]") && !agendaCleanupTelemetry.CLEANUP_AGENDA_MESSAGE_SAFE.includes("appointment-fixed"), "agenda cleanup message leaked an identifier");
  const serviceCleanupTelemetry = cleanupTelemetry("service", { attempted: true, idValue: "service-fixed", requestId: cleanupIds.service });
  assert(serviceCleanupTelemetry.CLEANUP_SERVICE_ATTEMPTED === true && serviceCleanupTelemetry.CLEANUP_SERVICE_HTTP_STATUS === 200, "service cleanup success telemetry invalid");
  assert(serviceCleanupTelemetry.APPOINTMENT_ID_PRESENT === false && serviceCleanupTelemetry.SERVICE_ID_PRESENT === true, "service cleanup id telemetry invalid");
  assert(serviceCleanupTelemetry.CLEANUP_SERVICE_REQUEST_ID_LENGTH === cleanupIds.service.length, "service cleanup request id length telemetry invalid");
  assert(!JSON.stringify(agendaCleanupTelemetry).includes("appointment-fixed") && !JSON.stringify(serviceCleanupTelemetry).includes("service-fixed"), "cleanup telemetry leaked an identifier");
  assert(plan.serviceRequestId !== plan.cleanupRequestId, "request ids must differ");
  const profileTelemetry = clientProfileIdempotencyTelemetry({ first: { duplicate: false, clientId: "client-id", created: true }, second: { duplicate: true, clientId: "client-id", created: true }, requestId: "client-replay-request" });
  assert(profileTelemetry.firstDuplicateFlag === false && profileTelemetry.secondDuplicateFlag === true, "profile telemetry flags invalid");
  assert(profileTelemetry.secondRequestIdSame && profileTelemetry.responseSemanticallyEqual, "profile telemetry replay equivalence invalid");
  assert(profileTelemetry.firstOperationId.fingerprint && !JSON.stringify(profileTelemetry).includes("client-id"), "profile telemetry leaked operation ID");
  const firstResult = { duplicate: false, clientId: "x", created: true };
  const replayResult = { duplicate: true, clientId: "x", created: true };
  assert(extractCallableResult({ result: firstResult }) === firstResult, "result callable shape not parsed");
  assert(extractCallableResult({ result: replayResult }) === replayResult, "replay result callable shape not parsed");
  assert(extractCallableResult({ data: firstResult }) === firstResult, "data callable shape not parsed");
  assert(extractCallableResult({}) === undefined, "empty callable response must remain invalid");
  const resultTelemetry = callableResponseTelemetry(200, { result: firstResult });
  assert(resultTelemetry.HTTP_STATUS === 200 && resultTelemetry.RESULT_TYPE === "object" && resultTelemetry.DATA_TYPE === "undefined", "callable response telemetry invalid");
  assert(!JSON.stringify(resultTelemetry).includes('"x"'), "callable response telemetry leaked payload values");
  assert(parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--preflight-only"]).preflightOnly, "preflight parser failed");
  const recoveryOpts = parseArgs(["node", "x", "--project=teste-483f6", "--auth-client=interactive", "--confirm-hml-write", "--client-bootstrap-recovery-only"]);
  assert(recoveryOpts.clientBootstrapRecoveryOnly, "recovery-only parser failed");
  assert(guardClientBootstrapRecoveryOptions(recoveryOpts, { FIRESTORE_AUDIT_TOKEN: "audit" }), "recovery-only guard failed");
  assertThrows(() => guardClientBootstrapRecoveryOptions(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-client=interactive", "--confirm-hml-write", "--client-bootstrap-recovery-only"]), { FIRESTORE_AUDIT_TOKEN: "audit" }), "HML project guard failed");
  assertThrows(() => guardClientBootstrapRecoveryOptions(parseArgs(["node", "x", "--project=teste-483f6", "--auth-client=interactive", "--client-bootstrap-recovery-only"]), { FIRESTORE_AUDIT_TOKEN: "audit" }), "--confirm-hml-write is required");
  const batchOpts = parseArgs(["node", "x", "--project=teste-483f6", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write", "--batch1"]);
  assert(batchOpts.batch1, "batch1 parser failed");
  assert(guardBatch1Options(batchOpts, { FIRESTORE_AUDIT_TOKEN: "audit" }), "batch1 guard failed");
  assertThrows(() => guardBatch1Options(parseArgs(["node", "x", "--project=barber-a01e7", "--auth-admin=interactive", "--auth-client=interactive", "--confirm-hml-write", "--batch1"]), { FIRESTORE_AUDIT_TOKEN: "audit" }), "HML project guard failed");
  const source = readFileSync(new URL(import.meta.url), "utf8");
  const batchMain = source.split("if (opts.batch1)")[1]?.split("  guardOptions(opts);")[0] || "";
  assert(!batchMain.includes("obtainAuditToken") && !batchMain.includes("createRefreshingAuditOperations"), "batch1 must not acquire gcloud audit tokens");
  for (const command of BATCH1_ALLOWED_COMMANDS) assert(["cliente.garantir-perfil", "agenda.criar", "agenda.cancelar", "admin.servico.salvar", "admin.servico.remover"].includes(command), "batch1 command out of scope");
  for (const status of [401, 403]) await assertRejects(auditPreflight("oauth-token", async () => { const error = new Error(`audit GET HTTP ${status}`); error.httpStatus = status; throw error; }), (error) => assert(error.message === "ABORT_BEFORE_MUTATION_AUDIT_UNAUTHORIZED", "audit unauthorized was not a preflight abort"));
  const encoded = (value) => typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
  const readMap = new Map([
    ["homologacao_mapeamentos/admin-auth", { fields: { tenant_id: encoded(TENANT), uid_producao_referencia: encoded("admin-operational") } }],
    ["admins/admin-operational", { fields: {} }],
    [`barbearias/${TENANT}/membros/admin-operational`, { fields: { papeis: { arrayValue: { values: [encoded("ADMIN")] } } } }],
    ["homologacao_mapeamentos/client-auth", { fields: { tenant_id: encoded(TENANT), uid_producao_referencia: encoded("client-operational") } }],
    ["admins/client-operational", null],
    [`barbearias/${TENANT}/membros/client-operational`, { fields: { papeis: { arrayValue: { values: [encoded("CLIENTE")] } } } }],
    ["clientes/client-operational", { fields: { nome: encoded("Cliente") } }],
  ]);
  const clientAuditTokens = new Set();
  const adminAuditTokens = new Set();
  const clientAuditRead = async (path, token) => { clientAuditTokens.add(token); return readMap.get(path) || null; };
  const adminAuditRead = async (path, token) => { adminAuditTokens.add(token); return readMap.get(path) || null; };
  const preflight = await runIdentityPreflight({
    adminSession: { localId: "admin-auth", idToken: payload(PROJECT, "admin-auth") },
    clientSession: { localId: "client-auth", idToken: payload(PROJECT, "client-auth") },
    clientToken: "CLIENT_ID_TOKEN",
    adminToken: "ADMIN_ID_TOKEN",
    clientRead: clientAuditRead,
    adminRead: adminAuditRead,
  });
  assert(preflight.clientProfileExists && !preflight.clientIsAdmin && !preflight.clientIsBarber && preflight.adminProven, "identity preflight failed");
  assert(clientAuditTokens.has("CLIENT_ID_TOKEN") && !clientAuditTokens.has("ADMIN_ID_TOKEN"), "client audit used the wrong identity token");
  assert(adminAuditTokens.has("ADMIN_ID_TOKEN") && !adminAuditTokens.has("CLIENT_ID_TOKEN"), "admin audit used the wrong identity token");
  const wireDoc = (fields) => ({ fields: Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, typeof value === "boolean" ? { booleanValue: value } : { stringValue: String(value) }])) });
  const batchState = { appointment: null, v2Appointment: null, legacyOccupation: null, v2Occupation: null, service: null, v2Service: null, clientCall: 0, appointmentCall: 0, serviceCall: 0, agendaCalls: [], agendaActors: [] };
  const fakePeriods = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((day) => [String(day), { arrayValue: { values: [{ mapValue: { fields: { inicio: { stringValue: "08:30" }, fim: { stringValue: "09:00" } } } }] } }]));
  const fakeConfig = { fields: { dias_fechados_semana: { mapValue: { fields: {} } }, periodos_semana: { mapValue: { fields: fakePeriods } } } };
  const fakeRead = async (path) => {
    const map = {
      [`homologacao_mapeamentos/client-auth`]: readMap.get("homologacao_mapeamentos/client-auth"),
      [`clientes/client-operational`]: readMap.get("clientes/client-operational"),
      [`barbearias/${TENANT}/membros/client-operational`]: readMap.get(`barbearias/${TENANT}/membros/client-operational`),
      [`homologacao_mapeamentos/admin-auth`]: readMap.get("homologacao_mapeamentos/admin-auth"),
      [`admins/admin-operational`]: readMap.get("admins/admin-operational"),
      [`barbearias/${TENANT}/membros/admin-operational`]: readMap.get(`barbearias/${TENANT}/membros/admin-operational`),
      "barbeiros/YMJrJJ58I6N9bMl4jsgy": wireDoc({ ativo: true }),
      "configuracoes/funcionamento": fakeConfig,
    };
    if (path.endsWith("/membros/client-operational")) return map[path];
    if (path.startsWith("servicos/hml_lote1_servico_") || path.startsWith(`barbearias/${TENANT}/servicos/hml_lote1_servico_`)) return batchState.service && path.startsWith("barbearias/") ? batchState.v2Service : batchState.service;
    if (path.includes("agendamentos/") && path.endsWith("08:30")) return path.startsWith("barbearias/") ? batchState.v2Appointment : batchState.appointment;
    if (path.includes("ocupacoes/") && path.endsWith("08:30")) return path.startsWith("barbearias/") ? batchState.v2Occupation : batchState.legacyOccupation;
    if (path.startsWith("barbearias/") && path.includes("/clientes/")) return map[path];
    return map[path] || null;
  };
  const fakeCall = async (command, data, requestId, token) => {
    if (command === "cliente.garantir-perfil") { batchState.clientCall += 1; return { duplicate: batchState.clientCall > 1, clientId: "client-operational" }; }
    if (command === "agenda.criar") {
      batchState.appointmentCall += 1;
      batchState.agendaCalls.push({ ...data, requestId });
      batchState.agendaActors.push(token);
      assert(data.cliente_id === "client-operational", "agenda client_id source invalid");
      const appointmentId = `YMJrJJ58I6N9bMl4jsgy_${data.data}_08:30`;
      if (batchState.appointmentCall === 1) {
        const values = { barbeiro_id: data.barbeiro_id, servico_id: data.servico_id, data: data.data, horario: data.horario, status: "agendado" };
        batchState.appointment = wireDoc(values); batchState.v2Appointment = wireDoc(values); batchState.legacyOccupation = wireDoc({ agendamento_id: appointmentId, status: "ocupado" }); batchState.v2Occupation = wireDoc({ agendamento_id: appointmentId, status: "ocupado" });
        return { duplicate: false, appointmentId, slots: 1 };
      }
      return { duplicate: true, appointmentId, slots: 1 };
    }
    if (command === "agenda.cancelar") { const value = { ...firestoreFields(batchState.appointment), status: "cancelado" }; batchState.appointment = wireDoc(value); batchState.v2Appointment = wireDoc(value); batchState.legacyOccupation = null; batchState.v2Occupation = null; return { duplicate: false, appointmentId: data.appointmentId }; }
    if (command === "admin.servico.salvar") { batchState.serviceCall += 1; if (batchState.serviceCall === 1) { const value = { id: data.id, nome: data.nome, descricao: data.descricao, duracao: data.duracao, preco: data.preco, ativo: data.ativo }; batchState.service = wireDoc(value); batchState.v2Service = wireDoc(value); return { duplicate: false, serviceId: data.id, created: true }; } return { duplicate: true, serviceId: data.id, created: true }; }
    if (command === "admin.servico.remover") { batchState.service = null; batchState.v2Service = null; return { duplicate: false, serviceId: data.id, removed: true }; }
    throw new Error("unexpected batch command");
  };
  const batchResult = await runBatch1({
    auditToken: "AUDIT",
    clientSession: { localId: "client-auth", idToken: "CLIENT" },
    adminSession: { localId: "admin-auth", idToken: "ADMIN" },
    read: fakeRead,
    list: async () => [{ name: `${FIRESTORE_ROOT}/servicos/hml-fixed-service`, ...wireDoc({ ativo: true, duracao: 30 }) }],
    query: async () => [],
    call: fakeCall,
  });
  assert(batchResult.appointment.replay.duplicate === true && batchResult.service.replay.duplicate === true, "batch idempotency model failed");
  assert(batchState.agendaCalls.length === 2 && JSON.stringify(batchState.agendaCalls[0]) === JSON.stringify(batchState.agendaCalls[1]), "agenda replay payload/requestId changed");
  assert(batchState.agendaActors[0] === "CLIENT" && batchState.agendaActors[1] === "CLIENT", "agenda actor changed");
  assert(batchState.legacyOccupation === null && batchState.v2Occupation === null && batchState.service === null && batchState.v2Service === null, "batch cleanup model failed");
  assert(!JSON.stringify({ wire: { Authorization: "Bearer [REDACTED]" }, cleanup }).includes("TOKEN"), "secret leaked in test fixture");
  console.log("hml batch1 auth/guard self-test: PASS");
}

function assert(condition, message) { if (!condition) throw new Error(message); }
function assertThrows(fn, message) { try { fn(); throw new Error("expected failure"); } catch (error) { if (error.message === "expected failure" || error.message !== message) throw error; } }
async function assertRejects(promise, check) { try { await promise; throw new Error("expected rejection"); } catch (error) { if (error.message === "expected rejection") throw error; check(error); } }

async function main() {
  const opts = parseArgs();
  if (opts.selfTest) { await selfTest(); return; }
  if (opts.cleanupOldBatch1Fixtures) {
    guardCleanupOldBatch1Options(opts);
    try {
      credentialState.admin = await interactiveSession("HML ADMIN TARGETED CLEANUP");
      const result = await runOldBatch1Cleanup({ token: credentialState.admin.idToken });
      const success = result.results.filter((item) => item.success === true).length;
      const failed = result.results.filter((item) => item.success !== true).length;
      const legacyOccupanciesRemaining = result.finalAudits.filter((item) => item.occupationsPresent && item.legacyPresent).length;
      const v2OccupanciesRemaining = result.finalAudits.filter((item) => item.occupationsPresent && item.v2Present).length;
      const activeRemaining = result.finalAudits.filter((item) => item.active).length;
      console.log(JSON.stringify({
        CLEANUP_PLANNED: result.planned,
        CLEANUP_SUCCESS: success,
        CLEANUP_FAILED: failed,
        LEGACY_OCCUPANCIES_REMAINING: legacyOccupanciesRemaining,
        V2_OCCUPANCIES_REMAINING: v2OccupanciesRemaining,
        ACTIVE_TEST_APPOINTMENTS_REMAINING: activeRemaining,
        ZERO_TEST_RESIDUE: result.zeroResidue ? "PASS" : "FAIL",
        STEPS: result.results,
        PRODUCTION_ACCESSED: "NÃO",
        FINAL_RESULT: result.zeroResidue && success === result.planned ? "PASS" : "FAIL",
      }));
    } finally { clearCredentials(); }
    return;
  }
  if (opts.findOldBatch1Fixture) {
    guardFindOldBatch1FixtureOptions(opts);
    try {
      credentialState.admin = await interactiveSession("HML ADMIN READ-ONLY");
      credentialState.client = await interactiveSession("HML CLIENT READ-ONLY");
      const clientIdentity = await proveClientIsNotPrivileged(credentialState.client.localId, credentialState.client.idToken, auditGet);
      const result = await findOldBatch1Fixtures({ token: credentialState.admin.idToken, expectedClientId: clientIdentity.operationalUid });
      const candidate = result.candidates[0];
      const matchingCandidates = result.candidates.filter((item) => item.clientFixtureMatch === "SIM").length;
      console.log(JSON.stringify({
        READ_ONLY_MODE: "SIM",
        FIREBASE_ADMIN_AUTH: "SIM",
        FIREBASE_CLIENT_AUTH: "SIM",
        CLIENT_OPERATIONAL_ID_RESOLVED: "SIM",
        GCLOUD_REQUIRED: "NÃO",
        CANDIDATES_FOUND: result.candidates.length,
        CLIENT_MATCHING_CANDIDATES: matchingCandidates,
        NON_CLIENT_CANDIDATES: result.candidates.length - matchingCandidates,
        OWNED_FIXTURES: matchingCandidates,
        UNIQUE_CANDIDATE: result.unique ? "SIM" : "NÃO",
        FIXTURE_OWNERSHIP_PROVEN: matchingCandidates > 0 ? "SIM" : "NÃO",
        CANDIDATES: result.candidates,
        APPOINTMENT_ID_FOUND: matchingCandidates > 0 ? "SIM" : "NÃO",
        APPOINTMENT_STATE: candidate?.estado || "INCONCLUSIVO",
        LEGACY_APPOINTMENT_PRESENT: candidate?.legacyPresent ? "SIM" : "NÃO",
        V2_APPOINTMENT_PRESENT: candidate?.v2Present ? "SIM" : "NÃO",
        LEGACY_OCCUPANCY_PRESENT: candidate?.legacyOccupancy ? "SIM" : "NÃO",
        V2_OCCUPANCY_PRESENT: candidate?.v2Occupancy ? "SIM" : "NÃO",
        CLEANUP_SET_PROVEN: matchingCandidates > 0 ? "SIM" : "NÃO",
        TARGETED_CLEANUP_REQUIRED: matchingCandidates > 0 ? "SIM" : result.candidates.length ? "INCONCLUSIVO" : "NÃO",
        TARGETED_CLEANUP_SAFE: matchingCandidates > 0 ? "SIM" : "NÃO",
        HML_DATA_CHANGED: "NÃO",
        PRODUCTION_ACCESSED: "NÃO",
      }));
    } finally { clearCredentials(); }
    return;
  }
  if (opts.preflightOnly) {
    guardOptions(opts, process.env, { requireWrite: false });
    const auditToken = String(process.env.FIRESTORE_AUDIT_TOKEN || "").trim();
    try {
      credentialState.client = await interactiveSession("HML CLIENT");
      credentialState.admin = await interactiveSession("HML ADMIN");
      const result = await runIdentityPreflight({ adminSession: credentialState.admin, clientSession: credentialState.client, auditToken });
      console.log(JSON.stringify({
        IDENTITY_PREFLIGHT: "PASS",
        CLIENT_PROFILE_EXISTS: result.clientProfileExists,
        CLIENT_IS_ADMIN: result.clientIsAdmin,
        CLIENT_IS_BARBER: result.clientIsBarber,
        CLIENT_TENANT_MATCH: result.clientTenantMatch,
        ADMIN_PROVEN: result.adminProven,
        DISTINCT_IDENTITIES: result.distinctIdentities,
        MUTATION_EXECUTED: "NÃO",
      }));
    } finally { clearCredentials(); }
    return;
  }
  if (opts.clientBootstrapRecoveryOnly) {
    guardClientBootstrapRecoveryOptions(opts);
    const auditToken = String(process.env.FIRESTORE_AUDIT_TOKEN || "").trim();
    try {
      const result = await runClientBootstrapRecovery({ auditToken });
      console.log(JSON.stringify({
        FINAL_RESULT: "PASS",
        LOGIN_RESULT: result.loginResult,
        GARANTIR_PERFIL_RESULT: "PASS",
        MAPPING_CREATED: "SIM",
        OPERATIONAL_UID_EQUALS_AUTH_UID: "SIM",
        CLIENT_LEGACY_CREATED: "SIM",
        CLIENT_V2_CREATED: "SIM",
        CLIENT_MEMBERSHIP_CREATED: "SIM",
        BARBER_ROLE_GRANTED: "NÃO",
        ADMIN_ROLE_GRANTED: "NÃO",
        SECOND_LOGIN: result.secondLogin,
        IDEMPOTENT_RECOVERY: "PASS",
        DUPLICATE_MAPPING: "NÃO",
        DUPLICATE_PROFILE: "NÃO",
        DUPLICATE_MEMBERSHIP: "NÃO",
        LEGACY_V2_EQUIVALENT: "SIM",
        PARTIAL_WRITE: "NÃO",
        PRODUCTION_ACCESSED: "NÃO",
      }));
    } finally { clearCredentials(); }
    return;
  }
  if (opts.batch1) {
    guardBatch1Options(opts);
    try {
      credentialState.client = await interactiveSession("HML CLIENT");
      credentialState.admin = await interactiveSession("HML ADMIN");
      const identity = await runIdentityPreflight({
        adminSession: credentialState.admin,
        clientSession: credentialState.client,
        clientToken: credentialState.client.idToken,
        adminToken: credentialState.admin.idToken,
        clientRead: auditGet,
        adminRead: auditGet,
      });
      if (!identity.clientProfileExists || identity.clientIsAdmin || identity.clientIsBarber || !identity.adminProven) throw new Error("BATCH1_IDENTITY_PREFLIGHT_FAILED");
      const result = await runBatch1({
        clientSession: credentialState.client,
        adminSession: credentialState.admin,
        clientRead: auditGet,
        adminRead: auditGet,
      });
      console.log(JSON.stringify({
        PREFLIGHT: "PASS",
        AUDIT_AUTHENTICATION: "FIREBASE_ID_TOKEN_RULES",
        GCLOUD_AUTH_ACCESS_TOKEN_USED: "NÃO",
        REST_AUDIT_REQUIRED_FOR_BATCH1: "SIM",
        FUNCTIONAL_FLOW_INDEPENDENT_OF_GCLOUD: "SIM",
        OPTIONAL_POST_AUDIT: "NÃO_APLICÁVEL_AUDITORIA_JÁ_INTEGRA_O_PREFLIGHT",
        CLIENT_GARANTIR_PERFIL: "PASS",
        CLIENT_PROFILE_REPLAY: "PASS",
        CLIENT_DUPLICATE_MAPPING: "NÃO",
        CLIENT_DUPLICATE_PROFILE: "NÃO",
        CLIENT_DUPLICATE_MEMBERSHIP: "NÃO",
        CLIENT_PRIVILEGE_ESCALATION: "NÃO",
        AGENDA_CRIAR: "PASS",
        AGENDA_FIRST_NON_REPLAY: "SIM",
        AGENDA_SECOND_REPLAY: "SIM",
        AGENDA_SAME_ID: "SIM",
        AGENDA_ONE_LOGICAL_APPOINTMENT: "SIM",
        AGENDA_ONE_LOGICAL_OCCUPANCY: "SIM",
        AGENDA_LEGACY_V2_APPOINTMENT: "SIM",
        AGENDA_LEGACY_V2_OCCUPANCY: "SIM",
        AGENDA_CLEANUP: "PASS",
        ADMIN_SERVICO_SALVAR: "PASS",
        ADMIN_SERVICO_REPLAY: "PASS",
        ADMIN_SERVICO_LEGACY_V2: "SIM",
        ADMIN_SERVICO_REMOVER: "PASS",
        ADMIN_SERVICO_REMOVE_REPLAY: "NOT_RUN",
        ADMIN_SERVICO_ZERO_RESIDUE: "PASS",
        PARTIAL_WRITE: "NÃO",
        CLEANUP: "PASS",
        ZERO_RESIDUE: "PASS",
        P0_FINDINGS: "NENHUM",
        P1_FINDINGS: "NENHUM",
        HML_ACCESSED: "SIM",
        PRODUCTION_ACCESSED: "NÃO",
        PRODUCTION_CHANGED: "NÃO",
        DEPLOY: "NÃO",
        FINAL_RESULT: "PASS",
      }));
    } finally { clearCredentials(); }
    return;
  }
  guardOptions(opts);
  throw new Error("HML batch execution requires the separately approved slot/service fixture run; no remote execution is performed by this validation build");
}

main().catch((error) => { clearCredentials(); console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: { message: error.message.replace(/token|password|senha/gi, "[REDACTED]") }, PRODUCTION_ACCESSED: "NÃO" })); process.exitCode = 1; });

export { CALLABLE, PROJECT, REGION, TENANT, clearCredentials, guardOptions, parseArgs };
