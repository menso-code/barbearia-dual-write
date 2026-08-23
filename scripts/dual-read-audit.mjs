#!/usr/bin/env node
/**
 * Auditor controlado do Dual Read.
 *
 * Esta rotina nunca atende o navegador e não muda dados operacionais. Ela
 * compara legado com V2 pelo validador já homologado e, somente se encontrar
 * diferença (ou em teste explícito), grava um evento sem dados pessoais em
 * barbearias/{tenantId}/audit_logs usando uma conta de serviço dedicada.
 *
 * Nesta versão a escrita é bloqueada fora da homologação.
 *
 * Uso:
 *   node scripts/dual-read-audit.mjs --self-test
 *   DUAL_READ_AUDIT_ENVIRONMENT=homologacao \
 *   DUAL_READ_SOURCE_CREDENTIALS=C:\\...\\reader.json \
 *   DUAL_READ_AUDIT_CREDENTIALS=C:\\...\\audit-writer.json \
 *   node scripts/dual-read-audit.mjs --verify
 *   ... node scripts/dual-read-audit.mjs --test-audit-write
 */

import { createHash, createSign } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const SOURCE_PROJECT = "barber-a01e7";
const TARGET_PROJECT = "teste-483f6";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ENVIRONMENT = process.env.DUAL_READ_AUDIT_ENVIRONMENT || "";
const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPORT_DIR = path.resolve("reports", "dual-read");
const FIRESTORE_SCOPE = "https://www.googleapis.com/auth/datastore";

function parseArgs(argv) {
  const modes = new Set(argv);
  const valid = new Set(["--self-test", "--verify", "--test-audit-write"]);
  if (modes.size !== 1 || ![...modes].every((arg) => valid.has(arg))) {
    throw new Error("Use exatamente um modo: --self-test, --verify ou --test-audit-write.");
  }
  return { selfTest: modes.has("--self-test"), verify: modes.has("--verify"), testAuditWrite: modes.has("--test-audit-write") };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function base64Url(value) {
  return Buffer.from(value).toString("base64url");
}

function encodeValue(value) {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { booleanValue: value };
  if (typeof value === "number") return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
  if (Array.isArray(value)) return { arrayValue: { values: value.map(encodeValue) } };
  if (value && typeof value === "object") {
    return { mapValue: { fields: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, encodeValue(item)])) } };
  }
  throw new Error(`Valor de auditoria inválido: ${typeof value}`);
}

async function accessToken(credentialPath) {
  if (!credentialPath) throw new Error("Defina DUAL_READ_AUDIT_CREDENTIALS fora do repositório.");
  const account = JSON.parse(await readFile(credentialPath, "utf8"));
  if (account.project_id !== TARGET_PROJECT) throw new Error("A credencial de auditoria não pertence à homologação.");
  if (!account.client_email || !account.private_key) throw new Error("Credencial de auditoria inválida.");
  const now = Math.floor(Date.now() / 1000);
  const header = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({
    iss: account.client_email,
    scope: FIRESTORE_SCOPE,
    aud: "https://oauth2.googleapis.com/token",
    iat: now,
    exp: now + 3600,
  }));
  const unsigned = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(unsigned).end().sign(account.private_key, "base64url");
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: `${unsigned}.${signature}`,
    }),
  });
  const data = await response.json();
  if (!response.ok || !data.access_token) throw new Error(`Autenticação de auditoria falhou: ${data.error_description || data.error || response.status}`);
  return data.access_token;
}

async function requestJson(url, token, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json", ...(options.headers || {}) },
  });
  const body = response.status === 204 ? {} : await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${response.status}: ${body.error?.message || "Falha no Firestore"}`);
  return body;
}

async function latestValidationBefore() {
  const folder = path.resolve("reports", "shadow-migration");
  const names = await readdir(folder);
  // O validador retorna código diferente de zero quando encontra divergências,
  // mas ainda produz um relatório bloqueado. Esse é justamente o caso que a
  // auditoria precisa registrar, sem tratar a divergência como falha do auditor.
  const candidates = names.filter((name) => /^(validation|blocked-divergence)-.*\.json$/i.test(name));
  return new Set(candidates);
}

async function runValidation() {
  const sourceCredential = process.env.DUAL_READ_SOURCE_CREDENTIALS || "";
  if (!sourceCredential) throw new Error("Defina DUAL_READ_SOURCE_CREDENTIALS com a credencial somente leitura de produção.");
  const auditCredential = process.env.DUAL_READ_AUDIT_CREDENTIALS || "";
  const before = await latestValidationBefore();
  const child = spawn(process.execPath, [path.join(SCRIPT_DIR, "shadow-migration.mjs"), "--validate"], {
    cwd: path.resolve("."),
    env: {
      ...process.env,
      SHADOW_SOURCE_CREDENTIALS: sourceCredential,
      SHADOW_TARGET_CREDENTIALS: auditCredential,
      MIGRATION_ENVIRONMENT: "",
    },
    stdio: "inherit",
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });
  const after = await latestValidationBefore();
  const created = [...after].filter((name) => !before.has(name));
  if (created.length !== 1) throw new Error("Não foi possível identificar o relatório de validação gerado.");
  const reportFile = path.resolve("reports", "shadow-migration", created[0]);
  const report = JSON.parse(await readFile(reportFile, "utf8"));
  if (exitCode !== 0 && (!report.target_state || !Array.isArray(report.target_state.divergent))) {
    throw new Error(`Validação legado × V2 falhou sem relatório de divergências utilizável (código ${exitCode}).`);
  }
  return { file: reportFile, report };
}

function buildEvent(validation, testEvent = false) {
  const target = validation.target_state || {};
  const divergent = Array.isArray(target.divergent) ? target.divergent.length : 0;
  const missing = Number(target.missing || 0);
  const eventType = testEvent ? "DUAL_READ_AUDIT_SELF_TEST" : "DUAL_READ_DIVERGENCE";
  const severity = testEvent ? "INFO" : (missing || divergent ? "HIGH" : "INFO");
  const event = {
    schema: 1,
    event_type: eventType,
    source: "legacy",
    comparison: "v2",
    tenant_id: TENANT_ID,
    environment: "homologacao",
    severity,
    generated_at: new Date().toISOString(),
    counts: { missing, divergent, equivalent: Number(target.equal || 0) },
    validation_status: validation.status || (missing || divergent ? "REPROVADO" : "APROVADO"),
    report_sha256: sha256(JSON.stringify(validation)),
    contains_personal_data: false,
  };
  return event;
}

async function createAuditEvent(event, token) {
  const eventId = `dual-read-${event.event_type.toLowerCase()}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  const url = `https://firestore.googleapis.com/v1/projects/${TARGET_PROJECT}/databases/(default)/documents/barbearias/${TENANT_ID}/audit_logs?documentId=${encodeURIComponent(eventId)}`;
  const document = await requestJson(url, token, {
    method: "POST",
    body: JSON.stringify({ fields: Object.fromEntries(Object.entries(event).map(([key, value]) => [key, encodeValue(value)])) }),
  });
  // A resposta ao POST não substitui a confirmação de persistência. A releitura
  // garante que a evidência foi gravada exatamente com o conteúdo mínimo esperado.
  const stored = await requestJson(
    `https://firestore.googleapis.com/v1/projects/${TARGET_PROJECT}/databases/(default)/documents/barbearias/${TENANT_ID}/audit_logs/${encodeURIComponent(eventId)}`,
    token,
  );
  const fields = stored.fields || {};
  if (fields.contains_personal_data?.booleanValue !== false
    || fields.event_type?.stringValue !== event.event_type
    || fields.tenant_id?.stringValue !== TENANT_ID
    || fields.environment?.stringValue !== "homologacao") {
    throw new Error("O evento de auditoria persistido não corresponde ao formato seguro esperado.");
  }
  const prohibited = Object.keys(fields).some((field) => /telefone|whatsapp|email|cliente|nome/i.test(field));
  if (prohibited) throw new Error("O evento de auditoria persistido contém campo pessoal proibido.");
  return { eventId, document: document.name, verified: true };
}

async function saveReport(report) {
  await mkdir(REPORT_DIR, { recursive: true });
  const file = path.join(REPORT_DIR, `dual-read-audit-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(file, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  return file;
}

function selfTest() {
  const event = buildEvent({ status: "APROVADO", target_state: { missing: 0, divergent: [], equal: 196 } }, true);
  if (event.contains_personal_data !== false || event.counts.equivalent !== 196 || event.event_type !== "DUAL_READ_AUDIT_SELF_TEST") {
    throw new Error("Self-test do evento de auditoria falhou.");
  }
  if (JSON.stringify(event).match(/telefone|whatsapp|email|cliente_nome/i)) throw new Error("Evento de auditoria contém dado pessoal proibido.");
  console.log("Self-test APROVADO: evento mínimo, sem dados pessoais e sem acesso ao Firestore.");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.selfTest) return selfTest();
  if (ENVIRONMENT !== "homologacao") throw new Error("Escrita de auditoria bloqueada fora da homologação.");
  const validation = await runValidation();
  const diverged = Number(validation.report.target_state?.missing || 0) > 0
    || (validation.report.target_state?.divergent || []).length > 0;
  const shouldWrite = args.testAuditWrite || diverged;
  let audit = null;
  if (shouldWrite) {
    const token = await accessToken(process.env.DUAL_READ_AUDIT_CREDENTIALS || "");
    audit = await createAuditEvent(buildEvent(validation.report, args.testAuditWrite), token);
  }
  const file = await saveReport({
    tool: "dual-read-audit",
    environment: "homologacao",
    source_project: SOURCE_PROJECT,
    target_project: TARGET_PROJECT,
    tenant_id: TENANT_ID,
    validation_report: path.basename(validation.file),
    validation_status: validation.report.status || (diverged ? "REPROVADO" : "APROVADO"),
    divergence_detected: diverged,
    audit_event_written: Boolean(audit),
    audit_event_id: audit?.eventId || null,
    audit_event_persisted_and_verified: Boolean(audit?.verified),
    generated_at: new Date().toISOString(),
  });
  console.log(`Auditoria Dual Read concluída. Relatório: ${file}`);
  console.log(audit ? `Evento auditável criado: ${audit.eventId}` : "Sem divergência: nenhum evento remoto foi criado.");
}

main().catch((error) => {
  console.error(`Auditoria Dual Read interrompida: ${error.message}`);
  process.exitCode = 1;
});
