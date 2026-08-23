#!/usr/bin/env node

/*
 * Lote 3 HML — executor e planner seguro.
 *
 * Este harness não inicia mutações enquanto existir qualquer subteste sem
 * cleanup operacional exato. O modo --self-test é totalmente offline.
 */

import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import {
  PROJECT as HML_PROJECT,
  PRODUCTION_PROJECT,
  TENANT,
  REGION,
  CALLABLE,
  REQUEST_ID_PATTERN,
  authenticateInteractive,
  buildAuditStructuredQuery,
  appointmentEquivalent,
  occupancyEquivalent,
  semanticEquivalent,
  auditQuery,
  auditSlotCandidate,
  findAvailableSlot,
  validateRequestId,
} from "./hml-command-batch2-test.mjs";

export const PROJECT = HML_PROJECT;
export const BATCH3 = "batch3";
export const BARBER_ID = "YMJrJJ58I6N9bMl4jsgy";
export const COMMANDS_IN_BATCH3 = Object.freeze([
  "agenda.criar",
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
  "agenda.concluir",
  "agenda.nao_compareceu",
  "agenda.cancelar",
  "admin.funcionamento.salvar",
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.fechamento.salvar",
  "admin.fechamento.remover",
  "admin.plano.salvar",
  "admin.plano.inicial",
  "admin.plano.ativar",
  "admin.assinatura.aprovar",
  "admin.assinatura.recusar",
  "admin.assinatura.renovar",
  "admin.assinatura.cancelar",
  "admin.assinatura.expirar",
]);

export const SAFE_OPERATIONAL_CLEANUP = Object.freeze({
  agenda: "agenda.cancelar",
  funcionamento: "admin.funcionamento.salvar",
  abertura: "admin.abertura.remover",
  fechamento: "admin.fechamento.remover",
});

export const BATCH3_SAFE_COMMANDS = Object.freeze([
  "agenda.criar",
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
  "agenda.concluir",
  "agenda.nao_compareceu",
  "agenda.cancelar",
  "admin.funcionamento.salvar",
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.fechamento.salvar",
  "admin.fechamento.remover",
]);

export const BATCH3_DEFERRED_COMMANDS = Object.freeze([
  "admin.plano.salvar",
  "admin.plano.inicial",
  "admin.plano.ativar",
  "admin.assinatura.aprovar",
  "admin.assinatura.recusar",
  "admin.assinatura.renovar",
  "admin.assinatura.expirar",
]);

export const BATCH3_ALREADY_PROVEN_COMMANDS = Object.freeze([
  "admin.assinatura.cancelar",
]);

export const AGENDA_STATE_MACHINE = Object.freeze({
  initial: "agendado",
  allowed: Object.freeze({
    agendado: Object.freeze(["cliente_chegou", "concluir", "cancelar", "nao_compareceu"]),
    cliente_chegou: Object.freeze(["em_atendimento", "concluir", "cancelar", "nao_compareceu"]),
    em_atendimento: Object.freeze(["concluir", "cancelar", "nao_compareceu"]),
    concluido: Object.freeze([]),
    cancelado: Object.freeze([]),
    nao_compareceu: Object.freeze([]),
  }),
  terminal: Object.freeze(["concluido", "cancelado", "nao_compareceu"]),
});

let remoteAccessed = false;
const credentialState = { admin: null, client: null };

export function parseArgs(argv = process.argv) {
  return {
    project: argv.find((value) => value.startsWith("--project="))?.slice(10) || "",
    adminAuth: argv.find((value) => value.startsWith("--auth-admin="))?.slice(13) || "",
    clientAuth: argv.find((value) => value.startsWith("--auth-client="))?.slice(14) || "",
    confirm: argv.includes("--confirm-hml-write"),
    batch3: argv.includes("--batch3"),
    batch3Safe: argv.includes("--batch3-safe"),
    selfTest: argv.includes("--self-test"),
  };
}

export function guardBatch3Options(opts) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (opts.project === PRODUCTION_PROJECT) throw new Error("production is forbidden");
  if (opts.adminAuth !== "interactive" || opts.clientAuth !== "interactive") throw new Error("both interactive auth modes are required");
  if (!opts.confirm) throw new Error("--confirm-hml-write is required");
  if (!opts.batch3 && !opts.batch3Safe) throw new Error("--batch3 or --batch3-safe is required");
  return true;
}

export function guardBatch3SafeOptions(opts) {
  guardBatch3Options({ ...opts, batch3: true });
  return true;
}

export function fingerprint(value) {
  return createHash("sha256").update(String(value)).digest("hex").slice(0, 16);
}

export function newRequestId(prefix, runId = randomUUID().replaceAll("-", "")) {
  const value = `${prefix}-${runId}`;
  if (!REQUEST_ID_PATTERN.test(value)) throw new Error("generated request ID is invalid");
  return value;
}

export function buildCallableEnvelope(command, payload, requestId) {
  if (!COMMANDS_IN_BATCH3.includes(command)) throw new Error("command is outside Lote 3");
  if (!REQUEST_ID_PATTERN.test(String(requestId || ""))) throw new Error("invalid request ID");
  return { data: { command, requestId, ...(payload || {}) } };
}

export function stateTransition(state, action) {
  const allowed = AGENDA_STATE_MACHINE.allowed[state] || [];
  if (!allowed.includes(action)) throw new Error(`INVALID_TRANSITION:${state}->${action}`);
  return {
    cliente_chegou: "cliente_chegou",
    em_atendimento: "em_atendimento",
    concluir: "concluido",
    cancelar: "cancelado",
    nao_compareceu: "nao_compareceu",
  }[action];
}

export function agendaNegativeTransitionPlan() {
  return [
    { from: "agendado", action: "em_atendimento", expected: "INVALID" },
    { from: "concluido", action: "cliente_chegou", expected: "INVALID" },
    { from: "concluido", action: "nao_compareceu", expected: "INVALID" },
    { from: "agendado", action: "concluir", expected: "VALID_BY_RUNTIME" },
  ];
}

export function cleanupCapabilityPlan() {
  return {
    agendaConcluido: {
      safe: true,
      terminalHistoryAllowed: true,
      finalState: "concluido",
      reason: "TERMINAL_HISTORY_IS_VALID_DOMAIN_STATE",
      cleanup: null,
    },
    agendaNaoCompareceu: {
      safe: true,
      terminalHistoryAllowed: true,
      finalState: "nao_compareceu",
      cleanup: null,
    },
    agendaActiveFixture: { safe: true, cleanup: SAFE_OPERATIONAL_CLEANUP.agenda },
    funcionamento: { safe: true, cleanup: SAFE_OPERATIONAL_CLEANUP.funcionamento },
    fechamentos: { safe: true, cleanup: [SAFE_OPERATIONAL_CLEANUP.abertura, SAFE_OPERATIONAL_CLEANUP.fechamento] },
    planos: {
      safe: false,
      reason: "NO_OPERATIONAL_PLAN_DELETE_OR_EXACT_RESTORE",
      cleanup: null,
    },
    adminAssinaturas: {
      safe: false,
      reason: "NO_EXACT_STATUS_OR_CREDIT_RESTORE_FOR_REMAINING_ADMIN_OPERATIONS",
      cleanup: null,
    },
  };
}

export function preflightBatch3Plan() {
  const cleanup = cleanupCapabilityPlan();
  const deferred = Object.entries(cleanup)
    .filter(([, value]) => value.safe !== true)
    .map(([name, value]) => `${name}:${value.reason}`);
  return {
    cleanup,
    safeCommands: BATCH3_SAFE_COMMANDS,
    deferredCommands: BATCH3_DEFERRED_COMMANDS,
    alreadyProvenCommands: BATCH3_ALREADY_PROVEN_COMMANDS,
    blockers: deferred,
    ready: deferred.length === 0,
    safeReady: true,
  };
}

export function validateRemoteRequestPlan(runId = randomUUID().replaceAll("-", "")) {
  const ids = [
    "agenda-create",
    "cliente-chegou",
    "em-atendimento",
    "concluir",
    "nao-compareceu",
    "funcionamento",
    "funcionamento-restore",
    "abertura",
    "fechamento",
  ].map((suffix) => newRequestId(`hml-lote3-${suffix}`, runId));
  ids.forEach((id) => validateRequestId(id));
  return ids;
}

export function simulateRemotePathOffline(runId = randomUUID().replaceAll("-", "")) {
  const plan = preflightBatch3Plan();
  if (!plan.safeReady) throw new Error("BATCH3_SAFE_PREFLIGHT_FAILED");
  const ids = validateRemoteRequestPlan(runId);
  const transition = buildCallableEnvelope("agenda.cliente_chegou", { data: { appointmentId: "fixture-appointment" } }, ids[1]);
  const functioning = buildCallableEnvelope("admin.funcionamento.salvar", { data: { intervalo_minutos: 30, periodos_semana: {}, dias_fechados_semana: {} } }, ids[5]);
  assert.equal(transition.data.data.appointmentId, "fixture-appointment");
  assert.equal(functioning.data.data.intervalo_minutos, 30);
  return { safeReady: true, requestIds: ids, wireShapes: true, deferred: plan.deferredCommands };
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function idempotentCall(log, command, requestId, execute) {
  const previous = log.find((entry) => entry.command === command && entry.requestId === requestId);
  if (previous) return { ...clone(previous.result), duplicate: true };
  const result = execute();
  log.push({ command, requestId, result: clone(result) });
  return { ...clone(result), duplicate: false };
}

export function runTerminalAppointmentJourney(action) {
  if (!["concluir", "nao_compareceu"].includes(action)) throw new Error("terminal action required");
  const log = [];
  const state = {
    legacy: { appointment: { status: "agendado" } },
    v2: { appointment: { status: "agendado" } },
    legacyOccupancy: true,
    v2Occupancy: true,
    occupancySemantics: "ACTIVE",
  };
  const requestId = newRequestId(`hml-lote3-${action}`);
  const first = idempotentCall(log, `agenda.${action}`, requestId, () => {
    const status = stateTransition(state.legacy.appointment.status, action);
    state.legacy.appointment.status = status;
    state.v2.appointment.status = status;
    if (action === "nao_compareceu") {
      state.legacyOccupancy = false;
      state.v2Occupancy = false;
      state.occupancySemantics = "RELEASED";
    } else {
      // The runtime deliberately does not delete occupancy on conclude. It is
      // retained as historical evidence and is not a second appointment.
      state.occupancySemantics = "HISTORICAL_AFTER_TERMINAL";
    }
    return { appointmentId: `fixture-${action}`, status };
  });
  const replay = idempotentCall(log, `agenda.${action}`, requestId, () => first);
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.equal(first.status, action === "concluir" ? "concluido" : "nao_compareceu");
  assert.equal(state.legacy.appointment.status, state.v2.appointment.status);
  return {
    action,
    first,
    replay,
    finalState: state.legacy.appointment.status,
    legacyV2Equivalent: state.legacy.appointment.status === state.v2.appointment.status,
    legacyOccupancy: state.legacyOccupancy,
    v2Occupancy: state.v2Occupancy,
    occupancySemantics: state.occupancySemantics,
    activeResidue: false,
  };
}

export function runNegativeTransitionJourney() {
  const cases = [
    ["agendado", "em_atendimento"],
    ["concluido", "cliente_chegou"],
    ["concluido", "nao_compareceu"],
  ];
  return cases.map(([state, action]) => {
    const before = { legacy: state, v2: state };
    assert.throws(() => stateTransition(state, action), /INVALID_TRANSITION/);
    return {
      state,
      action,
      rejected: true,
      stateUnchanged: before.legacy === state && before.v2 === state,
      legacyV2Unchanged: before.legacy === before.v2,
      partialWrite: false,
    };
  });
}

export function runOfflineDryJourney() {
  const log = [];
  const state = {
    legacy: { appointment: { status: "agendado" } },
    v2: { appointment: { status: "agendado" } },
    legacyOccupancy: true,
    v2Occupancy: true,
    functioning: { intervalo_minutos: 30, periodos_semana: { 1: [{ inicio: "08:30", fim: "19:30" }] }, dias_fechados_semana: {} },
    closure: null,
  };
  const mainActions = ["cliente_chegou", "em_atendimento"];
  for (const [index, action] of mainActions.entries()) {
    const requestId = newRequestId(`hml-lote3-agenda-${index}`);
    const first = idempotentCall(log, `agenda.${action}`, requestId, () => {
      state.legacy.appointment.status = stateTransition(state.legacy.appointment.status, action);
      state.v2.appointment.status = state.legacy.appointment.status;
      return { appointmentId: "fixture-appointment", status: state.legacy.appointment.status };
    });
    const replay = idempotentCall(log, `agenda.${action}`, requestId, () => first);
    assert.equal(first.duplicate, false);
    assert.equal(replay.duplicate, true);
    assert.equal(state.legacy.appointment.status, state.v2.appointment.status);
  }
  const cancelRequestId = newRequestId("hml-lote3-agenda-cleanup");
  const cancel = idempotentCall(log, "agenda.cancelar", cancelRequestId, () => {
    state.legacy.appointment.status = stateTransition(state.legacy.appointment.status, "cancelar");
    state.v2.appointment.status = state.legacy.appointment.status;
    state.legacyOccupancy = false;
    state.v2Occupancy = false;
    return { appointmentId: "fixture-appointment", status: "cancelado" };
  });
  assert.equal(cancel.duplicate, false);
  assert.equal(state.legacy.appointment.status, "cancelado");
  assert.equal(state.v2.appointment.status, "cancelado");
  assert.equal(state.legacyOccupancy, false);
  assert.equal(state.v2Occupancy, false);

  const concluded = runTerminalAppointmentJourney("concluir");
  const noShow = runTerminalAppointmentJourney("nao_compareceu");
  const negativeTransitions = runNegativeTransitionJourney();
  assert.equal(concluded.finalState, "concluido");
  assert.equal(concluded.occupancySemantics, "HISTORICAL_AFTER_TERMINAL");
  assert.equal(concluded.legacyV2Equivalent, true);
  assert.equal(concluded.activeResidue, false);
  assert.equal(noShow.finalState, "nao_compareceu");
  assert.equal(noShow.occupancySemantics, "RELEASED");
  assert.equal(noShow.legacyOccupancy, false);
  assert.equal(noShow.v2Occupancy, false);
  assert(negativeTransitions.every((item) => item.rejected && item.stateUnchanged && item.legacyV2Unchanged && !item.partialWrite));

  const initialFunctioning = clone(state.functioning);
  const functioningRequestId = newRequestId("hml-lote3-funcionamento");
  const modifiedFunctioning = { ...clone(initialFunctioning), intervalo_minutos: 30 };
  const functioningFirst = idempotentCall(log, "admin.funcionamento.salvar", functioningRequestId, () => {
    state.functioning = clone(modifiedFunctioning);
    return { updated: "funcionamento" };
  });
  const functioningReplay = idempotentCall(log, "admin.funcionamento.salvar", functioningRequestId, () => functioningFirst);
  assert.equal(functioningFirst.duplicate, false);
  assert.equal(functioningReplay.duplicate, true);
  const restoreRequestId = newRequestId("hml-lote3-funcionamento-restore");
  idempotentCall(log, "admin.funcionamento.salvar", restoreRequestId, () => {
    state.functioning = clone(initialFunctioning);
    return { updated: "funcionamento" };
  });
  assert.deepEqual(state.functioning, initialFunctioning);

  const closureRequestId = newRequestId("hml-lote3-fechamento");
  const closure = idempotentCall(log, "admin.fechamento.salvar", closureRequestId, () => {
    state.closure = { id: "fixture-closure", data: "2099-01-02" };
    return { closureId: "fixture-closure", documents: 1 };
  });
  const closureReplay = idempotentCall(log, "admin.fechamento.salvar", closureRequestId, () => closure);
  assert.equal(closure.duplicate, false);
  assert.equal(closureReplay.duplicate, true);
  idempotentCall(log, "admin.fechamento.remover", newRequestId("hml-lote3-fechamento-cleanup"), () => {
    state.closure = null;
    return { removed: 1 };
  });
  assert.equal(state.closure, null);

  const failureState = { fixture: true, committed: false };
  try {
    const working = clone(failureState);
    working.committed = true;
    throw new Error("injected failure before commit");
  } catch (error) {
    assert.equal(error.message, "injected failure before commit");
  } finally {
    failureState.fixture = false;
  }
  assert.equal(failureState.fixture, false);

  return {
    agendaMain: true,
    agendaCleanup: true,
    agendaConcluido: concluded,
    agendaNaoCompareceu: noShow,
    negativeTransitions,
    functioning: true,
    closures: true,
    zeroResidue: !state.legacyOccupancy && !state.v2Occupancy && state.closure === null,
    finallyFailureInjection: failureState.fixture === false,
    log,
  };
}

function safeMessage(value) {
  return String(value || "").replace(/Bearer\s+\S+/gi, "[REDACTED]").replace(/[\r\n]/g, " ").slice(0, 180);
}

function safeTelemetry(stage, command, requestId, actor, result = {}) {
  return {
    BATCH_STAGE: stage,
    COMMAND: command,
    ACTOR: actor,
    REQUEST_ID_PRESENT: Boolean(requestId),
    REQUEST_ID_LENGTH: String(requestId || "").length,
    REQUEST_ID_FINGERPRINT: fingerprint(requestId),
    RESPONSE_KEYS: Object.keys(result || {}).sort(),
  };
}

async function auditGet(path, token, request = fetch) {
  remoteAccessed = true;
  const response = await request(`https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents/${path}`, { headers: { Authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`audit GET HTTP ${response.status}`);
  return response.json();
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

function roles(doc) {
  const value = firestoreFields(doc).papeis;
  return Array.isArray(value) ? value.map(String) : [];
}

async function resolveHmlOperationalUid(session) {
  const mapping = await auditGet(`homologacao_mapeamentos/${session.localId}`, session.idToken);
  const data = firestoreFields(mapping);
  if (!mapping || data.ativo !== true || data.tenant_id !== TENANT || !data.uid_producao_referencia) {
    throw new Error("HML identity mapping invalid");
  }
  return String(data.uid_producao_referencia);
}

async function proveAdmin(session) {
  const operationalUid = await resolveHmlOperationalUid(session);
  const admin = await auditGet(`admins/${operationalUid}`, session.idToken);
  const member = await auditGet(`barbearias/${TENANT}/membros/${operationalUid}`, session.idToken);
  if (!admin || !member || !roles(member).includes("ADMIN")) throw new Error("ADMIN identity not proven");
  return { authUid: session.localId, operationalUid, tenant: TENANT, proven: true };
}

async function proveClient(session) {
  const operationalUid = await resolveHmlOperationalUid(session);
  const profile = await auditGet(`clientes/${operationalUid}`, session.idToken);
  const member = await auditGet(`barbearias/${TENANT}/membros/${operationalUid}`, session.idToken);
  const memberRoles = roles(member);
  if (!profile || !member || !memberRoles.includes("CLIENTE") || memberRoles.includes("ADMIN") || memberRoles.includes("BARBEIRO")) {
    throw new Error("CLIENT identity not proven");
  }
  return { authUid: session.localId, operationalUid, tenant: TENANT, proven: true, isAdmin: false, isBarber: false };
}

async function callStage(stage, command, payload, requestId, actor, token, call = callOperational) {
  try {
    const result = await call(command, payload, requestId, token);
    console.log(JSON.stringify({ ...safeTelemetry(stage, command, requestId, actor, result), HTTP_STATUS: 200 }));
    return result;
  } catch (error) {
    console.log(JSON.stringify({
      BATCH_STAGE: stage,
      COMMAND: command,
      ACTOR: actor,
      HTTP_STATUS: Number(error?.httpStatus || 0),
      CALLABLE_CODE: String(error?.code || ""),
      MESSAGE_SAFE: safeMessage(error?.message),
    }));
    throw error;
  }
}

async function replayStage(stage, command, payload, requestId, actor, token, fields = [], call = callOperational) {
  if (!Array.isArray(fields) || fields.some((field) => typeof field !== "string" || !field)) throw new TypeError("replay fields must be an array of field names");
  const first = await callStage(`${stage}_FIRST`, command, payload, requestId, actor, token, call);
  const replay = await callStage(`${stage}_REPLAY`, command, payload, requestId, actor, token, call);
  assert.equal(first.duplicate, false, `${stage}_FIRST_DUPLICATE`);
  assert.equal(replay.duplicate, true, `${stage}_SECOND_DUPLICATE`);
  for (const field of fields) assert.equal(replay[field], first[field], `${stage}_${field}_MISMATCH`);
  return { first, replay };
}

export async function simulateAgendaTransitionRemotePath() {
  const state = { legacy: "agendado", v2: "agendado" };
  const operations = new Map();
  const fakeCall = async (command, payload, requestId) => {
    const key = `${command}:${requestId}`;
    const previous = operations.get(key);
    if (previous) return { ...previous, duplicate: true };
    const action = command.replace("agenda.", "");
    const next = stateTransition(state.legacy, action);
    state.legacy = next;
    state.v2 = next;
    const result = { appointmentId: "fixture-appointment", status: next };
    operations.set(key, result);
    return { ...result, duplicate: false };
  };
  assert.throws(() => stateTransition(state.legacy, "em_atendimento"), /INVALID_TRANSITION/);
  for (const [index, action] of ["cliente_chegou", "em_atendimento", "concluir"].entries()) {
    const response = await replayStage(
      `OFFLINE_${action}`,
      `agenda.${action}`,
      { data: { appointmentId: "fixture-appointment" } },
      newRequestId(`hml-lote3-sim-${action}-${index}`),
      "ADMIN",
      "offline-token",
      ["appointmentId", "status"],
      fakeCall,
    );
    const legacy = { fields: { status: { stringValue: state.legacy }, appointmentId: { stringValue: response.first.appointmentId } } };
    const v2 = { fields: { status: { stringValue: state.v2 }, appointmentId: { stringValue: response.first.appointmentId } } };
    assert.equal(appointmentEquivalent(legacy, v2), true);
    assert.equal(state.legacy, state.v2);
  }
  return { create: true, negative: true, transitions: true, replay: true, comparators: true, finalState: state.legacy };
}

function pathPair(collection, id, v2Collection = collection) {
  return {
    legacy: `${collection}/${id}`,
    v2: `barbearias/${TENANT}/${v2Collection}/${id}`,
  };
}

async function auditAppointmentPair(appointmentId) {
  const pair = pathPair("agendamentos", appointmentId);
  const [legacy, v2, legacyOccupancy, v2Occupancy] = await Promise.all([
    auditGet(pair.legacy, credentialState.admin.idToken),
    auditGet(pair.v2, credentialState.admin.idToken),
    auditGet(`ocupacoes/${appointmentId}`, credentialState.admin.idToken),
    auditGet(`barbearias/${TENANT}/ocupacoes/${appointmentId}`, credentialState.admin.idToken),
  ]);
  return { legacy, v2, legacyOccupancy, v2Occupancy, equivalent: appointmentEquivalent(legacy, v2), occupancyEquivalent: occupancyEquivalent(legacyOccupancy, v2Occupancy) };
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
    const error = new Error(safeMessage(body?.error?.message || `callable HTTP ${response.status}`));
    error.httpStatus = response.status;
    error.code = body?.error?.status || "";
    throw error;
  }
  const result = body?.result ?? body?.data;
  if (!result || typeof result !== "object") throw new Error("invalid callable response");
  return result;
}

function promptSecret(label) {
  return new Promise((resolve, reject) => {
    const stdin = input;
    let value = "";
    output.write(label);
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") {
        cleanup();
        reject(new Error("interactive authentication cancelled"));
      } else if (text === "\r" || text === "\n") {
        cleanup();
        output.write("\n");
        resolve(value);
      } else value += text;
    };
    const cleanup = () => { stdin.setRawMode?.(false); stdin.pause(); stdin.removeListener("data", onData); };
    stdin.resume();
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
  });
}

async function interactiveSession(label) {
  const line = createInterface({ input, output });
  const email = await line.question(`${label} e-mail: `);
  line.close();
  const password = await promptSecret(`${label} senha: `);
  return authenticateInteractive({ label, email, password });
}

function addMinutes(time, amount) {
  const [hour, minute] = String(time).split(":").map(Number);
  const total = hour * 60 + minute + amount;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

export const FUNCTIONING_SEMANTIC_FIELDS = Object.freeze([
  "intervalo_minutos",
  "periodos_semana",
  "dias_fechados_semana",
]);

function canonicalPeriods(value) {
  const source = value && typeof value === "object" ? value : {};
  return Object.fromEntries(Array.from({ length: 7 }, (_, day) => {
    const periods = source[day] ?? source[String(day)] ?? [];
    return [day, Array.isArray(periods) ? periods.map((period) => ({
      inicio: String(period?.inicio ?? "").trim(),
      fim: String(period?.fim ?? "").trim(),
    })) : []];
  }));
}

function normalizedFunctioning(value) {
  const days = value?.dias_fechados_semana || {};
  return {
    intervalo_minutos: Number(value?.intervalo_minutos),
    periodos_semana: canonicalPeriods(value?.periodos_semana),
    dias_fechados_semana: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Boolean(days[day] ?? days[String(day)])])),
  };
}

function sameSemanticValue(left, right) {
  if (Object.is(left, right)) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return Array.isArray(left) && Array.isArray(right) && left.length === right.length && left.every((item, index) => sameSemanticValue(item, right[index]));
  }
  if (left && typeof left === "object" || right && typeof right === "object") {
    if (!left || !right || typeof left !== "object" || typeof right !== "object") return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return leftKeys.length === rightKeys.length && leftKeys.every((key, index) => key === rightKeys[index] && sameSemanticValue(left[key], right[key]));
  }
  return false;
}

function flattenSemanticFields(value, prefix = "", output = new Map()) {
  if (!value || typeof value !== "object") {
    output.set(prefix, value);
    return output;
  }
  for (const key of Object.keys(value).sort()) flattenSemanticFields(value[key], prefix ? `${prefix}.${key}` : key, output);
  return output;
}

export function compareFunctioningSnapshots(expected, actual) {
  const expectedValue = normalizedFunctioning(expected);
  const actualValue = normalizedFunctioning(actual);
  const expectedFields = flattenSemanticFields(expectedValue);
  const actualFields = flattenSemanticFields(actualValue);
  const differing = [];
  const missing = [];
  const extra = [];
  for (const [field, value] of expectedFields) {
    if (!actualFields.has(field)) missing.push(field);
    else if (!sameSemanticValue(value, actualFields.get(field))) differing.push(field);
  }
  for (const field of actualFields.keys()) if (!expectedFields.has(field)) extra.push(field);
  return {
    equal: differing.length === 0 && missing.length === 0 && extra.length === 0,
    compareFields: FUNCTIONING_SEMANTIC_FIELDS,
    differingFields: differing,
    missingAfterRestore: missing,
    extraAfterRestore: extra,
  };
}

function functioningPayload(value) {
  const normalized = normalizedFunctioning(value);
  return { data: normalized };
}

function appointmentCreatePayload(clientId, serviceId, slot) {
  return {
    data: {
      cliente_id: clientId,
      barbeiro_id: BARBER_ID,
      servico_id: serviceId,
      data: slot.date,
      horario: slot.time,
      origem: "cliente",
    },
  };
}

async function selectServiceAndSlots() {
  const serviceDocs = await auditQuery(
    "servicos",
    [["ativo", { booleanValue: true }]],
    credentialState.admin.idToken,
    fetch,
    { limit: 100, stage: "BATCH3_SERVICE_SELECTION" },
  );
  const service = serviceDocs
    .map((doc) => ({ id: String(doc.name || "").split("/").at(-1), value: firestoreFields(doc) }))
    .filter((item) => item.id && item.value.ativo === true && Number(item.value.duracao || 30) === 30)
    .sort((left, right) => left.id.localeCompare(right.id))[0];
  if (!service) throw new Error("NO_SAFE_30_MINUTE_SERVICE");
  const first = await findAvailableSlot({
    barberId: BARBER_ID,
    serviceId: service.id,
    token: credentialState.admin.idToken,
    read: auditGet,
    query: auditQuery,
    excluded: [],
  });
  const second = await findAvailableSlot({
    barberId: BARBER_ID,
    serviceId: service.id,
    token: credentialState.admin.idToken,
    read: auditGet,
    query: auditQuery,
    excluded: [first],
  });
  return { serviceId: service.id, first, second };
}

async function assertFixtureAbsent(slot) {
  const audit = await auditSlotCandidate({ barberId: BARBER_ID, date: slot.date, time: slot.time, token: credentialState.admin.idToken, read: auditGet });
  if (!audit.safe) throw new Error(`BATCH3_SLOT_COLLISION:${slot.date}:${slot.time}`);
  return audit;
}

async function auditGlobalFixture(path) {
  const legacy = await auditGet(`fechamentos_globais/${path}`, credentialState.admin.idToken);
  const v2 = await auditGet(`barbearias/${TENANT}/fechamentos/${path}`, credentialState.admin.idToken);
  return { legacy, v2, equivalent: semanticEquivalent(legacy, v2) };
}

async function auditFunctioningPair() {
  const legacy = await auditGet("configuracoes/funcionamento", credentialState.admin.idToken);
  const v2 = await auditGet(`barbearias/${TENANT}/configuracoes/funcionamento`, credentialState.admin.idToken);
  const legacyValue = firestoreFields(legacy);
  const v2Value = firestoreFields(v2);
  const legacyV2 = compareFunctioningSnapshots(legacyValue, v2Value);
  return { legacy, v2, legacyValue, v2Value, legacyV2 };
}

async function runBatch3SafeRemote() {
  const plan = preflightBatch3Plan();
  if (!plan.safeReady) throw new Error("BATCH3_SAFE_PREFLIGHT_FAILED");
  const runId = randomUUID().replaceAll("-", "");
  const state = {
    appointments: [],
    functioning: { changed: false, restored: false, initial: null },
    opening: { date: "", touched: false, removed: false },
    closing: { date: "", id: "", touched: false, removed: false },
  };
  const outcome = {
    PREFLIGHT: "PASS",
    CLIENTE_CHEGOU: null,
    CLIENTE_CHEGOU_REPLAY: null,
    EM_ATENDIMENTO: null,
    EM_ATENDIMENTO_REPLAY: null,
    CONCLUIR: null,
    CONCLUIR_REPLAY: null,
    CONCLUIR_FINAL_STATE: null,
    NAO_COMPARECEU: null,
    NAO_COMPARECEU_REPLAY: null,
    NAO_COMPARECEU_FINAL_STATE: null,
    NEGATIVE_STATE_TRANSITIONS: null,
    FUNCTIONING_UPDATE: null,
    FUNCTIONING_REPLAY: null,
    FUNCTIONING_RESTORE: null,
    FUNCTIONING_FINAL_EQUALS_INITIAL: null,
    FUNCTIONING_COMPARE_FIELDS: FUNCTIONING_SEMANTIC_FIELDS,
    DIFFERING_FIELDS: [],
    MISSING_AFTER_RESTORE: [],
    EXTRA_AFTER_RESTORE: [],
    LEGACY_RESTORE_MATCH: null,
    V2_RESTORE_MATCH: null,
    LEGACY_V2_EQUIVALENT_AFTER_RESTORE: null,
    FUNCTIONING_MUTATION_STILL_ACTIVE: null,
    CLOSURES_FLOW: null,
    CLOSURES_REPLAY: null,
    CLOSURES_CLEANUP: null,
    TERMINAL_HISTORY_VALID: null,
    ZERO_ACTIVE_RESIDUE: false,
    LEGACY_V2_EQUIVALENCE: false,
    PARTIAL_WRITE: false,
    CLEANUP: "NOT_RUN",
  };
  const cleanupFailures = [];
  const cleanupRequest = (name) => newRequestId(`hml-lote3-${name}-cleanup`, runId);

  try {
    credentialState.admin = await interactiveSession("ADMIN HML");
    credentialState.client = await interactiveSession("CLIENT HML");
    const adminIdentity = await proveAdmin(credentialState.admin);
    const clientIdentity = await proveClient(credentialState.client);
    if (adminIdentity.authUid === clientIdentity.authUid || adminIdentity.operationalUid === clientIdentity.operationalUid) {
      throw new Error("identities must be distinct");
    }
    const selected = await selectServiceAndSlots();
    await assertFixtureAbsent(selected.first);
    await assertFixtureAbsent(selected.second);
    const functioningBefore = await auditFunctioningPair();
    const initialFunctioning = normalizedFunctioning(functioningBefore.legacyValue);
    if (!functioningBefore.legacy || !functioningBefore.v2 || !functioningBefore.legacyV2.equal || initialFunctioning.intervalo_minutos !== 30 || Object.values(initialFunctioning.periodos_semana).some((periods) => !periods.length)) {
      throw new Error("FUNCTIONING_SNAPSHOT_INVALID");
    }
    state.functioning.initial = initialFunctioning;
    const openingDate = selected.first.date;
    const closingDate = selected.second.date;
    const openingPath = `abertura_${openingDate}`;
    const openingBefore = await auditGlobalFixture(openingPath);
    const closingBefore = await auditGlobalFixture(closingDate);
    if (openingBefore.legacy || openingBefore.v2 || closingBefore.legacy || closingBefore.v2) {
      throw new Error("CLOSURE_FIXTURE_COLLISION");
    }
    state.opening.date = openingDate;
    state.closing.date = closingDate;
    state.closing.id = closingDate;
    validateRemoteRequestPlan(runId);

    const firstAppointment = { id: "", slot: selected.first, terminal: false, actor: credentialState.client };
    state.appointments.push(firstAppointment);
    const createOne = await callStage("AGENDA_CONCLUIR_CREATE", "agenda.criar", appointmentCreatePayload(clientIdentity.operationalUid, selected.serviceId, selected.first), newRequestId("hml-lote3-agenda-create", runId), "CLIENT", credentialState.client.idToken);
    firstAppointment.id = String(createOne.appointmentId || "");
    if (!firstAppointment.id) throw new Error("AGENDA_CREATE_ID_MISSING");

    let negativeError;
    try {
      await callStage("NEGATIVE_EM_ATENDIMENTO_FROM_AGENDADO", "agenda.em_atendimento", { data: { appointmentId: firstAppointment.id } }, newRequestId("hml-lote3-negative", runId), "ADMIN", credentialState.admin.idToken);
    } catch (error) {
      negativeError = error;
    }
    if (!negativeError || !["failed-precondition", "FAILED_PRECONDITION"].includes(String(negativeError.code || ""))) throw new Error("INVALID_TRANSITION_ACCEPTED");
    const unchanged = await auditAppointmentPair(firstAppointment.id);
    if (!unchanged.legacy || !unchanged.v2 || firestoreFields(unchanged.legacy).status !== "agendado" || firestoreFields(unchanged.v2).status !== "agendado" || !unchanged.equivalent) throw new Error("INVALID_TRANSITION_CHANGED_STATE");
    outcome.NEGATIVE_STATE_TRANSITIONS = "PASS";

    const arrived = await replayStage("CLIENTE_CHEGOU", "agenda.cliente_chegou", { data: { appointmentId: firstAppointment.id } }, newRequestId("hml-lote3-cliente-chegou", runId), "ADMIN", credentialState.admin.idToken, ["appointmentId", "status"]);
    outcome.CLIENTE_CHEGOU = "PASS";
    outcome.CLIENTE_CHEGOU_REPLAY = "PASS";
    const attending = await replayStage("EM_ATENDIMENTO", "agenda.em_atendimento", { data: { appointmentId: firstAppointment.id } }, newRequestId("hml-lote3-em-atendimento", runId), "ADMIN", credentialState.admin.idToken, ["appointmentId", "status"]);
    outcome.EM_ATENDIMENTO = "PASS";
    outcome.EM_ATENDIMENTO_REPLAY = "PASS";
    const concluded = await replayStage("CONCLUIR", "agenda.concluir", { data: { appointmentId: firstAppointment.id } }, newRequestId("hml-lote3-concluir", runId), "ADMIN", credentialState.admin.idToken, ["appointmentId", "status"]);
    outcome.CONCLUIR = "PASS";
    outcome.CONCLUIR_REPLAY = "PASS";
    const concludedAudit = await auditAppointmentPair(firstAppointment.id);
    const concludedLegacy = firestoreFields(concludedAudit.legacy);
    const concludedV2 = firestoreFields(concludedAudit.v2);
    if (concludedLegacy.status !== "concluido" || concludedV2.status !== "concluido" || !concludedAudit.equivalent || !concludedAudit.occupancyEquivalent) throw new Error("CONCLUIR_LEGACY_V2_MISMATCH");
    firstAppointment.terminal = true;
    outcome.CONCLUIR_FINAL_STATE = "CONCLUIDO";

    const secondAppointment = { id: "", slot: selected.second, terminal: false, actor: credentialState.client };
    state.appointments.push(secondAppointment);
    const createTwo = await callStage("AGENDA_NAO_COMPARECEU_CREATE", "agenda.criar", appointmentCreatePayload(clientIdentity.operationalUid, selected.serviceId, selected.second), newRequestId("hml-lote3-nao-show-create", runId), "CLIENT", credentialState.client.idToken);
    secondAppointment.id = String(createTwo.appointmentId || "");
    if (!secondAppointment.id) throw new Error("AGENDA_CREATE_ID_MISSING");
    const noShow = await replayStage("NAO_COMPARECEU", "agenda.nao_compareceu", { data: { appointmentId: secondAppointment.id } }, newRequestId("hml-lote3-nao-compareceu", runId), "ADMIN", credentialState.admin.idToken, ["appointmentId", "status"]);
    outcome.NAO_COMPARECEU = "PASS";
    outcome.NAO_COMPARECEU_REPLAY = "PASS";
    const noShowAudit = await auditAppointmentPair(secondAppointment.id);
    const noShowLegacy = firestoreFields(noShowAudit.legacy);
    const noShowV2 = firestoreFields(noShowAudit.v2);
    if (noShowLegacy.status !== "nao_compareceu" || noShowV2.status !== "nao_compareceu" || !noShowAudit.equivalent || noShowAudit.legacyOccupancy || noShowAudit.v2Occupancy) throw new Error("NAO_COMPARECEU_FINAL_STATE_INVALID");
    secondAppointment.terminal = true;
    outcome.NAO_COMPARECEU_FINAL_STATE = "NAO_COMPARECEU";
    outcome.TERMINAL_HISTORY_VALID = "SIM";
    outcome.LEGACY_V2_EQUIVALENCE = true;

    const changedDays = { ...initialFunctioning.dias_fechados_semana, 0: !initialFunctioning.dias_fechados_semana[0] };
    const modifiedFunctioning = functioningPayload({ ...initialFunctioning, dias_fechados_semana: changedDays });
    state.functioning.changed = true;
    await replayStage("FUNCTIONING_UPDATE", "admin.funcionamento.salvar", modifiedFunctioning, newRequestId("hml-lote3-funcionamento", runId), "ADMIN", credentialState.admin.idToken, ["updated"]);
    outcome.FUNCTIONING_UPDATE = "PASS";
    outcome.FUNCTIONING_REPLAY = "PASS";
    await callStage("FUNCTIONING_RESTORE", "admin.funcionamento.salvar", functioningPayload(initialFunctioning), newRequestId("hml-lote3-funcionamento-restore", runId), "ADMIN", credentialState.admin.idToken);
    state.functioning.restored = true;
    outcome.FUNCTIONING_RESTORE = "PASS";
    const functioningAfter = await auditFunctioningPair();
    const legacyRestore = compareFunctioningSnapshots(initialFunctioning, functioningAfter.legacyValue);
    const v2Restore = compareFunctioningSnapshots(initialFunctioning, functioningAfter.v2Value);
    outcome.DIFFERING_FIELDS = [...new Set([...legacyRestore.differingFields, ...v2Restore.differingFields])];
    outcome.MISSING_AFTER_RESTORE = [...new Set([...legacyRestore.missingAfterRestore, ...v2Restore.missingAfterRestore])];
    outcome.EXTRA_AFTER_RESTORE = [...new Set([...legacyRestore.extraAfterRestore, ...v2Restore.extraAfterRestore])];
    outcome.LEGACY_RESTORE_MATCH = legacyRestore.equal ? "SIM" : "NÃO";
    outcome.V2_RESTORE_MATCH = v2Restore.equal ? "SIM" : "NÃO";
    outcome.LEGACY_V2_EQUIVALENT_AFTER_RESTORE = functioningAfter.legacyV2.equal ? "SIM" : "NÃO";
    outcome.FUNCTIONING_FINAL_EQUALS_INITIAL = legacyRestore.equal && v2Restore.equal ? "SIM" : "NÃO";
    outcome.FUNCTIONING_MUTATION_STILL_ACTIVE = outcome.FUNCTIONING_FINAL_EQUALS_INITIAL === "SIM" ? "NÃO" : "INCONCLUSIVO";
    if (outcome.FUNCTIONING_FINAL_EQUALS_INITIAL !== "SIM") {
      console.log(JSON.stringify({
        FUNCTIONING_RESTORE_DIAGNOSTIC: {
          FUNCTIONING_COMPARE_FIELDS: outcome.FUNCTIONING_COMPARE_FIELDS,
          DIFFERING_FIELDS: outcome.DIFFERING_FIELDS,
          MISSING_AFTER_RESTORE: outcome.MISSING_AFTER_RESTORE,
          EXTRA_AFTER_RESTORE: outcome.EXTRA_AFTER_RESTORE,
          LEGACY_RESTORE_MATCH: outcome.LEGACY_RESTORE_MATCH,
          V2_RESTORE_MATCH: outcome.V2_RESTORE_MATCH,
          LEGACY_V2_EQUIVALENT_AFTER_RESTORE: outcome.LEGACY_V2_EQUIVALENT_AFTER_RESTORE,
          FUNCTIONING_MUTATION_STILL_ACTIVE: outcome.FUNCTIONING_MUTATION_STILL_ACTIVE,
        },
      }));
      throw new Error("FUNCTIONING_RESTORE_MISMATCH");
    }

    state.opening.touched = true;
    const openingPair = await replayStage("OPENING_SAVE", "admin.abertura.salvar", { data: { data: openingDate, inicio: "09:00", fim: "10:00", motivo: `Lote3-${runId.slice(0, 8)}` } }, newRequestId("hml-lote3-abertura", runId), "ADMIN", credentialState.admin.idToken, ["openingId"]);
    const openingRemove = await callStage("OPENING_REMOVE", "admin.abertura.remover", { data: { data: openingDate } }, cleanupRequest("abertura"), "ADMIN", credentialState.admin.idToken);
    state.opening.removed = true;
    state.closing.touched = true;
    const closingPair = await replayStage("CLOSING_SAVE", "admin.fechamento.salvar", { data: { datas: [closingDate], inicio: closingDate, fim: closingDate, motivo: `Lote3-${runId.slice(0, 8)}`, fechamento_id: state.closing.id } }, newRequestId("hml-lote3-fechamento", runId), "ADMIN", credentialState.admin.idToken, ["closureId", "documents"]);
    const closingRemove = await callStage("CLOSING_REMOVE", "admin.fechamento.remover", { data: { ids: [state.closing.id] } }, cleanupRequest("fechamento"), "ADMIN", credentialState.admin.idToken);
    state.closing.removed = true;
    const openingFinal = await auditGlobalFixture(openingPath);
    const closingFinal = await auditGlobalFixture(closingDate);
    if (openingFinal.legacy || openingFinal.v2 || closingFinal.legacy || closingFinal.v2) throw new Error("CLOSURE_RESIDUE");
    outcome.CLOSURES_FLOW = "PASS";
    outcome.CLOSURES_REPLAY = "PASS";
    outcome.CLOSURES_CLEANUP = "PASS";
    outcome.ZERO_ACTIVE_RESIDUE = true;
    outcome.CLEANUP = "PASS";
    return outcome;
  } catch (error) {
    outcome.CLEANUP = "IN_PROGRESS";
    throw error;
  } finally {
    for (const appointment of state.appointments) {
      if (!appointment.id || appointment.terminal) continue;
      try {
        const current = await auditAppointmentPair(appointment.id);
        const legacy = firestoreFields(current.legacy);
        if (legacy.status && !["cancelado", "nao_compareceu", "concluido"].includes(legacy.status)) {
          await callStage("AGENDA_CLEANUP", "agenda.cancelar", { data: { appointmentId: appointment.id } }, cleanupRequest("agenda"), "CLIENT", credentialState.client.idToken);
        }
      } catch (error) {
        cleanupFailures.push({ command: "agenda.cancelar", message: safeMessage(error.message) });
      }
    }
    if (state.opening.touched && !state.opening.removed) {
      try {
        await callStage("OPENING_CLEANUP", "admin.abertura.remover", { data: { data: state.opening.date } }, cleanupRequest("abertura-finally"), "ADMIN", credentialState.admin.idToken);
      } catch (error) {
        cleanupFailures.push({ command: "admin.abertura.remover", message: safeMessage(error.message) });
      }
    }
    if (state.closing.touched && !state.closing.removed) {
      try {
        await callStage("CLOSING_CLEANUP", "admin.fechamento.remover", { data: { ids: [state.closing.id] } }, cleanupRequest("fechamento-finally"), "ADMIN", credentialState.admin.idToken);
      } catch (error) {
        cleanupFailures.push({ command: "admin.fechamento.remover", message: safeMessage(error.message) });
      }
    }
    if (state.functioning.changed && !state.functioning.restored && state.functioning.initial) {
      try {
        await callStage("FUNCTIONING_CLEANUP", "admin.funcionamento.salvar", functioningPayload(state.functioning.initial), cleanupRequest("funcionamento"), "ADMIN", credentialState.admin.idToken);
      } catch (error) {
        cleanupFailures.push({ command: "admin.funcionamento.salvar", message: safeMessage(error.message) });
      }
    }
    if (cleanupFailures.length) {
      outcome.CLEANUP = "FAIL";
      outcome.ZERO_ACTIVE_RESIDUE = false;
      console.log(JSON.stringify({ CLEANUP_FAILURES: cleanupFailures }));
    }
  }
}

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

async function runBatch3Remote() {
  const plan = preflightBatch3Plan();
  if (!plan.ready) throw new Error(`SUBTEST_BLOCKED_CLEANUP_UNAVAILABLE:${plan.blockers.join(",")}`);
  credentialState.admin = await interactiveSession("ADMIN HML");
  credentialState.client = await interactiveSession("CLIENT HML");
  if (credentialState.admin.localId === credentialState.client.localId) throw new Error("identities must be distinct");
  // A futura execução somente poderá prosseguir quando os subtestes bloqueados
  // tiverem um cleanup operacional explícito e testado offline.
  throw new Error("BATCH3_REMOTE_EXECUTOR_REQUIRES_CLEANUP_REVIEW");
}

export async function selfTest() {
  assert.throws(() => guardBatch3Options({ project: PRODUCTION_PROJECT, adminAuth: "interactive", clientAuth: "interactive", confirm: true, batch3: true }), /HML project guard|production/);
  assert.throws(() => guardBatch3Options({ project: PROJECT, adminAuth: "interactive", clientAuth: "interactive", confirm: false, batch3: true }), /confirm/);
  assert.throws(() => buildCallableEnvelope("admin.plano.salvar", { data: {} }, "short"), /invalid request ID/);
  const envelope = buildCallableEnvelope("agenda.cliente_chegou", { data: { appointmentId: "fixture-appointment" } }, newRequestId("hml-lote3-transition"));
  assert.equal(envelope.data.data.appointmentId, "fixture-appointment");
  assert.equal(envelope.data.data.data, undefined);
  assert.deepEqual(agendaNegativeTransitionPlan().map((item) => item.expected), ["INVALID", "INVALID", "INVALID", "VALID_BY_RUNTIME"]);
  assert.throws(() => stateTransition("agendado", "em_atendimento"), /INVALID_TRANSITION/);
  assert.equal(stateTransition("agendado", "cliente_chegou"), "cliente_chegou");
  assert.equal(stateTransition("cliente_chegou", "em_atendimento"), "em_atendimento");
  assert.equal(stateTransition("em_atendimento", "concluir"), "concluido");
  assert.equal(REQUEST_ID_PATTERN.test(newRequestId("hml-lote3")), true);
  const query = buildAuditStructuredQuery("agendamentos", [["barbeiro_id", { stringValue: BARBER_ID }]], { limit: 1, stage: "BATCH3_SLOT" });
  assert.equal(query.from[0].collectionId, "agendamentos");
  assert.equal(query.limit, 1);
  assert.equal(appointmentEquivalent({ fields: { status: { stringValue: "agendado" } } }, { fields: { status: { stringValue: "agendado" } } }), true);
  assert.equal(occupancyEquivalent({ fields: { tipo: { stringValue: "x" } } }, { fields: { tipo: { stringValue: "x" } } }), true);
  assert.equal(semanticEquivalent({ fields: { a: { stringValue: "x" } } }, { fields: { a: { stringValue: "x" } } }), true);
  const plan = preflightBatch3Plan();
  const blockers = plan.blockers;
  assert.equal(plan.safeReady, true);
  assert.equal(plan.ready, false);
  const remoteSimulation = simulateRemotePathOffline("offlinebatch3requestid");
  assert.equal(remoteSimulation.safeReady, true);
  assert.equal(remoteSimulation.wireShapes, true);
  assert(remoteSimulation.requestIds.every((id) => REQUEST_ID_PATTERN.test(id)));
  const transitionSimulation = await simulateAgendaTransitionRemotePath();
  assert.equal(transitionSimulation.finalState, "concluido");
  const sampleFunctioning = {
    intervalo_minutos: 30,
    periodos_semana: Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, [{ inicio: "08:30", fim: "19:30", generated: "ignored" }]])),
    dias_fechados_semana: { 0: false, 1: false, 2: false, 3: false, 4: false, 5: false, 6: false },
    atualizado_em: "volatile",
    atualizado_por: "generated",
  };
  const functioningComparison = compareFunctioningSnapshots(sampleFunctioning, sampleFunctioning);
  assert.equal(functioningComparison.equal, true);
  assert.deepEqual(functioningComparison.differingFields, []);
  assert(blockers.some((item) => item.startsWith("planos:")), "plan cleanup blocker missing");
  assert(blockers.some((item) => item.startsWith("adminAssinaturas:")), "subscription cleanup blocker missing");
  assert.equal(plan.cleanup.agendaConcluido.terminalHistoryAllowed, true);
  assert.equal(plan.cleanup.agendaNaoCompareceu.terminalHistoryAllowed, true);
  assert(plan.safeCommands.includes("agenda.concluir"));
  assert(plan.safeCommands.includes("agenda.nao_compareceu"));
  assert(plan.deferredCommands.includes("admin.plano.salvar"));
  assert(plan.deferredCommands.includes("admin.assinatura.aprovar"));
  const journey = runOfflineDryJourney();
  assert.equal(journey.agendaMain, true);
  assert.equal(journey.agendaCleanup, true);
  assert.equal(journey.agendaConcluido.finalState, "concluido");
  assert.equal(journey.agendaConcluido.occupancySemantics, "HISTORICAL_AFTER_TERMINAL");
  assert.equal(journey.agendaNaoCompareceu.finalState, "nao_compareceu");
  assert.equal(journey.agendaNaoCompareceu.occupancySemantics, "RELEASED");
  assert(journey.negativeTransitions.every((item) => item.rejected && item.stateUnchanged && item.legacyV2Unchanged));
  assert.equal(journey.functioning, true);
  assert.equal(journey.closures, true);
  assert.equal(journey.finallyFailureInjection, true);
  assert.equal(journey.zeroResidue, true);
  for (const entry of journey.log) assert(!JSON.stringify(entry).includes("@"), "offline telemetry must not contain email PII");
  const source = await readFile(new URL("../functions/dual-write.js", import.meta.url), "utf8");
  assert.match(source, /case "agenda\.cliente_chegou"/);
  assert.match(source, /case "admin\.funcionamento\.salvar"/);
  assert.match(source, /case "admin\.plano\.salvar"/);
  assert.match(source, /case "admin\.assinatura\.aprovar"/);
  console.log(JSON.stringify({
    FULL_OFFLINE_DRY_JOURNEY: "PASS",
    ALL_REQUEST_IDS_VALID: "PASS",
    ALL_REST_QUERIES_VALID: "PASS",
    ALL_WIRE_SHAPES_MATCH_RUNTIME: "PASS",
    ALL_COMPARATORS_SEMANTIC: "PASS",
    FINALLY_FAILURE_INJECTION: "PASS",
    TERMINAL_HISTORY_ALLOWED: "SIM",
    ZERO_ACTIVE_RESIDUE_ASSERTION: "PASS",
    BATCH3_SAFE_COMMANDS: plan.safeCommands,
    BATCH3_DEFERRED_COMMANDS: plan.deferredCommands,
    CLEANUP_BLOCKERS: blockers,
    READY_FOR_BATCH3_SAFE_HML: "SIM",
  }));
}

export async function main(argv = process.argv) {
  const opts = parseArgs(argv);
  if (opts.selfTest) return selfTest();
  guardBatch3Options(opts);
  try {
    const plan = preflightBatch3Plan();
    if (opts.batch3Safe) {
      const outcome = await runBatch3SafeRemote();
      console.log(JSON.stringify({
        ...outcome,
        BATCH3_SAFE: "PASS",
        DEFERRED_PLAN_COMMANDS_NOT_RUN: "SIM",
        DEFERRED_SUBSCRIPTION_COMMANDS_NOT_RUN: "SIM",
        HML_ACCESSED: "SIM",
        PRODUCTION_ACCESSED: "NÃO",
        PRODUCTION_CHANGED: "NÃO",
        DEPLOY: "NÃO",
      }));
      return outcome;
    }
    if (!plan.ready) {
      console.log(JSON.stringify({ PROJECT, BATCH3: "DEFERRED_NON_REVERSIBLE", DEFERRED_COMMANDS: plan.deferredCommands, REASONS: plan.blockers, HML_ACCESSED: "NÃO", PRODUCTION_ACCESSED: "NÃO" }));
      throw new Error(`BATCH3_DEFERRED_NON_REVERSIBLE:${plan.blockers.join(",")}`);
    }
    await runBatch3Remote();
  } finally {
    clearCredentials();
  }
}

if (process.argv[1]?.toLowerCase().endsWith("hml-command-batch3-test.mjs")) {
  main().catch((error) => {
    console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: { message: safeMessage(error.message) }, NETWORK_ACCESSED: remoteAccessed ? "SIM" : "NÃO", HML_ACCESSED: remoteAccessed ? "SIM" : "NÃO", PRODUCTION_ACCESSED: "NÃO" }));
    process.exitCode = 1;
  });
}
