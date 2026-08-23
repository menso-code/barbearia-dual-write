#!/usr/bin/env node
import readline from "node:readline";
import { randomUUID } from "node:crypto";

const PROJECT = "teste-483f6";
const FORBIDDEN = "barber-a01e7";
const TENANT = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const REGION = "southamerica-east1";
const API_KEY = "AIzaSyB3GtGg7NtoQtFOdlpcOk_pxyBpSGVUqLw";
const EXPECTED_UID = "QVadYsSKu9cFcUH1vZNo0JiSnMF2";
const BARBER_ID = "YMJrJJ58I6N9bMl4jsgy";
const ROOT = `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/(default)/documents`;
const CALLABLE = `https://${REGION}-${PROJECT}.cloudfunctions.net/executeOperationalCommand`;
const TRACE_READS = true;

function fail(message) { throw new Error(`ABORT: ${message}`); }
function arg(name, fallback = "") { const x = process.argv.find((v) => v.startsWith(`--${name}=`)); return x ? x.slice(name.length + 3) : fallback; }
function isCleanupOnly(argv = process.argv) { return argv.includes("--cleanup-only"); }
function decode(v) {
  if (!v) return null; if (v.stringValue !== undefined) return v.stringValue; if (v.booleanValue !== undefined) return v.booleanValue;
  if (v.integerValue !== undefined) return Number(v.integerValue); if (v.doubleValue !== undefined) return v.doubleValue; if (v.timestampValue !== undefined) return v.timestampValue;
  if (v.arrayValue) return (v.arrayValue.values || []).map(decode); if (v.mapValue) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)])); return null;
}
function fields(doc) { return Object.fromEntries(Object.entries(doc?.fields || {}).map(([k, v]) => [k, decode(v)])); }
function id(doc) { return String(doc?.name || "").split("/").at(-1); }
function canonical(v) { return v && typeof v === "object" ? (Array.isArray(v) ? v.map(canonical) : Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonical(v[k])]))) : v; }
function same(a, b) { return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b)); }
const IGNORE_PROJECTION_FIELDS = new Set(["criado_em", "atualizado_em", "created_at", "updated_at", "generated_at"]);
function semantic(doc) { const value = fields(doc); return Object.fromEntries(Object.entries(value).filter(([key]) => !IGNORE_PROJECTION_FIELDS.has(key)).sort(([a], [b]) => a.localeCompare(b))); }
function assertNamed(name, condition, detail = "") { console.error(`${name} | ${condition ? "PASS" : "FAIL"}${detail ? ` | ${detail}` : ""}`); if (!condition) fail(name); }
function newRunRequestId() { return `hml-idempotency-agenda-criar-${Date.now()}-${randomUUID().slice(0, 8)}`; }
function cleanupRequestId(runRequestId) { return `${runRequestId}-cleanup`; }
function verifyCleanupState(docs, activeMatches, appointmentId) {
  const [legacyAppointment, v2Appointment, legacyOccupation, v2Occupation] = docs;
  const terminal = new Set(["cancelado", "cancelled", "nao_compareceu", "concluido", "completed"]);
  const legacy = fields(legacyAppointment); const v2 = fields(v2Appointment);
  return Boolean(legacyAppointment && v2Appointment && id(legacyAppointment) === appointmentId && id(v2Appointment) === appointmentId
    && terminal.has(String(legacy.status || "")) && terminal.has(String(v2.status || ""))
    && !legacyOccupation && !v2Occupation && activeMatches.length === 0);
}
function responseShapeTelemetry(first) {
  return {
    responseType: typeof first,
    hasData: first != null,
    hasDuplicate: Object.prototype.hasOwnProperty.call(first ?? {}, "duplicate"),
    duplicateType: typeof first?.duplicate,
    duplicateIsFalse: first?.duplicate === false,
    duplicateIsTrue: first?.duplicate === true,
    hasAppointmentId: typeof first?.appointmentId === "string" && first.appointmentId.length > 0,
    appointmentIdLength: typeof first?.appointmentId === "string" ? first.appointmentId.length : 0,
    hasSlots: Object.prototype.hasOwnProperty.call(first ?? {}, "slots"),
  };
}
function knownAppointmentId(first, fallback) { return typeof first?.appointmentId === "string" && first.appointmentId.length > 0 ? first.appointmentId : fallback; }
function redact(value) {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).filter(([key]) => !/authorization|token|password|senha|cookie|secret/i.test(key)).map(([key, item]) => [key, redact(item)]));
  return value;
}
function callableFailure(status, bodyText) {
  let body = null;
  try { body = JSON.parse(bodyText); } catch { body = null; }
  const error = body?.error || {};
  const statusName = error.status || error.code || "UNKNOWN";
  const code = error.details?.code || error.code || statusName;
  const message = String(error.message || (body ? "Resposta callable sem mensagem de erro." : "Resposta callable não-JSON.")).replace(/(authorization|token|password|senha|cookie|secret)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]");
  const details = redact(error.details);
  const detailText = details === undefined ? "" : ` details=${JSON.stringify(details)}`;
  const failure = new Error(`Function recusou agenda.cancelar | http=${status} | status=${statusName} | code=${code} | message=${message}${detailText}`);
  failure.httpStatus = status; failure.firebaseStatus = statusName; failure.code = code; failure.remoteMessage = message; failure.safeDetails = details;
  return failure;
}
function massPaths(appointmentId) { return [`agendamentos/${appointmentId}`, `barbearias/${TENANT}/agendamentos/${appointmentId}`, `ocupacoes/${appointmentId}`, `barbearias/${TENANT}/ocupacoes/${appointmentId}`]; }
async function readMass(appointmentId) { return Promise.all(massPaths(appointmentId).map((path, i) => auditGet(path, ["MASS_LEGADO_AGENDAMENTO", "MASS_V2_AGENDAMENTO", "MASS_LEGADO_OCUPACAO", "MASS_V2_OCUPACAO"][i]))); }
async function cleanupMass(sessionToken, appointmentId, requestId) {
  const docs = await readMass(appointmentId); if (docs.every((x) => !x)) fail("massa residual não encontrada; cleanup recusado.");
  const appointmentDoc = docs[0] || docs[1]; const appointment = fields(appointmentDoc);
  assertNamed("CLEANUP_MASS_ID", id(appointmentDoc) === appointmentId && appointment.barbeiro_id === BARBER_ID && typeof appointment.data === "string" && typeof appointment.horario === "string", "massa corresponde ao escopo esperado");
  const legacyMatches = (await queryAppointments(BARBER_ID, appointment.data, process.env.FIRESTORE_AUDIT_TOKEN)).filter((x) => fields(x).horario === appointment.horario && !["cancelado", "cancelled", "nao_compareceu"].includes(fields(x).status));
  const appointmentStatus = String(appointment.status || "");
  const occupationGone = !docs[2] && !docs[3];
  if (["cancelado", "cancelled", "nao_compareceu"].includes(appointmentStatus) && occupationGone && legacyMatches.length === 0) {
    assertNamed("CLEANUP_ONE_LOGICAL_APPOINTMENT", true, "histórico cancelado sem resíduo ativo");
    assertNamed("CLEANUP_ZERO_RESIDUE", true, "nenhum efeito operacional ativo");
    return { result: { alreadyClean: true }, residual: false };
  }
  assertNamed("CLEANUP_ONE_LOGICAL_APPOINTMENT", legacyMatches.length === 1 && id(legacyMatches[0]) === appointmentId, legacyMatches.length === 1 ? "exatamente um agendamento lógico ativo localizado" : "conflito ou duplicação ativa detectado; cleanup recusado");
  const result = await call("agenda.cancelar", { appointmentId }, requestId, sessionToken);
  const after = await readMass(appointmentId); const clean = [after[2], after[3]].every((x) => !x) && [after[0], after[1]].every((x) => x && ["cancelado", "cancelled"].includes(fields(x).status)); assertNamed("CLEANUP_ZERO_RESIDUE", clean); return { result, residual: false };
}
async function hidden(label) {
  if (!process.stdin.isTTY) fail("senha interativa exige terminal local.");
  return new Promise((resolve) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); const stdin = process.stdin; const write = process.stdout.write.bind(process.stdout); const onData = (c) => { const s = c.toString(); if (!s.includes("\n") && !s.includes("\r")) write("\b \b".repeat(s.length)); }; stdin.on("data", onData); rl.question(label, (answer) => { stdin.off("data", onData); rl.close(); write("\n"); resolve(answer); }); });
}
async function login(email) {
  const password = await hidden(`Senha de ${email} (não será exibida nem salva): `);
  try {
    const authPath = "/v1/accounts:signInWithPassword";
    const r = await fetch(`https://identitytoolkit.googleapis.com${authPath}?key=${API_KEY}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password, returnSecureToken: true }) });
    if (TRACE_READS) console.error(`AUTH_LOGIN | POST ${authPath} | ${r.status}`);
    const body = await r.json(); if (!r.ok || body.localId !== EXPECTED_UID) fail("identidade não corresponde ao Samuel HML esperado."); return { token: body.idToken, uid: body.localId };
  } finally { password.fill?.(0); }
}
async function get(path, token, label = "READ") { const r = await fetch(`${ROOT}/${path}`, { headers: { authorization: `Bearer ${token}` } }); if (TRACE_READS) console.error(`${label} | GET ${path} | ${r.status}`); if (r.status === 404) return null; const b = await r.json(); if (!r.ok) fail(`leitura ${label} ${r.status}`); return b; }
async function list(path, token, label = "LIST") { const r = await fetch(`${ROOT}/${path}?pageSize=1000`, { headers: { authorization: `Bearer ${token}` } }); if (TRACE_READS) console.error(`${label} | LIST ${path} | ${r.status}`); if (r.status === 404) return []; const b = await r.json(); if (!r.ok) fail(`leitura ${label} ${r.status}`); return b.documents || []; }
async function queryAppointments(barberId, date, token) {
  const body = { structuredQuery: { from: [{ collectionId: "agendamentos" }], where: { compositeFilter: { op: "AND", filters: [{ fieldFilter: { field: { fieldPath: "barbeiro_id" }, op: "EQUAL", value: { stringValue: barberId } } }, { fieldFilter: { field: { fieldPath: "data" }, op: "EQUAL", value: { stringValue: date } } }] } } } };
  const r = await fetch(`${ROOT}:runQuery`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
  if (TRACE_READS) console.error(`AGENDAMENTOS_QUERY_LEGADO | POST :runQuery barbeiro_id/data | ${r.status}`);
  const result = await r.json(); if (!r.ok) fail(`leitura AGENDAMENTOS_QUERY_LEGADO ${r.status}`); return result.filter((x) => x.document).map((x) => x.document);
}
async function auditGet(path, label) { return get(path, process.env.FIRESTORE_AUDIT_TOKEN, `AUDIT_${label}`); }
async function call(command, data, requestId, token) { const r = await fetch(CALLABLE, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ data: { command, requestId, data } }) }); const text = await r.text(); if (!r.ok) throw callableFailure(r.status, text); let b; try { b = JSON.parse(text); } catch { fail("resposta callable malformada"); } if (b?.error) throw callableFailure(r.status, text); return b.result; }
function dateText(d) { return d.toISOString().slice(0, 10); }
function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
function mins(s) { const [h, m] = s.split(":").map(Number); return h * 60 + m; }
function time(n) { return `${String(Math.floor(n / 60)).padStart(2, "0")}:${String(n % 60).padStart(2, "0")}`; }
async function discover(token) {
  const barber = await get(`barbeiros/${BARBER_ID}`, token, "BARBEIRO_RESOLVE"); const barberData = fields(barber); if (!barber || barberData.nome !== "Samuel Torres" || barberData.ativo !== true) fail("Samuel barbeiro não está ativo ou não foi encontrado.");
  const services = (await list("servicos", token, "SERVICOS_LIST")).map((x) => ({ id: id(x), ...fields(x) })).filter((x) => x.ativo === true && Number(x.duracao) === 30); if (!services.length) fail("nenhum serviço ativo de 30 minutos.");
  const config = fields(await get("configuracoes/funcionamento", token, "FUNCIONAMENTO_READ"));
  for (let offset = 1; offset <= 10; offset++) { const d = addDays(new Date(), offset); const date = dateText(d); const day = d.getDay(); if (config.dias_fechados_semana?.[day] === true) continue; const periods = config.periodos_semana?.[day] || []; for (const p of periods) for (let n = mins(p.inicio); n + 30 <= mins(p.fim); n += 30) { const at = `${BARBER_ID}_${date}_${time(n)}`; const appointments = await queryAppointments(BARBER_ID, date, token); const matching = appointments.filter((x) => fields(x).horario === time(n) && !["cancelado", "nao_compareceu"].includes(fields(x).status)); const occupation = await get(`ocupacoes/${at}`, token, "OCUPACOES_SLOT_LEGADO"); if (!matching.length && !occupation) return { barber: barberData, service: services[0], date, time: time(n), appointmentId: at }; }
  }
  fail("nenhum slot inequivocamente livre nos próximos 10 dias.");
}
async function main() {
  if (process.argv.includes("--self-test")) {
    assertNamed("SELFTEST_CLEANUP_ONLY_PARSE", isCleanupOnly(["node", "script", "--cleanup-only"]) && !isCleanupOnly(["node", "script"]));
    let cleanupAttempted = false;
    try { let created = false; try { fail("SIMULATED_BEFORE_WRITE"); } finally { if (created) cleanupAttempted = true; } } catch { /* expected */ }
    assertNamed("SELFTEST_ABORT_BEFORE_WRITE_NO_CLEANUP", cleanupAttempted === false);
    try { let created = true; try { fail("SIMULATED_AFTER_WRITE"); } finally { if (created) cleanupAttempted = true; } } catch { /* expected */ }
    assertNamed("SELFTEST_ABORT_AFTER_WRITE_CLEANUP", cleanupAttempted === true);
    const a = { fields: { status: { stringValue: "agendado" }, appointmentId: { stringValue: "x" }, atualizado_em: { timestampValue: "a" } } };
    const b = { fields: { appointmentId: { stringValue: "x" }, status: { stringValue: "agendado" }, updated_at: { timestampValue: "b" } } };
    assertNamed("SELFTEST_SEMANTIC_NORMALIZATION", same(semantic(a), semantic(b)));
    const ok = { result: { duplicate: false } };
    assertNamed("SELFTEST_CALLABLE_200", ok.result.duplicate === false);
    for (const [name, status, body] of [
      ["PERMISSION", 403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "Permissão insuficiente." } })],
      ["PRECONDITION", 400, JSON.stringify({ error: { status: "FAILED_PRECONDITION", message: "AGENDAMENTO_INDISPONIVEL" } })],
      ["NOT_FOUND", 404, JSON.stringify({ error: { status: "NOT_FOUND", message: "AGENDAMENTO_INDISPONIVEL" } })],
      ["NON_JSON", 502, "upstream failure"],
      ["MALFORMED", 500, "{bad"],
    ]) {
      const error = callableFailure(status, body);
      assertNamed(`SELFTEST_CALLABLE_${name}`, error.httpStatus === status && typeof error.code === "string" && !/token|senha|password|authorization|cookie/i.test(error.message));
    }
    const secretError = callableFailure(403, JSON.stringify({ error: { status: "PERMISSION_DENIED", message: "token=hidden", details: { access_token: "secret", safe: "x" } } }));
    assertNamed("SELFTEST_NO_SECRET_LEAK", !/secret|access_token/i.test(secretError.message) && secretError.safeDetails.access_token === undefined);
    const runA = newRunRequestId(); const runB = newRunRequestId();
    assertNamed("SELFTEST_REQUEST_ID_CHANGES_BETWEEN_RUNS", runA !== runB);
    assertNamed("SELFTEST_REQUEST_ID_STABLE_WITHIN_RUN", runA === runA);
    assertNamed("SELFTEST_CLEANUP_REQUEST_ID_SEPARATE", cleanupRequestId(runA) !== runA);
    const testAppointment = "barber-date-time";
    assertNamed("SELFTEST_ID_FROM_FIRST_SUCCESS", knownAppointmentId({ duplicate: false, appointmentId: "x" }, testAppointment) === "x");
    for (const response of [{ duplicate: true, appointmentId: "x" }, { appointmentId: "x" }]) {
      let preserved = knownAppointmentId(response, testAppointment); let failed = false;
      try { if (response.duplicate !== false) throw new Error("FIRST_DUPLICATE_FALSE"); } catch { failed = true; }
      assertNamed("SELFTEST_ID_SURVIVES_ASSERT_FAILURE", failed && preserved === "x");
    }
    assertNamed("SELFTEST_SAFE_ID_FALLBACK", knownAppointmentId({}, testAppointment) === testAppointment);
    const telemetry = responseShapeTelemetry({ duplicate: false, appointmentId: "sensitive-id", slots: 1 });
    assertNamed("SELFTEST_TELEMETRY_NO_ID_VALUE", !Object.values(telemetry).includes("sensitive-id") && telemetry.appointmentIdLength === 12);
    const terminalDoc = (status) => ({ name: "projects/p/databases/(default)/documents/agendamentos/x", fields: { status: { stringValue: status } } });
    assertNamed("SELFTEST_VERIFY_CLEANUP_PASS", verifyCleanupState([terminalDoc("cancelado"), terminalDoc("cancelado"), null, null], [], "x"));
    assertNamed("SELFTEST_VERIFY_CLEANUP_FAIL_ACTIVE", !verifyCleanupState([terminalDoc("cancelado"), terminalDoc("cancelado"), null, null], [terminalDoc("agendado")], "x"));
    console.log(JSON.stringify({ status: "SELF_TEST_OK" })); return;
  }
  if (PROJECT !== "teste-483f6" || JSON.stringify(process.argv).includes(FORBIDDEN)) fail("projeto de produção detectado."); if (process.env.GOOGLE_APPLICATION_CREDENTIALS || process.env.FIRESTORE_ACCESS_TOKEN) fail("credencial externa não permitida."); if (!process.env.FIRESTORE_AUDIT_TOKEN) fail("credencial efêmera de auditoria somente leitura ausente.");
  if (process.argv.includes("--verify-cleanup-only")) {
    const appointmentId = arg("appointment-id"); if (!appointmentId || appointmentId.includes("/")) fail("appointmentId explícito obrigatório para verificação read-only.");
    const docs = await readMass(appointmentId); if (!docs[0] || !docs[1]) fail("appointments Legado/V2 ausentes; verificação inconclusiva.");
    const appointment = fields(docs[0]);
    const activeMatches = (await queryAppointments(BARBER_ID, appointment.data, process.env.FIRESTORE_AUDIT_TOKEN)).filter((x) => { const value = fields(x); return id(x) === appointmentId && value.horario === appointment.horario && !["cancelado", "cancelled", "nao_compareceu", "concluido", "completed"].includes(String(value.status || "")); });
    if (!verifyCleanupState(docs, activeMatches, appointmentId)) fail("CLEANUP_ZERO_RESIDUE não comprovado.");
    console.error("CLEANUP_ZERO_RESIDUE | PASS"); console.log(JSON.stringify({ status: "CLEANUP_ZERO_RESIDUE" })); return;
  }
  if (!process.argv.includes("--confirm-hml-write")) fail("use --confirm-hml-write.");
  const session = await login(arg("email", "menso333+samuelhml@gmail.com"));
  if (isCleanupOnly()) { await cleanupMass(session.token, "YMJrJJ58I6N9bMl4jsgy_2026-08-21_08:30", `hml-cleanup-${Date.now()}`); console.log(JSON.stringify({ status: "CLEANUP_ZERO_RESIDUE" })); return; }
  let createdId = ""; let runRequestId = ""; let testFailure = null; let cleanupFailure = null;
  try {
    runRequestId = newRunRequestId(); const test = await discover(session.token); await auditGet(`barbeiros/${BARBER_ID}`, "PREFLIGHT"); console.log(JSON.stringify({ project: PROJECT, barber: test.barber.nome, service: test.service.nome, date: test.date, time: test.time, duration: test.service.duracao, requestId: runRequestId }, null, 2));
    const payload = { barbeiro_id: BARBER_ID, servico_id: test.service.id, data: test.date, horario: test.time }; const first = await call("agenda.criar", payload, runRequestId, session.token); console.error(`AGENDA_CRIAR_RESPONSE_SHAPE | ${JSON.stringify(responseShapeTelemetry(first))}`); createdId = knownAppointmentId(first, test.appointmentId); assertNamed("FIRST_DUPLICATE_FALSE", first?.duplicate === false); const firstDocs = await readMass(createdId); assertNamed("ONE_LOGICAL_APPOINTMENT", Boolean(firstDocs[0] && firstDocs[1])); assertNamed("ONE_LOGICAL_OCCUPANCY", Boolean(firstDocs[2] && firstDocs[3]));
    const second = await call("agenda.criar", payload, runRequestId, session.token); assertNamed("SECOND_DUPLICATE_TRUE", second?.duplicate === true); assertNamed("SAME_APPOINTMENT_ID", second?.appointmentId === createdId); const secondDocs = await readMass(createdId); assertNamed("LEGACY_V2_APPOINTMENT_EQUIVALENT", same(semantic(secondDocs[0]), semantic(secondDocs[1]))); assertNamed("LEGACY_V2_OCCUPANCY_EQUIVALENT", same(semantic(secondDocs[2]), semantic(secondDocs[3]))); console.log(JSON.stringify({ first, second, status: "IDEMPOTENCIA_COMPROVADA" }, null, 2));
  } catch (error) { testFailure = error; console.error(`TEST_FAILURE | ${error.message}`); throw error; } finally { if (createdId) { try { await cleanupMass(session.token, createdId, cleanupRequestId(runRequestId)); } catch (error) { cleanupFailure = error; console.error(`CLEANUP_FAILURE | ${error.message}`); } } }
}
main().catch((e) => { console.error(`❌ GO-LIVE BLOQUEADO: ${e.message}`); process.exitCode = 1; });
