import test from "node:test";
import assert from "node:assert/strict";
import {
  HML_PROJECT,
  PRODUCTION_PROJECT,
  CLIENT_BOOTSTRAP_COMMAND,
  CLIENT_PROFILE_UPDATE_COMMAND,
  SERVICE_PROVISION_COMMAND,
  PLAN_FIXTURE_ID,
  SERVICE_FIXTURE_ID,
  SERVICE_FIXTURE_NAME,
  PLAN_ACTIVATE_RUNTIME_RESPONSE_KEYS,
  assertPlanActivationResponse,
  createRemoteProvisionTransport,
  buildProvisionPlan,
  buildServiceFixture,
  buildClientFixtureMarker,
  buildCallablePayload,
  classifyProvisionDependencies,
  classifyProvisionPreflight,
  classifyClientFixture,
  classifyServiceFixture,
  classifyPlanFixture,
  classifyPlanServiceDependency,
  evaluateProvisionReadiness,
  semanticFixtureDiff,
  subscriptionSemanticDiff,
  compareSubscriptionFinalState,
  summarizePlanStateAudit,
  runPlanStateReadOnlyAudit,
  guardProvisionOptions,
  guardBatch4SafeOptions,
  productionGuard,
  runOfflineDryJourney,
  runOfflineBatch4SafeJourney,
  runBatch4Safe,
  runOfflineProvisionDesign,
  runOfflineProvisionPathReview,
  provisionBatch4Fixtures,
  runRemoteProvision,
  runRemoteBatch4Safe,
  runSelfTest,
  classifyClientIdentity,
  selectReferenceService,
  main,
} from "./hml-command-batch4-test.mjs";

test("self-test offline cobre os dois subtestes seguros", async () => {
  const result = await runSelfTest();
  assert.equal(result.planActivate, "PASS");
  assert.equal(result.planRestore, "PASS");
  assert.equal(result.subscriptionReject, "PASS");
  assert.equal(result.failureInjection, "PASS");
  assert.equal(result.safeBatch4.PLAN_ACTIVATE_FLOW, "PASS");
  assert.equal(result.safeBatch4.SUBSCRIPTION_REJECT_FLOW, "PASS");
});

test("produção é rejeitada", () => {
  assert.throws(() => productionGuard(PRODUCTION_PROJECT), /somente teste-483f6/);
  assert.doesNotThrow(() => productionGuard(HML_PROJECT));
});

test("batch4-safe exige HML, confirmação explícita e autenticação interativa", () => {
  assert.doesNotThrow(() => guardBatch4SafeOptions({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmHmlWrite: true,
  }));
  assert.throws(() => guardBatch4SafeOptions({ project: PRODUCTION_PROJECT, adminAuth: "interactive", clientAuth: "interactive", confirmHmlWrite: true }), /somente teste-483f6/);
  assert.throws(() => guardBatch4SafeOptions({ project: HML_PROJECT, adminAuth: "interactive", clientAuth: "interactive" }), /CONFIRM_HML_WRITE_REQUIRED/);
  assert.throws(() => guardBatch4SafeOptions({ project: HML_PROJECT, adminAuth: "interactive", clientAuth: "interactive", confirmHmlWrite: true, provisionMode: true }), /BATCH4_SAFE_CANNOT_COMBINE_WITH_PROVISION/);
});

test("batch4-safe percorre a jornada funcional completa sem rede", async () => {
  const result = await runOfflineBatch4SafeJourney();
  assert.equal(result.PLAN_ACTIVATE_FLOW, "PASS");
  assert.equal(result.PLAN_ACTIVATE_REPLAY, "PASS");
  assert.equal(result.PLAN_ACTIVE_AUDIT, "PASS");
  assert.equal(result.PLAN_RESTORE_FLOW, "PASS");
  assert.equal(result.PLAN_ACTIVE_DURING_SUBSCRIPTION_FLOW, "SIM");
  assert.equal(result.PLAN_FINAL_EQUALS_INITIAL, "SIM");
  assert.equal(result.PLAN_FINAL_ACTIVE_STATE, false);
  assert.equal(result.SUBSCRIPTION_REQUEST_FLOW, "PASS");
  assert.equal(result.SUBSCRIPTION_REQUEST_REPLAY, "PASS");
  assert.equal(result.SUBSCRIPTION_REJECT_FLOW, "PASS");
  assert.equal(result.SUBSCRIPTION_REJECT_REPLAY, "PASS");
  assert.equal(result.SUBSCRIPTION_FINAL_STATE, "RECUSADA");
  assert.equal(result.SUBSCRIPTION_LEGACY_V2, "SIM");
  assert.equal(result.SUBSCRIPTION_DOCUMENT_PRESENT, "SIM");
  assert.equal(result.ACTIVE_SUBSCRIPTION_CREATED, "NÃO");
  assert.equal(result.ACTIVE_CREDITS_CREATED, "NÃO");
  assert.equal(result.PARTIAL_WRITE, "NÃO");
  assert.equal(result.NETWORK_ACCESSED, "NÃO");
});

test("dispatcher CLI encaminha somente o modo batch4-safe", async () => {
  let received;
  const originalLog = console.log;
  let output = "";
  console.log = (value) => { output += String(value); };
  try {
    await main([
      "--project=teste-483f6",
      "--auth-admin=interactive",
      "--auth-client=interactive",
      "--confirm-hml-write",
      "--batch4-safe",
    ], {
      runRemoteBatch4Safe: async (args) => {
        received = args;
        return { FINAL_RESULT: "PASS", NETWORK_ACCESSED: "NÃO" };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(received.project, HML_PROJECT);
  assert.equal(received.authAdmin, "interactive");
  assert.equal(received.authClient, "interactive");
  assert.equal(received.confirmHmlWrite, true);
  assert.deepEqual(JSON.parse(output), { FINAL_RESULT: "PASS", NETWORK_ACCESSED: "NÃO" });
});

test("wire shape não duplica data e mantém campos permitidos", () => {
  const payload = buildCallablePayload("admin.plano.ativar", { id: "dedicated", ativo: true }, "batch4-wire-0001");
  assert.equal(payload.data.command, "admin.plano.ativar");
  assert.equal(payload.data.requestId, "batch4-wire-0001");
  assert.deepEqual(payload.data.data, { id: "dedicated", ativo: true });
  assert.equal(payload.data.data.data, undefined);
});

test("contrato real de admin.plano.ativar não exige created", () => {
  assert.deepEqual(PLAN_ACTIVATE_RUNTIME_RESPONSE_KEYS, ["duplicate", "planId"]);
  assert.doesNotThrow(() => assertPlanActivationResponse({ duplicate: false, planId: PLAN_FIXTURE_ID }));
  assert.doesNotThrow(() => assertPlanActivationResponse({ duplicate: true, planId: PLAN_FIXTURE_ID }, { replay: true }));
  assert.throws(() => assertPlanActivationResponse({ duplicate: false, planId: PLAN_FIXTURE_ID, created: true }), /RESPONSE_SHAPE_INVALID/);
  assert.throws(() => assertPlanActivationResponse({ duplicate: false }), /RESPONSE_SHAPE_INVALID|FIRST_FAILED/);
});

test("auditoria read-only classifica plano restaurado e assinatura sem callable", () => {
  const service = buildServiceFixture();
  const serviceFields = { ...service };
  delete serviceFields.id;
  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const planFields = { ...plan, servicos_incluidos: [SERVICE_FIXTURE_NAME] };
  delete planFields.id;
  const summary = summarizePlanStateAudit({
    plan: { id: PLAN_FIXTURE_ID, fields: planFields },
    planV2: { id: PLAN_FIXTURE_ID, fields: structuredClone(planFields) },
    service: { id: SERVICE_FIXTURE_ID, fields: serviceFields },
    serviceV2: { id: SERVICE_FIXTURE_ID, fields: structuredClone(serviceFields) },
    subscription: { exists: false },
  });
  assert.equal(summary.PLAN_FINAL_ACTIVE_STATE, false);
  assert.equal(summary.PLAN_STATE_CLASSIFICATION, "PLAN_STATE_RESTORED_OR_UNCHANGED");
  assert.equal(summary.PLAN_LEGACY_V2_EQUIVALENT, "SIM");
  assert.equal(summary.PLAN_REFERENCES_DEDICATED_SERVICE_ONLY, "SIM");
  assert.equal(summary.PLAN_SERVICOS_INCLUIDOS_VALID, "SIM");
  assert.equal(summary.SUBSCRIPTION_CALLABLE_SENT, "NÃO");
  assert.equal(summary.SUBSCRIPTION_DOCUMENT_PRESENT, "NÃO");
});

test("transport sem tracker não acessa .created após resposta da callable", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { duplicate: false, planId: PLAN_FIXTURE_ID } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  try {
    const transport = createRemoteProvisionTransport({
      adminSession: { token: "synthetic-admin", uid: "admin-x" },
      clientSession: { token: "synthetic-client", uid: "client-x" },
    });
    const result = await transport.call("admin.plano.ativar", { id: PLAN_FIXTURE_ID, ativo: true }, "batch4-transport-no-tracker-01", { authUid: "admin-x" });
    assert.deepEqual(result, { duplicate: false, planId: PLAN_FIXTURE_ID });
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("telemetria usa o estágio explícito para o mesmo comando", async () => {
  const originalFetch = globalThis.fetch;
  const originalLog = console.log;
  const logs = [];
  globalThis.fetch = async () => new Response(JSON.stringify({ result: { duplicate: false, planId: PLAN_FIXTURE_ID } }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  console.log = (value) => logs.push(JSON.parse(String(value)));
  try {
    const transport = createRemoteProvisionTransport({
      adminSession: { token: "synthetic-admin", uid: "admin-x" },
      clientSession: { token: "synthetic-client", uid: "client-x" },
    });
    await transport.call("admin.plano.ativar", { id: PLAN_FIXTURE_ID, ativo: false }, "batch4-explicit-stage-01", { authUid: "admin-x" }, { stage: "PLAN_RESTORE" });
  } finally {
    console.log = originalLog;
    globalThis.fetch = originalFetch;
  }
  assert.equal(logs[0].PROVISION_STAGE, "PLAN_RESTORE");
});

test("journey offline não acessa rede", () => {
  const result = runOfflineDryJourney();
  assert.equal(result.networkAccessed, "NÃO");
  assert.equal(result.legacyV2, "PASS");
  assert.equal(result.idempotency, "PASS");
});

test("provisionamento offline exige confirmação, fixtures dedicadas e é idempotente", () => {
  assert.doesNotThrow(() => guardProvisionOptions({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
  }));
  assert.throws(() => guardProvisionOptions({
    project: PRODUCTION_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
  }));
  assert.throws(() => guardProvisionOptions({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmPersistentFixture: true,
  }), /CONFIRM_DEDICATED_CLIENT_REQUIRED/);
  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  assert.equal(plan.id, PLAN_FIXTURE_ID);
  assert.deepEqual(plan.servicos_ids, [SERVICE_FIXTURE_ID]);
  assert.equal(plan.ativo, false);
  assert.match(plan.descricao, /batch4-admin-domain-tests/);
  const service = buildServiceFixture();
  assert.equal(service.id, SERVICE_FIXTURE_ID);
  assert.equal(service.nome, SERVICE_FIXTURE_NAME);
  assert.equal(buildClientFixtureMarker().nome, "batch4-client-fixture");
  assert.equal(buildCallablePayload(SERVICE_PROVISION_COMMAND, service, "batch4-service-0001").data.data.id, SERVICE_FIXTURE_ID);
  assert.equal(buildCallablePayload(CLIENT_PROFILE_UPDATE_COMMAND, { nome: "batch4-client-fixture" }, "batch4-client-0002").data.data.nome, "batch4-client-fixture");
  assert.equal(buildCallablePayload(CLIENT_BOOTSTRAP_COMMAND, { nome: "batch4-client-fixture" }, "batch4-client-0001").data.extras.nome, "batch4-client-fixture");
  assert.deepEqual(runOfflineProvisionDesign(), { policy: "PASS", guards: "PASS", idempotency: "PASS", incompatibleAbort: "PASS", directWrites: 0, networkAccessed: "NÃO" });
});

test("provisionamento exige cadeia CLIENT → SERVICE → PLAN sem conflito silencioso", () => {
  const fields = { nome: "client", descricao: "client" };
  const missing = classifyProvisionDependencies({
    client: { id: "client-x", fields },
    clientV2: { id: "client-x", fields },
    member: { fields: { papeis: ["CLIENTE"] } },
    admin: null,
  });
  assert.equal(missing.client, "MARKER_REQUIRED");
  assert.equal(missing.service, "MISSING");
  assert.equal(missing.plan, "MISSING");
  assert.deepEqual(missing.order, [CLIENT_PROFILE_UPDATE_COMMAND, SERVICE_PROVISION_COMMAND, "admin.plano.salvar"]);
  assert.throws(() => buildProvisionPlan({ serviceId: "real-service" }), /DEDICATED_SERVICE_REFERENCE_REQUIRED/);
});

test("revisão remota simulada valida atores, wire shapes, auditorias e falhas por estágio", () => {
  const result = runOfflineProvisionPathReview();
  assert.equal(result.preflight, "PASS");
  assert.equal(result.actors, "PASS");
  assert.equal(result.requestIds, "PASS");
  assert.equal(result.legacyV2Audits, "PASS");
  assert.equal(result.idempotency, "PASS");
  assert.equal(result.failureInjection, "PASS");
  assert.equal(result.undefinedHelpers, "PASS");
  assert.equal(result.partialProvisionTracking.length, 3);
  assert.deepEqual(result.partialProvisionTracking[1].alreadyCreated, ["CLIENT_MARKER"]);
  assert.deepEqual(result.partialProvisionTracking[1].laterStagesBlocked, ["PLAN_CREATE"]);
  assert.equal(result.wireShapes.every((shape) => shape.valid), true);
});

test("executor de provisionamento envia dados sem envelope duplicado e audita cada dependência", async () => {
  const state = {
    client: { id: "client-x", fields: { nome: "client before marker" } },
    clientV2: { id: "client-x", fields: { nome: "client before marker" } },
    member: { fields: { papeis: ["CLIENTE"] } },
    admin: null,
    service: null,
    serviceV2: null,
    plan: null,
    planV2: null,
  };
  const calls = [];
  const transport = {
    call(command, data) {
      calls.push({ command, data });
      if (command === CLIENT_PROFILE_UPDATE_COMMAND) {
        state.client.fields = { ...state.client.fields, ...data };
        state.clientV2.fields = { ...state.clientV2.fields, ...data };
      } else if (command === SERVICE_PROVISION_COMMAND) {
        const { id, ...fields } = data;
        state.service = { id, fields };
        state.serviceV2 = { id, fields: structuredClone(fields) };
      } else if (command === "admin.plano.salvar") {
        const { id, ...fields } = data;
        state.plan = { id, fields };
        state.planV2 = { id, fields: structuredClone(fields) };
      }
      return { duplicate: false };
    },
  };
  const result = await provisionBatch4Fixtures({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
    adminIdentity: { authUid: "admin-x", isAdmin: true, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    clientIdentity: { authUid: "client-x", operationalUid: "client-x", isAdmin: false, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    serviceId: SERVICE_FIXTURE_ID,
    transport,
    audit: { readFixtureState: async () => structuredClone(state) },
  });
  assert.deepEqual(calls.map(({ command }) => command), [CLIENT_PROFILE_UPDATE_COMMAND, SERVICE_PROVISION_COMMAND, "admin.plano.salvar"]);
  assert.equal(calls.every(({ data }) => data.data === undefined), true);
  assert.deepEqual(result.audits.map(({ stage }) => stage), ["CLIENT", "SERVICE", "PLAN"]);
  assert.equal(result.directFirestoreWrites, 0);
});

test("executor remoto mantém guard de produção antes da autenticação", async () => {
  await assert.rejects(() => runRemoteProvision({
    project: PRODUCTION_PROJECT,
    authAdmin: "interactive",
    authClient: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
  }), /somente teste-483f6/);
  await assert.rejects(() => runRemoteProvision({
    project: HML_PROJECT,
    authAdmin: "interactive",
    authClient: "interactive",
    confirmDedicatedClient: false,
    confirmPersistentFixture: true,
  }), /CONFIRM_DEDICATED_CLIENT_REQUIRED/);
});

test("preflight de cliente distingue identidade, aceita bootstrap pendente e não concede papel", () => {
  const result = classifyClientIdentity({
    authUid: "client-auth",
    adminAuthUid: "admin-auth",
    mapping: null,
    directAdmin: null,
    directMember: null,
    operationalAdmin: null,
    operationalMember: null,
  });
  assert.equal(result.distinct, true);
  assert.equal(result.bootstrapRequired, true);
  assert.equal(result.isAdmin, false);
  assert.equal(result.isBarber, false);
});

test("service reference seleciona somente serviço ativo e equivalente", () => {
  const legacy = [
    { id: "invalid", fields: { nome: "inativo", duracao: 30, preco: "1", ativo: false } },
    { id: "service-fixture", fields: { nome: "Corte", duracao: 30, preco: "10", ativo: true } },
  ];
  const result = selectReferenceService(legacy, new Map([
    ["invalid", { id: "invalid", fields: legacy[0].fields }],
    ["service-fixture", { id: "service-fixture", fields: legacy[1].fields }],
  ]));
  assert.equal(result.found, true);
  assert.equal(result.id, "service-fixture");
  assert.equal(result.legacyV2Equivalent, true);
  assert.equal(result.safeAsPlanReference, true);
});

test("preflight desambigua CLIENT, SERVICE, PLAN e dependência sem expor valores", () => {
  const clientFields = { nome: "cliente dedicado", tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" };
  const clientBase = {
    client: { id: "client-x", fields: clientFields },
    clientV2: { id: "client-x", fields: { ...clientFields } },
    member: { fields: { tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595", papeis: ["CLIENTE"] } },
    admin: null,
  };
  assert.equal(classifyClientFixture(clientBase).state, "MUTABLE_TO_FIXTURE");
  assert.equal(classifyClientFixture({ ...clientBase, confirmDedicatedClient: true }).ownershipProven, true);
  assert.equal(classifyClientFixture(clientBase).ownershipSource, "UNPROVEN");
  assert.equal(classifyClientFixture({
    ...clientBase,
    member: { fields: { tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595", papeis: ["ADMIN"] } },
  }).state, "INCOMPATIBLE");
  assert.equal(classifyClientFixture({}).state, "ABSENT");

  const service = buildServiceFixture();
  const serviceFields = { ...service };
  delete serviceFields.id;
  const serviceDoc = { id: service.id, fields: serviceFields };
  assert.equal(classifyServiceFixture({ service: serviceDoc, serviceV2: structuredClone(serviceDoc) }).state, "COMPATIBLE");
  assert.equal(classifyServiceFixture({ service: { ...serviceDoc, fields: { ...serviceFields, nome: "outro" } }, serviceV2: structuredClone(serviceDoc) }).state, "INCOMPATIBLE");
  assert.equal(classifyServiceFixture({ service: serviceDoc }).state, "LEGACY_ONLY");
  assert.equal(classifyServiceFixture({ serviceV2: serviceDoc }).state, "V2_ONLY");
  assert.equal(classifyServiceFixture({}).state, "ABSENT");

  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const planFields = { ...plan };
  delete planFields.id;
  const planDoc = { id: plan.id, fields: planFields };
  assert.equal(classifyPlanFixture({ plan: planDoc, planV2: structuredClone(planDoc) }).state, "COMPATIBLE");
  assert.equal(classifyPlanFixture({ plan: { ...planDoc, fields: { ...planFields, servicos_ids: ["other-service"] } }, planV2: structuredClone(planDoc) }).state, "INCOMPATIBLE");
  assert.equal(classifyPlanFixture({ plan: planDoc }).state, "LEGACY_ONLY");
  assert.equal(classifyPlanFixture({ planV2: planDoc }).state, "V2_ONLY");
  assert.equal(classifyPlanFixture({}).state, "ABSENT");

  const derivedPlanDoc = { ...planDoc, fields: { ...planFields, servicos_incluidos: [SERVICE_FIXTURE_NAME] } };
  assert.equal(classifyPlanFixture({
    plan: derivedPlanDoc,
    planV2: structuredClone(derivedPlanDoc),
    service: serviceDoc,
    serviceV2: serviceDoc,
  }).state, "COMPATIBLE");
  const inconsistentDerived = classifyPlanFixture({
    plan: { ...derivedPlanDoc, fields: { ...derivedPlanDoc.fields, servicos_incluidos: ["wrong service"] } },
    planV2: structuredClone(derivedPlanDoc),
    service: serviceDoc,
    serviceV2: serviceDoc,
  });
  assert.equal(inconsistentDerived.state, "INCOMPATIBLE");
  assert.equal(inconsistentDerived.failures[0].failingComparator, "DERIVED_SERVICE_NAMES");

  assert.equal(classifyPlanServiceDependency({ serviceState: "ABSENT", planState: "ABSENT" }).state, "PROVISIONABLE");
  assert.equal(classifyPlanServiceDependency({ serviceState: "COMPATIBLE", planState: "ABSENT" }).state, "READY");
  assert.equal(classifyPlanServiceDependency({ serviceState: "INCOMPATIBLE", planState: "ABSENT" }).state, "INCOMPATIBLE");

  const safeReference = { id: "real-service", fields: { nome: "Serviço normal", duracao: 30, preco: "10", ativo: true } };
  assert.equal(classifyServiceFixture({ service: safeReference, serviceV2: structuredClone(safeReference) }).state, "INCOMPATIBLE");

  const readyPreflight = classifyProvisionPreflight({ ...clientBase, confirmDedicatedClient: true });
  const readiness = evaluateProvisionReadiness({ preflight: readyPreflight, confirmDedicatedClient: true, productionGuardPassed: true, actorsValid: true });
  assert.equal(readyPreflight.client.state, "MUTABLE_TO_FIXTURE");
  assert.equal(readyPreflight.service.state, "ABSENT");
  assert.equal(readyPreflight.plan.state, "ABSENT");
  assert.equal(readyPreflight.dependency.state, "PROVISIONABLE");
  assert.equal(readiness.ready, true);
  assert.deepEqual(readiness.blockers, []);
  assert.equal(readiness.clientOwnershipSource, "EXPLICIT_OPERATOR_CONFIRMATION");
  assert.equal(evaluateProvisionReadiness({ preflight: classifyProvisionPreflight(clientBase), confirmDedicatedClient: false }).ready, false);

  const multi = classifyProvisionPreflight({
    ...clientBase,
    member: { fields: { tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595", papeis: ["ADMIN"] } },
    service: { id: SERVICE_FIXTURE_ID, fields: { nome: "wrong" } },
    serviceV2: { id: SERVICE_FIXTURE_ID, fields: { nome: "wrong" } },
    plan: { id: PLAN_FIXTURE_ID, fields: { ativo: true, servicos_ids: ["wrong"] } },
    planV2: { id: PLAN_FIXTURE_ID, fields: { ativo: true, servicos_ids: ["wrong"] } },
  });
  assert.equal(multi.client.state, "INCOMPATIBLE");
  assert.equal(multi.service.state, "INCOMPATIBLE");
  assert.equal(multi.plan.state, "INCOMPATIBLE");
  assert.ok(multi.failures.length >= 3);
  assert.ok(multi.failures.every((failure) => Array.isArray(failure.differingFields)
    && Array.isArray(failure.missingFields)
    && Array.isArray(failure.extraFields)));
  assert.ok(multi.failures.every((failure) => !Object.hasOwn(failure, "actual") && !Object.hasOwn(failure, "expected")));
});

test("comparador semântico ignora metadados, ordem de chaves e arrays não ordenados", () => {
  const left = {
    nome: "fixture",
    servicos_ids: ["b", "a"],
    criado_em: "timestamp-a",
    nested: { z: 2, a: 1 },
  };
  const right = {
    nested: { a: 1, z: 2 },
    servicos_ids: ["a", "b"],
    atualizado_em: "timestamp-b",
    nome: "fixture",
  };
  assert.equal(semanticFixtureDiff(left, right).equal, true);
  assert.deepEqual(semanticFixtureDiff(left, { ...right, nome: "different" }).differingFields, ["nome"]);
});

test("auditoria de assinatura normaliza timestamps gerados e separa os predicados", () => {
  const legacy = {
    id: "client-x_batch4-plan-dedicated",
    fields: {
      cliente_id: "client-x",
      plano_id: PLAN_FIXTURE_ID,
      status: "RECUSADA",
      solicitado_em: "2026-08-23T00:00:00.001Z",
      termos_aceitos_em: "2026-08-23T00:00:00.002Z",
      recusado_em: "2026-08-23T00:00:01.001Z",
      recusado_por: "admin-x",
    },
  };
  const v2 = {
    id: legacy.id,
    fields: {
      ...legacy.fields,
      solicitado_em: "2026-08-23T00:00:00.101Z",
      termos_aceitos_em: "2026-08-23T00:00:00.202Z",
      recusado_em: "2026-08-23T00:00:01.101Z",
    },
  };
  assert.equal(subscriptionSemanticDiff(legacy, v2).equal, true);
  const result = compareSubscriptionFinalState({
    subscription: { legacy, v2 },
    expectedClientId: "client-x",
    expectedPlanId: PLAN_FIXTURE_ID,
  });
  assert.equal(result.pass, true);
  assert.deepEqual(result.FAILING_PREDICATES, []);
  assert.equal(result.ACTIVE_CREDITS_PRESENT, "NÃO");
});

test("auditoria de assinatura expõe somente predicados e campos divergentes", () => {
  const result = compareSubscriptionFinalState({
    subscription: {
      legacy: { id: "safe-id", fields: { cliente_id: "wrong-client", plano_id: "wrong-plan", status: "PENDENTE", creditos_mensais: { restantes: 1 } } },
      v2: { id: "safe-id", fields: { cliente_id: "wrong-client", plano_id: "wrong-plan", status: "PENDENTE", creditos_mensais: { restantes: 1 } } },
    },
    expectedClientId: "client-x",
    expectedPlanId: PLAN_FIXTURE_ID,
  });
  assert.equal(result.pass, false);
  assert.deepEqual(result.FAILING_PREDICATES, [
    "SUBSCRIPTION_STATUS_MATCH",
    "SUBSCRIPTION_CLIENT_MATCH",
    "SUBSCRIPTION_PLAN_MATCH",
    "ACTIVE_CREDITS_ABSENT",
  ]);
  assert.deepEqual(result.DIFFERING_FIELDS, []);
  assert.equal(Object.hasOwn(result, "actual"), false);
  assert.equal(Object.hasOwn(result, "expected"), false);
});

test("auditoria read-only classifica plano e assinatura sem inferir mutação", () => {
  const result = summarizePlanStateAudit({
    plan: { id: PLAN_FIXTURE_ID, fields: { ativo: false, servicos_ids: [SERVICE_FIXTURE_ID] } },
    planV2: { id: PLAN_FIXTURE_ID, fields: { ativo: false, servicos_ids: [SERVICE_FIXTURE_ID] } },
    service: { id: SERVICE_FIXTURE_ID, fields: { nome: SERVICE_FIXTURE_NAME } },
    serviceV2: { id: SERVICE_FIXTURE_ID, fields: { nome: SERVICE_FIXTURE_NAME } },
    subscription: { legacy: null, v2: null, exists: false },
    expectedClientId: "client-x",
    expectedPlanId: PLAN_FIXTURE_ID,
  });
  assert.equal(result.PLAN_FINAL_ACTIVE_STATE, false);
  assert.equal(result.SUBSCRIPTION_DOCUMENT_PRESENT, "NÃO");
  assert.equal(result.ACTIVE_CREDITS_PRESENT, "NÃO");
  assert.equal(result.PARTIAL_WRITE_FINAL_CLASSIFICATION, "NÃO");
});

test("caminho do executor separa resposta recebida de falha da auditoria final", async () => {
  const service = buildServiceFixture();
  const serviceFields = { ...service };
  delete serviceFields.id;
  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const planFields = { ...plan, servicos_incluidos: [SERVICE_FIXTURE_NAME] };
  delete planFields.id;
  const snapshot = () => ({
    client: { id: "client-x", fields: { nome: "batch4-client-fixture" } },
    clientV2: { id: "client-x", fields: { nome: "batch4-client-fixture" } },
    member: { fields: { tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595", papeis: ["CLIENTE"] } },
    admin: null,
    service: { id: SERVICE_FIXTURE_ID, fields: serviceFields },
    serviceV2: { id: SERVICE_FIXTURE_ID, fields: structuredClone(serviceFields) },
    plan: { id: PLAN_FIXTURE_ID, fields: { ...planFields } },
    planV2: { id: PLAN_FIXTURE_ID, fields: { ...planFields } },
  });
  const subscriptionId = `client-x_${PLAN_FIXTURE_ID}`;
  let planActive = false;
  let subscriptionCreated = false;
  let rejectCreated = false;
  const requestIds = new Set();
  const transport = {
    async call(command, data, requestId) {
      if (command === "admin.plano.ativar") {
        const duplicate = requestIds.has(requestId);
        requestIds.add(requestId);
        planActive = data.ativo === true;
        return { duplicate, planId: PLAN_FIXTURE_ID };
      }
      if (command === "assinatura.solicitar") {
        const duplicate = subscriptionCreated;
        subscriptionCreated = true;
        return { duplicate, subscriptionId, status: "PENDENTE" };
      }
      const duplicate = rejectCreated;
      rejectCreated = true;
      return { duplicate, subscriptionId, status: "RECUSADA" };
    },
  };
  const audit = {
    async readFixtureState() {
      const state = snapshot();
      state.plan.fields.ativo = planActive;
      state.planV2.fields.ativo = planActive;
      return state;
    },
    async readSubscription(_id, { stage } = {}) {
      if (stage === "SUBSCRIPTION_PREFLIGHT") return { legacy: null, v2: null, exists: false };
      return {
        legacy: { id: subscriptionId, fields: { cliente_id: "wrong-client", plano_id: PLAN_FIXTURE_ID, status: "PENDENTE" } },
        v2: { id: subscriptionId, fields: { cliente_id: "wrong-client", plano_id: PLAN_FIXTURE_ID, status: "PENDENTE" } },
        exists: true,
        legacyV2Equivalent: true,
      };
    },
  };
  let caught;
  await assert.rejects(() => runBatch4Safe({
    project: HML_PROJECT,
    confirmHmlWrite: true,
    adminIdentity: { authUid: "admin-x", operationalUid: "admin-x", isAdmin: true, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    clientIdentity: { authUid: "client-x", operationalUid: "client-x", isAdmin: false, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    fixturePolicy: { purpose: "batch4-admin-domain-tests", project: HML_PROJECT, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595", dedicated: true, sharedWithRealHmlUsage: false, persistentHistoryAllowed: true },
    transport,
    audit,
  }), (error) => {
    caught = error;
    return true;
  });
  assert.equal(caught.message, "SUBSCRIPTION_FINAL_AUDIT_FAILED");
  assert.equal(caught.subscriptionCallableResponseReceived, true);
  assert.equal(caught.subscriptionRequestResponseReceived, true);
  assert.equal(caught.subscriptionRejectResponseReceived, true);
  assert.equal(caught.planFinalAuditCompleted, false);
  assert.equal(caught.mutationStarted, true);
  assert.equal(caught.subscriptionAuditResult.SUBSCRIPTION_STATUS_MATCH, "NÃO");
  assert.deepEqual(caught.subscriptionAuditResult.FAILING_PREDICATES, ["SUBSCRIPTION_STATUS_MATCH", "SUBSCRIPTION_CLIENT_MATCH"]);
});

test("executor mantém estágio monotônico e identifica falha na auditoria do plano", async () => {
  const state = {
    client: { id: "client-stage", fields: { nome: "client before marker" } },
    clientV2: { id: "client-stage", fields: { nome: "client before marker" } },
    member: { fields: { papeis: ["CLIENTE"] } },
    admin: null,
    service: null,
    serviceV2: null,
    plan: null,
    planV2: null,
  };
  const tracker = { created: [], completed: [], currentStage: "PREFLIGHT", lastSuccessfulStage: "", failedStage: "" };
  const transport = {
    async call(command, data) {
      if (command === CLIENT_PROFILE_UPDATE_COMMAND) {
        state.client.fields = { ...state.client.fields, ...data };
        state.clientV2.fields = { ...state.clientV2.fields, ...data };
      } else if (command === SERVICE_PROVISION_COMMAND) {
        const { id, ...fields } = data;
        state.service = { id, fields };
        state.serviceV2 = { id, fields: structuredClone(fields) };
      } else {
        const { id, ...fields } = data;
        state.plan = { id, fields };
        state.planV2 = { id, fields: { ...fields, servicos_incluidos: ["wrong service"] } };
      }
      return { duplicate: false };
    },
  };
  await assert.rejects(() => provisionBatch4Fixtures({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
    adminIdentity: { authUid: "admin-stage", isAdmin: true, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    clientIdentity: { authUid: "client-stage", operationalUid: "client-stage", isAdmin: false, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    serviceId: SERVICE_FIXTURE_ID,
    tracker,
    transport,
    audit: { readFixtureState: async () => structuredClone(state) },
  }), /PROVISION_PLAN_AUDIT_FAILED|PLAN_INCOMPATIBLE/);
  assert.equal(tracker.lastSuccessfulStage, "PLAN_CREATE");
  assert.equal(tracker.failedStage, "PLAN_AUDIT");
});

test("as três fixtures existentes são somente NOOP e compatíveis no caminho do executor", async () => {
  const service = buildServiceFixture();
  const serviceFields = { ...service };
  delete serviceFields.id;
  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const planFields = { ...plan, servicos_incluidos: [SERVICE_FIXTURE_NAME] };
  delete planFields.id;
  const state = {
    client: { id: "client-existing", fields: { nome: "batch4-client-fixture" } },
    clientV2: { id: "client-existing", fields: { nome: "batch4-client-fixture" } },
    member: { fields: { papeis: ["CLIENTE"] } },
    admin: null,
    service: { id: service.id, fields: serviceFields },
    serviceV2: { id: service.id, fields: structuredClone(serviceFields) },
    plan: { id: plan.id, fields: planFields },
    planV2: { id: plan.id, fields: structuredClone(planFields) },
  };
  const calls = [];
  const result = await provisionBatch4Fixtures({
    project: HML_PROJECT,
    adminAuth: "interactive",
    clientAuth: "interactive",
    confirmDedicatedClient: true,
    confirmPersistentFixture: true,
    adminIdentity: { authUid: "admin-existing", isAdmin: true, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    clientIdentity: { authUid: "client-existing", operationalUid: "client-existing", isAdmin: false, isBarber: false, tenant: "tnt_80b2fda7ad644a1dbeff050aa8e0d595" },
    serviceId: SERVICE_FIXTURE_ID,
    transport: { call: async (...args) => { calls.push(args); return { duplicate: false }; } },
    audit: { readFixtureState: async () => structuredClone(state) },
  });
  assert.equal(result.writes, 0);
  assert.deepEqual(result.commands, []);
  assert.equal(calls.length, 0);
  assert.equal(result.audits.length, 3);
});

test("dispatcher CLI de fixture-preflight exige o relatório dedicado", async () => {
  const required = {
    CLIENT_FIXTURE_STATE: "COMPATIBLE",
    SERVICE_FIXTURE_STATE: "COMPATIBLE",
    PLAN_FIXTURE_STATE: "COMPATIBLE",
    PLAN_SERVICE_DEPENDENCY: "READY",
    READINESS_BLOCKERS: [],
  };
  const originalLog = console.log;
  let output = "";
  console.log = (value) => { output += String(value); };
  try {
    await main([
      "--project=teste-483f6",
      "--auth-admin=interactive",
      "--auth-client=interactive",
      "--fixture-preflight-only",
    ], { runFixtureReadOnlyPreflight: async () => required });
  } finally {
    console.log = originalLog;
  }
  const report = JSON.parse(output);
  for (const field of Object.keys(required)) assert.ok(Object.hasOwn(report, field), `missing ${field}`);
  assert.equal(report.CLIENT_FIXTURE_STATE, "COMPATIBLE");
  assert.equal(report.PLAN_SERVICE_DEPENDENCY, "READY");
});

test("dispatcher CLI do plano read-only não alcança mutações", async () => {
  let called = false;
  const originalLog = console.log;
  let output = "";
  console.log = (value) => { output += String(value); };
  try {
    await main([
      "--project=teste-483f6",
      "--auth-admin=interactive",
      "--auth-client=interactive",
      "--plan-state-read-only",
    ], {
      runPlanStateReadOnlyAudit: async () => {
        called = true;
        return {
          PLAN_LEGACY_PRESENT: "SIM",
          PLAN_V2_PRESENT: "SIM",
          PLAN_FINAL_ACTIVE_STATE: false,
          SUBSCRIPTION_CALLABLE_SENT: "NÃO",
          HML_DATA_CHANGED: "NÃO",
        };
      },
    });
  } finally {
    console.log = originalLog;
  }
  assert.equal(called, true);
  assert.equal(JSON.parse(output).SUBSCRIPTION_CALLABLE_SENT, "NÃO");
});
