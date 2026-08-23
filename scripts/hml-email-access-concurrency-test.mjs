#!/usr/bin/env node

import { randomUUID, createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PROJECT = "teste-483f6";
const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const REGION = "southamerica-east1";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CALLABLE = `https://${REGION}-${PROJECT}.cloudfunctions.net/executeOperationalCommand`;
const TERMINAL = new Set(["cancelado", "cancelled"]);
let activeCredentialSession = null;
function clearCredentialSession() {
  if (!activeCredentialSession) return;
  activeCredentialSession.idToken = "";
  activeCredentialSession.refreshToken = "";
  activeCredentialSession.localId = "";
  activeCredentialSession = null;
}

function options(argv = process.argv) {
  const project = argv.find((value) => value.startsWith("--project="))?.slice(10) || "";
  const auth = argv.find((value) => value.startsWith("--auth="))?.slice(7) || "env";
  return { project, auth, confirm: argv.includes("--confirm-hml-write"), preflightOnly: argv.includes("--preflight-only"), selfTest: argv.includes("--self-test") };
}
export function validateGuards(opts, env = process.env, { requireWriteConfirmation = true } = {}) {
  if (opts.project !== PROJECT) throw new Error("HML project guard failed");
  if (!new Set(["env", "interactive"]).has(opts.auth)) throw new Error("unsupported auth mode");
  if (opts.auth === "interactive" && opts.project !== PROJECT) throw new Error("interactive auth is HML-only");
  if (requireWriteConfirmation && !opts.confirm) throw new Error("--confirm-hml-write is required");
  if (opts.project === "barber-a01e7") throw new Error("production is forbidden");
  if (env.HML_CALLABLE_ENDPOINT && env.HML_CALLABLE_ENDPOINT !== CALLABLE) throw new Error("HML endpoint mismatch");
  if (!env.FIRESTORE_AUDIT_TOKEN) throw new Error("FIRESTORE_AUDIT_TOKEN is required");
  if (opts.auth !== "interactive" && (!env.FIREBASE_ID_TOKEN || !env.HML_ADMIN_UID)) throw new Error("ephemeral ADMIN credentials are required");
}
export function normalizeEmail(value) { return String(value ?? "").trim().toLowerCase(); }
export function indexPath(email) { return `barbearias/${TENANT}/email_acesso_index/${createHash("sha256").update(normalizeEmail(email)).digest("hex")}`; }
export function newFixtures() {
  const id = randomUUID().replace(/-/g, "").slice(0, 16);
  return { idA: `hml_email_race_a_${id}`, idB: `hml_email_race_b_${id}`, emailA: `hml-email-race-${id}@example.invalid`, emailB: `hml-email-rotated-${id}@example.invalid`, requestPrefix: `hml-email-race-${id}` };
}
function decode(v) {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(decode);
  if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([key, value]) => [key, decode(value)]));
  return null;
}
function fields(doc) { return Object.fromEntries(Object.entries(doc?.fields || {}).map(([key, value]) => [key, decode(value)])); }
function docId(doc) { return String(doc?.name || "").split("/").at(-1); }
function safeError(error) { return { code: String(error?.code || ""), message: String(error?.message || "").replace(/(token|password|senha|authorization|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]") }; }
function decodeJwtPayload(token) {
  const parts = String(token || "").split(".");
  if (parts.length !== 3) return null;
  try {
    const encoded = parts[1].replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(parts[1].length / 4) * 4, "=");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch { return null; }
}
export function normalizeIdToken(value) { return String(value || "").trim(); }
export function tokenPreflightMetadata(rawToken, expectedProject, uid) {
  const raw = String(rawToken || "");
  const token = raw.trim();
  const leadingWhitespaceRemoved = raw.length > 0 && raw !== raw.replace(/^\s+/, "");
  const trailingWhitespaceRemoved = raw.length > 0 && raw !== raw.replace(/\s+$/, "");
  const claims = decodeJwtPayload(token);
  const actualAud = typeof claims?.aud === "string" ? claims.aud : "";
  return {
    expectedProject,
    actualAud,
    expectedProjectLength: expectedProject.length,
    actualAudLength: actualAud.length,
    audType: typeof claims?.aud,
    audMatches: actualAud === expectedProject,
    tokenSegments: token.split(".").length,
    tokenLength: token.length,
    leadingWhitespaceRemoved,
    trailingWhitespaceRemoved,
    rawLength: raw.length,
    trimmedLength: token.length,
    trimChanged: raw !== token,
    claims,
    token,
  };
}
export function validateFirebaseIdToken(token, uid, expectedProject = PROJECT, emit = null) {
  const metadata = tokenPreflightMetadata(token, expectedProject, uid);
  if (emit) emit({ TOKEN_PREFLIGHT: { ...metadata, claims: undefined, token: undefined } });
  token = metadata.token;
  const claims = metadata.claims;
  assert(claims && claims.aud === expectedProject, "Firebase ID token project mismatch");
  assert(typeof claims.sub === "string" && claims.sub === uid, "Firebase ID token UID mismatch");
  assert(Number(claims.exp) > Math.floor(Date.now() / 1000), "Firebase ID token expired");
  return { projectMatch: true, uidMatch: true, unexpired: true };
}
export function buildCallableRequest(command, data, requestId, token) {
  assert(typeof token === "string" && token.length > 0, "Firebase ID token is required");
  return {
    method: "POST",
    redirect: "error",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ data: { command, requestId, data } }),
  };
}
export function runPreflight(argv, env, emit = (value) => console.log(JSON.stringify(value))) {
  const opts = options(argv);
  assert(opts.preflightOnly, "--preflight-only is required");
  validateGuards(opts, env, { requireWriteConfirmation: false });
  validateFirebaseIdToken(env.FIREBASE_ID_TOKEN, env.HML_ADMIN_UID, opts.project, emit);
  return { project: opts.project, network: false };
}
export function classifyRace(results) {
  const winners = results.filter((result) => result.status === "fulfilled");
  const rejections = results.filter((result) => result.status === "rejected");
  const rejectionText = rejections.map((result) => `${result.reason?.code || ""} ${result.reason?.message || ""}`).join(" ");
  const validRejection = rejections.length === 1 && /already-exists|failed-precondition|EMAIL_JA_VINCULADO|uniqu|vinculad/i.test(rejectionText);
  return {
    concurrentRequests: results.length,
    winners: winners.length,
    rejections: rejections.length,
    validRejection,
    concurrentRequestsEq2: results.length === 2,
    winnersEq1: winners.length === 1,
    rejectionsEq1: rejections.length === 1,
    rejectionIsUniqueness: validRejection,
    requestStatuses: results.map((result) => result.status),
    rejectionCodes: rejections.map((result) => String(result.reason?.code || "")),
    rejectionClasses: rejections.map((result) => /already-exists|EMAIL_JA_VINCULADO|uniqu|vinculad/i.test(`${result.reason?.code || ""} ${result.reason?.message || ""}`) ? "UNIQUENESS" : "OTHER"),
  };
}
export function classifyResidue(docs, fixtureIds, indexPaths) {
  const fixtureSet = new Set(fixtureIds); const indexSet = new Set(indexPaths);
  return docs.filter((doc) => fixtureSet.has(docId(doc)) || indexSet.has(docId(doc))).length === 0;
}
export function cleanupIds(fixtures, discoveredIds = []) { return [...new Set([fixtures.idA, fixtures.idB, ...discoveredIds])]; }
function assert(condition, message) { if (!condition) throw new Error(message); }
async function assertRejects(operation, expectedMessage) {
  try { await operation(); } catch (error) { assert(error.message === expectedMessage, `unexpected rejection: ${error.message}`); return; }
  throw new Error(`expected rejection: ${expectedMessage}`);
}

function hmlAuthConfig() {
  const source = readFileSync(new URL("../public-hml/js/firebase-config.js", import.meta.url), "utf8");
  const apiKey = source.match(/"apiKey"\s*:\s*"([^"]+)"/)?.[1] || "";
  const projectId = source.match(/"projectId"\s*:\s*"([^"]+)"/)?.[1] || "";
  assert(projectId === PROJECT && apiKey, "HML Auth configuration unavailable");
  return { apiKey, projectId };
}
async function authenticateInteractive({ email, password, request = fetch, apiKey = hmlAuthConfig().apiKey }) {
  assert(typeof email === "string" && email.trim(), "HML admin e-mail is required");
  assert(typeof password === "string" && password.length > 0, "HML admin password is required");
  const response = await request(`https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${encodeURIComponent(apiKey)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ email: email.trim(), password, returnSecureToken: true }),
  });
  const body = await response.json();
  if (!response.ok || !body.idToken || !body.localId) {
    const error = new Error("HML Admin authentication failed");
    error.code = body?.error?.message || String(response.status);
    throw error;
  }
  const session = { idToken: normalizeIdToken(body.idToken), refreshToken: String(body.refreshToken || ""), localId: String(body.localId) };
  validateFirebaseIdToken(session.idToken, session.localId, PROJECT);
  return session;
}
function promptLine(label, { silent = false } = {}) {
  return new Promise((resolve, reject) => {
    process.stdout.write(label);
    const stdin = process.stdin;
    let value = "";
    const onData = (chunk) => {
      const text = String(chunk);
      if (text === "\u0003") { cleanup(); reject(new Error("interactive authentication cancelled")); return; }
      if (text === "\r" || text === "\n") { cleanup(); process.stdout.write("\n"); resolve(value); return; }
      value += text;
      if (!silent && text !== "\r" && text !== "\n") process.stdout.write(text);
    };
    const cleanup = () => { stdin.off("data", onData); if (stdin.isTTY) stdin.setRawMode(false); stdin.pause(); };
    if (stdin.isTTY) stdin.setRawMode(true);
    stdin.resume(); stdin.setEncoding("utf8"); stdin.on("data", onData);
  });
}
async function obtainInteractiveAuth() {
  let email = await promptLine("HML Admin e-mail: ");
  let password = await promptLine("HML Admin senha: ", { silent: true });
  try { return await authenticateInteractive({ email, password }); }
  finally { email = null; password = null; }
}

async function get(path, token) {
  const response = await fetch(`${ROOT}/${path}`, { headers: buildAuditHeaders(token) });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`audit GET HTTP ${response.status}`);
  return response.json();
}
export function buildAuditHeaders(token) {
  assert(typeof token === "string" && token.length > 0, "audit token is required");
  return { Authorization: `Bearer ${token}` };
}
async function query(path, token) {
  const response = await fetch(`${ROOT}:runQuery`, { method: "POST", headers: { ...buildAuditHeaders(token), "Content-Type": "application/json" }, body: JSON.stringify({ structuredQuery: { from: [{ collectionId: path }] } }) });
  if (!response.ok) throw new Error(`audit query HTTP ${response.status}`);
  return (await response.json()).filter((item) => item.document).map((item) => item.document);
}
async function auditFixture(fixtures, token) {
  const paths = [
    `barbeiros/${fixtures.idA}`, `barbeiros/${fixtures.idB}`,
    `barbearias/${TENANT}/barbeiros/${fixtures.idA}`, `barbearias/${TENANT}/barbeiros/${fixtures.idB}`,
    indexPath(fixtures.emailA), indexPath(fixtures.emailB),
  ];
  const docs = await Promise.all(paths.map((path) => get(path, token)));
  return { paths, docs, byPath: Object.fromEntries(paths.map((path, i) => [path, docs[i]])) };
}
async function call(command, data, requestId, token) {
  const response = await fetch(CALLABLE, buildCallableRequest(command, data, requestId, token));
  const text = await response.text(); let body = null; try { body = JSON.parse(text); } catch { /* sanitized below */ }
  if (!response.ok || body?.error) { const error = new Error(body?.error?.message || `callable HTTP ${response.status}`); error.code = body?.error?.status || body?.error?.code || String(response.status); throw error; }
  return body?.result ?? body?.data;
}
export async function proveAdmin(token, auditToken, uid, read = get) {
  const authAdmin = await read(`admins/${uid}`, auditToken);
  const authMember = await read(`barbearias/${TENANT}/membros/${uid}`, auditToken);
  const mapping = await read(`homologacao_mapeamentos/${uid}`, auditToken);
  const mappingData = fields(mapping);
  const operationalUid = typeof mappingData.uid_producao_referencia === "string" ? mappingData.uid_producao_referencia.trim() : "";
  if (mapping) {
    assert(mappingData.tenant_id === TENANT, "identity mapping tenant mismatch");
    assert(operationalUid, "identity mapping has no operational UID");
  }
  const targetUid = operationalUid || uid;
  const admin = operationalUid ? await read(`admins/${targetUid}`, auditToken) : authAdmin;
  const member = operationalUid ? await read(`barbearias/${TENANT}/membros/${targetUid}`, auditToken) : authMember;
  const roles = fields(member).papeis;
  assert(authAdmin || (Array.isArray(fields(authMember).papeis) && fields(authMember).papeis.includes("ADMIN")) || admin || (Array.isArray(roles) && roles.includes("ADMIN")), "identity is not proven as tenant ADMIN");
  return { authUid: uid, operationalUid: targetUid };
}
async function main() {
  if (process.argv.includes("--self-test")) {
    for (const argv of [["node", "x"], ["node", "x", "--project=barber-a01e7", "--confirm-hml-write"], ["node", "x", "--project=teste-483f6", "--confirm-hml-write"]]) assertThrows(() => validateGuards(options(argv), {}));
    assert(validateGuards(options(["node", "x", "--project=teste-483f6", "--confirm-hml-write"]), { FIREBASE_ID_TOKEN: "x", HML_ADMIN_UID: "u", FIRESTORE_AUDIT_TOKEN: "a" }) === undefined, "guard success failed");
    assert(classifyRace([{ status: "fulfilled" }, { status: "rejected", reason: { code: "already-exists", message: "EMAIL_JA_VINCULADO" } }]).validRejection, "winner/loser classifier failed");
    assert(!classifyRace([{ status: "fulfilled" }, { status: "fulfilled" }]).validRejection, "two winners accepted");
    assert(!classifyRace([{ status: "rejected" }, { status: "rejected" }]).validRejection, "two losers accepted");
    const fixture = { idA: "a", idB: "b", emailA: "a@example.invalid", emailB: "b@example.invalid" };
    assert(classifyResidue([], ["a", "b"], ["idx-a", "idx-b"]), "zero residue failed");
    assert(!classifyResidue([{ name: "barbeiros/a" }], ["a", "b"], ["idx-a", "idx-b"]), "residue missed");
    assert(cleanupIds(fixture, ["a"]).length === 2, "cleanup ids not deduplicated");
    const encoded = (value) => typeof value === "boolean" ? { booleanValue: value } : { stringValue: value };
    const mappedReads = new Map([
      ["admins/auth", null],
      [`barbearias/${TENANT}/membros/auth`, { fields: { papeis: { arrayValue: { values: [encoded("CLIENTE")] } } } }],
      ["homologacao_mapeamentos/auth", { fields: { tenant_id: encoded(TENANT), uid_producao_referencia: encoded("operational") } }],
      ["admins/operational", { fields: {} }],
      [`barbearias/${TENANT}/membros/operational`, { fields: { papeis: { arrayValue: { values: [encoded("ADMIN")] } } } }],
    ]);
    const mappedProof = await proveAdmin("token", "audit", "auth", async (path) => mappedReads.get(path) || null);
    assert(mappedProof.operationalUid === "operational", "mapped admin proof failed");
    const directReads = new Map([["admins/auth", { fields: {} }], [`barbearias/${TENANT}/membros/auth`, null], ["homologacao_mapeamentos/auth", null]]);
    await proveAdmin("token", "audit", "auth", async (path) => directReads.get(path) || null);
    const invalidMapping = new Map([["homologacao_mapeamentos/auth", { fields: { tenant_id: encoded("wrong") } }]]);
    await assertRejects(() => proveAdmin("token", "audit", "auth", async (path) => invalidMapping.get(path) || null), "identity mapping tenant mismatch");
    const missingOperational = new Map([["homologacao_mapeamentos/auth", { fields: { tenant_id: encoded(TENANT), uid_producao_referencia: encoded("") } }]]);
    await assertRejects(() => proveAdmin("token", "audit", "auth", async (path) => missingOperational.get(path) || null), "identity mapping has no operational UID");
    const jwtPart = Buffer.from(JSON.stringify({ aud: PROJECT, sub: "auth", exp: Math.floor(Date.now() / 1000) + 300 }), "utf8").toString("base64url");
    const testToken = `header.${jwtPart}.signature`;
    assert(validateFirebaseIdToken(`  ${testToken}\r\n`, "auth", "teste-483f6").projectMatch, "ID token validation failed");
    await assertRejects(() => Promise.resolve().then(() => validateFirebaseIdToken(testToken, "auth", "barber-a01e7")), "Firebase ID token project mismatch");
    const preflightArgs = ["node", "harness", "--project=teste-483f6", "--preflight-only"];
    const preflightEnv = { FIREBASE_ID_TOKEN: testToken, HML_ADMIN_UID: "auth", FIRESTORE_AUDIT_TOKEN: "audit" };
    let preflightLogged = null;
    assert(runPreflight(preflightArgs, preflightEnv, (value) => { preflightLogged = value; }).network === false, "CLI HML preflight failed");
    assert(preflightLogged?.TOKEN_PREFLIGHT?.audMatches === true, "CLI HML telemetry failed");
    const prodToken = `header.${Buffer.from(JSON.stringify({ aud: "barber-a01e7", sub: "auth", exp: Math.floor(Date.now() / 1000) + 300 }), "utf8").toString("base64url")}.signature`;
    await assertRejects(() => Promise.resolve().then(() => runPreflight(preflightArgs, { ...preflightEnv, FIREBASE_ID_TOKEN: prodToken }, () => {})), "Firebase ID token project mismatch");
    const assertAdminWire = (command, payload, requestId) => {
      const request = buildCallableRequest(command, payload, requestId, "TOKEN");
      assert(request.headers.Authorization === "Bearer TOKEN", "Authorization header missing");
      assert(request.headers["Content-Type"] === "application/json", "Content-Type missing");
      const outer = JSON.parse(request.body);
      assert(outer.data.command === command, "callable command invalid");
      assert(outer.data.requestId === requestId, "callable requestId invalid");
      assert(outer.data.data && typeof outer.data.data === "object", "callable data missing");
      assert(outer.data.data.data === undefined, "duplicate data envelope detected");
      return outer;
    };
    assertAdminWire("admin.barbeiro.salvar", { id: "fixture", email_acesso: "a@example.invalid" }, "request-save");
    assertAdminWire("admin.barbeiro.salvar", { id: "fixture", email_acesso: "b@example.invalid" }, "request-rotate");
    assertAdminWire("admin.barbeiro.remover", { id: "fixture" }, "request-remove");
    const concurrentA = assertAdminWire("admin.barbeiro.salvar", { id: "fixture-a", email_acesso: "same@example.invalid" }, "request-a");
    const concurrentB = assertAdminWire("admin.barbeiro.salvar", { id: "fixture-b", email_acesso: "same@example.invalid" }, "request-b");
    assert(concurrentA.data.requestId !== concurrentB.data.requestId, "concurrent requestIds must differ");
    assertAdminWire("admin.barbeiro.remover", { id: "fixture-a" }, "request-cleanup-a");
    assertAdminWire("admin.barbeiro.remover", { id: "fixture-b" }, "request-cleanup-b");
    await assertRejects(() => Promise.resolve().then(() => buildAuditHeaders("")), "audit token is required");
    const auditHeaders = buildAuditHeaders("AUDIT_TOKEN");
    assert(auditHeaders.Authorization === "Bearer AUDIT_TOKEN", "audit Authorization header invalid");
    assert(!JSON.stringify({ auditHeaders }).includes("CALLABLE_TOKEN"), "token separation test failed");
    await assertRejects(() => Promise.resolve().then(() => validateFirebaseIdToken(testToken, "other")), "Firebase ID token UID mismatch");
    validateGuards(options(["node", "harness", "--project=teste-483f6", "--auth=interactive", "--confirm-hml-write"]), { FIRESTORE_AUDIT_TOKEN: "audit" });
    await assertRejects(() => Promise.resolve().then(() => validateGuards(options(["node", "harness", "--project=barber-a01e7", "--auth=interactive", "--confirm-hml-write"]), { FIRESTORE_AUDIT_TOKEN: "audit" })), "HML project guard failed");
    let authRequest = null;
    const interactiveSession = await authenticateInteractive({
      email: "admin@example.invalid",
      password: "offline-password",
      apiKey: "offline-key",
      request: async (url, init) => {
        authRequest = { url, init };
        return { ok: true, async json() { return { idToken: testToken, refreshToken: "refresh", localId: "auth" }; } };
      },
    });
    assert(interactiveSession.localId === "auth" && interactiveSession.idToken === testToken, "interactive auth result invalid");
    assert(JSON.parse(authRequest.init.body).returnSecureToken === true, "interactive auth request invalid");
    assert(!JSON.stringify({ logged: false }).includes("offline-password"), "password logging test failed");
    interactiveSession.idToken = ""; interactiveSession.refreshToken = ""; interactiveSession.localId = "";
    console.log("hml email access concurrency self-test: PASS"); return;
  }
  const opts = options();
  if (opts.preflightOnly) { runPreflight(process.argv, process.env); return; }
  validateGuards(opts);
  const fixtures = newFixtures(); const auditToken = process.env.FIRESTORE_AUDIT_TOKEN; let mutated = false; const discovered = [];
  console.error(JSON.stringify({ AUDIT_TOKEN_PRESENT: Boolean(auditToken), AUDIT_TOKEN_SOURCE: "FIRESTORE_AUDIT_TOKEN", AUDIT_TOKEN_LENGTH: String(auditToken || "").length }));
  let token = "";
  let adminUid = "";
  if (opts.auth === "interactive") {
    activeCredentialSession = await obtainInteractiveAuth();
    token = activeCredentialSession.idToken;
    adminUid = activeCredentialSession.localId;
  } else {
    token = normalizeIdToken(process.env.FIREBASE_ID_TOKEN);
    adminUid = process.env.HML_ADMIN_UID;
    validateFirebaseIdToken(token, adminUid, opts.project);
  }
  await proveAdmin(token, auditToken, adminUid);
  const before = await auditFixture(fixtures, auditToken);
  assert(before.docs.every((doc) => !doc), "fixture/index already exists");
  try {
    mutated = true;
    const base = (id, email) => ({ id, nome: id, foto: "", especialidade: "HML_TEST", descricao: "fixture descartável", uid_usuario: "", email_acesso: email, ativo: false });
    const requestIds = [`${fixtures.requestPrefix}-a`, `${fixtures.requestPrefix}-b`];
    const barberIds = [fixtures.idA, fixtures.idB];
    const results = await Promise.allSettled([
      call("admin.barbeiro.salvar", base(barberIds[0], fixtures.emailA), requestIds[0], token),
      call("admin.barbeiro.salvar", base(barberIds[1], fixtures.emailA), requestIds[1], token),
    ]);
    const race = classifyRace(results);
    console.log(JSON.stringify({
      CONCURRENCY_TELEMETRY: {
        CONCURRENT_REQUESTS_EQ_2: race.concurrentRequestsEq2,
        WINNERS_EQ_1: race.winnersEq1,
        REJECTIONS_EQ_1: race.rejectionsEq1,
        REJECTION_IS_UNIQUENESS: race.rejectionIsUniqueness,
        REQUEST_A_STATUS: race.requestStatuses[0],
        REQUEST_B_STATUS: race.requestStatuses[1],
        REQUEST_IDS_DISTINCT: requestIds[0] !== requestIds[1],
        BARBER_IDS_DISTINCT: barberIds[0] !== barberIds[1],
        SAME_NORMALIZED_EMAIL: normalizeEmail(fixtures.emailA) === normalizeEmail(fixtures.emailA),
        REJECTION_CODE: race.rejectionCodes[0] || "",
        REJECTION_CLASS: race.rejectionClasses[0] || "NONE",
      },
    }));
    assert(race.concurrentRequestsEq2, "CONCURRENT_REQUESTS_EQ_2");
    assert(race.winnersEq1, "WINNERS_EQ_1");
    assert(race.rejectionsEq1, "REJECTIONS_EQ_1");
    assert(race.rejectionIsUniqueness, "REJECTION_IS_UNIQUENESS");
    const winner = results.find((result) => result.status === "fulfilled").value.barberId; discovered.push(winner);
    let audit = await auditFixture(fixtures, auditToken); const winnerLegacy = audit.byPath[`barbeiros/${winner}`]; const winnerV2 = audit.byPath[`barbearias/${TENANT}/barbeiros/${winner}`];
    assert(winnerLegacy && winnerV2 && audit.byPath[indexPath(fixtures.emailA)]?.fields?.barbeiro_id?.stringValue === winner, "winner/index inconsistente");
    const loser = winner === fixtures.idA ? fixtures.idB : fixtures.idA; assert(!audit.byPath[`barbeiros/${loser}`] && !audit.byPath[`barbearias/${TENANT}/barbeiros/${loser}`], "loser residue detected");
    await call("admin.barbeiro.salvar", base(winner, fixtures.emailB), `${fixtures.requestPrefix}-rotate`, token);
    audit = await auditFixture(fixtures, auditToken); assert(!audit.byPath[indexPath(fixtures.emailA)] && audit.byPath[indexPath(fixtures.emailB)]?.fields?.barbeiro_id?.stringValue === winner, "rotation failed");
    await call("admin.barbeiro.remover", { id: winner }, `${fixtures.requestPrefix}-remove`, token);
    audit = await auditFixture(fixtures, auditToken); assert(!audit.docs.some(Boolean), "final fixture residue detected");
    console.log(JSON.stringify({ PREFLIGHT: "PASS", CONCURRENT_REQUESTS: 2, WINNERS: 1, REJECTIONS: 1, REJECTION_CODE: "already-exists", INDEX_DOCUMENTS: 1, INDEX_OWNER: winner, EMAIL_ROTATION_A_TO_B: "PASS", REMOVE_OPERATION: "PASS", ZERO_RESIDUE: "PASS" }));
  } finally {
    if (mutated) {
      for (const id of cleanupIds(fixtures, discovered)) { try { const doc = await get(`barbeiros/${id}`, auditToken); if (doc) await call("admin.barbeiro.remover", { id }, `${fixtures.requestPrefix}-finally-${id}`, token); } catch (error) { console.error(JSON.stringify({ CLEANUP_ERROR: safeError(error) })); } }
      try {
        const finalAudit = await auditFixture(fixtures, auditToken);
        console.error(JSON.stringify({ CLEANUP_FINAL_AUDIT: finalAudit.docs.every((doc) => !doc) ? "ZERO_RESIDUE" : "RESIDUE_DETECTED" }));
      } catch (error) { console.error(JSON.stringify({ CLEANUP_FINAL_AUDIT: "INCONCLUSIVE", ERROR: safeError(error) })); }
    }
    clearCredentialSession();
  }
}
function assertThrows(fn) { try { fn(); throw new Error("expected failure"); } catch (error) { if (error.message === "expected failure") throw error; } }
main().catch((error) => { clearCredentialSession(); console.error(JSON.stringify({ FINAL_RESULT: "FAIL", ERROR: safeError(error), PRODUCTION_ACCESSED: "NÃO" })); process.exitCode = 1; });
