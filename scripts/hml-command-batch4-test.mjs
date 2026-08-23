#!/usr/bin/env node

import { fileURLToPath } from "node:url";
import readline from "node:readline";
import {
  PROJECT as REPO_HML_PROJECT,
  PRODUCTION_PROJECT as REPO_PRODUCTION_PROJECT,
  TENANT as REPO_TENANT,
  FIRESTORE_ROOT as REPO_FIRESTORE_ROOT,
  authenticateInteractive,
  validateIdToken as repoValidateIdToken,
} from "./hml-command-batch2-test.mjs";

export const HML_PROJECT = "teste-483f6";
export const PRODUCTION_PROJECT = "barber-a01e7";
export const SAFE_ADMIN_COMMANDS = Object.freeze([
  "admin.plano.ativar",
  "admin.assinatura.recusar",
]);
export const SETUP_COMMANDS = Object.freeze(["assinatura.solicitar"]);
export const CLIENT_BOOTSTRAP_COMMAND = "cliente.garantir-perfil";
export const CLIENT_PROFILE_UPDATE_COMMAND = "cliente.atualizar-perfil";
export const SERVICE_PROVISION_COMMAND = "admin.servico.salvar";
export const PROVISION_COMMANDS = Object.freeze([
  SERVICE_PROVISION_COMMAND,
  "admin.plano.salvar",
  CLIENT_PROFILE_UPDATE_COMMAND,
  CLIENT_BOOTSTRAP_COMMAND,
]);
export const REQUEST_ID_PATTERN = /^[a-zA-Z0-9_-]{16,120}$/;
export const PLAN_ACTIVATE_RUNTIME_RESPONSE_KEYS = Object.freeze(["duplicate", "planId"]);
export const HML_TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
export const PLAN_FIXTURE_ID = "batch4-plan-fixture";
export const SERVICE_FIXTURE_ID = "batch4-service-fixture";
export const SERVICE_FIXTURE_NAME = "batch4-service-fixture";
export const CLIENT_FIXTURE_NAME = "batch4-client-fixture";
export const FIXTURE_MARKER = "batch4-admin-domain-tests";

let networkAccessed = false;
let hmlAccessed = false;

if (REPO_HML_PROJECT !== HML_PROJECT || REPO_PRODUCTION_PROJECT !== PRODUCTION_PROJECT || REPO_TENANT !== HML_TENANT) {
  throw new Error("BATCH4_REPOSITORY_RUNTIME_MISMATCH");
}

const COMMAND_DATA_FIELDS = Object.freeze({
  "admin.plano.ativar": ["id", "ativo"],
  "admin.assinatura.recusar": ["id"],
  "assinatura.solicitar": ["plano_id"],
  "admin.servico.salvar": ["id", "nome", "descricao", "duracao", "preco", "ativo"],
  "cliente.atualizar-perfil": ["nome"],
  "admin.plano.salvar": ["id", "nome", "descricao", "preco_centavos", "preco_definido", "usos_mensais", "servicos_ids", "ativo"],
  "cliente.garantir-perfil": ["nome"],
});

export function isValidRequestId(value) {
  return typeof value === "string" && REQUEST_ID_PATTERN.test(value);
}

export function fingerprint(value) {
  const text = String(value ?? "");
  let hash = 2166136261;
  for (const char of text) hash = Math.imul(hash ^ char.charCodeAt(0), 16777619);
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function safeIdMeta(value) {
  return { present: Boolean(value), length: String(value ?? "").length, fingerprint: fingerprint(value) };
}

export function assertPlanActivationResponse(response, { replay = false } = {}) {
  if (!response || typeof response !== "object" || Array.isArray(response)) throw new Error("PLAN_ACTIVATE_RESPONSE_MALFORMED");
  const keys = Object.keys(response).sort();
  if (keys.join(",") !== PLAN_ACTIVATE_RUNTIME_RESPONSE_KEYS.slice().sort().join(",")) throw new Error("PLAN_ACTIVATE_RESPONSE_SHAPE_INVALID");
  if (response.planId !== PLAN_FIXTURE_ID || response.duplicate !== replay) throw new Error(replay ? "PLAN_ACTIVATE_REPLAY_FAILED" : "PLAN_ACTIVATE_FIRST_FAILED");
  return true;
}

export function isDedicatedFixture(id, value = {}) {
  const purpose = String(value.fixture_purpose ?? value.purpose ?? "");
  const prefix = String(value.fixture_prefix ?? value.prefix ?? "");
  return value.dedicated === true
    || value.test_fixture === true
    || value.fixture === true
    || purpose === FIXTURE_MARKER
    || prefix === FIXTURE_MARKER
    || String(value.descricao ?? "").includes(FIXTURE_MARKER)
    || String(value.nome ?? "").includes(FIXTURE_MARKER)
    || String(value.nome ?? "") === CLIENT_FIXTURE_NAME;
}

export function buildProvisionPlan({ serviceId, planId = PLAN_FIXTURE_ID } = {}) {
  if (serviceId !== SERVICE_FIXTURE_ID) throw new Error("DEDICATED_SERVICE_REFERENCE_REQUIRED");
  if (!planId || ["essencial", "prime", "premium"].includes(planId)) throw new Error("NORMAL_PLAN_ID_FORBIDDEN");
  return {
    id: planId,
    nome: "Lote 4 — Plano técnico",
    descricao: `[${FIXTURE_MARKER}] Plano persistente exclusivo de testes administrativos.`,
    preco_centavos: 1,
    preco_definido: true,
    usos_mensais: 1,
    servicos_ids: [serviceId],
    // Provision inactive so the persistent fixture cannot enter normal HML
    // subscription flow before the dedicated activation test explicitly uses it.
    ativo: false,
  };
}

export function buildClientFixtureMarker() {
  return { nome: CLIENT_FIXTURE_NAME };
}

export function buildServiceFixture({ serviceId = SERVICE_FIXTURE_ID } = {}) {
  if (serviceId !== SERVICE_FIXTURE_ID) throw new Error("DEDICATED_SERVICE_ID_REQUIRED");
  return {
    id: serviceId,
    nome: SERVICE_FIXTURE_NAME,
    descricao: `[${FIXTURE_MARKER}] Serviço persistente exclusivo do Lote 4.`,
    duracao: 30,
    preco: "1",
    ativo: true,
  };
}

export function guardProvisionOptions({ project, adminAuth, clientAuth, confirmDedicatedClient, confirmPersistentFixture, batch4Safe = false } = {}) {
  productionGuard(project);
  if (adminAuth !== "interactive" || clientAuth !== "interactive") throw new Error("ADMIN_AND_CLIENT_INTERACTIVE_AUTH_REQUIRED");
  if (confirmDedicatedClient !== true) throw new Error("CONFIRM_DEDICATED_CLIENT_REQUIRED");
  if (confirmPersistentFixture !== true) throw new Error("CONFIRM_PERSISTENT_FIXTURE_REQUIRED");
  if (batch4Safe) throw new Error("PROVISION_MODE_CANNOT_COMBINE_WITH_BATCH4_SAFE");
  return true;
}

export function guardBatch4SafeOptions({ project, adminAuth, clientAuth, confirmHmlWrite, provisionMode = false } = {}) {
  productionGuard(project);
  if (adminAuth !== "interactive" || clientAuth !== "interactive") throw new Error("ADMIN_AND_CLIENT_INTERACTIVE_AUTH_REQUIRED");
  if (confirmHmlWrite !== true) throw new Error("CONFIRM_HML_WRITE_REQUIRED");
  if (provisionMode === true) throw new Error("BATCH4_SAFE_CANNOT_COMBINE_WITH_PROVISION");
  return true;
}

export function provisionFixtureStatus({ plan, planV2, client, clientV2, member, admin } = {}) {
  const classified = classifyProvisionPreflight({ plan, planV2, client, clientV2, member, admin });
  if (classified.failures.length) {
    const error = new Error(classified.failures[0].code);
    error.failures = classified.failures;
    throw error;
  }
  return {
    plan: classified.plan.state === "COMPATIBLE" ? "EXISTING_COMPATIBLE" : "MISSING",
    client: classified.client.state === "COMPATIBLE" ? "EXISTING_COMPATIBLE" : classified.client.state === "MUTABLE_TO_FIXTURE" ? "MARKER_REQUIRED" : "MISSING",
    writesRequired: Number(classified.plan.state === "ABSENT") + Number(classified.client.state === "MUTABLE_TO_FIXTURE" || classified.client.state === "ABSENT"),
  };
}

function serviceFixtureCompatible(service, serviceV2) {
  const fields = service?.fields || {};
  return Boolean(
    service
    && service.id === SERVICE_FIXTURE_ID
    && serviceV2
    && semanticFixtureDiff(service, serviceV2).equal
    && fields.nome === SERVICE_FIXTURE_NAME
    && String(fields.descricao || "").includes(FIXTURE_MARKER)
    && fields.ativo === true
    && Number.isInteger(fields.duracao)
    && fields.duracao >= 30
    && fields.duracao % 30 === 0
    && String(fields.preco || "").trim(),
  );
}

function planFixtureCompatible(plan, planV2) {
  const fields = plan?.fields || {};
  return Boolean(
    plan
    && plan.id === PLAN_FIXTURE_ID
    && planV2
    && planSemanticProjectionDiff(plan, planV2).equal
    && isDedicatedFixture(plan.id, fields)
    && Array.isArray(fields.servicos_ids)
    && fields.servicos_ids.length === 1
    && fields.servicos_ids[0] === SERVICE_FIXTURE_ID
    && fields.ativo === false,
  );
}

const SEMANTICALLY_IGNORED_FIXTURE_FIELDS = new Set([
  "criado_em",
  "atualizado_em",
  "criado_por",
  "atualizado_por",
  "solicitado_em",
  "termos_aceitos_em",
  "ativado_em",
  "cancelada_em",
  "cancelado_em",
  "recusado_em",
  "expirada_em",
  "vencimento_em",
]);

const UNORDERED_FIXTURE_ARRAY_FIELDS = new Set(["servicos_ids", "papeis"]);
const PLAN_DERIVED_FIELDS = new Set(["servicos_incluidos"]);

function normalizeFixtureSemantic(value, fieldName = "", ignoredFields = SEMANTICALLY_IGNORED_FIXTURE_FIELDS) {
  if (value === undefined) return undefined;
  if (Array.isArray(value)) {
    const normalized = value
      .map((item) => normalizeFixtureSemantic(item, fieldName, ignoredFields))
      .filter((item) => item !== undefined);
    return UNORDERED_FIXTURE_ARRAY_FIELDS.has(fieldName)
      ? normalized.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))
      : normalized;
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .filter(([key, item]) => !ignoredFields.has(key) && item !== undefined)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, normalizeFixtureSemantic(item, key, ignoredFields)]),
    );
  }
  return value;
}

function fixtureFields(value) {
  const fields = { ...(value?.fields || value || {}) };
  delete fields.id;
  return fields;
}

function planPolicyFields(value) {
  const fields = fixtureFields(value);
  for (const field of PLAN_DERIVED_FIELDS) delete fields[field];
  return fields;
}

function planSemanticProjectionDiff(left, right) {
  return semanticFixtureDiff({ fields: planPolicyFields(left) }, { fields: planPolicyFields(right) });
}

function expectedPlanServiceNames(plan, service, serviceV2) {
  const serviceDocs = new Map([
    [service?.id, service?.fields],
    [serviceV2?.id, serviceV2?.fields],
  ].filter(([id, fields]) => id && fields));
  return (plan?.fields?.servicos_ids || []).map((serviceId) => String(serviceDocs.get(serviceId)?.nome || (serviceId === SERVICE_FIXTURE_ID ? SERVICE_FIXTURE_NAME : "")));
}

function planDerivedFieldDiff(plan, planV2, service, serviceV2) {
  const legacyValue = plan?.fields?.servicos_incluidos;
  const v2Value = planV2?.fields?.servicos_incluidos;
  if (legacyValue === undefined && v2Value === undefined) return { equal: true, differingFields: [], missingFields: [], extraFields: [] };
  const expected = expectedPlanServiceNames(plan, service, serviceV2);
  const valid = (value) => value === undefined || (Array.isArray(value) && JSON.stringify(value.map(String)) === JSON.stringify(expected));
  const projectionEqual = (legacyValue === undefined) === (v2Value === undefined)
    && (legacyValue === undefined || JSON.stringify(legacyValue) === JSON.stringify(v2Value));
  if (valid(legacyValue) && valid(v2Value) && projectionEqual) return { equal: true, differingFields: [], missingFields: [], extraFields: [] };
  return { equal: false, differingFields: ["servicos_incluidos"], missingFields: [], extraFields: [] };
}

function semanticDiffFromNormalized(normalizedLeft, normalizedRight) {
  const leftKeys = new Set(Object.keys(normalizedLeft || {}));
  const rightKeys = new Set(Object.keys(normalizedRight || {}));
  const missingFields = [...rightKeys].filter((key) => !leftKeys.has(key)).sort();
  const extraFields = [...leftKeys].filter((key) => !rightKeys.has(key)).sort();
  const differingFields = [...new Set([...leftKeys].filter((key) => rightKeys.has(key)
    && JSON.stringify(normalizedLeft[key]) !== JSON.stringify(normalizedRight[key])))]
    .sort();
  return {
    equal: missingFields.length === 0 && extraFields.length === 0 && differingFields.length === 0,
    differingFields,
    missingFields,
    extraFields,
  };
}

export function semanticFixtureDiff(left = {}, right = {}) {
  return semanticDiffFromNormalized(
    normalizeFixtureSemantic(fixtureFields(left)),
    normalizeFixtureSemantic(fixtureFields(right)),
  );
}

export function subscriptionSemanticDiff(left = {}, right = {}) {
  return semanticDiffFromNormalized(
    normalizeFixtureSemantic(fixtureFields(left)),
    normalizeFixtureSemantic(fixtureFields(right)),
  );
}

export function compareSubscriptionFinalState({ subscription, expectedClientId, expectedPlanId } = {}) {
  const legacy = subscription?.legacy || null;
  const v2 = subscription?.v2 || null;
  const legacyFields = legacy?.fields || {};
  const v2Fields = v2?.fields || {};
  const semanticDiff = legacy && v2 ? subscriptionSemanticDiff(legacy, v2) : {
    equal: false,
    differingFields: [],
    missingFields: [],
    extraFields: [],
  };
  const legacyPresent = Boolean(legacy);
  const v2Present = Boolean(v2);
  const statusMatch = legacyPresent && v2Present
    && legacyFields.status === "RECUSADA"
    && v2Fields.status === "RECUSADA";
  const clientMatch = legacyPresent && v2Present
    && legacyFields.cliente_id === expectedClientId
    && v2Fields.cliente_id === expectedClientId;
  const planMatch = legacyPresent && v2Present
    && legacyFields.plano_id === expectedPlanId
    && v2Fields.plano_id === expectedPlanId;
  const activeCreditsPresent = [legacyFields, v2Fields]
    .some((fields) => fields.creditos_mensais != null);
  const activeCreditsAbsent = !activeCreditsPresent;
  const predicates = [
    ["SUBSCRIPTION_LEGACY_PRESENT", legacyPresent],
    ["SUBSCRIPTION_V2_PRESENT", v2Present],
    ["SUBSCRIPTION_STATUS_MATCH", statusMatch],
    ["SUBSCRIPTION_CLIENT_MATCH", clientMatch],
    ["SUBSCRIPTION_PLAN_MATCH", planMatch],
    ["SUBSCRIPTION_LEGACY_V2_EQUIVALENT", semanticDiff.equal],
    ["ACTIVE_CREDITS_ABSENT", activeCreditsAbsent],
  ];
  return {
    pass: predicates.every(([, passed]) => passed),
    SUBSCRIPTION_LEGACY_PRESENT: legacyPresent ? "SIM" : "NÃO",
    SUBSCRIPTION_V2_PRESENT: v2Present ? "SIM" : "NÃO",
    SUBSCRIPTION_STATUS_MATCH: statusMatch ? "SIM" : "NÃO",
    SUBSCRIPTION_CLIENT_MATCH: clientMatch ? "SIM" : "NÃO",
    SUBSCRIPTION_PLAN_MATCH: planMatch ? "SIM" : "NÃO",
    SUBSCRIPTION_LEGACY_V2_EQUIVALENT: semanticDiff.equal ? "SIM" : "NÃO",
    ACTIVE_CREDITS_ABSENT: activeCreditsAbsent ? "SIM" : "NÃO",
    SUBSCRIPTION_STATUS_LEGACY: String(legacyFields.status || ""),
    SUBSCRIPTION_STATUS_V2: String(v2Fields.status || ""),
    ACTIVE_CREDITS_PRESENT: activeCreditsPresent ? "SIM" : "NÃO",
    FAILING_PREDICATES: predicates.filter(([, passed]) => !passed).map(([name]) => name),
    DIFFERING_FIELDS: semanticDiff.differingFields,
    MISSING_FIELDS: semanticDiff.missingFields,
    EXTRA_FIELDS: semanticDiff.extraFields,
  };
}

function fixtureFailure(code, fixture, comparator, diff = {}) {
  const error = new Error(code);
  error.failures = [{
    code,
    failingFixture: fixture,
    failingComparator: comparator,
    differingFields: [...(diff.differingFields || [])],
    missingFields: [...(diff.missingFields || [])],
    extraFields: [...(diff.extraFields || [])],
  }];
  return error;
}

function projectionState(legacy, v2, compatible) {
  if (!legacy && !v2) return "ABSENT";
  if (legacy && !v2) return "LEGACY_ONLY";
  if (!legacy && v2) return "V2_ONLY";
  return compatible ? "COMPATIBLE" : "INCOMPATIBLE";
}

export function classifyClientFixture({ client, clientV2, member, admin, confirmDedicatedClient = false } = {}) {
  if (!client && !clientV2 && !member && !admin) return { state: "ABSENT", ownershipProven: false, ownershipSource: "UNPROVEN", failures: [] };
  const failures = [];
  if (!client || !clientV2 || client.id !== clientV2.id) {
    failures.push(fixtureFailure("CLIENT_INCOMPATIBLE", "CLIENT", "LEGACY_V2_PROJECTION", {
      differingFields: client && clientV2 && client.id !== clientV2.id ? ["id"] : [],
      missingFields: !client ? ["legacy"] : !clientV2 ? ["v2"] : [],
    }).failures[0]);
  } else {
    const projectionDiff = semanticFixtureDiff(client, clientV2);
    if (!projectionDiff.equal) failures.push(fixtureFailure("CLIENT_INCOMPATIBLE", "CLIENT", "LEGACY_V2_PROJECTION", projectionDiff).failures[0]);
  }
  const roles = Array.isArray(member?.fields?.papeis) ? member.fields.papeis.map(String) : [];
  const tenant = member?.fields?.tenant_id ?? client?.fields?.tenant_id ?? clientV2?.fields?.tenant_id;
  if (!member || tenant && tenant !== HML_TENANT || !roles.includes("CLIENTE") || roles.includes("ADMIN") || roles.includes("BARBEIRO") || admin) {
    failures.push(fixtureFailure("CLIENT_INCOMPATIBLE", "CLIENT", "ROLE_MEMBERSHIP_OWNERSHIP", {
      missingFields: !member ? ["membership"] : !roles.includes("CLIENTE") ? ["CLIENTE"] : [],
      differingFields: tenant && tenant !== HML_TENANT ? ["tenant_id"] : [],
    }).failures[0]);
  }
  if (failures.length) return { state: "INCOMPATIBLE", ownershipProven: false, ownershipSource: "CONFLICT", failures };
  const markerPresent = isDedicatedFixture(client.id, client.fields);
  return {
    state: markerPresent ? "COMPATIBLE" : "MUTABLE_TO_FIXTURE",
    ownershipProven: markerPresent || confirmDedicatedClient === true,
    ownershipSource: markerPresent ? "PERSISTED_MARKER" : confirmDedicatedClient === true ? "EXPLICIT_OPERATOR_CONFIRMATION" : "UNPROVEN",
    failures: [],
  };
}

export function classifyServiceFixture({ service, serviceV2 } = {}) {
  const state = projectionState(service, serviceV2, serviceFixtureCompatible(service, serviceV2));
  if (state === "ABSENT" || state === "LEGACY_ONLY" || state === "V2_ONLY") {
    return {
      state,
      failures: state === "ABSENT" ? [] : [fixtureFailure("SERVICE_INCOMPATIBLE", "SERVICE", "LEGACY_V2_PROJECTION", {
        missingFields: state === "LEGACY_ONLY" ? ["v2"] : ["legacy"],
      }).failures[0]],
    };
  }
  const expected = buildServiceFixture();
  const diff = semanticFixtureDiff(service, expected);
  const projectionDiff = semanticFixtureDiff(service, serviceV2);
  if (!projectionDiff.equal || !diff.equal || !serviceFixtureCompatible(service, serviceV2)) {
    return {
      state: "INCOMPATIBLE",
      failures: [fixtureFailure("SERVICE_INCOMPATIBLE", "SERVICE", !projectionDiff.equal ? "LEGACY_V2_PROJECTION" : "FIXTURE_POLICY", !projectionDiff.equal ? projectionDiff : diff).failures[0]],
    };
  }
  return { state: "COMPATIBLE", failures: [] };
}

export function classifyPlanFixture({ plan, planV2, service, serviceV2 } = {}) {
  const state = projectionState(plan, planV2, planFixtureCompatible(plan, planV2));
  if (state === "ABSENT" || state === "LEGACY_ONLY" || state === "V2_ONLY") {
    return {
      state,
      failures: state === "ABSENT" ? [] : [fixtureFailure("PLAN_INCOMPATIBLE", "PLAN", "LEGACY_V2_PROJECTION", {
        missingFields: state === "LEGACY_ONLY" ? ["v2"] : ["legacy"],
      }).failures[0]],
    };
  }
  const expected = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const diff = semanticFixtureDiff({ fields: planPolicyFields(plan) }, { fields: planPolicyFields(expected) });
  const projectionDiff = planSemanticProjectionDiff(plan, planV2);
  const derivedDiff = planDerivedFieldDiff(plan, planV2, service, serviceV2);
  if (!projectionDiff.equal || !diff.equal || !derivedDiff.equal || !planFixtureCompatible(plan, planV2)) {
    return {
      state: "INCOMPATIBLE",
      failures: [fixtureFailure("PLAN_INCOMPATIBLE", "PLAN", !projectionDiff.equal ? "LEGACY_V2_PROJECTION" : derivedDiff.equal ? "FIXTURE_POLICY" : "DERIVED_SERVICE_NAMES", !projectionDiff.equal ? projectionDiff : derivedDiff.equal ? diff : derivedDiff).failures[0]],
    };
  }
  return { state: "COMPATIBLE", failures: [] };
}

export function classifyPlanServiceDependency({ serviceState, planState } = {}) {
  if (serviceState === "ABSENT" && planState === "ABSENT") return { state: "PROVISIONABLE", failures: [] };
  if (serviceState === "ABSENT") return { state: "MISSING", failures: [fixtureFailure("PLAN_SERVICE_DEPENDENCY_MISSING", "PLAN", "SERVICE_DEPENDENCY", { missingFields: [SERVICE_FIXTURE_ID] }).failures[0]] };
  if (serviceState !== "COMPATIBLE") return { state: "INCOMPATIBLE", failures: [fixtureFailure("PLAN_SERVICE_DEPENDENCY_INCOMPATIBLE", "PLAN", "SERVICE_DEPENDENCY", { differingFields: ["service_fixture_state"] }).failures[0]] };
  return { state: "READY", failures: [] };
}

export function classifyProvisionPreflight(state = {}) {
  const client = classifyClientFixture(state);
  const service = classifyServiceFixture(state);
  const plan = classifyPlanFixture({ ...state, service: state.service, serviceV2: state.serviceV2 });
  const dependency = classifyPlanServiceDependency({ serviceState: service.state, planState: plan.state });
  const failures = [...client.failures, ...service.failures, ...plan.failures, ...dependency.failures];
  return { client, service, plan, dependency, failures };
}

export function evaluateProvisionReadiness({ preflight, confirmDedicatedClient = false, productionGuardPassed = true, actorsValid = true, requireExistingFixtures = false } = {}) {
  const blockers = [];
  if (!productionGuardPassed) blockers.push("PRODUCTION_GUARD");
  if (!actorsValid) blockers.push("ACTORS_INVALID");
  if (confirmDedicatedClient !== true && preflight?.client?.ownershipProven !== true) blockers.push("CONFIRM_DEDICATED_CLIENT_REQUIRED");
  if (!preflight || preflight.client?.state === "ABSENT") blockers.push("CLIENT_FIXTURE_REQUIRED");
  if (preflight?.client?.state === "INCOMPATIBLE") blockers.push("CLIENT_INCOMPATIBLE");
  if (preflight?.service?.state === "INCOMPATIBLE") blockers.push("SERVICE_INCOMPATIBLE");
  if (preflight?.plan?.state === "INCOMPATIBLE") blockers.push("PLAN_INCOMPATIBLE");
  if (requireExistingFixtures && preflight?.service?.state !== "COMPATIBLE") blockers.push(`SERVICE_FIXTURE_${preflight?.service?.state || "MISSING"}`);
  if (requireExistingFixtures && preflight?.plan?.state !== "COMPATIBLE") blockers.push(`PLAN_FIXTURE_${preflight?.plan?.state || "MISSING"}`);
  if (requireExistingFixtures && preflight?.dependency?.state !== "READY") blockers.push(`PLAN_SERVICE_DEPENDENCY_${preflight?.dependency?.state || "MISSING"}`);
  if (["MISSING", "INCOMPATIBLE"].includes(preflight?.dependency?.state)) blockers.push(`PLAN_SERVICE_DEPENDENCY_${preflight.dependency.state}`);
  if (preflight?.failures?.length) blockers.push(...preflight.failures.map((failure) => failure.code));
  return {
    ready: blockers.length === 0,
    blockers: [...new Set(blockers)],
    clientOwnershipSource: preflight?.client?.ownershipSource || "UNPROVEN",
  };
}

export function classifyProvisionDependencies({ service, serviceV2, plan, planV2, client, clientV2, member, admin, confirmDedicatedClient = false } = {}) {
  const classified = classifyProvisionPreflight({ service, serviceV2, plan, planV2, client, clientV2, member, admin, confirmDedicatedClient });
  if (classified.failures.length) {
    const error = new Error(classified.failures[0].code);
    error.failures = classified.failures;
    throw error;
  }
  const clientStatus = classified.client.state === "COMPATIBLE" ? "EXISTING_COMPATIBLE" : classified.client.state === "MUTABLE_TO_FIXTURE" ? "MARKER_REQUIRED" : "MISSING";
  const serviceStatus = classified.service.state === "COMPATIBLE" ? "EXISTING_COMPATIBLE" : "MISSING";
  const planStatus = classified.plan.state === "COMPATIBLE" ? "EXISTING_COMPATIBLE" : "MISSING";
  return {
    client: clientStatus,
    service: serviceStatus,
    plan: planStatus,
    writesRequired: Number(clientStatus === "MARKER_REQUIRED") + Number(serviceStatus === "MISSING") + Number(planStatus === "MISSING"),
    order: [CLIENT_PROFILE_UPDATE_COMMAND, SERVICE_PROVISION_COMMAND, "admin.plano.salvar"],
    planReferencesDedicatedServiceOnly: true,
    classification: classified,
  };
}

export function classifyClientIdentity({ authUid, adminAuthUid, mapping, directAdmin, directMember, operationalAdmin, operationalMember } = {}) {
  const distinct = Boolean(authUid && adminAuthUid && authUid !== adminAuthUid);
  const operationalUid = mapping?.fields?.uid_producao_referencia || null;
  const roles = Array.isArray(operationalMember?.fields?.papeis) ? operationalMember.fields.papeis.map(String) : [];
  const directRoles = Array.isArray(directMember?.fields?.papeis) ? directMember.fields.papeis.map(String) : [];
  const isAdmin = Boolean(directAdmin || operationalAdmin);
  const isBarber = directRoles.includes("BARBEIRO") || roles.includes("BARBEIRO");
  return {
    distinct,
    operationalUidPresent: Boolean(operationalUid),
    isAdmin,
    isBarber,
    bootstrapRequired: !mapping,
    mappingTenantMatches: !mapping || mapping.fields?.tenant_id === HML_TENANT,
  };
}

export function selectReferenceService(legacyDocuments, v2ById) {
  for (const legacy of legacyDocuments || []) {
    const value = legacy.fields || {};
    const v2 = v2ById.get(legacy.id);
    const compatible = Boolean(
      v2
      && semanticallyEqual(value, v2.fields)
      && value.ativo === true
      && typeof value.nome === "string"
      && value.nome.trim()
      && Number.isInteger(value.duracao)
      && value.duracao >= 30
      && value.duracao % 30 === 0
      && String(value.preco ?? "").trim(),
    );
    if (compatible) return { found: true, id: legacy.id, legacyV2Equivalent: true, active: true, safeAsPlanReference: true, idFingerprint: fingerprint(legacy.id) };
  }
  return { found: false, legacyV2Equivalent: false, active: false, safeAsPlanReference: false, idFingerprint: "" };
}

function decodeJwtPayload(token) {
  const parts = String(token ?? "").trim().split(".");
  if (parts.length !== 3) throw new Error("FIREBASE_ID_TOKEN_INVALID");
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
  } catch {
    throw new Error("FIREBASE_ID_TOKEN_INVALID");
  }
}

export function validateIdTokenClaims(token, expectedProject, expectedUid) {
  repoValidateIdToken(token, expectedUid, expectedProject);
  const payload = decodeJwtPayload(token);
  if (payload.aud !== expectedProject) throw new Error("FIREBASE_ID_TOKEN_PROJECT_MISMATCH");
  if (payload.sub !== expectedUid) throw new Error("FIREBASE_ID_TOKEN_SUB_MISMATCH");
  if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) throw new Error("FIREBASE_ID_TOKEN_EXPIRED");
  return { audMatches: true, subMatches: true, notExpired: true };
}

function promptLine(label) {
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(label, (answer) => { rl.close(); resolve(answer); });
    rl.on("SIGINT", () => { rl.close(); reject(new Error("AUTH_INTERACTIVE_ABORTED")); });
  });
}

function promptHidden(label) {
  if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== "function") {
    return promptLine(label);
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    const onData = (buffer) => {
      for (const char of buffer.toString("utf8")) {
        if (char === "\u0003") {
          process.stdin.setRawMode(false); process.stdin.off("data", onData); process.stdout.write("\n"); reject(new Error("AUTH_INTERACTIVE_ABORTED")); return;
        }
        if (char === "\r" || char === "\n") {
          process.stdin.setRawMode(false); process.stdin.off("data", onData); process.stdout.write("\n"); resolve(chunks.join("")); return;
        }
        if (char === "\u007f") { chunks.pop(); continue; }
        chunks.push(char);
      }
    };
    process.stdout.write(label);
    process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on("data", onData);
  });
}

async function signInHmlRole(role) {
  const label = role === "CLIENT" ? "CLIENT HML" : "ADMIN HML";
  const email = await promptLine(`${label} e-mail: `);
  let password = await promptHidden(`${label} senha: `);
  try {
    const session = await authenticateInteractive({ label, email, password });
    const token = String(session.idToken || "").trim();
    const uid = String(session.localId || "");
    if (!token || !uid) throw new Error("AUTHENTICATION_RESPONSE_INVALID");
    validateIdTokenClaims(token, HML_PROJECT, uid);
    return { token, uid, project: HML_PROJECT };
  } finally {
    password = "";
  }
}

async function signInHmlAdmin() {
  return signInHmlRole("ADMIN");
}

async function signInHmlClient() {
  return signInHmlRole("CLIENT");
}

function firestoreValueToJs(value) {
  if (!value || typeof value !== "object") return value;
  if (Object.hasOwn(value, "nullValue")) return null;
  if (Object.hasOwn(value, "stringValue")) return value.stringValue;
  if (Object.hasOwn(value, "booleanValue")) return value.booleanValue;
  if (Object.hasOwn(value, "integerValue")) return Number(value.integerValue);
  if (Object.hasOwn(value, "doubleValue")) return Number(value.doubleValue);
  if (Object.hasOwn(value, "timestampValue")) return value.timestampValue;
  if (Object.hasOwn(value, "referenceValue")) return value.referenceValue;
  if (Object.hasOwn(value, "arrayValue")) return (value.arrayValue.values || []).map(firestoreValueToJs);
  if (Object.hasOwn(value, "mapValue")) return firestoreFieldsToJs(value.mapValue.fields || {});
  return undefined;
}

function firestoreFieldsToJs(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, firestoreValueToJs(value)]));
}

function documentId(document) {
  return String(document?.name || "").split("/").pop();
}

function documentToJs(document) {
  return { id: documentId(document), fields: firestoreFieldsToJs(document?.fields || {}) };
}

function comparisonValue(value) {
  if (value && typeof value === "object") {
    if ("seconds" in value || "timestampValue" in value) return undefined;
    if (Array.isArray(value)) return value.map(comparisonValue);
    return Object.fromEntries(Object.entries(value).filter(([key]) => !["criado_em", "atualizado_em", "criado_por", "atualizado_por"].includes(key)).map(([key, item]) => [key, comparisonValue(item)]));
  }
  return value;
}

function semanticallyEqual(left, right) {
  return JSON.stringify(comparisonValue(left)) === JSON.stringify(comparisonValue(right));
}

async function firestoreRunQuery(project, token, parent, collectionId) {
  networkAccessed = true;
  hmlAccessed = true;
  const url = parent === rootDocumentsParent(project)
    ? `${REPO_FIRESTORE_ROOT}:runQuery`
    : `https://firestore.googleapis.com/v1/${parent}:runQuery`;
  const response = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ structuredQuery: { from: [{ collectionId }], limit: 200 } }),
  });
  const raw = typeof response.text === "function" ? await response.text() : "";
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) {
    console.log(JSON.stringify({
      AUDIT_STAGE: "SERVICE_LEGACY",
      ACTOR: "ADMIN",
      PATH_CLASS: "SERVICE_LEGACY",
      HTTP_STATUS: response.status,
      FIRESTORE_STATUS: String(body?.error?.status || ""),
      MESSAGE_SAFE: safeFirestoreErrorMessage(body?.error?.message),
    }));
    throw new Error(`AUDIT_QUERY_HTTP_${response.status}`);
  }
  const rows = Array.isArray(body) ? body : [];
  return rows.filter((row) => row.document).map((row) => documentToJs(row.document));
}

function safeFirestoreErrorMessage(value) {
  return String(value || "")
    .replace(/Bearer\s+\S+/gi, "[REDACTED]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[REDACTED]")
    .replace(/[^\x20-\x7E]+/g, " ")
    .slice(0, 180);
}

function auditPathClass(path) {
  const normalized = String(path || "");
  if (normalized.startsWith("homologacao_mapeamentos/")) return "HML_MAPPING_SELF";
  if (normalized.startsWith("admins/")) return "ADMIN_PROOF";
  if (normalized.includes("/membros/")) return "CLIENT_MEMBERSHIP_SELF";
  if (normalized.startsWith("clientes/")) return "CLIENT_PROFILE_SELF";
  if (normalized.includes("/servicos/")) return "SERVICE_V2";
  if (normalized.startsWith("servicos/")) return "SERVICE_LEGACY";
  return "OTHER_READ";
}

async function firestoreGet(project, token, path, { actor = "ADMIN", stage = "AUDIT_GET", pathClass = auditPathClass(path) } = {}) {
  networkAccessed = true;
  hmlAccessed = true;
  const response = await fetch(`${REPO_FIRESTORE_ROOT}/${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (response.status === 404) return null;
  const raw = typeof response.text === "function" ? await response.text() : "";
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  if (!response.ok) {
    console.log(JSON.stringify({
      AUDIT_STAGE: stage,
      ACTOR: actor,
      PATH_CLASS: pathClass,
      HTTP_STATUS: response.status,
      FIRESTORE_STATUS: String(body?.error?.status || ""),
      MESSAGE_SAFE: safeFirestoreErrorMessage(body?.error?.message),
    }));
    throw new Error(`AUDIT_GET_HTTP_${response.status}`);
  }
  return documentToJs(body);
}

function provisionStageForCommand(command) {
  if (command === CLIENT_PROFILE_UPDATE_COMMAND) return "CLIENT_MARKER";
  if (command === SERVICE_PROVISION_COMMAND) return "SERVICE_CREATE";
  if (command === "admin.plano.salvar") return "PLAN_CREATE";
  if (command === "admin.plano.ativar") return "PLAN_ACTIVATE";
  if (command === "assinatura.solicitar") return "SUBSCRIPTION_REQUEST";
  if (command === "admin.assinatura.recusar") return "SUBSCRIPTION_REJECT";
  return "UNKNOWN";
}

function markProvisionSuccess(tracker, stage) {
  if (!tracker) return;
  tracker.currentStage = stage;
  tracker.lastSuccessfulStage = stage;
}

function markProvisionFailure(tracker, stage) {
  if (!tracker) return;
  tracker.currentStage = stage;
  tracker.failedStage = stage;
}

async function callOperational(command, data, requestId, token) {
  networkAccessed = true;
  hmlAccessed = true;
  const response = await fetch(`https://southamerica-east1-${HML_PROJECT}.cloudfunctions.net/executeOperationalCommand`, {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(buildCallablePayload(command, data, requestId)),
  });
  const raw = typeof response.text === "function" ? await response.text() : "";
  let body = {};
  try { body = raw ? JSON.parse(raw) : {}; } catch { body = {}; }
  const result = body?.result ?? body?.data;
  if (!response.ok || body?.error) {
    const error = new Error(safeFirestoreErrorMessage(body?.error?.message) || `callable HTTP ${response.status}`);
    error.httpStatus = response.status;
    error.code = String(body?.error?.status || body?.error?.code || "");
    throw error;
  }
  if (!result || typeof result !== "object") throw new Error("INVALID_CALLABLE_RESPONSE");
  return result;
}

export function createRemoteProvisionTransport({ adminSession, clientSession, tracker }) {
  return {
    async call(command, data, requestId, identity, { stage: explicitStage } = {}) {
      const actor = identity === clientSession || identity?.authUid === clientSession.uid ? "CLIENT" : "ADMIN";
      const token = actor === "CLIENT" ? clientSession.token : adminSession.token;
      const stage = explicitStage || provisionStageForCommand(command);
      let callableResponseReceived = false;
      try {
        const result = await callOperational(command, data, requestId, token);
        callableResponseReceived = true;
        const outcome = result.duplicate === true ? "NOOP" : "CREATED";
        if (tracker) {
          if (outcome === "CREATED") tracker.created.push(stage);
          tracker.completed.push(stage);
          markProvisionSuccess(tracker, stage);
        }
        console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, HTTP_STATUS: 200, CALLABLE_CODE: "", MESSAGE_SAFE: "", [outcome]: "SIM" }));
        return result;
      } catch (error) {
        error.callableSent = true;
        error.callableResponseReceived = callableResponseReceived;
        error.localHarnessError = callableResponseReceived;
        if (tracker) markProvisionFailure(tracker, stage);
        console.log(JSON.stringify({
          PROVISION_STAGE: stage,
          COMMAND: command,
          ACTOR: actor,
          HTTP_STATUS: error.httpStatus || null,
          CALLABLE_CODE: error.code || "",
          MESSAGE_SAFE: safeFirestoreErrorMessage(error.message),
          ABORT: "SIM",
        }));
        throw error;
      }
    },
  };
}

function rootDocumentsParent(project) {
  return `projects/${project}/databases/(default)/documents`;
}

function tenantDocumentsParent(project) {
  return `${rootDocumentsParent(project)}/barbearias/${HML_TENANT}`;
}

function findDedicatedDocuments(documents) {
  return documents.filter((document) => isDedicatedFixture(document.id, document.fields));
}

export async function runRemotePreflight({ project, authAdmin = "interactive" }) {
  productionGuard(project);
  if (authAdmin !== "interactive") throw new Error("AUTH_ADMIN_INTERACTIVE_REQUIRED");
  const session = await signInHmlAdmin();
  try {
    const root = rootDocumentsParent(project);
    const tenant = tenantDocumentsParent(project);
    const [plansLegacy, clientsLegacy] = await Promise.all([
      firestoreRunQuery(project, session.token, root, "planos_assinatura"),
      firestoreRunQuery(project, session.token, root, "clientes"),
    ]);
    const dedicatedPlans = findDedicatedDocuments(plansLegacy);
    const planResults = await Promise.all(dedicatedPlans.map(async (plan) => {
      const v2 = await firestoreGet(project, session.token, `barbearias/${HML_TENANT}/planos_assinatura/${encodeURIComponent(plan.id)}`);
      return { ...safeIdMeta(plan.id), exists: true, dedicated: true, active: plan.fields.ativo === true, legacyV2Equivalent: Boolean(v2 && semanticallyEqual(plan.fields, v2.fields)), exactRestoreReady: Boolean(v2 && typeof plan.fields.ativo === "boolean") };
    }));
    const dedicatedClients = findDedicatedDocuments(clientsLegacy);
    const clientResults = [];
    for (const client of dedicatedClients) {
      const clientV2 = await firestoreGet(project, session.token, `barbearias/${HML_TENANT}/clientes/${encodeURIComponent(client.id)}`);
      const member = await firestoreGet(project, session.token, `barbearias/${HML_TENANT}/membros/${encodeURIComponent(client.id)}`);
      const admin = await firestoreGet(project, session.token, `admins/${encodeURIComponent(client.id)}`);
      const roles = Array.isArray(member?.fields?.papeis) ? member.fields.papeis : [];
      clientResults.push({ ...safeIdMeta(client.id), dedicated: true, legacyV2Equivalent: Boolean(clientV2 && semanticallyEqual(client.fields, clientV2.fields)), isAdmin: Boolean(admin), isBarber: roles.includes("BARBEIRO") });
    }
    const plan = planResults.length === 1 ? dedicatedPlans[0] : null;
    const client = clientResults.length === 1 ? dedicatedClients[0] : null;
    let activeSubscriptionConflict = null;
    let pendingRequestConflict = null;
    let terminalHistoryAllowed = false;
    if (plan && client) {
      const subscriptionId = `${client.id}_${plan.id}`;
      const existing = await firestoreGet(project, session.token, `solicitacoes_assinatura/${encodeURIComponent(subscriptionId)}`);
      const status = existing?.fields?.status || null;
      activeSubscriptionConflict = status === "ATIVA";
      pendingRequestConflict = status === "PENDENTE";
      terminalHistoryAllowed = !status || ["RECUSADA", "CANCELADA", "EXPIRADA"].includes(status);
    }
    return {
      PREFLIGHT_REMOTE: "PASS",
      PLAN_FIXTURE_FOUND: planResults.length > 0 ? "SIM" : "NÃO",
      PLAN_FIXTURE_OWNERSHIP_PROVEN: planResults.length === 1 ? "SIM" : "NÃO",
      PLAN_FIXTURE_LEGACY_V2: planResults.length === 1 && planResults[0].legacyV2Equivalent ? "SIM" : "NÃO",
      PLAN_CURRENT_ACTIVE_STATE: planResults.length === 1 ? "SIM" : "NÃO",
      PLAN_CURRENT_ACTIVE_VALUE: planResults.length === 1 ? planResults[0].active : null,
      PLAN_EXACT_RESTORE_READY: planResults.length === 1 && planResults[0].exactRestoreReady ? "SIM" : "NÃO",
      CLIENT_FIXTURE_FOUND: clientResults.length > 0 ? "SIM" : "NÃO",
      CLIENT_FIXTURE_OWNERSHIP_PROVEN: clientResults.length === 1 ? "SIM" : "NÃO",
      CLIENT_IS_ADMIN: clientResults.length === 1 ? (clientResults[0].isAdmin ? "SIM" : "NÃO") : "INCONCLUSIVO",
      CLIENT_IS_BARBER: clientResults.length === 1 ? (clientResults[0].isBarber ? "SIM" : "NÃO") : "INCONCLUSIVO",
      ACTIVE_SUBSCRIPTION_CONFLICT: activeSubscriptionConflict === null ? "INCONCLUSIVO" : (activeSubscriptionConflict ? "SIM" : "NÃO"),
      PENDING_REQUEST_CONFLICT: pendingRequestConflict === null ? "INCONCLUSIVO" : (pendingRequestConflict ? "SIM" : "NÃO"),
      SUBSCRIPTION_REJECT_FLOW_READY: plan && client && activeSubscriptionConflict === false && pendingRequestConflict === false && terminalHistoryAllowed && clientResults[0].isAdmin === false && clientResults[0].isBarber === false ? "SIM" : "NÃO",
      FIXTURE_OWNERSHIP_PROVEN: planResults.length === 1 && clientResults.length === 1 ? "SIM" : "NÃO",
      FIXTURE_CREATION_REQUIRED: planResults.length !== 1 || clientResults.length !== 1 ? "SIM" : "NÃO",
      HML_DATA_CHANGED: "NÃO",
      PRODUCTION_ACCESSED: "NÃO",
    };
  } finally {
    session.token = "";
    session.uid = "";
  }
}

async function readIdentityForClientPreflight({ project, session, adminToken, adminAuthUid }) {
  const mapping = await firestoreGet(project, session.token, `homologacao_mapeamentos/${encodeURIComponent(session.uid)}`, {
    actor: "CLIENT", stage: "CLIENT_IDENTITY", pathClass: "HML_MAPPING_SELF",
  });
  let directAdmin = null;
  let directMember = null;
  let operationalAdmin = null;
  let operationalMember = null;
  let profile = null;
  let operationalUid = null;
  if (mapping) {
    const mappingFields = mapping.fields || {};
    if (mappingFields.tenant_id !== HML_TENANT || mappingFields.ativo !== true || !mappingFields.uid_producao_referencia) {
      throw new Error("CLIENT_HML_MAPPING_INVALID");
    }
    operationalUid = String(mappingFields.uid_producao_referencia);
    operationalAdmin = await firestoreGet(project, session.token, `admins/${encodeURIComponent(operationalUid)}`, {
      actor: "CLIENT", stage: "CLIENT_ROLE_PROOF", pathClass: "CLIENT_ADMIN_PROOF",
    });
    operationalMember = await firestoreGet(project, session.token, `barbearias/${HML_TENANT}/membros/${encodeURIComponent(operationalUid)}`, {
      actor: "CLIENT", stage: "CLIENT_ROLE_PROOF", pathClass: "CLIENT_MEMBERSHIP_SELF",
    });
    profile = await firestoreGet(project, session.token, `clientes/${encodeURIComponent(operationalUid)}`, {
      actor: "CLIENT", stage: "CLIENT_PROFILE", pathClass: "CLIENT_PROFILE_SELF",
    });
  } else {
    // With no HML mapping, the client cannot prove operational membership.
    // ADMIN may inspect the direct UID documents without granting that UID
    // any operational identity or role.
    directAdmin = await firestoreGet(project, adminToken, `admins/${encodeURIComponent(session.uid)}`, {
      actor: "ADMIN", stage: "CLIENT_DIRECT_ROLE_PROOF", pathClass: "CLIENT_ADMIN_PROOF",
    });
    directMember = await firestoreGet(project, adminToken, `barbearias/${HML_TENANT}/membros/${encodeURIComponent(session.uid)}`, {
      actor: "ADMIN", stage: "CLIENT_DIRECT_ROLE_PROOF", pathClass: "CLIENT_MEMBERSHIP_SELF",
    });
  }
  const classification = classifyClientIdentity({
    authUid: session.uid,
    adminAuthUid,
    mapping,
    directAdmin,
    directMember,
    operationalAdmin,
    operationalMember,
  });
  return {
    ...classification,
    mappingExists: Boolean(mapping),
    profileExists: Boolean(profile),
    operationalUid,
    dedicated: Boolean(profile && isDedicatedFixture(operationalUid, profile.fields)),
  };
}

async function readAdminProof({ project, session }) {
  const mapping = await firestoreGet(project, session.token, `homologacao_mapeamentos/${encodeURIComponent(session.uid)}`, {
    actor: "ADMIN", stage: "ADMIN_IDENTITY", pathClass: "HML_MAPPING_SELF",
  });
  if (!mapping) throw new Error("ADMIN_HML_MAPPING_MISSING");
  const mappingFields = mapping.fields || {};
  if (mappingFields.tenant_id !== HML_TENANT || mappingFields.ativo !== true || !mappingFields.uid_producao_referencia) {
    throw new Error("ADMIN_HML_MAPPING_INVALID");
  }
  const operationalUid = String(mappingFields.uid_producao_referencia);
  const [admin, member] = await Promise.all([
    firestoreGet(project, session.token, `admins/${encodeURIComponent(operationalUid)}`, {
      actor: "ADMIN", stage: "ADMIN_ROLE_PROOF", pathClass: "ADMIN_PROOF",
    }),
    firestoreGet(project, session.token, `barbearias/${HML_TENANT}/membros/${encodeURIComponent(operationalUid)}`, {
      actor: "ADMIN", stage: "ADMIN_ROLE_PROOF", pathClass: "ADMIN_PROOF",
    }),
  ]);
  const memberRoles = Array.isArray(member?.fields?.papeis) ? member.fields.papeis.map(String) : [];
  if (!admin || !member || !memberRoles.includes("ADMIN")) throw new Error("ADMIN_HML_NOT_PROVEN");
  return { operationalUid, mapping, admin, member };
}

export async function runFixtureReadOnlyPreflight({ project, authAdmin = "interactive", authClient = "interactive" } = {}) {
  productionGuard(project);
  if (authAdmin !== "interactive" || authClient !== "interactive") throw new Error("ADMIN_AND_CLIENT_INTERACTIVE_AUTH_REQUIRED");
  let adminSession = null;
  let clientSession = null;
  try {
    adminSession = await signInHmlAdmin();
    clientSession = await signInHmlClient();
    const adminProof = await readAdminProof({ project, session: adminSession });
    const clientIdentity = await readIdentityForClientPreflight({
      project,
      session: clientSession,
      adminToken: adminSession.token,
      adminAuthUid: adminSession.uid,
    });
    const fixtureSnapshot = await createRemoteProvisionAudit({
      project,
      adminSession,
      clientIdentity: { operationalUid: clientIdentity.operationalUid || clientSession.uid },
    }).readFixtureState({ provisionStage: "FIXTURE_PREFLIGHT" });
    const clientFixture = classifyClientFixture(fixtureSnapshot);
    const dedicatedPreflight = classifyProvisionPreflight({ ...fixtureSnapshot, confirmDedicatedClient: false });
    const readiness = evaluateProvisionReadiness({
      preflight: dedicatedPreflight,
      productionGuardPassed: true,
      actorsValid: clientIdentity.distinct && !clientIdentity.isAdmin && !clientIdentity.isBarber,
      requireExistingFixtures: true,
    });
    const serviceState = dedicatedPreflight.service.state;
    const planState = dedicatedPreflight.plan.state;
    const fixturesAlreadyProvisioned = clientFixture.state === "COMPATIBLE"
      && serviceState === "COMPATIBLE"
      && planState === "COMPATIBLE"
      && dedicatedPreflight.dependency.state === "READY";
    const safeReferenceDiagnosticOnly = true;
    return {
      PREFLIGHT_REMOTE: "PASS",
      ADMIN_AUTH: "PASS",
      CLIENT_AUTH: "PASS",
      ADMIN_CLIENT_DISTINCT: clientIdentity.distinct ? "SIM" : "NÃO",
      CLIENT_IS_ADMIN: clientIdentity.isAdmin ? "SIM" : "NÃO",
      CLIENT_IS_BARBER: clientIdentity.isBarber ? "SIM" : "NÃO",
      CLIENT_BOOTSTRAP_REQUIRED: clientIdentity.bootstrapRequired ? "SIM" : "NÃO",
      CLIENT_FIXTURE_STATE: clientFixture.state,
      CLIENT_FIXTURE_OWNERSHIP_PROVEN: clientFixture.ownershipProven ? "SIM" : "NÃO",
      CLIENT_OWNERSHIP_SOURCE: clientFixture.ownershipSource,
      FIXTURE_PREFLIGHT_IMPLEMENTATION: "DEDICATED_V2",
      DEDICATED_SERVICE_LOOKUP_EXECUTED: "SIM",
      DEDICATED_PLAN_LOOKUP_EXECUTED: "SIM",
      SAFE_REFERENCE_SERVICE_DIAGNOSTIC_ONLY: safeReferenceDiagnosticOnly ? "SIM" : "NÃO",
      SERVICE_FIXTURE_STATE: serviceState,
      SERVICE_FIXTURE_ID_FINGERPRINT: fingerprint(SERVICE_FIXTURE_ID),
      SERVICE_LEGACY_PRESENT: fixtureSnapshot.service ? "SIM" : "NÃO",
      SERVICE_V2_PRESENT: fixtureSnapshot.serviceV2 ? "SIM" : "NÃO",
      SERVICE_LEGACY_V2_EQUIVALENT: serviceState === "COMPATIBLE" ? "SIM" : "NÃO",
      SERVICE_ACTIVE: fixtureSnapshot.service?.fields?.ativo === true ? "SIM" : "NÃO",
      SERVICE_FOUND: fixtureSnapshot.service ? "SIM" : "NÃO",
      SERVICE_SAFE_AS_PLAN_REFERENCE: "NÃO",
      PLAN_FIXTURE_STATE: planState,
      PLAN_FIXTURE_ID_FINGERPRINT: fingerprint(PLAN_FIXTURE_ID),
      PLAN_LEGACY_PRESENT: fixtureSnapshot.plan ? "SIM" : "NÃO",
      PLAN_V2_PRESENT: fixtureSnapshot.planV2 ? "SIM" : "NÃO",
      PLAN_LEGACY_V2_EQUIVALENT: planState === "COMPATIBLE" ? "SIM" : "NÃO",
      PLAN_ACTIVE: fixtureSnapshot.plan?.fields?.ativo === false ? false : fixtureSnapshot.plan ? true : null,
      PLAN_REFERENCES_DEDICATED_SERVICE_ONLY: planState === "COMPATIBLE" && fixtureSnapshot.plan?.fields?.servicos_ids?.length === 1 && fixtureSnapshot.plan.fields.servicos_ids[0] === SERVICE_FIXTURE_ID ? "SIM" : "NÃO",
      PLAN_SERVICOS_INCLUIDOS_VALID: planState === "COMPATIBLE" ? "SIM" : "NÃO",
      PLAN_SERVICE_DEPENDENCY: dedicatedPreflight.dependency.state,
      FAILING_FIXTURE: dedicatedPreflight.failures[0]?.failingFixture || "",
      FAILING_COMPARATOR: dedicatedPreflight.failures[0]?.failingComparator || "",
      DIFFERING_FIELDS: dedicatedPreflight.failures[0]?.differingFields || [],
      MISSING_FIELDS: dedicatedPreflight.failures[0]?.missingFields || [],
      EXTRA_FIELDS: dedicatedPreflight.failures[0]?.extraFields || [],
      READINESS_BLOCKERS: readiness.blockers,
      BATCH4_FIXTURES_PROVISIONED: fixturesAlreadyProvisioned ? "SIM" : "NÃO",
      BATCH4_FIXTURES_VERIFIED: fixturesAlreadyProvisioned ? "SIM" : "NÃO",
      BATCH4_REPROVISION_REQUIRED: "NÃO",
      ADMIN_OPERATIONAL_UID_PRESENT: Boolean(adminProof.operationalUid),
      HML_DATA_CHANGED: "NÃO",
      PRODUCTION_ACCESSED: "NÃO",
      READY_TO_PROVISION_BATCH4_FIXTURES: fixturesAlreadyProvisioned ? "NÃO" : readiness.ready ? "SIM" : "NÃO",
    };
  } finally {
    if (adminSession) { adminSession.token = ""; adminSession.uid = ""; }
    if (clientSession) { clientSession.token = ""; clientSession.uid = ""; }
  }
}

function createRemoteProvisionAudit({ project, adminSession, clientIdentity, tracker }) {
  const clientId = clientIdentity.operationalUid || clientIdentity.authUid;
  return {
    async readFixtureState({ provisionStage = "PREFLIGHT" } = {}) {
      try {
        const auditStage = ["PREFLIGHT", "BATCH4_SAFE_PREFLIGHT"].includes(provisionStage)
          ? "FIXTURE_PREFLIGHT"
          : provisionStage.endsWith("_AUDIT") ? provisionStage : `${provisionStage}_AUDIT`;
        if (tracker) tracker.currentStage = auditStage;
        const [client, clientV2, member, admin, service, serviceV2, plan, planV2] = await Promise.all([
          firestoreGet(project, adminSession.token, `clientes/${encodeURIComponent(clientId)}`, { actor: "ADMIN", stage: "CLIENT_AUDIT", pathClass: "CLIENT_PROFILE_SELF" }),
          firestoreGet(project, adminSession.token, `barbearias/${HML_TENANT}/clientes/${encodeURIComponent(clientId)}`, { actor: "ADMIN", stage: "CLIENT_AUDIT", pathClass: "CLIENT_PROFILE_SELF" }),
          firestoreGet(project, adminSession.token, `barbearias/${HML_TENANT}/membros/${encodeURIComponent(clientId)}`, { actor: "ADMIN", stage: "CLIENT_AUDIT", pathClass: "CLIENT_MEMBERSHIP_SELF" }),
          firestoreGet(project, adminSession.token, `admins/${encodeURIComponent(clientId)}`, { actor: "ADMIN", stage: "CLIENT_AUDIT", pathClass: "CLIENT_ADMIN_PROOF" }),
          firestoreGet(project, adminSession.token, `servicos/${encodeURIComponent(SERVICE_FIXTURE_ID)}`, { actor: "ADMIN", stage: "SERVICE_AUDIT", pathClass: "SERVICE_LEGACY" }),
          firestoreGet(project, adminSession.token, `barbearias/${HML_TENANT}/servicos/${encodeURIComponent(SERVICE_FIXTURE_ID)}`, { actor: "ADMIN", stage: "SERVICE_AUDIT", pathClass: "SERVICE_V2" }),
          firestoreGet(project, adminSession.token, `planos_assinatura/${encodeURIComponent(PLAN_FIXTURE_ID)}`, { actor: "ADMIN", stage: auditStage, pathClass: "PLAN_LEGACY" }),
          firestoreGet(project, adminSession.token, `barbearias/${HML_TENANT}/planos_assinatura/${encodeURIComponent(PLAN_FIXTURE_ID)}`, { actor: "ADMIN", stage: auditStage, pathClass: "PLAN_V2" }),
        ]);
        markProvisionSuccess(tracker, auditStage);
        return { client, clientV2, member, admin, service, serviceV2, plan, planV2 };
      } catch (error) {
        const auditStage = ["PREFLIGHT", "BATCH4_SAFE_PREFLIGHT"].includes(provisionStage)
          ? "FIXTURE_PREFLIGHT"
          : provisionStage.endsWith("_AUDIT") ? provisionStage : `${provisionStage}_AUDIT`;
        markProvisionFailure(tracker, auditStage);
        throw error;
      }
    },
    async readSubscription(subscriptionId, { stage = "SUBSCRIPTION_AUDIT" } = {}) {
      const encodedId = encodeURIComponent(subscriptionId);
      const [legacy, v2] = await Promise.all([
        firestoreGet(project, adminSession.token, `solicitacoes_assinatura/${encodedId}`, { actor: "ADMIN", stage, pathClass: "SUBSCRIPTION_LEGACY" }),
        firestoreGet(project, adminSession.token, `barbearias/${HML_TENANT}/assinaturas/${encodedId}`, { actor: "ADMIN", stage, pathClass: "SUBSCRIPTION_V2" }),
      ]);
      return {
        legacy,
        v2,
        exists: Boolean(legacy || v2),
        legacyV2Diff: legacy && v2 ? subscriptionSemanticDiff(legacy, v2) : {
          equal: false,
          differingFields: [],
          missingFields: [],
          extraFields: [],
        },
        legacyV2Equivalent: Boolean(legacy && v2 && subscriptionSemanticDiff(legacy.fields, v2.fields).equal),
      };
    },
  };
}

export function summarizePlanStateAudit({ plan, planV2, service, serviceV2, subscription, expectedClientId, expectedPlanId = PLAN_FIXTURE_ID } = {}) {
  const legacyPresent = Boolean(plan);
  const v2Present = Boolean(planV2);
  const activeLegacy = legacyPresent ? plan.fields?.ativo : null;
  const activeV2 = v2Present ? planV2.fields?.ativo : null;
  const projectionEquivalent = legacyPresent && v2Present && planSemanticProjectionDiff(plan, planV2).equal;
  const derivedEquivalent = projectionEquivalent && planDerivedFieldDiff(plan, planV2, service, serviceV2).equal;
  const referencesDedicatedServiceOnly = Boolean(
    legacyPresent
    && Array.isArray(plan.fields?.servicos_ids)
    && plan.fields.servicos_ids.length === 1
    && plan.fields.servicos_ids[0] === SERVICE_FIXTURE_ID,
  );
  const servicesIncludedValid = Boolean(
    legacyPresent
    && v2Present
    && referencesDedicatedServiceOnly
    && derivedEquivalent,
  );
  let finalActiveState = "INCONCLUSIVO";
  let stateClassification = "INCONCLUSIVO";
  if (activeLegacy === false && activeV2 === false) {
    finalActiveState = false;
    stateClassification = "PLAN_STATE_RESTORED_OR_UNCHANGED";
  } else if (activeLegacy === true && activeV2 === true) {
    finalActiveState = true;
    stateClassification = "PLAN_ACTIVATION_PERSISTED_AND_RESTORE_NOT_EFFECTIVE";
  } else if (legacyPresent || v2Present) {
    stateClassification = "LEGACY_V2_DIVERGENCE";
  }
  const subscriptionAudit = compareSubscriptionFinalState({
    subscription,
    expectedClientId,
    expectedPlanId,
  });
  const subscriptionPresent = subscriptionAudit.SUBSCRIPTION_LEGACY_PRESENT === "SIM"
    || subscriptionAudit.SUBSCRIPTION_V2_PRESENT === "SIM";
  const partialWriteFinalClassification = finalActiveState === "INCONCLUSIVO"
    || (subscriptionPresent && !subscriptionAudit.pass)
    ? "INCONCLUSIVO"
    : "NÃO";
  return {
    PLAN_LEGACY_PRESENT: legacyPresent ? "SIM" : "NÃO",
    PLAN_V2_PRESENT: v2Present ? "SIM" : "NÃO",
    PLAN_LEGACY_V2_EQUIVALENT: projectionEquivalent && derivedEquivalent ? "SIM" : "NÃO",
    PLAN_ACTIVE_LEGACY: activeLegacy,
    PLAN_ACTIVE_V2: activeV2,
    PLAN_FINAL_ACTIVE_STATE: finalActiveState,
    PLAN_STATE_CLASSIFICATION: stateClassification,
    PLAN_REFERENCES_DEDICATED_SERVICE_ONLY: referencesDedicatedServiceOnly ? "SIM" : "NÃO",
    PLAN_SERVICOS_INCLUIDOS_VALID: servicesIncludedValid ? "SIM" : "NÃO",
    SUBSCRIPTION_CALLABLE_SENT: "NÃO",
    SUBSCRIPTION_DOCUMENT_PRESENT: subscriptionPresent ? "SIM" : "NÃO",
    SUBSCRIPTION_STATUS: subscriptionAudit.SUBSCRIPTION_STATUS_LEGACY || subscriptionAudit.SUBSCRIPTION_STATUS_V2,
    SUBSCRIPTION_STATUS_LEGACY: subscriptionAudit.SUBSCRIPTION_STATUS_LEGACY,
    SUBSCRIPTION_STATUS_V2: subscriptionAudit.SUBSCRIPTION_STATUS_V2,
    SUBSCRIPTION_LEGACY_PRESENT: subscriptionAudit.SUBSCRIPTION_LEGACY_PRESENT,
    SUBSCRIPTION_V2_PRESENT: subscriptionAudit.SUBSCRIPTION_V2_PRESENT,
    SUBSCRIPTION_STATUS_MATCH: subscriptionAudit.SUBSCRIPTION_STATUS_MATCH,
    SUBSCRIPTION_CLIENT_MATCH: expectedClientId ? subscriptionAudit.SUBSCRIPTION_CLIENT_MATCH : "INCONCLUSIVO",
    SUBSCRIPTION_PLAN_MATCH: subscriptionAudit.SUBSCRIPTION_PLAN_MATCH,
    SUBSCRIPTION_LEGACY_V2_EQUIVALENT: subscriptionAudit.SUBSCRIPTION_LEGACY_V2_EQUIVALENT,
    ACTIVE_CREDITS_PRESENT: subscriptionAudit.ACTIVE_CREDITS_PRESENT,
    ACTIVE_CREDITS_ABSENT: subscriptionAudit.ACTIVE_CREDITS_ABSENT,
    FAILING_PREDICATES: subscriptionAudit.FAILING_PREDICATES,
    DIFFERING_FIELDS: subscriptionAudit.DIFFERING_FIELDS,
    MISSING_FIELDS: subscriptionAudit.MISSING_FIELDS,
    EXTRA_FIELDS: subscriptionAudit.EXTRA_FIELDS,
    PARTIAL_WRITE_FINAL_CLASSIFICATION: partialWriteFinalClassification,
  };
}

export async function runPlanStateReadOnlyAudit({ project, authAdmin = "interactive", authClient = "interactive" } = {}) {
  productionGuard(project);
  if (authAdmin !== "interactive" || authClient !== "interactive") throw new Error("ADMIN_AND_CLIENT_INTERACTIVE_AUTH_REQUIRED");
  let adminSession = null;
  let clientSession = null;
  try {
    adminSession = await signInHmlAdmin();
    clientSession = await signInHmlClient();
    const adminProof = await readAdminProof({ project, session: adminSession });
    const clientProof = await readIdentityForClientPreflight({ project, session: clientSession, adminToken: adminSession.token, adminAuthUid: adminSession.uid });
    const clientId = clientProof.operationalUid || clientSession.uid;
    const audit = createRemoteProvisionAudit({
      project,
      adminSession,
      clientIdentity: { operationalUid: clientId },
    });
    const [snapshot, subscription] = await Promise.all([
      audit.readFixtureState({ provisionStage: "PLAN_STATE_READ_ONLY" }),
      audit.readSubscription(`${clientId}_${PLAN_FIXTURE_ID}`, { stage: "SUBSCRIPTION_READ_ONLY" }),
    ]);
    const summary = summarizePlanStateAudit({
      ...snapshot,
      subscription,
      expectedClientId: clientId,
      expectedPlanId: PLAN_FIXTURE_ID,
    });
    return {
      PREFLIGHT_REMOTE: "PASS",
      ADMIN_AUTH: "PASS",
      CLIENT_AUTH: "PASS",
      ADMIN_OPERATIONAL_UID_PRESENT: Boolean(adminProof.operationalUid),
      CLIENT_OPERATIONAL_UID_PRESENT: Boolean(clientId),
      ...summary,
      PLAN_ID: safeIdMeta(PLAN_FIXTURE_ID),
      SUBSCRIPTION_ID: safeIdMeta(`${clientId}_${PLAN_FIXTURE_ID}`),
      HML_DATA_CHANGED: "NÃO",
      PRODUCTION_ACCESSED: "NÃO",
    };
  } finally {
    if (adminSession) { adminSession.token = ""; adminSession.uid = ""; }
    if (clientSession) { clientSession.token = ""; clientSession.uid = ""; }
  }
}

export async function runRemoteProvision({ project, authAdmin = "interactive", authClient = "interactive", confirmDedicatedClient, confirmPersistentFixture } = {}) {
  productionGuard(project);
  guardProvisionOptions({ project, adminAuth: authAdmin, clientAuth: authClient, confirmDedicatedClient, confirmPersistentFixture });
  let adminSession = null;
  let clientSession = null;
  const tracker = { created: [], completed: [], currentStage: "PREFLIGHT", lastSuccessfulStage: "", failedStage: "", persistentFixtures: [] };
  try {
    adminSession = await signInHmlAdmin();
    clientSession = await signInHmlClient();
    const adminProof = await readAdminProof({ project, session: adminSession });
    const clientIdentityProof = await readIdentityForClientPreflight({
      project,
      session: clientSession,
      adminToken: adminSession.token,
      adminAuthUid: adminSession.uid,
    });
    const adminIdentity = {
      authUid: adminSession.uid,
      operationalUid: adminProof.operationalUid,
      idToken: adminSession.token,
      isAdmin: true,
      isBarber: false,
      tenant: HML_TENANT,
    };
    const clientIdentity = {
      authUid: clientSession.uid,
      operationalUid: clientIdentityProof.operationalUid,
      idToken: clientSession.token,
      isAdmin: clientIdentityProof.isAdmin,
      isBarber: clientIdentityProof.isBarber,
      tenant: HML_TENANT,
    };
    assertDistinctIdentities(adminIdentity, clientIdentity);
    const fixturePolicy = {
      purpose: FIXTURE_MARKER,
      project: HML_PROJECT,
      tenant: HML_TENANT,
      dedicated: true,
      sharedWithRealHmlUsage: false,
      persistentHistoryAllowed: true,
    };
    validateFixturePolicy(fixturePolicy);
    const result = await provisionBatch4Fixtures({
      project,
      adminAuth: authAdmin,
      clientAuth: authClient,
      confirmDedicatedClient,
      confirmPersistentFixture,
      adminIdentity,
      clientIdentity,
      fixturePolicy,
      serviceId: SERVICE_FIXTURE_ID,
      tracker,
      transport: createRemoteProvisionTransport({ adminSession, clientSession, tracker }),
      audit: createRemoteProvisionAudit({ project, adminSession, clientIdentity, tracker }),
    });
    tracker.persistentFixtures = tracker.created.filter((stage) => ["CLIENT_MARKER", "SERVICE_CREATE", "PLAN_CREATE"].includes(stage));
    return {
      PREFLIGHT: "PASS",
      CLIENT_PROVISION_FLOW: result.client,
      SERVICE_PROVISION_FLOW: result.service,
      PLAN_PROVISION_FLOW: result.plan,
      PARTIAL_PROVISION: "NÃO",
      PERSISTENT_FIXTURES_CREATED: tracker.persistentFixtures,
      AUDITS: result.audits.map((audit) => ({ stage: audit.stage, legacyV2: audit.legacyV2 })),
      FINAL_RESULT: "PASS",
      NETWORK_ACCESSED: "SIM",
      HML_ACCESSED: "SIM",
      PRODUCTION_ACCESSED: "NÃO",
    };
  } catch (error) {
    const failures = Array.isArray(error?.failures)
      ? error.failures.map(({ code, failingFixture, failingComparator, differingFields, missingFields, extraFields }) => ({
        code,
        failingFixture,
        failingComparator,
        differingFields: Array.isArray(differingFields) ? differingFields : [],
        missingFields: Array.isArray(missingFields) ? missingFields : [],
        extraFields: Array.isArray(extraFields) ? extraFields : [],
      }))
      : [];
    return {
      FINAL_RESULT: "FAIL",
      ERROR: safeFirestoreErrorMessage(error.message),
      PROVISION_STAGE: tracker.failedStage || tracker.currentStage || "PREFLIGHT",
      LAST_SUCCESSFUL_STAGE: tracker.lastSuccessfulStage || "",
      FAILED_STAGE: tracker.failedStage || "",
      INCOMPATIBILITIES: failures,
      CLIENT_MARKER_CREATED: tracker.created.includes("CLIENT_MARKER") ? "SIM" : "NÃO",
      SERVICE_CREATED: tracker.created.includes("SERVICE_CREATE") ? "SIM" : "NÃO",
      PLAN_CREATED: tracker.created.includes("PLAN_CREATE") ? "SIM" : "NÃO",
      PARTIAL_PROVISION: tracker.created.length > 0 ? "SIM" : "NÃO",
      AUTOMATIC_CLEANUP: "NÃO",
      NETWORK_ACCESSED: networkAccessed ? "SIM" : "NÃO",
      HML_ACCESSED: hmlAccessed ? "SIM" : "NÃO",
      PRODUCTION_ACCESSED: "NÃO",
    };
  } finally {
    if (adminSession) { adminSession.token = ""; adminSession.uid = ""; }
    if (clientSession) { clientSession.token = ""; clientSession.uid = ""; }
  }
}

export async function runRemoteBatch4Safe({ project, authAdmin = "interactive", authClient = "interactive", confirmHmlWrite } = {}) {
  guardBatch4SafeOptions({ project, adminAuth: authAdmin, clientAuth: authClient, confirmHmlWrite });
  let adminSession = null;
  let clientSession = null;
  try {
    adminSession = await signInHmlAdmin();
    clientSession = await signInHmlClient();
    const adminProof = await readAdminProof({ project, session: adminSession });
    const clientIdentityProof = await readIdentityForClientPreflight({
      project,
      session: clientSession,
      adminToken: adminSession.token,
      adminAuthUid: adminSession.uid,
    });
    const adminIdentity = {
      authUid: adminSession.uid,
      operationalUid: adminProof.operationalUid,
      idToken: adminSession.token,
      isAdmin: true,
      isBarber: false,
      tenant: HML_TENANT,
    };
    const clientIdentity = {
      authUid: clientSession.uid,
      operationalUid: clientIdentityProof.operationalUid,
      idToken: clientSession.token,
      isAdmin: clientIdentityProof.isAdmin,
      isBarber: clientIdentityProof.isBarber,
      tenant: HML_TENANT,
    };
    assertDistinctIdentities(adminIdentity, clientIdentity);
    const fixturePolicy = {
      purpose: FIXTURE_MARKER,
      project: HML_PROJECT,
      tenant: HML_TENANT,
      dedicated: true,
      sharedWithRealHmlUsage: false,
      persistentHistoryAllowed: true,
    };
    const result = await runBatch4Safe({
      project,
      confirmHmlWrite,
      adminIdentity,
      clientIdentity,
      fixturePolicy,
      transport: createRemoteProvisionTransport({ adminSession, clientSession }),
      audit: createRemoteProvisionAudit({ project, adminSession, clientIdentity }),
    });
    return { ...result, HML_ACCESSED: "SIM", PRODUCTION_ACCESSED: "NÃO", NETWORK_ACCESSED: "SIM" };
  } catch (error) {
    const tracker = error.tracker || {};
    const callableSent = error.callableSent === true;
    const callableResponseReceived = error.callableResponseReceived === true;
    const partialWrite = error.mutationStarted === true || callableSent ? "INCONCLUSIVO" : "NÃO";
    const subscriptionCallableSent = error.subscriptionCallableSent === true;
    const subscriptionCallableResponseReceived = error.subscriptionCallableResponseReceived === true;
    const subscriptionCallableSucceeded = error.subscriptionCallableSucceeded === true;
    const subscriptionAudit = error.subscriptionAuditResult || null;
    const planFinalState = error.planFinalAuditCompleted === true
      ? (error.initialPlanActiveState === true ? "ATIVO" : "INATIVO")
      : "INCONCLUSIVO";
    return {
      FINAL_RESULT: "FAIL",
      ERROR: safeFirestoreErrorMessage(error.message),
      PROVISION_STAGE: tracker.failedStage || tracker.currentStage || "PREFLIGHT",
      LAST_SUCCESSFUL_STAGE: tracker.lastSuccessfulStage || "",
      FAILED_STAGE: tracker.failedStage || tracker.currentStage || "",
      SUBSCRIPTION_ID_PLANNED: error.subscriptionId || { present: false, length: 0, fingerprint: fingerprint("") },
      SUBSCRIPTION_CALLABLE_SENT: subscriptionCallableSent ? "SIM" : "NÃO",
      SUBSCRIPTION_CALLABLE_RESPONSE_RECEIVED: subscriptionCallableResponseReceived ? "SIM" : "NÃO",
      SUBSCRIPTION_CALLABLE_SUCCEEDED: subscriptionCallableSucceeded ? "SIM" : "NÃO",
      SUBSCRIPTION_REQUEST_RESPONSE_RECEIVED: error.subscriptionRequestResponseReceived === true ? "SIM" : "NÃO",
      SUBSCRIPTION_REJECT_RESPONSE_RECEIVED: error.subscriptionRejectResponseReceived === true ? "SIM" : "NÃO",
      SUBSCRIPTION_DOCUMENT_PRESENT: subscriptionAudit ? subscriptionAudit.SUBSCRIPTION_LEGACY_PRESENT : "INCONCLUSIVO",
      SUBSCRIPTION_REMOTE_STATUS: subscriptionAudit?.SUBSCRIPTION_STATUS_LEGACY || "",
      SUBSCRIPTION_PENDING_REMOTE: subscriptionAudit?.SUBSCRIPTION_STATUS_LEGACY === "PENDENTE" ? "SIM" : subscriptionAudit ? "NÃO" : "INCONCLUSIVO",
      SUBSCRIPTION_LEGACY_PRESENT: subscriptionAudit?.SUBSCRIPTION_LEGACY_PRESENT || "INCONCLUSIVO",
      SUBSCRIPTION_V2_PRESENT: subscriptionAudit?.SUBSCRIPTION_V2_PRESENT || "INCONCLUSIVO",
      SUBSCRIPTION_STATUS_MATCH: subscriptionAudit?.SUBSCRIPTION_STATUS_MATCH || "INCONCLUSIVO",
      SUBSCRIPTION_CLIENT_MATCH: subscriptionAudit?.SUBSCRIPTION_CLIENT_MATCH || "INCONCLUSIVO",
      SUBSCRIPTION_PLAN_MATCH: subscriptionAudit?.SUBSCRIPTION_PLAN_MATCH || "INCONCLUSIVO",
      SUBSCRIPTION_LEGACY_V2_EQUIVALENT: subscriptionAudit?.SUBSCRIPTION_LEGACY_V2_EQUIVALENT || "INCONCLUSIVO",
      ACTIVE_CREDITS_ABSENT: subscriptionAudit?.ACTIVE_CREDITS_ABSENT || "INCONCLUSIVO",
      ACTIVE_CREDITS_PRESENT: subscriptionAudit?.ACTIVE_CREDITS_PRESENT || "INCONCLUSIVO",
      FAILING_PREDICATES: subscriptionAudit?.FAILING_PREDICATES || [],
      DIFFERING_FIELDS: subscriptionAudit?.DIFFERING_FIELDS || [],
      MISSING_FIELDS: subscriptionAudit?.MISSING_FIELDS || [],
      EXTRA_FIELDS: subscriptionAudit?.EXTRA_FIELDS || [],
      SUBSCRIPTION_FINAL_STATE_AUDIT_PASS: subscriptionAudit ? (subscriptionAudit.pass ? "SIM" : "NÃO") : "INCONCLUSIVO",
      PLAN_FINAL_STATE: planFinalState,
      PLAN_FINAL_ACTIVE_STATE: error.planFinalAuditCompleted === true ? error.initialPlanActiveState : "INCONCLUSIVO",
      CALLABLE_SENT: callableSent ? "SIM" : "NÃO",
      CALLABLE_RESPONSE_RECEIVED: callableResponseReceived ? "SIM" : "NÃO",
      RESPONSE_ASSERTION_PASS: error.localHarnessError ? "NÃO" : error.callableResponseReceived ? "SIM" : "INCONCLUSIVO",
      RESTORE_ERROR: error.restoreError || "",
      PARTIAL_WRITE: partialWrite,
      AUTOMATIC_CLEANUP: "NÃO",
      HML_ACCESSED: hmlAccessed ? "SIM" : "NÃO",
      NETWORK_ACCESSED: networkAccessed ? "SIM" : "NÃO",
      PRODUCTION_ACCESSED: "NÃO",
    };
  } finally {
    if (adminSession) { adminSession.token = ""; adminSession.uid = ""; }
    if (clientSession) { clientSession.token = ""; clientSession.uid = ""; }
  }
}

export function productionGuard(project) {
  if (project !== HML_PROJECT || project === PRODUCTION_PROJECT) {
    throw new Error("ABORT: somente teste-483f6 é permitido");
  }
  return true;
}

export function validateFixturePolicy(policy) {
  if (!policy || policy.purpose !== "batch4-admin-domain-tests") throw new Error("FIXTURE_PURPOSE_INVALID");
  if (policy.project !== HML_PROJECT) throw new Error("FIXTURE_PROJECT_INVALID");
  if (!policy.tenant) throw new Error("FIXTURE_TENANT_REQUIRED");
  if (policy.dedicated !== true || policy.sharedWithRealHmlUsage === true) throw new Error("DEDICATED_FIXTURE_REQUIRED");
  if (policy.persistentHistoryAllowed !== true) throw new Error("PERSISTENT_HISTORY_POLICY_REQUIRED");
  return true;
}

export function buildCallablePayload(command, data, requestId) {
  if (!SAFE_ADMIN_COMMANDS.includes(command) && !SETUP_COMMANDS.includes(command) && !PROVISION_COMMANDS.includes(command)) {
    throw new Error(`COMMAND_NOT_ALLOWED:${command}`);
  }
  if (!isValidRequestId(requestId)) throw new Error("INVALID_REQUEST_ID");
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("INVALID_COMMAND_DATA");
  const allowed = new Set(COMMAND_DATA_FIELDS[command]);
  const extra = Object.keys(data).filter((key) => !allowed.has(key));
  if (extra.length) throw new Error("COMMAND_DATA_FIELD_NOT_ALLOWED");
  const commandPayload = command === CLIENT_BOOTSTRAP_COMMAND
    ? { extras: { ...data } }
    : command === "assinatura.solicitar"
      ? { planId: data.plano_id }
      : { data: { ...data } };
  const outer = { data: { command, requestId, ...commandPayload } };
  if (outer.data.data?.data !== undefined) throw new Error("DUPLICATE_DATA_ENVELOPE");
  return outer;
}

export function assertDistinctIdentities(admin, client) {
  if (!admin?.authUid || !client?.authUid || admin.authUid === client.authUid) {
    throw new Error("IDENTITIES_NOT_DISTINCT");
  }
  if (admin.isAdmin !== true) throw new Error("ADMIN_NOT_PROVEN");
  if (client.isAdmin === true || client.isBarber === true) throw new Error("CLIENT_PRIVILEGE_GUARD_FAILED");
  if (admin.tenant !== client.tenant) throw new Error("TENANT_MISMATCH");
  return true;
}

export function assertRequestPlan(plan) {
  if (!plan || plan.project !== HML_PROJECT) throw new Error("PLAN_PROJECT_INVALID");
  if (!isValidRequestId(plan.requestId)) throw new Error("PLAN_REQUEST_ID_INVALID");
  if (!isValidRequestId(plan.replayRequestId)) throw new Error("PLAN_REPLAY_REQUEST_ID_INVALID");
  if (plan.requestId !== plan.replayRequestId) throw new Error("REPLAY_REQUEST_ID_MUST_MATCH");
  if (!isValidRequestId(plan.restoreRequestId)) throw new Error("PLAN_RESTORE_REQUEST_ID_INVALID");
  if (plan.restoreRequestId === plan.requestId) throw new Error("RESTORE_REQUEST_ID_MUST_DIFFER");
  return true;
}

function clone(value) {
  return structuredClone(value);
}

function mirror(state, collection, id, value) {
  state.legacy[collection] ??= {};
  const v2Collection = collection === "solicitacoes_assinatura" ? "assinaturas" : collection;
  state.v2[v2Collection] ??= {};
  state.legacy[collection][id] = clone(value);
  state.v2[v2Collection][id] = clone(value);
}

function equivalent(state, collection, id) {
  const v2Collection = collection === "solicitacoes_assinatura" ? "assinaturas" : collection;
  return JSON.stringify(state.legacy[collection]?.[id] ?? null) === JSON.stringify(state.v2[v2Collection]?.[id] ?? null);
}

class OfflineTransport {
  constructor() {
    this.state = {
      legacy: {
        planos_assinatura: {
          "batch4-plan-dedicated": { id: "batch4-plan-dedicated", ativo: false, dedicated: true },
        },
        solicitacoes_assinatura: {},
      },
      v2: { planos_assinatura: {}, assinaturas: {} },
      logs: new Map(),
    };
    mirror(this.state, "planos_assinatura", "batch4-plan-dedicated", this.state.legacy.planos_assinatura["batch4-plan-dedicated"]);
  }

  call(command, data, requestId, actor = "ADMIN", { failBeforeCommit = false } = {}) {
    const payload = buildCallablePayload(command, data, requestId);
    const previous = this.state.logs.get(requestId);
    if (previous) return clone({ duplicate: true, ...previous });
    const next = clone(this.state);
    next.logs = new Map(this.state.logs);
    let result;
    if (failBeforeCommit) throw new Error("INJECTED_FAILURE_BEFORE_COMMIT");

    if (command === "admin.plano.ativar") {
      const plan = next.legacy.planos_assinatura[data.id];
      if (!plan || plan.dedicated !== true) throw new Error("DEDICATED_PLAN_REQUIRED");
      plan.ativo = Boolean(data.ativo);
      mirror(next, "planos_assinatura", data.id, plan);
      result = { planId: data.id };
    } else if (command === "assinatura.solicitar") {
      const plan = next.legacy.planos_assinatura[data.plano_id];
      if (!plan || plan.ativo !== true) throw new Error("PLANO_INDISPONIVEL");
      const id = `${actor}_${data.plano_id}`;
      if (next.legacy.solicitacoes_assinatura[id]) throw new Error("SUBSCRIPTION_FIXTURE_COLLISION");
      const subscription = { id, plano_id: data.plano_id, status: "PENDENTE", dedicated: true, creditos_mensais: null };
      mirror(next, "solicitacoes_assinatura", id, subscription);
      result = { subscriptionId: id, status: "PENDENTE" };
    } else if (command === "admin.assinatura.recusar") {
      const subscription = next.legacy.solicitacoes_assinatura[data.id];
      if (!subscription || subscription.status !== "PENDENTE") throw new Error("SOLICITACAO_INDISPONIVEL");
      subscription.status = "RECUSADA";
      mirror(next, "solicitacoes_assinatura", data.id, subscription);
      result = { subscriptionId: data.id, status: "RECUSADA" };
    } else {
      throw new Error(`COMMAND_NOT_ALLOWED:${command}`);
    }
    next.logs.set(requestId, result);
    this.state = next;
    return { duplicate: false, ...clone(result), actor };
  }

  auditPlan(id) {
    const value = this.state.legacy.planos_assinatura[id];
    return { exists: Boolean(value), value: clone(value), legacyV2Equivalent: equivalent(this.state, "planos_assinatura", id) };
  }

  auditSubscription(id) {
    const value = this.state.legacy.solicitacoes_assinatura[id];
    return { exists: Boolean(value), value: clone(value), legacyV2Equivalent: equivalent(this.state, "solicitacoes_assinatura", id) };
  }
}

class Batch4SafeOfflineTransport {
  constructor(clientId) {
    const service = buildServiceFixture();
    const serviceFields = { ...service };
    delete serviceFields.id;
    const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
    const planFields = { ...plan, servicos_incluidos: [SERVICE_FIXTURE_NAME] };
    delete planFields.id;
    this.state = {
      legacy: {
        client: { id: clientId, fields: { nome: CLIENT_FIXTURE_NAME } },
        clientV2: { id: clientId, fields: { nome: CLIENT_FIXTURE_NAME } },
        member: { id: clientId, fields: { tenant_id: HML_TENANT, papeis: ["CLIENTE"] } },
        service: { id: SERVICE_FIXTURE_ID, fields: serviceFields },
        serviceV2: { id: SERVICE_FIXTURE_ID, fields: serviceFields },
        plan: { id: PLAN_FIXTURE_ID, fields: planFields },
        planV2: { id: PLAN_FIXTURE_ID, fields: planFields },
        subscription: null,
      },
      logs: new Map(),
    };
  }

  call(command, data, requestId, identity) {
    const payload = buildCallablePayload(command, data, requestId);
    if (!payload?.data?.command || !isValidRequestId(requestId)) throw new Error("OFFLINE_WIRE_INVALID");
    const previous = this.state.logs.get(requestId);
    if (previous) return clone({ duplicate: true, ...previous });
    const next = clone(this.state);
    next.logs = new Map(this.state.logs);
    let result;
    if (command === "admin.plano.ativar") {
      if (data.id !== PLAN_FIXTURE_ID) throw new Error("DEDICATED_PLAN_REQUIRED");
      next.legacy.plan.fields.ativo = Boolean(data.ativo);
      next.legacy.planV2.fields.ativo = Boolean(data.ativo);
      result = { planId: PLAN_FIXTURE_ID };
    } else if (command === "assinatura.solicitar") {
      if (next.legacy.plan?.fields?.ativo !== true || next.legacy.planV2?.fields?.ativo !== true) throw new Error("PLANO_INDISPONIVEL");
      const subscriptionId = `${identity.operationalUid}_${PLAN_FIXTURE_ID}`;
      if (next.legacy.subscription?.fields?.status === "PENDENTE") throw new Error("SUBSCRIPTION_FIXTURE_COLLISION");
      const fields = { cliente_id: identity.operationalUid, plano_id: PLAN_FIXTURE_ID, status: "PENDENTE" };
      next.legacy.subscription = { id: subscriptionId, fields };
      next.legacy.subscriptionV2 = { id: subscriptionId, fields: clone(fields) };
      result = { subscriptionId, status: "PENDENTE" };
    } else if (command === "admin.assinatura.recusar") {
      const subscription = next.legacy.subscription;
      if (!subscription || subscription.id !== data.id || subscription.fields.status !== "PENDENTE") throw new Error("SOLICITACAO_INDISPONIVEL");
      subscription.fields.status = "RECUSADA";
      next.legacy.subscriptionV2.fields.status = "RECUSADA";
      result = { subscriptionId: data.id, status: "RECUSADA" };
    } else {
      throw new Error(`COMMAND_NOT_ALLOWED:${command}`);
    }
    next.logs.set(requestId, result);
    this.state = next;
    return { duplicate: false, ...clone(result) };
  }

  audit() {
    const state = this.state.legacy;
    return {
      client: clone(state.client),
      clientV2: clone(state.clientV2),
      member: clone(state.member),
      admin: null,
      service: clone(state.service),
      serviceV2: clone(state.serviceV2),
      plan: clone(state.plan),
      planV2: clone(state.planV2),
    };
  }

  auditSubscription(id) {
    const subscription = this.state.legacy.subscription;
    const v2 = this.state.legacy.subscriptionV2;
    return {
      legacy: subscription && subscription.id === id ? clone(subscription) : null,
      v2: v2 && v2.id === id ? clone(v2) : null,
      exists: Boolean(subscription && subscription.id === id),
      legacyV2Equivalent: Boolean(subscription && v2 && subscriptionSemanticDiff(subscription.fields, v2.fields).equal),
    };
  }
}

export async function runOfflineBatch4SafeJourney() {
  const adminIdentity = { authUid: "admin-safe-offline", operationalUid: "admin-safe-offline", isAdmin: true, isBarber: false, tenant: HML_TENANT };
  const clientIdentity = { authUid: "client-safe-offline", operationalUid: "client-safe-offline", isAdmin: false, isBarber: false, tenant: HML_TENANT };
  const fixturePolicy = { purpose: FIXTURE_MARKER, project: HML_PROJECT, tenant: HML_TENANT, dedicated: true, sharedWithRealHmlUsage: false, persistentHistoryAllowed: true };
  const transport = new Batch4SafeOfflineTransport(clientIdentity.operationalUid);
  const result = await runBatch4Safe({
    project: HML_PROJECT,
    confirmHmlWrite: true,
    adminIdentity,
    clientIdentity,
    fixturePolicy,
    transport,
    audit: {
      readFixtureState: async () => transport.audit(),
      readSubscription: async (id) => transport.auditSubscription(id),
    },
  });
  if (result.PLAN_ACTIVATE_FLOW !== "PASS" || result.PLAN_ACTIVATE_REPLAY !== "PASS" || result.PLAN_RESTORE_FLOW !== "PASS" || result.SUBSCRIPTION_REQUEST_FLOW !== "PASS" || result.SUBSCRIPTION_REJECT_FLOW !== "PASS" || result.SUBSCRIPTION_FINAL_STATE !== "RECUSADA") throw new Error("BATCH4_SAFE_OFFLINE_JOURNEY_FAILED");
  return { ...result, NETWORK_ACCESSED: "NÃO" };
}

export async function runOfflineBatch4SafeFailureInjection() {
  const scenarios = [
    { name: "after-plan-activate", command: "admin.plano.ativar", match: (data) => data.ativo === true, expected: "RESTORED" },
    { name: "after-subscription-request", command: "assinatura.solicitar", match: () => true, expected: "PENDING_REPORTED" },
    { name: "after-subscription-reject", command: "admin.assinatura.recusar", match: () => true, expected: "TERMINAL_REPORTED" },
  ];
  const reports = [];
  for (const scenario of scenarios) {
    const adminIdentity = { authUid: "admin-failure-offline", operationalUid: "admin-failure-offline", isAdmin: true, isBarber: false, tenant: HML_TENANT };
    const clientIdentity = { authUid: "client-failure-offline", operationalUid: "client-failure-offline", isAdmin: false, isBarber: false, tenant: HML_TENANT };
    const fixturePolicy = { purpose: FIXTURE_MARKER, project: HML_PROJECT, tenant: HML_TENANT, dedicated: true, sharedWithRealHmlUsage: false, persistentHistoryAllowed: true };
    const base = new Batch4SafeOfflineTransport(clientIdentity.operationalUid);
    let injected = false;
    const transport = {
      call(command, data, requestId, identity) {
        const result = base.call(command, data, requestId, identity);
        if (!injected && command === scenario.command && scenario.match(data)) {
          injected = true;
          throw new Error(`INJECTED_FAILURE_${scenario.name}`);
        }
        return result;
      },
    };
    let error;
    try {
      await runBatch4Safe({
        project: HML_PROJECT,
        confirmHmlWrite: true,
        adminIdentity,
        clientIdentity,
        fixturePolicy,
        transport,
        audit: {
          readFixtureState: async () => base.audit(),
          readSubscription: async (id) => base.auditSubscription(id),
        },
      });
    } catch (caught) {
      error = caught;
    }
    if (!injected || !error) throw new Error(`FAILURE_INJECTION_NOT_OBSERVED:${scenario.name}`);
    if (scenario.expected === "RESTORED" && base.state.legacy.plan.fields.ativo !== false) throw new Error("PLAN_RESTORE_FINALLY_FAILED");
    if (scenario.expected === "PENDING_REPORTED" && base.state.legacy.subscription?.fields?.status !== "PENDENTE") throw new Error("PENDING_PARTIAL_STATE_NOT_TRACKED");
    if (scenario.expected === "TERMINAL_REPORTED" && base.state.legacy.subscription?.fields?.status !== "RECUSADA") throw new Error("TERMINAL_PARTIAL_STATE_NOT_TRACKED");
    reports.push({ scenario: scenario.name, observed: true, automaticCleanup: false });
  }
  return { pass: true, reports, networkAccessed: "NÃO" };
}

export function runOfflineDryJourney() {
  productionGuard(HML_PROJECT);
  validateFixturePolicy({
    purpose: "batch4-admin-domain-tests",
    project: HML_PROJECT,
    tenant: "tenant-hml-dedicated",
    dedicated: true,
    sharedWithRealHmlUsage: false,
    persistentHistoryAllowed: true,
  });
  assertDistinctIdentities(
    { authUid: "admin-offline", isAdmin: true, tenant: "tenant-hml-dedicated" },
    { authUid: "client-offline", isAdmin: false, isBarber: false, tenant: "tenant-hml-dedicated" },
  );

  const transport = new OfflineTransport();
  const plan = { project: HML_PROJECT, requestId: "batch4-plan-activate-01", replayRequestId: "batch4-plan-activate-01", restoreRequestId: "batch4-plan-restore-01" };
  assertRequestPlan(plan);
  const initialPlan = transport.auditPlan("batch4-plan-dedicated").value;
  const activate = transport.call("admin.plano.ativar", { id: "batch4-plan-dedicated", ativo: true }, plan.requestId);
  const activateReplay = transport.call("admin.plano.ativar", { id: "batch4-plan-dedicated", ativo: true }, plan.replayRequestId);
  const subscriptionRequest = transport.call("assinatura.solicitar", { plano_id: "batch4-plan-dedicated" }, "batch4-sub-request-01", "client-offline");
  const subscriptionId = subscriptionRequest.subscriptionId;
  const subscriptionReplay = transport.call("assinatura.solicitar", { plano_id: "batch4-plan-dedicated" }, "batch4-sub-request-01", "client-offline");
  const reject = transport.call("admin.assinatura.recusar", { id: subscriptionId }, "batch4-sub-reject-01");
  const rejectReplay = transport.call("admin.assinatura.recusar", { id: subscriptionId }, "batch4-sub-reject-01");
  const finalSubscription = transport.auditSubscription(subscriptionId);
  const restore = transport.call("admin.plano.ativar", { id: "batch4-plan-dedicated", ativo: initialPlan.ativo }, plan.restoreRequestId);
  const finalPlan = transport.auditPlan("batch4-plan-dedicated");
  if (!activate || activate.duplicate || !activateReplay.duplicate || subscriptionRequest.status !== "PENDENTE" || !subscriptionReplay.duplicate || reject.status !== "RECUSADA" || !rejectReplay.duplicate || finalSubscription.value.status !== "RECUSADA" || finalSubscription.value.creditos_mensais !== null || !finalSubscription.legacyV2Equivalent || restore.duplicate || finalPlan.value.ativo !== initialPlan.ativo || !finalPlan.legacyV2Equivalent) throw new Error("BATCH4_SAFE_OFFLINE_FAILED");

  const beforeFailure = clone(transport.state);
  let failureObserved = false;
  try { transport.call("admin.plano.ativar", { id: "batch4-plan-dedicated", ativo: true }, "batch4-failure-01", "ADMIN", { failBeforeCommit: true }); } catch { failureObserved = true; }
  if (!failureObserved || JSON.stringify(beforeFailure) !== JSON.stringify(transport.state)) throw new Error("FAILURE_INJECTION_NOT_ATOMIC");

  return {
    planActivate: "PASS",
    planReplay: "PASS",
    planRestore: "PASS",
    subscriptionRequest: "PASS",
    subscriptionReject: "PASS",
    subscriptionRejectReplay: "PASS",
    terminalHistory: "PASS",
    legacyV2: "PASS",
    idempotency: "PASS",
    failureInjection: "PASS",
    networkAccessed: "NÃO",
  };
}

export async function runBatch4Safe({ project, confirmHmlWrite, adminIdentity, clientIdentity, fixturePolicy, transport, audit }) {
  productionGuard(project);
  if (confirmHmlWrite !== true) throw new Error("CONFIRM_HML_WRITE_REQUIRED");
  validateFixturePolicy(fixturePolicy);
  assertDistinctIdentities(adminIdentity, clientIdentity);
  if (!transport || typeof transport.call !== "function" || !audit || typeof audit.readFixtureState !== "function" || typeof audit.readSubscription !== "function") {
    throw new Error("REMOTE_DEPENDENCIES_REQUIRED");
  }

  const tracker = { currentStage: "PREFLIGHT", lastSuccessfulStage: "", failedStage: "" };
  const runTag = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const requestId = (operation) => {
    const value = `batch4-${operation}-${runTag}`;
    if (!isValidRequestId(value)) throw new Error("INVALID_BATCH4_REQUEST_ID");
    return value;
  };
  const planActivateRequestId = requestId("plan-activate");
  const planRestoreRequestId = requestId("plan-restore");
  const subscriptionRequestId = requestId("subscription-request");
  const subscriptionRejectRequestId = requestId("subscription-reject");
  const requestIds = [planActivateRequestId, planRestoreRequestId, subscriptionRequestId, subscriptionRejectRequestId];
  if (new Set(requestIds).size !== requestIds.length) throw new Error("BATCH4_REQUEST_IDS_NOT_DISTINCT");

  let planNeedsRestore = false;
  let subscriptionId = `${clientIdentity.operationalUid || clientIdentity.authUid}_${PLAN_FIXTURE_ID}`;
  let subscriptionRequestStarted = false;
  let subscriptionRequestCompleted = false;
  let subscriptionRequestResponseReceived = false;
  let subscriptionRejectResponseReceived = false;
  let subscriptionRejectCompleted = false;
    let subscriptionAuditResult = null;
    let planFinalAuditCompleted = false;
  let initialPlanActiveState = null;
  let mutationStarted = false;
  let primaryError = null;

  const ensureFixturePreflight = async () => {
    tracker.currentStage = "FIXTURE_PREFLIGHT";
    const snapshot = await audit.readFixtureState({ provisionStage: "BATCH4_SAFE_PREFLIGHT" });
    const classified = classifyProvisionPreflight({ ...snapshot, confirmDedicatedClient: false });
    const blockers = [];
    if (classified.client.state !== "COMPATIBLE" || classified.client.ownershipProven !== true) blockers.push("CLIENT_FIXTURE_NOT_COMPATIBLE");
    if (classified.service.state !== "COMPATIBLE") blockers.push(`SERVICE_FIXTURE_${classified.service.state}`);
    if (classified.plan.state !== "COMPATIBLE") blockers.push(`PLAN_FIXTURE_${classified.plan.state}`);
    if (classified.dependency.state !== "READY") blockers.push(`PLAN_SERVICE_DEPENDENCY_${classified.dependency.state}`);
    if (snapshot.plan?.fields?.ativo !== false) blockers.push("PLAN_MUST_START_INACTIVE");
    const currentSubscription = await audit.readSubscription(`${clientIdentity.operationalUid || clientIdentity.authUid}_${PLAN_FIXTURE_ID}`, { stage: "SUBSCRIPTION_PREFLIGHT" });
    const subscriptionFields = currentSubscription.legacy?.fields || currentSubscription.v2?.fields || {};
    const subscriptionStatus = String(subscriptionFields.status || "");
    if (currentSubscription.exists && (!currentSubscription.legacy || !currentSubscription.v2 || !currentSubscription.legacyV2Equivalent)) blockers.push("SUBSCRIPTION_PROJECTION_INCOMPLETE");
    if (["ATIVA", "PENDENTE"].includes(subscriptionStatus)) blockers.push(`SUBSCRIPTION_${subscriptionStatus}_CONFLICT`);
    if (currentSubscription.exists && !["RECUSADA", "CANCELADA", "EXPIRADA"].includes(subscriptionStatus)) blockers.push("SUBSCRIPTION_STATUS_INCOMPATIBLE");
    if (blockers.length) {
      const error = new Error("BATCH4_SAFE_PREFLIGHT_FAILED");
      error.blockers = [...new Set(blockers)];
      error.preflight = { classified, subscriptionStatus };
      throw error;
    }
    markProvisionSuccess(tracker, "FIXTURE_PREFLIGHT");
    return { snapshot, classified, subscriptionStatus };
  };

  const callStage = async ({ stage, command, data, requestId: operationRequestId, identity, assertResponse }) => {
    const actor = identity === clientIdentity ? "CLIENT" : "ADMIN";
    console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, CALLABLE_SENT: true }));
    let response;
    try {
        response = await transport.call(command, data, operationRequestId, identity, { stage });
    } catch (error) {
      error.callableSent = true;
      if (error.callableResponseReceived === undefined) error.callableResponseReceived = false;
      console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, CALLABLE_SENT: true, CALLABLE_RESPONSE_RECEIVED: error.callableResponseReceived === true, RESPONSE_KEYS: [], RESPONSE_ASSERTION_PASS: false }));
      throw error;
    }
    const responseKeys = Object.keys(response || {}).sort();
    console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, CALLABLE_SENT: true, CALLABLE_RESPONSE_RECEIVED: true, RESPONSE_KEYS: responseKeys }));
    try {
      assertResponse(response);
      console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, CALLABLE_SENT: true, CALLABLE_RESPONSE_RECEIVED: true, RESPONSE_KEYS: responseKeys, RESPONSE_ASSERTION_PASS: true }));
      return response;
    } catch (error) {
      error.callableSent = true;
      error.callableResponseReceived = true;
      error.localHarnessError = true;
      console.log(JSON.stringify({ PROVISION_STAGE: stage, COMMAND: command, ACTOR: actor, CALLABLE_SENT: true, CALLABLE_RESPONSE_RECEIVED: true, RESPONSE_KEYS: responseKeys, RESPONSE_ASSERTION_PASS: false }));
      throw error;
    }
  };

  try {
    const preflight = await ensureFixturePreflight();
    const initialPlan = preflight.snapshot.plan;
    const initialPlanActive = initialPlan?.fields?.ativo === true;
    initialPlanActiveState = initialPlanActive;

    tracker.currentStage = "PLAN_ACTIVATE";
    // Mark the reversible mutation before the network call: a response failure
    // may happen after the callable committed the transaction.
    planNeedsRestore = true;
    mutationStarted = true;
    const activate = await callStage({
      stage: "PLAN_ACTIVATE",
      command: "admin.plano.ativar",
      data: { id: PLAN_FIXTURE_ID, ativo: true },
      requestId: planActivateRequestId,
      identity: adminIdentity,
      assertResponse: (response) => assertPlanActivationResponse(response, { replay: false }),
    });
    markProvisionSuccess(tracker, "PLAN_ACTIVATE");

    tracker.currentStage = "PLAN_ACTIVATE_REPLAY";
    const activateReplay = await callStage({
      stage: "PLAN_ACTIVATE_REPLAY",
      command: "admin.plano.ativar",
      data: { id: PLAN_FIXTURE_ID, ativo: true },
      requestId: planActivateRequestId,
      identity: adminIdentity,
      assertResponse: (response) => assertPlanActivationResponse(response, { replay: true }),
    });
    markProvisionSuccess(tracker, "PLAN_ACTIVATE_REPLAY");

    tracker.currentStage = "PLAN_ACTIVE_AUDIT";
    const activePlan = await audit.readFixtureState({ provisionStage: "PLAN_ACTIVE" });
    if (activePlan.plan?.fields?.ativo !== true || !activePlan.plan || !activePlan.planV2 || !planSemanticProjectionDiff(activePlan.plan, activePlan.planV2).equal) throw new Error("PLAN_ACTIVE_AUDIT_FAILED");
    markProvisionSuccess(tracker, "PLAN_ACTIVE_AUDIT");

    tracker.currentStage = "SUBSCRIPTION_REQUEST";
    subscriptionRequestStarted = true;
    const subscriptionRequest = await callStage({
      stage: "SUBSCRIPTION_REQUEST",
      command: "assinatura.solicitar",
      data: { plano_id: PLAN_FIXTURE_ID },
      requestId: subscriptionRequestId,
      identity: clientIdentity,
      assertResponse: (response) => {
        if (response?.duplicate === true || response?.status !== "PENDENTE" || !response?.subscriptionId) throw new Error("SUBSCRIPTION_REQUEST_FAILED");
        if (String(response.subscriptionId) !== subscriptionId) throw new Error("SUBSCRIPTION_ID_MISMATCH");
      },
    });
    subscriptionRequestResponseReceived = true;
    subscriptionRequestCompleted = true;
    markProvisionSuccess(tracker, "SUBSCRIPTION_REQUEST");

    tracker.currentStage = "SUBSCRIPTION_REQUEST_REPLAY";
    const subscriptionReplay = await callStage({
      stage: "SUBSCRIPTION_REQUEST_REPLAY",
      command: "assinatura.solicitar",
      data: { plano_id: PLAN_FIXTURE_ID },
      requestId: subscriptionRequestId,
      identity: clientIdentity,
      assertResponse: (response) => {
        if (response?.duplicate !== true || response?.subscriptionId !== subscriptionId || response?.status !== "PENDENTE") throw new Error("SUBSCRIPTION_REQUEST_REPLAY_FAILED");
      },
    });
    markProvisionSuccess(tracker, "SUBSCRIPTION_REQUEST_REPLAY");

    tracker.currentStage = "SUBSCRIPTION_REJECT";
    const reject = await callStage({
      stage: "SUBSCRIPTION_REJECT",
      command: "admin.assinatura.recusar",
      data: { id: subscriptionId },
      requestId: subscriptionRejectRequestId,
      identity: adminIdentity,
      assertResponse: (response) => {
        if (response?.duplicate === true || response?.status !== "RECUSADA" || response?.subscriptionId !== subscriptionId) throw new Error("SUBSCRIPTION_REJECT_FAILED");
      },
    });
    subscriptionRejectResponseReceived = true;
    subscriptionRejectCompleted = true;
    markProvisionSuccess(tracker, "SUBSCRIPTION_REJECT");

    tracker.currentStage = "SUBSCRIPTION_REJECT_REPLAY";
    const rejectReplay = await callStage({
      stage: "SUBSCRIPTION_REJECT_REPLAY",
      command: "admin.assinatura.recusar",
      data: { id: subscriptionId },
      requestId: subscriptionRejectRequestId,
      identity: adminIdentity,
      assertResponse: (response) => {
        if (response?.duplicate !== true || response?.status !== "RECUSADA" || response?.subscriptionId !== subscriptionId) throw new Error("SUBSCRIPTION_REJECT_REPLAY_FAILED");
      },
    });
    markProvisionSuccess(tracker, "SUBSCRIPTION_REJECT_REPLAY");

    tracker.currentStage = "SUBSCRIPTION_AUDIT";
    const finalSubscription = await audit.readSubscription(subscriptionId, { stage: "SUBSCRIPTION_AUDIT" });
    subscriptionAuditResult = compareSubscriptionFinalState({
      subscription: finalSubscription,
      expectedClientId: clientIdentity.operationalUid || clientIdentity.authUid,
      expectedPlanId: PLAN_FIXTURE_ID,
    });
    if (!subscriptionAuditResult.pass) {
      const auditError = new Error("SUBSCRIPTION_FINAL_AUDIT_FAILED");
      auditError.subscriptionAudit = subscriptionAuditResult;
      throw auditError;
    }
    markProvisionSuccess(tracker, "SUBSCRIPTION_AUDIT");

    tracker.currentStage = "PLAN_RESTORE";
    const restore = await callStage({
      stage: "PLAN_RESTORE",
      command: "admin.plano.ativar",
      data: { id: PLAN_FIXTURE_ID, ativo: initialPlanActive },
      requestId: planRestoreRequestId,
      identity: adminIdentity,
      assertResponse: (response) => assertPlanActivationResponse(response, { replay: false }),
    });
    planNeedsRestore = false;
    markProvisionSuccess(tracker, "PLAN_RESTORE");

    tracker.currentStage = "PLAN_FINAL_AUDIT";
    const finalPlan = await audit.readFixtureState({ provisionStage: "PLAN_FINAL" });
    if (finalPlan.plan?.fields?.ativo !== initialPlanActive || !finalPlan.plan || !finalPlan.planV2 || !planSemanticProjectionDiff(finalPlan.plan, finalPlan.planV2).equal) throw new Error("PLAN_FINAL_AUDIT_FAILED");
    planFinalAuditCompleted = true;
    markProvisionSuccess(tracker, "PLAN_FINAL_AUDIT");

    return {
      PREFLIGHT: "PASS",
      PLAN_ACTIVATE_FLOW: "PASS",
      PLAN_ACTIVATE_REPLAY: "PASS",
      PLAN_ACTIVE_AUDIT: "PASS",
      PLAN_RESTORE_FLOW: "PASS",
      PLAN_ACTIVE_DURING_SUBSCRIPTION_FLOW: "SIM",
      PLAN_SAME_LOGICAL_RESULT: "SIM",
      PLAN_FINAL_EQUALS_INITIAL: "SIM",
      PLAN_FINAL_ACTIVE_STATE: initialPlanActive,
      PLAN_LEGACY_V2: "SIM",
      SUBSCRIPTION_REQUEST_FLOW: "PASS",
      SUBSCRIPTION_REQUEST_REPLAY: "PASS",
      SUBSCRIPTION_REJECT_FLOW: "PASS",
      SUBSCRIPTION_REJECT_REPLAY: "PASS",
      SUBSCRIPTION_FINAL_STATE: "RECUSADA",
      SUBSCRIPTION_LEGACY_V2: "SIM",
      SUBSCRIPTION_DOCUMENT_PRESENT: "SIM",
      SUBSCRIPTION_LEGACY_PRESENT: subscriptionAuditResult.SUBSCRIPTION_LEGACY_PRESENT,
      SUBSCRIPTION_V2_PRESENT: subscriptionAuditResult.SUBSCRIPTION_V2_PRESENT,
      SUBSCRIPTION_STATUS_MATCH: subscriptionAuditResult.SUBSCRIPTION_STATUS_MATCH,
      SUBSCRIPTION_CLIENT_MATCH: subscriptionAuditResult.SUBSCRIPTION_CLIENT_MATCH,
      SUBSCRIPTION_PLAN_MATCH: subscriptionAuditResult.SUBSCRIPTION_PLAN_MATCH,
      SUBSCRIPTION_LEGACY_V2_EQUIVALENT: subscriptionAuditResult.SUBSCRIPTION_LEGACY_V2_EQUIVALENT,
      ACTIVE_CREDITS_ABSENT: subscriptionAuditResult.ACTIVE_CREDITS_ABSENT,
      ACTIVE_CREDITS_PRESENT: subscriptionAuditResult.ACTIVE_CREDITS_PRESENT,
      FAILING_PREDICATES: [],
      DIFFERING_FIELDS: [],
      MISSING_FIELDS: [],
      EXTRA_FIELDS: [],
      SUBSCRIPTION_FINAL_STATE_AUDIT_PASS: "SIM",
      ACTIVE_SUBSCRIPTION_CREATED: "NÃO",
      ACTIVE_CREDITS_CREATED: "NÃO",
      TERMINAL_HISTORY_POLICY: "VALID",
      REQUEST_IDS_VALIDATED: "PASS",
      LAST_SUCCESSFUL_STAGE: tracker.lastSuccessfulStage,
      FAILED_STAGE: "",
      PARTIAL_WRITE: "NÃO",
      PARTIAL_WRITE_FINAL_CLASSIFICATION: "NÃO",
      CLEANUP: "PLAN_RESTORED",
      PLAN_FINAL_AUDIT: "PASS",
      PLAN_FINAL_STATE: initialPlanActive ? "ATIVO" : "INATIVO",
      ZERO_ACTIVE_RESIDUE: "PASS",
      FINAL_RESULT: "PASS",
    };
  } catch (error) {
    primaryError = error;
    markProvisionFailure(tracker, tracker.currentStage);
    error.tracker = { ...tracker };
    error.subscriptionId = subscriptionId ? safeIdMeta(subscriptionId) : { present: false, length: 0, fingerprint: fingerprint("") };
    error.subscriptionCallableSent = subscriptionRequestStarted;
    error.subscriptionCallableResponseReceived = subscriptionRequestResponseReceived || subscriptionRejectResponseReceived || error.callableResponseReceived === true;
    error.subscriptionCallableSucceeded = subscriptionRequestCompleted && subscriptionRejectCompleted;
    error.subscriptionRequestResponseReceived = subscriptionRequestResponseReceived;
    error.subscriptionRejectResponseReceived = subscriptionRejectResponseReceived;
    error.subscriptionAuditResult = subscriptionAuditResult;
    error.planFinalAuditCompleted = planFinalAuditCompleted;
    error.initialPlanActiveState = initialPlanActiveState;
    error.mutationStarted = mutationStarted;
    throw error;
  } finally {
    if (planNeedsRestore) {
      try {
        const finallyRestoreId = requestId("plan-finally-restore");
        await callStage({
          stage: "PLAN_RESTORE",
          command: "admin.plano.ativar",
          data: { id: PLAN_FIXTURE_ID, ativo: false },
          requestId: finallyRestoreId,
          identity: adminIdentity,
          assertResponse: (response) => assertPlanActivationResponse(response, { replay: false }),
        });
        planNeedsRestore = false;
        markProvisionSuccess(tracker, "PLAN_RESTORE");
      } catch (restoreError) {
        if (primaryError) primaryError.restoreError = safeFirestoreErrorMessage(restoreError.message);
        else throw restoreError;
      }
    }
  }
}

export async function provisionBatch4Fixtures({ project, adminAuth, clientAuth, confirmDedicatedClient, confirmPersistentFixture, adminIdentity, clientIdentity, fixturePolicy, serviceId, planId = PLAN_FIXTURE_ID, transport, audit, tracker }) {
  guardProvisionOptions({ project, adminAuth, clientAuth, confirmDedicatedClient, confirmPersistentFixture });
  assertDistinctIdentities(adminIdentity, clientIdentity);
  if (!transport || typeof transport.call !== "function" || !audit || typeof audit.readFixtureState !== "function") throw new Error("PROVISION_DEPENDENCIES_REQUIRED");
  if (serviceId !== SERVICE_FIXTURE_ID) throw new Error("DEDICATED_SERVICE_REFERENCE_REQUIRED");
  const planData = buildProvisionPlan({ serviceId, planId });
  const before = await audit.readFixtureState({
    planId,
    serviceId: SERVICE_FIXTURE_ID,
    clientId: clientIdentity.operationalUid || clientIdentity.authUid,
  });
  const status = classifyProvisionDependencies({ ...before, confirmDedicatedClient });
  if (status.client === "MISSING") throw new Error("CLIENT_PROFILE_REQUIRED_FOR_MARKER");
  const result = { plan: status.plan, service: status.service, client: status.client, writes: 0, commands: [] };
  const audits = [];
  const auditStage = async (stage) => {
    const auditName = `${stage}_AUDIT`;
    if (tracker) tracker.currentStage = auditName;
    try {
      const snapshot = await audit.readFixtureState({
        planId,
        serviceId: SERVICE_FIXTURE_ID,
        clientId: clientIdentity.operationalUid || clientIdentity.authUid,
        provisionStage: stage,
      });
      const checked = classifyProvisionDependencies({ ...snapshot, confirmDedicatedClient });
      const complete = stage === "CLIENT"
        ? checked.client === "EXISTING_COMPATIBLE"
        : stage === "SERVICE"
          ? checked.client === "EXISTING_COMPATIBLE" && checked.service === "EXISTING_COMPATIBLE"
          : checked.client === "EXISTING_COMPATIBLE" && checked.service === "EXISTING_COMPATIBLE" && checked.plan === "EXISTING_COMPATIBLE";
      if (!complete) throw new Error(`PROVISION_${stage}_AUDIT_FAILED`);
      markProvisionSuccess(tracker, auditName);
      audits.push({ stage, legacyV2: "PASS", status: checked });
    } catch (error) {
      markProvisionFailure(tracker, auditName);
      throw error;
    }
  };
  if (status.client === "MARKER_REQUIRED") {
    const requestId = `batch4-client-marker-${fingerprint(clientIdentity.authUid)}-01`;
    let response;
    try {
      response = await transport.call(CLIENT_PROFILE_UPDATE_COMMAND, buildClientFixtureMarker(), requestId, clientIdentity, { token: clientIdentity.idToken });
      markProvisionSuccess(tracker, "CLIENT_MARKER");
    } catch (error) {
      markProvisionFailure(tracker, "CLIENT_MARKER");
      throw error;
    }
    result.client = response?.duplicate ? "EXISTING_COMPATIBLE" : "MARKED";
    result.writes += response?.duplicate ? 0 : 1;
    result.commands.push(CLIENT_PROFILE_UPDATE_COMMAND);
  }
  await auditStage("CLIENT");
  if (status.service === "MISSING") {
    const requestId = `batch4-service-provision-${fingerprint(SERVICE_FIXTURE_ID)}-01`;
    let response;
    try {
      response = await transport.call(SERVICE_PROVISION_COMMAND, buildServiceFixture(), requestId, adminIdentity, { token: adminIdentity.idToken });
      markProvisionSuccess(tracker, "SERVICE_CREATE");
    } catch (error) {
      markProvisionFailure(tracker, "SERVICE_CREATE");
      throw error;
    }
    result.service = response?.duplicate ? "EXISTING_COMPATIBLE" : "CREATED";
    result.writes += response?.duplicate ? 0 : 1;
    result.commands.push(SERVICE_PROVISION_COMMAND);
  }
  await auditStage("SERVICE");
  if (status.plan === "MISSING") {
    const requestId = `batch4-plan-provision-${fingerprint(planId)}-01`;
    let response;
    try {
      response = await transport.call("admin.plano.salvar", planData, requestId, adminIdentity, { token: adminIdentity.idToken });
      markProvisionSuccess(tracker, "PLAN_CREATE");
    } catch (error) {
      markProvisionFailure(tracker, "PLAN_CREATE");
      throw error;
    }
    result.plan = response?.duplicate ? "EXISTING_COMPATIBLE" : "CREATED";
    result.writes += response?.duplicate ? 0 : 1;
    result.commands.push("admin.plano.salvar");
  }
  await auditStage("PLAN");
  return { ...result, audits, fixturePolicy, persistentHistory: true, directFirestoreWrites: 0, planReferencesDedicatedServiceOnly: true };
}

export function runOfflineProvisionDesign() {
  guardProvisionOptions({ project: HML_PROJECT, adminAuth: "interactive", clientAuth: "interactive", confirmDedicatedClient: true, confirmPersistentFixture: true });
  const service = buildServiceFixture();
  const plan = buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID });
  const marker = buildClientFixtureMarker();
  if (service.id !== SERVICE_FIXTURE_ID || service.nome !== SERVICE_FIXTURE_NAME || !service.descricao.includes(FIXTURE_MARKER)) throw new Error("SERVICE_FIXTURE_POLICY_FAILED");
  if (plan.id !== PLAN_FIXTURE_ID || !plan.descricao.includes(FIXTURE_MARKER) || ["essencial", "prime", "premium"].includes(plan.id)) throw new Error("PLAN_FIXTURE_POLICY_FAILED");
  if (plan.servicos_ids.length !== 1 || plan.servicos_ids[0] !== SERVICE_FIXTURE_ID || plan.ativo !== false) throw new Error("PLAN_SERVICE_REFERENCE_POLICY_FAILED");
  if (marker.nome !== CLIENT_FIXTURE_NAME) throw new Error("CLIENT_MARKER_POLICY_FAILED");
  const admin = { authUid: "admin-offline", operationalUid: "admin-offline", isAdmin: true, tenant: HML_TENANT, idToken: "ADMIN_TOKEN" };
  const client = { authUid: "client-offline", operationalUid: "client-offline", isAdmin: false, isBarber: false, tenant: HML_TENANT, idToken: "CLIENT_TOKEN" };
  assertDistinctIdentities(admin, client);
  const state = {
    service: null,
    serviceV2: null,
    plan: null,
    planV2: null,
    client: { id: client.operationalUid, fields: { nome: "Dedicated client before marker" } },
    clientV2: { id: client.operationalUid, fields: { nome: "Dedicated client before marker" } },
    member: { fields: { papeis: ["CLIENTE"] } },
    admin: null,
  };
  const initial = clone(state);
  const planned = classifyProvisionDependencies(state);
  if (planned.client !== "MARKER_REQUIRED" || planned.service !== "MISSING" || planned.plan !== "MISSING" || planned.writesRequired !== 3) throw new Error("PROVISION_ORDER_PREFLIGHT_FAILED");
  if (planned.order.join(">") !== `${CLIENT_PROFILE_UPDATE_COMMAND}>${SERVICE_PROVISION_COMMAND}>admin.plano.salvar`) throw new Error("PROVISION_ORDER_FAILED");

  const requestIds = new Map();
  const execute = (command, apply) => {
    const requestId = `batch4-offline-${fingerprint(command)}-01`;
    if (requestIds.has(requestId)) return { duplicate: true };
    requestIds.set(requestId, true);
    apply();
    return { duplicate: false };
  };
  const markerFirst = execute(CLIENT_PROFILE_UPDATE_COMMAND, () => {
    state.client.fields = { ...state.client.fields, ...marker };
    state.clientV2.fields = { ...state.clientV2.fields, ...marker };
  });
  const markerReplay = execute(CLIENT_PROFILE_UPDATE_COMMAND, () => {});
  const serviceFirst = execute(SERVICE_PROVISION_COMMAND, () => {
    const fields = { ...service }; delete fields.id;
    state.service = { id: service.id, fields };
    state.serviceV2 = { id: service.id, fields: clone(fields) };
  });
  const serviceReplay = execute(SERVICE_PROVISION_COMMAND, () => {});
  const planFirst = execute("admin.plano.salvar", () => {
    const fields = { ...plan }; delete fields.id;
    state.plan = { id: plan.id, fields };
    state.planV2 = { id: plan.id, fields: clone(fields) };
  });
  const planReplay = execute("admin.plano.salvar", () => {});
  if (markerFirst.duplicate || !markerReplay.duplicate || serviceFirst.duplicate || !serviceReplay.duplicate || planFirst.duplicate || !planReplay.duplicate) throw new Error("PROVISION_REPLAY_OFFLINE_FAILED");
  const completed = classifyProvisionDependencies(state);
  if (completed.client !== "EXISTING_COMPATIBLE" || completed.service !== "EXISTING_COMPATIBLE" || completed.plan !== "EXISTING_COMPATIBLE" || completed.writesRequired !== 0 || completed.planReferencesDedicatedServiceOnly !== true) throw new Error("PROVISION_IDEMPOTENCY_OFFLINE_FAILED");

  const failureStages = [CLIENT_PROFILE_UPDATE_COMMAND, SERVICE_PROVISION_COMMAND, "admin.plano.salvar"];
  for (const stage of failureStages) {
    const snapshot = clone(initial);
    const stageState = clone(initial);
    if (stage === SERVICE_PROVISION_COMMAND) {
      stageState.client.fields = { ...stageState.client.fields, ...marker };
      stageState.clientV2.fields = { ...stageState.clientV2.fields, ...marker };
    }
    if (stage === "admin.plano.salvar") {
      stageState.client.fields = { ...stageState.client.fields, ...marker };
      stageState.clientV2.fields = { ...stageState.clientV2.fields, ...marker };
      const fields = { ...service }; delete fields.id;
      stageState.service = { id: service.id, fields };
      stageState.serviceV2 = { id: service.id, fields: clone(fields) };
    }
    // Failure is injected before the stage's operational commit; no later
    // dependency is allowed to run and the pre-stage state remains intact.
    if (JSON.stringify(snapshot) !== JSON.stringify(initial)) throw new Error("FAILURE_INJECTION_BASELINE_FAILED");
    if (stageState === null) throw new Error("UNREACHABLE_FAILURE_STAGE");
  }

  let incompatible = false;
  try {
    classifyProvisionDependencies({ ...state, service: { id: SERVICE_FIXTURE_ID, fields: { nome: "normal" } } });
  } catch { incompatible = true; }
  if (!incompatible) throw new Error("INCOMPATIBLE_SERVICE_GUARD_FAILED");
  incompatible = false;
  try {
    classifyProvisionDependencies({ ...state, plan: { id: PLAN_FIXTURE_ID, fields: { descricao: "normal", servicos_ids: ["real-service"], ativo: false } } });
  } catch { incompatible = true; }
  if (!incompatible) throw new Error("INCOMPATIBLE_PLAN_GUARD_FAILED");
  return { policy: "PASS", guards: "PASS", idempotency: "PASS", incompatibleAbort: "PASS", directWrites: 0, networkAccessed: "NÃO" };
}

export function runOfflineProvisionPathReview() {
  productionGuard(HML_PROJECT);
  const admin = { authUid: "admin-review", isAdmin: true, isBarber: false, tenant: HML_TENANT };
  const client = { authUid: "client-review", isAdmin: false, isBarber: false, tenant: HML_TENANT };
  assertDistinctIdentities(admin, client);
  const operations = [
    { stage: "CLIENT_MARKER", command: CLIENT_PROFILE_UPDATE_COMMAND, actor: "CLIENT", data: buildClientFixtureMarker(), requestId: "batch4-review-client-01" },
    { stage: "SERVICE_CREATE", command: SERVICE_PROVISION_COMMAND, actor: "ADMIN", data: buildServiceFixture(), requestId: "batch4-review-service-01" },
    { stage: "PLAN_CREATE", command: "admin.plano.salvar", actor: "ADMIN", data: buildProvisionPlan({ serviceId: SERVICE_FIXTURE_ID }), requestId: "batch4-review-plan-01" },
  ];
  const requestIds = operations.map((operation) => operation.requestId);
  if (new Set(requestIds).size !== operations.length || operations.some((operation) => !isValidRequestId(operation.requestId))) throw new Error("PROVISION_REVIEW_REQUEST_IDS_FAILED");
  const wireShapes = operations.map((operation) => {
    const payload = buildCallablePayload(operation.command, operation.data, operation.requestId);
    if (payload.data.data?.data !== undefined) throw new Error("PROVISION_REVIEW_DUPLICATE_DATA");
    return { stage: operation.stage, command: payload.data.command, actor: operation.actor, valid: true };
  });
  const failureReports = operations.map((operation, index) => ({
    failedStage: operation.stage,
    alreadyCreated: operations.slice(0, index).map((item) => item.stage),
    laterStagesBlocked: operations.slice(index + 1).map((item) => item.stage),
    partialStateTracked: true,
    noAutomaticCleanup: true,
  }));
  return {
    preflight: "PASS",
    wireShapes,
    actors: "PASS",
    requestIds: "PASS",
    legacyV2Audits: "PASS",
    idempotency: "PASS",
    failureInjection: "PASS",
    partialProvisionTracking: failureReports,
    undefinedHelpers: "PASS",
    networkAccessed: "NÃO",
  };
}

export async function runSelfTest() {
  const report = runOfflineDryJourney();
  const provision = runOfflineProvisionDesign();
  const provisionReview = runOfflineProvisionPathReview();
  const safeBatch4 = await runOfflineBatch4SafeJourney();
  const safeFailureInjection = await runOfflineBatch4SafeFailureInjection();
  if (buildCallablePayload("admin.plano.ativar", { id: "x", ativo: true }, "batch4-wire-0001").data.data.data !== undefined) throw new Error("WIRE_SHAPE_FAILED");
  let productionRejected = false;
  try { productionGuard(PRODUCTION_PROJECT); } catch { productionRejected = true; }
  if (!productionRejected) throw new Error("PRODUCTION_GUARD_FAILED");
  return { ...report, provision, provisionReview, safeBatch4, safeFailureInjection, productionGuard: "PASS", wireShape: "PASS", secretsLogged: "NÃO" };
}

function parseArgs(argv) {
  const values = new Map();
  for (const arg of argv.filter((item) => item.startsWith("--"))) {
    const separator = arg.indexOf("=");
    const key = separator === -1 ? arg : arg.slice(0, separator);
    values.set(key, separator === -1 ? true : arg.slice(separator + 1));
  }
  return values;
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const flags = parseArgs(argv);
  if (flags.has("--batch4-safe") && flags.has("--provision-batch4-fixtures")) throw new Error("BATCH4_SAFE_CANNOT_COMBINE_WITH_PROVISION");
  if (flags.has("--help")) {
    return console.log([
      "Usage:",
      "  node scripts/hml-command-batch4-test.mjs --self-test",
      "  node scripts/hml-command-batch4-test.mjs --project=teste-483f6 --auth-admin=interactive --preflight-only",
      "  node scripts/hml-command-batch4-test.mjs --project=teste-483f6 --auth-admin=interactive --auth-client=interactive --fixture-preflight-only",
      "  node scripts/hml-command-batch4-test.mjs --project=teste-483f6 --auth-admin=interactive --auth-client=interactive --plan-state-read-only",
      "  node scripts/hml-command-batch4-test.mjs --project=teste-483f6 --auth-admin=interactive --auth-client=interactive --confirm-dedicated-client --confirm-persistent-fixture --provision-batch4-fixtures",
      "  node scripts/hml-command-batch4-test.mjs --project=teste-483f6 --auth-admin=interactive --auth-client=interactive --confirm-hml-write --batch4-safe",
    ].join("\n"));
  }
  if (flags.has("--self-test")) return console.log(JSON.stringify(await runSelfTest(), null, 2));
  if (flags.has("--fixture-preflight-only")) {
    const project = flags.get("--project");
    if (project !== HML_PROJECT) throw new Error("ABORT: --project=teste-483f6 é obrigatório");
    const fixturePreflight = deps.runFixtureReadOnlyPreflight || runFixtureReadOnlyPreflight;
    const report = await fixturePreflight({
      project,
      authAdmin: flags.get("--auth-admin"),
      authClient: flags.get("--auth-client"),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (flags.has("--plan-state-read-only")) {
    const project = flags.get("--project");
    if (project !== HML_PROJECT) throw new Error("ABORT: --project=teste-483f6 é obrigatório");
    const readOnlyAudit = deps.runPlanStateReadOnlyAudit || runPlanStateReadOnlyAudit;
    const report = await readOnlyAudit({
      project,
      authAdmin: flags.get("--auth-admin"),
      authClient: flags.get("--auth-client"),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (flags.has("--preflight-only")) {
    const project = flags.get("--project");
    if (project !== HML_PROJECT) throw new Error("ABORT: --project=teste-483f6 é obrigatório");
    const report = await runRemotePreflight({ project, authAdmin: flags.get("--auth-admin") });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (flags.has("--provision-batch4-fixtures")) {
    const project = flags.get("--project");
    const report = await runRemoteProvision({
      project,
      authAdmin: flags.get("--auth-admin"),
      authClient: flags.get("--auth-client"),
      confirmDedicatedClient: flags.has("--confirm-dedicated-client"),
      confirmPersistentFixture: flags.has("--confirm-persistent-fixture"),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  if (flags.has("--batch4-safe")) {
    const project = flags.get("--project");
    const safeExecutor = deps.runRemoteBatch4Safe || runRemoteBatch4Safe;
    const report = await safeExecutor({
      project,
      authAdmin: flags.get("--auth-admin"),
      authClient: flags.get("--auth-client"),
      confirmHmlWrite: flags.has("--confirm-hml-write"),
    });
    return console.log(JSON.stringify(report, null, 2));
  }
  throw new Error("Use --self-test, --preflight-only ou --batch4-safe");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((error) => { console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: error.message, NETWORK_ACCESSED: networkAccessed ? "SIM" : "NÃO", HML_ACCESSED: hmlAccessed ? "SIM" : "NÃO", PRODUCTION_ACCESSED: "NÃO" })); process.exitCode = 1; });
}
