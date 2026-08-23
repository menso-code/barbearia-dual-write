import assert from "node:assert/strict";
import test from "node:test";
import {
  PROJECT,
  PRODUCTION_PROJECT,
  COMMAND,
  SAVE_COMMAND,
  REMOVE_COMMAND,
  FIXTURE_ID,
  buildCallableEnvelope,
  buildFixtureSavePayload,
  buildFixtureRemovePayload,
  buildAdminCallableEnvelope,
  assertActivateResponse,
  classifyBarberFixture,
  guardReadOnlyOptions,
  productionGuard,
  runReadOnlyPreflight,
  runSelfTest,
  simulateActivationJourney,
  simulateDedicatedFixtureJourney,
  runBarberActivateRemote,
} from "./hml-barber-activate-test.mjs";

test("contrato do comando e resposta", () => {
  const request = buildCallableEnvelope("barber-1", true, "hml-barber-activate-123456");
  assert.deepEqual(request, { data: { command: COMMAND, requestId: "hml-barber-activate-123456", data: { id: "barber-1", ativo: true } } });
  assert.doesNotThrow(() => assertActivateResponse({ barberId: "barber-1", duplicate: false }, { barberId: "barber-1", duplicate: false }));
  assert.throws(() => assertActivateResponse({ barberId: "barber-1", created: true }, { barberId: "barber-1", duplicate: false }), /RESPONSE_SHAPE/);
});

test("guards bloqueiam ator/projeto/modo de mutação", () => {
  assert.doesNotThrow(() => guardReadOnlyOptions({ project: PROJECT, adminAuth: "interactive", fixturePreflightOnly: true, mutationRequested: false }));
  assert.throws(() => guardReadOnlyOptions({ project: PRODUCTION_PROJECT, adminAuth: "interactive", fixturePreflightOnly: true }), /HML_PROJECT/);
  assert.throws(() => guardReadOnlyOptions({ project: PROJECT, adminAuth: "interactive", fixturePreflightOnly: true, mutationRequested: true }), /MUTATION_MODE/);
  assert.throws(() => guardReadOnlyOptions({ project: PROJECT, adminAuth: "client", fixturePreflightOnly: true }), /ADMIN_INTERACTIVE/);
});

test("fixture ausente, incompatível e ownership não comprovado abortam", async () => {
  const find = async () => ({ candidates: [], uniqueCandidate: false, ownershipProven: false });
  const absent = await runReadOnlyPreflight({ project: PROJECT, authAdmin: "interactive", adminSession: { token: "offline" }, find });
  assert.equal(absent.FIXTURE_OWNERSHIP_PROVEN, "NÃO");
  const incompatible = classifyBarberFixture({ id: "barber-x", legacy: { nome: "normal", ativo: true }, v2: { nome: "normal", ativo: false }, member: null });
  assert.equal(incompatible.fixtureState, "INCOMPATIBLE");
  assert.equal(incompatible.ownershipProven, false);
});

test("ownership dedicado exige marcador explícito e membership equivalente", () => {
  const value = { nome: FIXTURE_ID, descricao: "Dedicated test fixture: barber-activate-fixture", ativo: false };
  const result = classifyBarberFixture({ id: FIXTURE_ID, legacy: value, v2: { ...value }, member: null });
  assert.equal(result.ownershipProven, true);
  assert.equal(result.fixtureState, "COMPATIBLE");
  const noMarker = classifyBarberFixture({ id: FIXTURE_ID, legacy: { nome: "Barbeiro técnico", ativo: false }, v2: { nome: "Barbeiro técnico", ativo: false }, member: null });
  assert.equal(noMarker.ownershipProven, false);
  assert.equal(result.membershipApplicable, false);
});

test("provisionamento da fixture usa somente comandos operacionais e é reversível", () => {
  const save = buildFixtureSavePayload();
  assert.deepEqual(save, { id: FIXTURE_ID, nome: FIXTURE_ID, descricao: "Dedicated test fixture: barber-activate-fixture", ativo: false });
  assert.deepEqual(buildFixtureRemovePayload(), { id: FIXTURE_ID });
  const saveEnvelope = buildAdminCallableEnvelope(SAVE_COMMAND, save, "hml-barber-fixture-save");
  const activateEnvelope = buildAdminCallableEnvelope(COMMAND, { id: FIXTURE_ID, ativo: true }, "hml-barber-fixture-activate");
  const removeEnvelope = buildAdminCallableEnvelope(REMOVE_COMMAND, { id: FIXTURE_ID }, "hml-barber-fixture-remove");
  assert.equal(saveEnvelope.data.command, SAVE_COMMAND);
  assert.equal(activateEnvelope.data.command, COMMAND);
  assert.equal(removeEnvelope.data.command, REMOVE_COMMAND);
  assert.throws(() => buildAdminCallableEnvelope("admin.barbeiro.salvar", { id: "other" }, "bad:id"), /REQUEST_ID/);
  const journey = simulateDedicatedFixtureJourney();
  assert.equal(journey.saveResult.created, true);
  assert.equal(journey.activation.finalEqualsInitial, true);
  assert.equal(journey.removeResult.removed, true);
  assert.equal(journey.finalState.exists, false);
});

test("executor remoto simulado cobre create, activate, replay, restore, cleanup e zero residue", async () => {
  let candidate = null;
  const requests = new Map();
  const find = async () => ({
    candidates: candidate ? [{ ownershipProven: true, fixtureState: "COMPATIBLE", active: candidate.active }] : [],
    uniqueCandidate: Boolean(candidate),
    ownershipProven: Boolean(candidate),
  });
  const call = async (command, data, requestId) => {
    assert.match(requestId, /^[a-zA-Z0-9_-]{16,120}$/);
    if (requests.has(requestId)) return { ...requests.get(requestId), duplicate: true };
    let result;
    if (command === SAVE_COMMAND) { candidate = { active: false }; result = { barberId: FIXTURE_ID, created: true, duplicate: false }; }
    else if (command === COMMAND) { candidate.active = data.ativo; result = { barberId: FIXTURE_ID, duplicate: false }; }
    else { candidate = null; result = { barberId: FIXTURE_ID, removed: true, duplicate: false }; }
    requests.set(requestId, { ...result, duplicate: false });
    return result;
  };
  const report = await runBarberActivateRemote({
    project: PROJECT,
    adminAuth: "interactive",
    confirmHmlWrite: true,
    adminSession: { token: "offline" },
    find,
    call,
  });
  assert.equal(report.FINAL_RESULT, "PASS");
  assert.equal(report.ZERO_RESIDUE, "PASS");
  assert.deepEqual(report.STAGES.map((stage) => stage.STAGE), ["FIXTURE_CREATE", "ACTIVATE_FIRST", "ACTIVATE_REPLAY", "RESTORE", "CLEANUP"]);
});

test("executor reutiliza fixture compatível e aborta incompatibilidade", async () => {
  const compatibleState = { active: false };
  const compatibleFind = async () => ({ candidates: [{ ownershipProven: true, fixtureState: "COMPATIBLE", active: compatibleState.active }], uniqueCandidate: true, ownershipProven: true });
  const calls = [];
  const requestResults = new Map();
  const compatibleCall = async (command, data, requestId) => {
    calls.push(command);
    if (requestResults.has(requestId)) return { ...requestResults.get(requestId), duplicate: true };
    if (command === COMMAND) { compatibleState.active = data.ativo; const result = { barberId: FIXTURE_ID, duplicate: false }; requestResults.set(requestId, result); return result; }
    throw new Error("UNEXPECTED_PROVISION_CALL");
  };
  const report = await runBarberActivateRemote({ project: PROJECT, adminAuth: "interactive", confirmHmlWrite: true, adminSession: { token: "offline" }, find: compatibleFind, call: compatibleCall });
  assert.equal(report.FINAL_RESULT, "PASS");
  assert.equal(calls.includes(SAVE_COMMAND), false);
  assert.equal(calls.includes(REMOVE_COMMAND), false);
  await assert.rejects(() => runBarberActivateRemote({
    project: PROJECT,
    adminAuth: "interactive",
    confirmHmlWrite: true,
    adminSession: { token: "offline" },
    find: async () => ({ candidates: [{ ownershipProven: false, fixtureState: "INCOMPATIBLE" }], uniqueCandidate: true, ownershipProven: false }),
    call: compatibleCall,
  }), /EXISTING_INCOMPATIBLE_FIXTURE/);
});

test("falha após create executa apenas restore/cleanup da fixture comprovada", async () => {
  let candidate = null;
  const calls = [];
  const find = async () => ({ candidates: candidate ? [{ ownershipProven: true, fixtureState: "COMPATIBLE", active: candidate.active }] : [], uniqueCandidate: Boolean(candidate), ownershipProven: Boolean(candidate) });
  const call = async (command, data) => {
    calls.push(command);
    if (command === SAVE_COMMAND) { candidate = { active: false }; return { barberId: FIXTURE_ID, created: true, duplicate: false }; }
    if (command === COMMAND) throw new Error("INJECTED_ACTIVATE_REMOTE");
    candidate = null;
    return { barberId: FIXTURE_ID, removed: true, duplicate: false };
  };
  await assert.rejects(() => runBarberActivateRemote({ project: PROJECT, adminAuth: "interactive", confirmHmlWrite: true, adminSession: { token: "offline" }, find, call }), /INJECTED_ACTIVATE_REMOTE/);
  assert.deepEqual(calls, [SAVE_COMMAND, COMMAND, REMOVE_COMMAND]);
  assert.equal(candidate, null);
});

test("first activation, replay, restore e request IDs distintos", () => {
  const result = simulateActivationJourney({ initialActive: false });
  assert.equal(result.first.duplicate, false);
  assert.equal(result.replay.duplicate, true);
  assert.equal(result.restore.duplicate, false);
  assert.equal(result.finalEqualsInitial, true);
});

test("falhas em qualquer estágio não deixam projeção parcial", () => {
  for (const failAt of ["before-write", "legacy", "v2"]) {
    assert.throws(() => simulateActivationJourney({ initialActive: false, failAt }), /INJECTED_/);
  }
});

test("self-test e production guard", () => {
  assert.equal(runSelfTest().mutationMode, "DISABLED");
  assert.doesNotThrow(() => productionGuard(PROJECT));
  assert.throws(() => productionGuard(PRODUCTION_PROJECT), /HML_PROJECT/);
});
