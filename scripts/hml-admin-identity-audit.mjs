#!/usr/bin/env node

import { createHash } from "node:crypto";

const PROJECT = "teste-483f6";
const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;

function parseArgs(argv = process.argv) {
  return {
    project: argv.find((v) => v.startsWith("--project="))?.slice(10) || "",
    selfTest: argv.includes("--self-test"),
  };
}

function assertReadOnlyGuards(opts, env = process.env) {
  if (opts.project !== PROJECT) throw new Error("exact HML project is required");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (!env.HML_ADMIN_UID || !env.FIRESTORE_AUDIT_TOKEN) throw new Error("HML_ADMIN_UID and FIRESTORE_AUDIT_TOKEN are required");
}

function shortFingerprint(value) {
  return createHash("sha256").update(String(value || "")).digest("hex").slice(0, 12);
}

function decodeValue(value) {
  if (!value) return undefined;
  if (value.stringValue !== undefined) return value.stringValue;
  if (value.booleanValue !== undefined) return value.booleanValue;
  if (value.integerValue !== undefined) return Number(value.integerValue);
  if (value.doubleValue !== undefined) return value.doubleValue;
  if (value.arrayValue) return (value.arrayValue.values || []).map(decodeValue);
  if (value.mapValue) return Object.fromEntries(Object.entries(value.mapValue.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
  return undefined;
}

function fields(document) {
  return Object.fromEntries(Object.entries(document?.fields || {}).map(([k, v]) => [k, decodeValue(v)]));
}

function identitySummary(uid) {
  return { present: Boolean(uid), length: String(uid || "").length, fingerprint: shortFingerprint(uid) };
}

async function readDocument(path, token) {
  const response = await fetch(`${ROOT}/${path}`, { headers: { authorization: `Bearer ${token}` } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`read failed HTTP ${response.status}`);
  return response.json();
}

function adminRole(document) {
  if (!document) return false;
  const data = fields(document);
  return data.ativo !== false && (data.papel === "ADMIN" || data.role === "ADMIN" || data.tipo === "ADMIN" || data.admin === true || data.papeis?.includes?.("ADMIN") || Boolean(document));
}

export async function auditIdentity({ authUid, auditToken, read = readDocument }) {
  const authAdmin = await read(`admins/${authUid}`, auditToken);
  const authMember = await read(`barbearias/${TENANT}/membros/${authUid}`, auditToken);
  const mapping = await read(`homologacao_mapeamentos/${authUid}`, auditToken);
  const mappingData = fields(mapping);
  const operationalUid = typeof mappingData.uid_producao_referencia === "string" ? mappingData.uid_producao_referencia.trim() : "";
  const operationalAdmin = operationalUid ? await read(`admins/${operationalUid}`, auditToken) : null;
  const operationalMember = operationalUid ? await read(`barbearias/${TENANT}/membros/${operationalUid}`, auditToken) : null;
  const authMemberData = fields(authMember);
  const operationalMemberData = fields(operationalMember);
  return {
    authUid: identitySummary(authUid),
    operationalUid: identitySummary(operationalUid),
    authUidAdmin: adminRole(authAdmin),
    authUidMemberAdmin: authMemberData.papeis?.includes?.("ADMIN") === true,
    mappingExists: Boolean(mapping),
    operationalUidAdmin: adminRole(operationalAdmin),
    operationalUidMemberAdmin: operationalMemberData.papeis?.includes?.("ADMIN") === true,
    mappingTenantMatches: mappingData.tenant_id === TENANT,
  };
}

function runSelfTest() {
  const doc = (fields) => ({ fields });
  const encoded = (v) => typeof v === "boolean" ? { booleanValue: v } : { stringValue: v };
  const reads = new Map([
    [`admins/auth`, null],
    [`barbearias/${TENANT}/membros/auth`, doc({ papeis: { arrayValue: { values: [encoded("CLIENTE")] } } })],
    [`homologacao_mapeamentos/auth`, doc({ uid_producao_referencia: encoded("operational") , tenant_id: encoded(TENANT) })],
    [`admins/operational`, null],
    [`barbearias/${TENANT}/membros/operational`, doc({ papeis: { arrayValue: { values: [encoded("ADMIN")] } } })],
  ]);
  const read = async (path) => reads.get(path) || null;
  return auditIdentity({ authUid: "auth", auditToken: "offline", read }).then((result) => {
    if (!result.mappingExists || !result.operationalUidMemberAdmin || result.authUidAdmin || result.authUidMemberAdmin) throw new Error("offline identity audit failed");
    console.log("hml admin identity audit self-test: PASS");
  });
}

async function main() {
  const opts = parseArgs();
  if (opts.selfTest) return runSelfTest();
  assertReadOnlyGuards(opts);
  const result = await auditIdentity({ authUid: process.env.HML_ADMIN_UID, auditToken: process.env.FIRESTORE_AUDIT_TOKEN });
  console.log(JSON.stringify({ ...result, readOnly: true, project: PROJECT, tenant: TENANT }));
}

if (process.argv[1]?.endsWith("hml-admin-identity-audit.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
