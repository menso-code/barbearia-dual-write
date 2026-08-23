#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import readline from "node:readline";
import { authenticateInteractive, validateIdToken } from "./hml-command-batch2-test.mjs";

export const PROJECT = "teste-483f6";
export const PRODUCTION_PROJECT = "barber-a01e7";
export const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
export const COMMAND = "admin.barbeiro.ativar";
export const SAVE_COMMAND = "admin.barbeiro.salvar";
export const REMOVE_COMMAND = "admin.barbeiro.remover";
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,120}$/;
export const LEGACY_COLLECTION = "barbeiros";
export const V2_COLLECTION = `barbearias/${TENANT}/barbeiros`;
export const RELATED_MEMBER_PREFIX = `barbearias/${TENANT}/membros/`;
export const FIXTURE_PURPOSE = "barber-activate-fixture";
export const FIXTURE_ID = "batch4-barber-activate-fixture";
export const REGION = "southamerica-east1";
export const CALLABLE = `https://${REGION}-${PROJECT}.cloudfunctions.net/executeOperationalCommand`;

let networkAccessed = false;
let hmlAccessed = false;

export function fingerprint(value) {
  return createHash("sha256").update(String(value ?? "")).digest("hex").slice(0, 8);
}

export function safeIdMeta(value) {
  return { present: Boolean(value), length: String(value ?? "").length, fingerprint: fingerprint(value) };
}

export function isValidRequestId(value) {
  return REQUEST_ID_PATTERN.test(String(value ?? ""));
}

export function newRequestId(prefix = "hml-barber-activate") {
  const value = `${prefix}-${randomUUID().replaceAll("-", "")}`;
  if (!isValidRequestId(value)) throw new Error("REQUEST_ID_INVALID");
  return value;
}

export function productionGuard(project) {
  if (project !== PROJECT || project === PRODUCTION_PROJECT) throw new Error("HML_PROJECT_GUARD_FAILED");
  return true;
}

export function parseArgs(argv = process.argv) {
  return {
    project: argv.find((item) => item.startsWith("--project="))?.slice(10) || "",
    adminAuth: argv.find((item) => item.startsWith("--auth-admin="))?.slice(13) || "",
    fixturePreflightOnly: argv.includes("--fixture-preflight-only"),
    selfTest: argv.includes("--self-test"),
    barberActivateSafe: argv.includes("--barber-activate-safe"),
    confirmHmlWrite: argv.includes("--confirm-hml-write"),
    mutationRequested: argv.includes("--activate") || argv.includes("--confirm-hml-write"),
  };
}

export function guardReadOnlyOptions(options) {
  productionGuard(options.project);
  if (options.adminAuth !== "interactive") throw new Error("ADMIN_INTERACTIVE_AUTH_REQUIRED");
  if (!options.fixturePreflightOnly) throw new Error("FIXTURE_PREFLIGHT_ONLY_REQUIRED");
  if (options.mutationRequested) throw new Error("MUTATION_MODE_DISABLED_IN_THIS_BUILD");
  return true;
}

export function guardBarberActivateOptions(options) {
  productionGuard(options.project);
  if (options.adminAuth !== "interactive") throw new Error("ADMIN_INTERACTIVE_AUTH_REQUIRED");
  if (!options.barberActivateSafe) throw new Error("BARBER_ACTIVATE_SAFE_REQUIRED");
  if (!options.confirmHmlWrite) throw new Error("CONFIRM_HML_WRITE_REQUIRED");
  return true;
}

export function buildActivatePayload(barberId, ativo) {
  const id = String(barberId ?? "").trim();
  if (!id || typeof ativo !== "boolean") throw new Error("BARBER_ACTIVATE_PAYLOAD_INVALID");
  return { data: { id, ativo } };
}

export function buildFixtureSavePayload() {
  return {
    id: FIXTURE_ID,
    nome: FIXTURE_ID,
    descricao: `Dedicated test fixture: ${FIXTURE_PURPOSE}`,
    ativo: false,
  };
}

export function buildFixtureRemovePayload() {
  return { id: FIXTURE_ID };
}

export function buildAdminCallableEnvelope(command, data, requestId) {
  if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
  if (![SAVE_COMMAND, COMMAND, REMOVE_COMMAND].includes(command)) throw new Error("BARBER_COMMAND_NOT_ALLOWED");
  return { data: { command, requestId, data: structuredClone(data) } };
}

export function buildCallableEnvelope(barberId, ativo, requestId) {
  if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
  return { data: { command: COMMAND, requestId, data: buildActivatePayload(barberId, ativo).data } };
}

export function assertActivateResponse(response, { barberId, duplicate } = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("BARBER_ACTIVATE_RESPONSE_MALFORMED");
  const keys = Object.keys(response).sort();
  if (keys.join(",") !== "barberId,duplicate") throw new Error("BARBER_ACTIVATE_RESPONSE_SHAPE_INVALID");
  if (response.barberId !== barberId || response.duplicate !== duplicate) throw new Error("BARBER_ACTIVATE_RESPONSE_INVALID");
  return true;
}

function decodeFirestoreValue(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(decodeFirestoreValue);
  if (Object.hasOwn(value, "mapValue")) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([key, item]) => [key, decodeFirestoreValue(item)]));
  return null;
}

function fields(document) {
  return Object.fromEntries(Object.entries(document?.fields || {}).map(([key, value]) => [key, decodeFirestoreValue(value)]));
}

function documentId(document) {
  return String(document?.name || "").split("/").pop() || "";
}

function isDedicatedBarberFixture(value = {}) {
  return value.test_fixture === true
    || value.dedicated === true
    || value.fixture_purpose === FIXTURE_PURPOSE
    || value.purpose === FIXTURE_PURPOSE
    || String(value.descricao || "").includes(FIXTURE_PURPOSE)
    || String(value.nome || "").includes(FIXTURE_PURPOSE);
}

function semanticBarberProjection(legacy, v2) {
  const keys = ["nome", "foto", "especialidade", "descricao", "uid_usuario", "email_acesso", "ativo"];
  return keys.every((key) => (legacy?.[key] ?? null) === (v2?.[key] ?? null));
}

export function classifyBarberFixture({ id, legacy, v2, member } = {}) {
  const legacyPresent = Boolean(legacy);
  const v2Present = Boolean(v2);
  const linkedUid = String(legacy?.uid_usuario || v2?.uid_usuario || "");
  const membershipConsistent = !linkedUid || (member && member.ativo === legacy?.ativo && member.barbeiro_id === id);
  const ownership = id === FIXTURE_ID && legacyPresent && v2Present && isDedicatedBarberFixture(legacy) && isDedicatedBarberFixture(v2);
  const equivalent = legacyPresent && v2Present && semanticBarberProjection(legacy, v2);
  return {
    id: safeIdMeta(id),
    ownershipProven: ownership && equivalent,
    legacyPresent,
    v2Present,
    legacyV2Equivalent: equivalent,
    membershipPresent: Boolean(member),
    membershipApplicable: Boolean(linkedUid),
    membershipConsistent: Boolean(membershipConsistent),
    active: legacyPresent ? Boolean(legacy.ativo) : null,
    fixtureState: !legacyPresent && !v2Present ? "ABSENT" : (ownership && equivalent && membershipConsistent ? "COMPATIBLE" : "INCOMPATIBLE"),
    differingFields: equivalent ? [] : ["barber_projection"],
    missingFields: !legacyPresent || !v2Present ? [!legacyPresent ? "legacy" : "v2"] : [],
  };
}

async function requestJson(url, init = {}) {
  networkAccessed = true;
  hmlAccessed = true;
  const response = await fetch(url, init);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(`AUDIT_HTTP_${response.status}`);
    error.httpStatus = response.status;
    throw error;
  }
  return body;
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

export async function callOperational(command, data, requestId, token, request = fetch) {
  if (![SAVE_COMMAND, COMMAND, REMOVE_COMMAND].includes(command)) throw new Error("BARBER_COMMAND_NOT_ALLOWED");
  if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
  networkAccessed = true;
  hmlAccessed = true;
  const response = await request(CALLABLE, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildAdminCallableEnvelope(command, data, requestId)),
  });
  const body = await readResponseJson(response);
  if (!response.ok || body?.error) {
    const error = new Error(String(body?.error?.message || `callable HTTP ${response.status}`).slice(0, 180));
    error.httpStatus = response.status;
    error.code = String(body?.error?.status || "");
    throw error;
  }
  const result = body?.result ?? body?.data;
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("INVALID_CALLABLE_RESPONSE");
  return result;
}

function assertCommandResponse(response, expectedKeys, label) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error(`${label}_RESPONSE_MALFORMED`);
  const actual = Object.keys(response).sort().join(",");
  if (actual !== [...expectedKeys].sort().join(",")) throw new Error(`${label}_RESPONSE_SHAPE_INVALID`);
  return true;
}

function assertFixtureSaveResponse(response) {
  assertCommandResponse(response, ["barberId", "created", "duplicate"], "BARBER_SAVE");
  if (response.barberId !== FIXTURE_ID || response.created !== true || response.duplicate !== false) throw new Error("BARBER_SAVE_RESPONSE_INVALID");
}

function assertFixtureRemoveResponse(response) {
  assertCommandResponse(response, ["barberId", "duplicate", "removed"], "BARBER_REMOVE");
  if (response.barberId !== FIXTURE_ID || response.removed !== true || response.duplicate !== false) throw new Error("BARBER_REMOVE_RESPONSE_INVALID");
}

export async function listCollection(path, token, request = requestJson) {
  return (await request(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}?pageSize=1000`, {
    headers: { Authorization: `Bearer ${token}` },
  })).documents || [];
}

export async function getDocument(path, token, request = requestJson) {
  try {
    return await request(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (error) {
    if (error.httpStatus === 404) return null;
    throw error;
  }
}

export async function findDedicatedBarberFixture({ token, list = listCollection, get = getDocument } = {}) {
  const [legacyDocuments, v2Documents] = await Promise.all([
    list(LEGACY_COLLECTION, token),
    list(V2_COLLECTION, token),
  ]);
  const legacyById = new Map(legacyDocuments.map((doc) => [documentId(doc), fields(doc)]));
  const v2ById = new Map(v2Documents.map((doc) => [documentId(doc), fields(doc)]));
  const ids = [...new Set([...legacyById.keys(), ...v2ById.keys()])];
  const candidates = [];
  for (const id of ids) {
    const legacy = legacyById.get(id);
    const v2 = v2ById.get(id);
    if (!isDedicatedBarberFixture(legacy) && !isDedicatedBarberFixture(v2)) continue;
    const uid = String(legacy?.uid_usuario || v2?.uid_usuario || "");
    const member = uid ? fields(await get(`${RELATED_MEMBER_PREFIX}${encodeURIComponent(uid)}`, token)) : null;
    candidates.push(classifyBarberFixture({ id, legacy, v2, member }));
  }
  return {
    candidates,
    uniqueCandidate: candidates.length === 1,
    ownershipProven: candidates.length === 1 && candidates[0].ownershipProven,
  };
}

function promptLine(label) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => { rl.close(); resolve(answer); });
    rl.on("SIGINT", () => { rl.close(); reject(new Error("AUTH_INTERACTIVE_ABORTED")); });
  });
}

function promptHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") return promptLine(label);
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003") { process.stdin.setRawMode(false); process.stdin.off("data", onData); reject(new Error("AUTH_INTERACTIVE_ABORTED")); return; }
        if (char === "\r" || char === "\n") { process.stdin.setRawMode(false); process.stdin.off("data", onData); process.stdout.write("\n"); resolve(chunks.join("")); return; }
        if (char === "\u007f") chunks.pop(); else chunks.push(char);
      }
    };
    process.stdout.write(label); process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

async function authenticateAdmin() {
  const email = await promptLine("ADMIN HML e-mail: ");
  let password = await promptHidden("ADMIN HML senha: ");
  try {
    const session = await authenticateInteractive({ label: "ADMIN HML", email, password });
    validateIdToken(session.idToken, session.localId, PROJECT);
    return { token: session.idToken, uid: session.localId };
  } finally {
    password = "";
  }
}

export function simulateActivationJourney({ initialActive = false, failAt = "" } = {}) {
  const state = { legacy: { ativo: initialActive }, v2: { ativo: initialActive }, member: { ativo: initialActive }, audit: new Map() };
  const snapshot = structuredClone(state);
  const call = (ativo, requestId) => {
    if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
    if (state.audit.has(requestId)) return { duplicate: true, ...structuredClone(state.audit.get(requestId)) };
    if (failAt === "before-write") throw new Error("INJECTED_BEFORE_WRITE");
    state.legacy.ativo = ativo;
    if (failAt === "legacy") throw new Error("INJECTED_LEGACY");
    state.v2.ativo = ativo;
    if (failAt === "v2") throw new Error("INJECTED_V2");
    state.member.ativo = ativo;
    const result = { barberId: "fixture", duplicate: false };
    state.audit.set(requestId, { barberId: "fixture" });
    return result;
  };
  const rollbackOnFailure = (fn) => {
    try { return fn(); } catch (error) { Object.assign(state, structuredClone(snapshot)); throw error; }
  };
  const first = rollbackOnFailure(() => call(!initialActive, "hml-barber-activate-first"));
  const replay = call(!initialActive, "hml-barber-activate-first");
  const restore = rollbackOnFailure(() => call(initialActive, "hml-barber-activate-restore"));
  return { first, replay, restore, finalEqualsInitial: JSON.stringify(state) === JSON.stringify(snapshot), state };
}

export function simulateDedicatedFixtureJourney({ failAt = "" } = {}) {
  const savePayload = buildFixtureSavePayload();
  const removePayload = buildFixtureRemovePayload();
  const state = {
    exists: false,
    legacy: null,
    v2: null,
    member: null,
    audit: new Map(),
  };
  const save = (requestId) => {
    if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
    if (state.audit.has(requestId)) return { duplicate: true, ...structuredClone(state.audit.get(requestId)) };
    if (failAt === "save") throw new Error("INJECTED_SAVE");
    state.exists = true;
    state.legacy = { ...savePayload };
    if (failAt === "save-legacy") throw new Error("INJECTED_SAVE_LEGACY");
    state.v2 = { ...savePayload };
    state.audit.set(requestId, { barberId: FIXTURE_ID, created: true });
    return { barberId: FIXTURE_ID, created: true, duplicate: false };
  };
  const activate = (ativo, requestId) => {
    if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
    if (state.audit.has(requestId)) return { duplicate: true, ...structuredClone(state.audit.get(requestId)) };
    if (!state.exists) throw new Error("FIXTURE_NOT_PROVISIONED");
    state.legacy.ativo = ativo;
    if (failAt === "activate-legacy") throw new Error("INJECTED_ACTIVATE_LEGACY");
    state.v2.ativo = ativo;
    state.audit.set(requestId, { barberId: FIXTURE_ID });
    return { barberId: FIXTURE_ID, duplicate: false };
  };
  const remove = (requestId) => {
    if (!isValidRequestId(requestId)) throw new Error("REQUEST_ID_INVALID");
    if (state.audit.has(requestId)) return { duplicate: true, ...structuredClone(state.audit.get(requestId)) };
    if (!state.exists) return { barberId: FIXTURE_ID, removed: false, duplicate: false };
    if (failAt === "remove") throw new Error("INJECTED_REMOVE");
    state.exists = false;
    state.legacy = null;
    state.v2 = null;
    state.member = null;
    state.audit.set(requestId, { barberId: FIXTURE_ID, removed: true });
    return { barberId: FIXTURE_ID, removed: true, duplicate: false };
  };
  const saveResult = save("hml-barber-fixture-save");
  const activation = simulateActivationJourney({ initialActive: false, failAt: "" });
  const removeResult = remove("hml-barber-fixture-remove");
  return { savePayload, removePayload, saveResult, activation, removeResult, finalState: state };
}

export async function runReadOnlyPreflight({ project, authAdmin = "interactive", adminSession, find = findDedicatedBarberFixture } = {}) {
  productionGuard(project);
  if (authAdmin !== "interactive") throw new Error("ADMIN_INTERACTIVE_AUTH_REQUIRED");
  const session = adminSession || await authenticateAdmin();
  const result = await find({ token: session.token });
  return {
    PROJECT: project,
    COMMAND,
    ACTOR: "ADMIN",
    READ_ONLY: "SIM",
    CANDIDATES_FOUND: result.candidates.length,
    UNIQUE_CANDIDATE: result.uniqueCandidate ? "SIM" : "NÃO",
    FIXTURE_OWNERSHIP_PROVEN: result.ownershipProven ? "SIM" : "NÃO",
    CANDIDATES: result.candidates,
    MUTATION_MODE: "DISABLED",
    NETWORK_ACCESSED: networkAccessed ? "SIM" : "NÃO",
    HML_ACCESSED: hmlAccessed ? "SIM" : "NÃO",
    PRODUCTION_ACCESSED: "NÃO",
  };
}

function safeStage(stage, command, actor, requestId, response, assertionPass) {
  return {
    STAGE: stage,
    COMMAND: command,
    ACTOR: actor,
    CALLABLE_SENT: true,
    RESPONSE_RECEIVED: Boolean(response),
    RESPONSE_KEYS: response && typeof response === "object" ? Object.keys(response).sort() : [],
    ASSERTION_PASS: assertionPass,
    REQUEST_ID_PRESENT: Boolean(requestId),
    REQUEST_ID_LENGTH: String(requestId || "").length,
    REQUEST_ID_FINGERPRINT: requestId ? fingerprint(requestId) : "",
  };
}

function compatibleFixture(result) {
  return result?.candidates?.length === 1 && result.candidates[0].ownershipProven && result.candidates[0].fixtureState === "COMPATIBLE";
}

export async function runBarberActivateRemote({
  project,
  adminAuth = "interactive",
  confirmHmlWrite = false,
  adminSession,
  find = findDedicatedBarberFixture,
  call = callOperational,
} = {}) {
  guardBarberActivateOptions({ project, adminAuth, barberActivateSafe: true, confirmHmlWrite });
  const session = adminSession || await authenticateAdmin();
  const stages = [];
  const state = { created: false, active: false, ownershipProven: false, cleanupAttempted: false };
  let primaryError;
  let cleanupError;
  let preflight = await find({ token: session.token });
  if (preflight.candidates.length > 1 || (preflight.candidates.length === 1 && !compatibleFixture(preflight))) {
    throw new Error("EXISTING_INCOMPATIBLE_FIXTURE");
  }
  try {
    if (preflight.candidates.length === 0) {
      const requestId = newRequestId("hml-barber-fixture-save");
      const response = await call(SAVE_COMMAND, buildFixtureSavePayload(), requestId, session.token);
      stages.push(safeStage("FIXTURE_CREATE", SAVE_COMMAND, "ADMIN", requestId, response, true));
      assertFixtureSaveResponse(response);
      state.created = true;
      preflight = await find({ token: session.token });
    }
    if (!compatibleFixture(preflight)) throw new Error("FIXTURE_OWNERSHIP_NOT_PROVEN");
    state.ownershipProven = true;
    const initialActive = Boolean(preflight.candidates[0].active);
    if (initialActive !== false) throw new Error("FIXTURE_INITIAL_STATE_INVALID");
    const activateRequestId = newRequestId("hml-barber-fixture-activate");
    const first = await call(COMMAND, { id: FIXTURE_ID, ativo: true }, activateRequestId, session.token);
    stages.push(safeStage("ACTIVATE_FIRST", COMMAND, "ADMIN", activateRequestId, first, true));
    assertActivateResponse(first, { barberId: FIXTURE_ID, duplicate: false });
    state.active = true;
    const afterActivate = await find({ token: session.token });
    if (!compatibleFixture(afterActivate) || afterActivate.candidates[0].active !== true) throw new Error("ACTIVATE_AUDIT_FAILED");
    const replay = await call(COMMAND, { id: FIXTURE_ID, ativo: true }, activateRequestId, session.token);
    stages.push(safeStage("ACTIVATE_REPLAY", COMMAND, "ADMIN", activateRequestId, replay, true));
    assertActivateResponse(replay, { barberId: FIXTURE_ID, duplicate: true });
    const restoreRequestId = newRequestId("hml-barber-fixture-restore");
    const restore = await call(COMMAND, { id: FIXTURE_ID, ativo: false }, restoreRequestId, session.token);
    stages.push(safeStage("RESTORE", COMMAND, "ADMIN", restoreRequestId, restore, true));
    assertActivateResponse(restore, { barberId: FIXTURE_ID, duplicate: false });
    state.active = false;
    const afterRestore = await find({ token: session.token });
    if (!compatibleFixture(afterRestore) || afterRestore.candidates[0].active !== false) throw new Error("RESTORE_AUDIT_FAILED");
    const removeRequestId = newRequestId("hml-barber-fixture-remove");
    if (state.created) {
      const removed = await call(REMOVE_COMMAND, buildFixtureRemovePayload(), removeRequestId, session.token);
      stages.push(safeStage("CLEANUP", REMOVE_COMMAND, "ADMIN", removeRequestId, removed, true));
      assertFixtureRemoveResponse(removed);
      state.cleanupAttempted = true;
      state.created = false;
    }
    const finalAudit = await find({ token: session.token });
    if (state.cleanupAttempted && finalAudit.candidates.length !== 0) throw new Error("ZERO_RESIDUE_FAILED");
    if (!state.cleanupAttempted && !compatibleFixture(finalAudit)) throw new Error("REUSED_FIXTURE_AUDIT_FAILED");
    return { FINAL_RESULT: "PASS", STAGES: stages, ZERO_RESIDUE: "PASS", PARTIAL_WRITE: "NÃO", NETWORK_ACCESSED: "SIM", HML_ACCESSED: "SIM", PRODUCTION_ACCESSED: "NÃO" };
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    if (primaryError && state.ownershipProven && (state.active || state.created)) {
      try {
        if (state.active) {
          const restoreRequestId = newRequestId("hml-barber-fixture-restore");
          const restore = await call(COMMAND, { id: FIXTURE_ID, ativo: false }, restoreRequestId, session.token);
          assertActivateResponse(restore, { barberId: FIXTURE_ID, duplicate: false });
          state.active = false;
        }
        if (state.created) {
          const removeRequestId = newRequestId("hml-barber-fixture-remove");
          const removed = await call(REMOVE_COMMAND, buildFixtureRemovePayload(), removeRequestId, session.token);
          assertFixtureRemoveResponse(removed);
          state.cleanupAttempted = true;
          state.created = false;
        }
      } catch (error) {
        cleanupError = error;
      }
    }
    if (primaryError && cleanupError) {
      primaryError.cleanupError = String(cleanupError.message || "").slice(0, 180);
    }
  }
}

export function runSelfTest() {
  productionGuard(PROJECT);
  if (!isValidRequestId("hml-barber-activate-1234567890")) throw new Error("request ID contract failed");
  if (isValidRequestId("bad:id")) throw new Error("invalid request ID accepted");
  const envelope = buildCallableEnvelope("barber-fixture", true, "hml-barber-activate-1234567890");
  if (envelope.data.command !== COMMAND || envelope.data.data.id !== "barber-fixture" || envelope.data.data.ativo !== true) throw new Error("wire shape failed");
  assertActivateResponse({ duplicate: false, barberId: "barber-fixture" }, { barberId: "barber-fixture", duplicate: false });
  assertActivateResponse({ duplicate: true, barberId: "barber-fixture" }, { barberId: "barber-fixture", duplicate: true });
  const fixture = { nome: FIXTURE_ID, descricao: `Dedicated test fixture: ${FIXTURE_PURPOSE}`, ativo: false };
  const classification = classifyBarberFixture({ id: FIXTURE_ID, legacy: fixture, v2: { ...fixture }, member: null });
  if (!classification.ownershipProven || classification.fixtureState !== "COMPATIBLE") throw new Error("fixture ownership classifier failed");
  if (classifyBarberFixture({ id: FIXTURE_ID, legacy: { ...fixture, ativo: true }, v2: { ...fixture, ativo: true }, member: null }).fixtureState !== "COMPATIBLE") throw new Error("membership-free fixture classification failed");
  if (classifyBarberFixture({ id: "barber-x", legacy: fixture, v2: fixture, member: null }).ownershipProven) throw new Error("deterministic fixture ID guard failed");
  const saveEnvelope = buildAdminCallableEnvelope(SAVE_COMMAND, buildFixtureSavePayload(), "hml-barber-fixture-save");
  const removeEnvelope = buildAdminCallableEnvelope(REMOVE_COMMAND, buildFixtureRemovePayload(), "hml-barber-fixture-remove");
  if (saveEnvelope.data.data.id !== FIXTURE_ID || removeEnvelope.data.data.id !== FIXTURE_ID) throw new Error("fixture provision wire shape failed");
  const fixtureJourney = simulateDedicatedFixtureJourney();
  if (!fixtureJourney.saveResult.created || !fixtureJourney.removeResult.removed || fixtureJourney.finalState.exists) throw new Error("fixture lifecycle failed");
  const journey = simulateActivationJourney();
  if (journey.first.duplicate || !journey.replay.duplicate || !journey.finalEqualsInitial) throw new Error("activation journey failed");
  for (const failAt of ["before-write", "legacy", "v2"]) {
    try { simulateActivationJourney({ failAt }); throw new Error("failure injection not raised"); } catch (error) { if (!String(error.message).startsWith("INJECTED_")) throw error; }
  }
  return { command: COMMAND, wireShape: "PASS", ownership: "PASS", idempotency: "PASS", restore: "PASS", failureInjection: "PASS", mutationMode: "DISABLED", networkAccessed: "NÃO" };
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.selfTest) return console.log(JSON.stringify(runSelfTest()));
  if (options.barberActivateSafe) {
    const report = await runBarberActivateRemote({ project: options.project, adminAuth: options.adminAuth, confirmHmlWrite: options.confirmHmlWrite });
    return console.log(JSON.stringify(report, null, 2));
  }
  guardReadOnlyOptions(options);
  const report = await runReadOnlyPreflight({ project: options.project, authAdmin: options.adminAuth });
  console.log(JSON.stringify(report, null, 2));
}

if (process.argv[1]?.toLowerCase().endsWith("hml-barber-activate-test.mjs")) {
  main().catch((error) => {
    console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: String(error.message || "").slice(0, 180), NETWORK_ACCESSED: networkAccessed ? "SIM" : "NÃO", HML_ACCESSED: hmlAccessed ? "SIM" : "NÃO", PRODUCTION_ACCESSED: "NÃO" }));
    process.exitCode = 1;
  });
}
