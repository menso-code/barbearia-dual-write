/**
 * Aplicador controlado do seed legado em homologação.
 *
 * Este arquivo e deliberadamente separado da previa. Ele so aceita o projeto
 * teste-483f6, cria documentos que ainda nao existem e nunca atualiza ou apaga
 * registros legados existentes. Nenhuma acao e executada sem confirmacao
 * explicita na linha de comando.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";

const PROJECT_ID = "teste-483f6";
const PRODUCTION_PROJECT_ID = "barber-a01e7";
const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ROOT = `projects/${PROJECT_ID}/databases/(default)/documents`;
const API = `https://firestore.googleapis.com/v1/${ROOT}`;
const REPORT_DIR = resolve("reports", "hml-legacy-seed");
const SNAPSHOT_DIR = resolve(REPORT_DIR, "snapshots");
const DEFAULT_PLAN = resolve(REPORT_DIR, "hml-legacy-seed-plan-2026-08-19T19-56-41-314Z.json");
const WRITE_TOKEN_ENV = "HML_LEGACY_SEED_WRITE_TOKEN";

const PROJECTIONS = [
  ["barbeiros", "barbeiros", "barbeiros"],
  ["servicos", "servicos", "servicos"],
  ["configuracoes", "configuracoes", "configuracoes"],
  ["fechamentos", "fechamentos", "fechamentos_globais"],
  ["clientes", "clientes", "clientes"],
  ["agendamentos", "agendamentos", "agendamentos"],
  ["ocupacoes", "ocupacoes", "ocupacoes"],
  ["bloqueios", "bloqueios", "bloqueios"],
  ["planos_assinatura", "planos_assinatura", "planos_assinatura"],
  ["assinaturas", "assinaturas", "solicitacoes_assinatura"],
  ["historico_assinaturas", "historico_assinaturas", "historico_assinaturas"],
].map(([key, source, target]) => ({ key, source, target }));

const EXPECTED_TOTALS = {
  source_documents: 153,
  legacy_documents: 1,
  EQUIVALENTE: 1,
  AUSENTE: 152,
  DIVERGENTE: 0,
  SOMENTE_LEGADO: 0,
};

const EXPECTED_CREATES = {
  barbeiros: 4,
  servicos: 39,
  clientes: 17,
  agendamentos: 48,
  ocupacoes: 31,
  planos_assinatura: 4,
  solicitacoes_assinatura: 5,
  historico_assinaturas: 4,
};

const args = new Set(process.argv.slice(2));
const valueAfter = (flag) => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function nowId() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function sha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
  }
  return value;
}

function decodeValue(value) {
  if ("nullValue" in value) return null;
  if ("booleanValue" in value) return value.booleanValue;
  if ("integerValue" in value) return Number(value.integerValue);
  if ("doubleValue" in value) return Number(value.doubleValue);
  if ("timestampValue" in value) return value.timestampValue;
  if ("stringValue" in value) return value.stringValue;
  if ("referenceValue" in value) return value.referenceValue;
  if ("geoPointValue" in value) return value.geoPointValue;
  if ("bytesValue" in value) return value.bytesValue;
  if ("arrayValue" in value) return (value.arrayValue.values || []).map(decodeValue);
  if ("mapValue" in value) return decodeFields(value.mapValue.fields || {});
  return value;
}

function decodeFields(fields = {}) {
  return Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, decodeValue(value)]));
}

function fingerprint(fields) {
  return sha256(canonical(decodeFields(fields)));
}

function idFromName(name) {
  return name.split("/").at(-1);
}

function redactedId(id) {
  return sha256(id).slice(0, 16);
}

function requireHmlProject() {
  const configured = process.env.GOOGLE_CLOUD_PROJECT || process.env.GCLOUD_PROJECT || PROJECT_ID;
  assert(configured === PROJECT_ID, `BLOQUEADO: este aplicador aceita somente ${PROJECT_ID}; recebido ${configured}.`);
  assert(configured !== PRODUCTION_PROJECT_ID, "BLOQUEADO: producao nunca pode ser usada por este aplicador.");
}

function isSafeLocalPath(filePath) {
  const candidate = resolve(filePath);
  return relative(REPORT_DIR, candidate) === "" || !relative(REPORT_DIR, candidate).startsWith("..");
}

async function ensureDirectories() {
  await mkdir(REPORT_DIR, { recursive: true });
  await mkdir(SNAPSHOT_DIR, { recursive: true });
}

async function fetchJson(url, options = {}) {
  const response = await fetch(url, options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Firestore respondeu ${response.status}: ${body.error?.message || "erro desconhecido"}`);
  return body;
}

function authHeaders(token) {
  assert(token && token.trim(), `Credencial ausente. Defina ${WRITE_TOKEN_ENV} somente em homologacao.`);
  return { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
}

async function listCollection(path, token) {
  const documents = [];
  let pageToken = "";
  do {
    const url = new URL(`${API}/${path}`);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const page = await fetchJson(url, { headers: authHeaders(token) });
    documents.push(...(page.documents || []));
    pageToken = page.nextPageToken || "";
  } while (pageToken);
  return documents;
}

async function getDocument(path, token) {
  const response = await fetch(`${API}/${path}`, { headers: authHeaders(token) });
  if (response.status === 404) return null;
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`Falha ao ler ${path}: ${body.error?.message || response.status}`);
  return body;
}

async function commit(writes, token) {
  return fetchJson(`${API}:commit`, {
    method: "POST",
    headers: authHeaders(token),
    body: JSON.stringify({ writes }),
  });
}

async function readPlan(planPath) {
  const absolute = resolve(planPath || DEFAULT_PLAN);
  assert(isSafeLocalPath(absolute), "BLOQUEADO: o plano deve ficar dentro de reports/hml-legacy-seed.");
  const plan = JSON.parse(await readFile(absolute, "utf8"));
  assert(plan.project_id === PROJECT_ID, "BLOQUEADO: plano nao pertence a homologacao teste-483f6.");
  assert(plan.tenant_id === TENANT_ID, "BLOQUEADO: tenant do plano nao confere.");
  assert(plan.scope === "todos", "BLOQUEADO: apenas o plano aprovado com escopo todos e aceito.");
  assert(plan.totals && Object.entries(EXPECTED_TOTALS).every(([key, value]) => plan.totals[key] === value), "BLOQUEADO: totais do plano nao correspondem ao seed aprovado.");
  return { absolute, plan, hash: sha256(plan) };
}

function projectionFor(item) {
  const key = item.key || item.collection;
  return PROJECTIONS.find((projection) => projection.key === key)
    || PROJECTIONS.find((projection) => projection.target === item.legacy_target);
}

function approvedCreateCounts(plan) {
  const counts = {};
  for (const item of plan.collections || []) {
    const projection = projectionFor(item);
    if (!projection) continue;
    const creates = (item.documents || []).filter((doc) => doc.classification === "CRIAR_SEED").length;
    if (creates) counts[projection.target] = (counts[projection.target] || 0) + creates;
  }
  return counts;
}

function exactObject(a, b) {
  return JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

async function buildCurrentState(plan, token) {
  const byTarget = [];
  let sourceCount = 0;
  let legacyCount = 0;
  let equivalent = 0;
  let missing = 0;
  let divergent = 0;
  let legacyOnly = 0;

  for (const item of plan.collections || []) {
    const projection = projectionFor(item);
    assert(projection, `BLOQUEADO: colecao sem projecao aprovada: ${item.key || item.collection || item.legacy_target}.`);
    const sourcePath = `barbearias/${TENANT_ID}/${projection.source}`;
    const sourceDocs = await listCollection(sourcePath, token);
    const legacyDocs = await listCollection(projection.target, token);
    const source = new Map(sourceDocs.map((doc) => [idFromName(doc.name), doc]));
    const legacy = new Map(legacyDocs.map((doc) => [idFromName(doc.name), doc]));
    const planned = new Map((item.documents || []).map((doc) => [doc.id_hash, doc]));
    const entries = [];

    for (const [id, sourceDoc] of source) {
      const idHash = redactedId(id);
      const legacyDoc = legacy.get(id);
      const sourceHash = fingerprint(sourceDoc.fields || {});
      const planDoc = planned.get(idHash);
      assert(planDoc, `BLOQUEADO: documento V2 novo fora do plano aprovado (${projection.target}/${idHash}).`);
      assert(planDoc.source_hash === sourceHash, `BLOQUEADO: documento V2 mudou desde a previa (${projection.target}/${idHash}).`);
      sourceCount += 1;
      if (!legacyDoc) {
        missing += 1;
        entries.push({ id, id_hash: idHash, sourceDoc, targetPath: `${projection.target}/${id}`, state: "AUSENTE" });
      } else if (fingerprint(legacyDoc.fields || {}) === sourceHash) {
        equivalent += 1;
        entries.push({ id, id_hash: idHash, sourceDoc, targetPath: `${projection.target}/${id}`, state: "EQUIVALENTE" });
      } else {
        divergent += 1;
        entries.push({ id, id_hash: idHash, sourceDoc, targetPath: `${projection.target}/${id}`, state: "DIVERGENTE" });
      }
    }
    for (const id of legacy.keys()) if (!source.has(id)) legacyOnly += 1;
    legacyCount += legacy.size;
    byTarget.push({ projection, sourcePath, legacyPath: projection.target, entries });
  }

  const totals = {
    source_documents: sourceCount,
    legacy_documents: legacyCount,
    EQUIVALENTE: equivalent,
    AUSENTE: missing,
    DIVERGENTE: divergent,
    SOMENTE_LEGADO: legacyOnly,
  };
  return { byTarget, totals };
}

function validateApprovedState(state, plan) {
  assert(exactObject(state.totals, EXPECTED_TOTALS), `BLOQUEADO: estado atual nao corresponde ao plano aprovado: ${JSON.stringify(state.totals)}.`);
  assert(exactObject(approvedCreateCounts(plan), EXPECTED_CREATES), "BLOQUEADO: escopo de criacao do plano nao corresponde ao aprovado.");
  for (const group of state.byTarget) {
    for (const entry of group.entries) {
      if (entry.state === "DIVERGENTE") throw new Error(`BLOQUEADO: legado existente diverge em ${entry.targetPath}.`);
    }
  }
}

function snapshotFrom(state, planPath, planHash) {
  const documents = state.byTarget.flatMap((group) => group.entries
    .filter((entry) => entry.state === "AUSENTE")
    .map((entry) => ({
      id: entry.id,
      id_hash: entry.id_hash,
      target_path: entry.targetPath,
      source_hash: fingerprint(entry.sourceDoc.fields || {}),
      fields: entry.sourceDoc.fields || {},
    })));
  return {
    format: "hml-legacy-seed-snapshot-v1",
    project_id: PROJECT_ID,
    tenant_id: TENANT_ID,
    created_at: new Date().toISOString(),
    plan_file: basename(planPath),
    plan_sha256: planHash,
    document_count: documents.length,
    documents,
  };
}

async function writeJsonWithHash(filePath, payload) {
  const json = `${JSON.stringify(payload, null, 2)}\n`;
  await writeFile(filePath, json, "utf8");
  await writeFile(`${filePath}.sha256`, `${sha256(json)}  ${basename(filePath)}\n`, "utf8");
  return sha256(json);
}

function sanitizedGroups(state) {
  return state.byTarget.map((group) => ({
    collection: group.projection.target,
    source: group.projection.source,
    counts: Object.fromEntries(["EQUIVALENTE", "AUSENTE", "DIVERGENTE"].map((name) => [name, group.entries.filter((entry) => entry.state === name).length])),
    documents: group.entries.map((entry) => ({ id_hash: entry.id_hash, state: entry.state, source_hash: fingerprint(entry.sourceDoc.fields || {}) })),
  }));
}

async function writeReport(kind, status, details) {
  await ensureDirectories();
  const stamp = nowId();
  const jsonPath = resolve(REPORT_DIR, `${kind}-${stamp}.json`);
  const report = {
    format: "hml-legacy-seed-report-v1",
    kind,
    status,
    project_id: PROJECT_ID,
    tenant_id: TENANT_ID,
    generated_at: new Date().toISOString(),
    ...details,
  };
  const reportHash = await writeJsonWithHash(jsonPath, report);
  const markdown = [
    `# ${kind}`, "", `- Status: **${status}**`, `- Projeto: \`${PROJECT_ID}\``, `- Tenant: \`${TENANT_ID}\``,
    `- Gerado em: ${report.generated_at}`, `- SHA-256: \`${reportHash}\``,
    ...(report.totals ? ["", "## Totais", "", ...Object.entries(report.totals).map(([key, value]) => `- ${key}: ${value}`)] : []),
    ...(report.message ? ["", report.message] : []), "",
  ].join("\n");
  await writeFile(jsonPath.replace(/\.json$/, ".md"), markdown, "utf8");
  return { jsonPath, reportHash, report };
}

async function preflight(planPath, token) {
  requireHmlProject();
  await ensureDirectories();
  const { absolute, plan, hash } = await readPlan(planPath);
  const state = await buildCurrentState(plan, token);
  validateApprovedState(state, plan);
  const snapshot = snapshotFrom(state, absolute, hash);
  assert(snapshot.document_count === 152, `BLOQUEADO: seed atual contem ${snapshot.document_count} documentos; esperado 152.`);
  const snapshotPath = resolve(SNAPSHOT_DIR, `${nowId()}-before.json`);
  const snapshotHash = await writeJsonWithHash(snapshotPath, snapshot);
  return { planPath: absolute, plan, planHash: hash, state, snapshot, snapshotPath, snapshotHash };
}

async function applySeed(planPath) {
  assert(args.has("--confirm-apply"), "BLOQUEADO: use --apply --confirm-apply somente apos revisao humana.");
  const token = process.env[WRITE_TOKEN_ENV];
  const prepared = await preflight(planPath, token);
  const writes = prepared.snapshot.documents.map((document) => ({
    update: { name: `${ROOT}/${document.target_path}`, fields: document.fields },
    currentDocument: { exists: false },
  }));
  assert(writes.length === 152, "BLOQUEADO: quantidade de escritas fora do escopo aprovado.");
  await commit(writes, token);

  const failures = [];
  for (const document of prepared.snapshot.documents) {
    const current = await getDocument(document.target_path, token);
    if (!current || fingerprint(current.fields || {}) !== document.source_hash) failures.push(document.id_hash);
  }
  const report = await writeReport("hml-legacy-seed-apply", failures.length ? "FALHA_VALIDACAO" : "APLICADO_VALIDADO", {
    plan_sha256: prepared.planHash,
    snapshot_path: prepared.snapshotPath,
    snapshot_sha256: prepared.snapshotHash,
    totals: prepared.state.totals,
    documents_created: writes.length,
    validation_failures: failures,
    groups: sanitizedGroups(prepared.state),
    rollback_allowed: failures.length === 0,
    message: failures.length ? "A validacao posterior falhou. Use apenas o rollback restrito apos revisao." : "Seed aplicado e validado; rollback continua restrito aos documentos desta execucao.",
  });
  if (failures.length) throw new Error(`VALIDACAO FALHOU. Relatorio: ${report.jsonPath}`);
  console.log(`SEED APLICADO E VALIDADO. Relatorio: ${report.jsonPath}`);
}

async function rollback(reportPath) {
  assert(args.has("--confirm-rollback"), "BLOQUEADO: use --rollback <relatorio> --confirm-rollback somente apos revisao humana.");
  requireHmlProject();
  const absoluteReport = resolve(reportPath || "");
  assert(isSafeLocalPath(absoluteReport), "BLOQUEADO: rollback aceita somente relatorio local dentro de reports/hml-legacy-seed.");
  const report = JSON.parse(await readFile(absoluteReport, "utf8"));
  assert(report.status === "APLICADO_VALIDADO" && report.rollback_allowed === true, "BLOQUEADO: somente uma execucao validada pode sofrer rollback.");
  const snapshotPath = resolve(report.snapshot_path);
  assert(isSafeLocalPath(snapshotPath), "BLOQUEADO: snapshot fora do diretorio permitido.");
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));
  const snapshotRaw = await readFile(snapshotPath, "utf8");
  assert(sha256(snapshotRaw) === report.snapshot_sha256, "BLOQUEADO: hash do snapshot nao confere.");
  const token = process.env[WRITE_TOKEN_ENV];
  const writes = [];
  for (const document of snapshot.documents || []) {
    const current = await getDocument(document.target_path, token);
    assert(current, `BLOQUEADO: documento de rollback ausente (${document.id_hash}).`);
    assert(fingerprint(current.fields || {}) === document.source_hash, `BLOQUEADO: documento foi alterado apos o seed (${document.id_hash}).`);
    writes.push({ delete: `${ROOT}/${document.target_path}`, currentDocument: { updateTime: current.updateTime } });
  }
  await commit(writes, token);
  const remaining = [];
  for (const document of snapshot.documents || []) if (await getDocument(document.target_path, token)) remaining.push(document.id_hash);
  const result = await writeReport("hml-legacy-seed-rollback", remaining.length ? "FALHA_VALIDACAO" : "ROLLBACK_VALIDADO", {
    source_apply_report: absoluteReport,
    snapshot_path: snapshotPath,
    documents_deleted: writes.length,
    remaining_documents: remaining,
    message: remaining.length ? "Rollback incompleto; interrompa e revise o relatorio." : "Rollback restrito concluido somente para documentos criados por esta execucao.",
  });
  if (remaining.length) throw new Error(`ROLLBACK FALHOU. Relatorio: ${result.jsonPath}`);
  console.log(`ROLLBACK VALIDADO. Relatorio: ${result.jsonPath}`);
}

function selfTest() {
  assert(redactedId("abc") === redactedId("abc"), "hash de identificador nao deterministico");
  assert(fingerprint({ nome: { stringValue: "Teste" } }) === fingerprint({ nome: { stringValue: "Teste" } }), "fingerprint nao deterministico");
  assert(!isSafeLocalPath(resolve(REPORT_DIR, "..", "fora.json")), "trava de caminho falhou");
  assert(exactObject(EXPECTED_CREATES, { barbeiros: 4, servicos: 39, clientes: 17, agendamentos: 48, ocupacoes: 31, planos_assinatura: 4, solicitacoes_assinatura: 5, historico_assinaturas: 4 }), "escopo aprovado invalido");
  console.log("SELF-TEST APROVADO: sem rede, sem escrita e com travas de homologacao ativas.");
}

async function main() {
  if (args.has("--self-test")) return selfTest();
  if (args.has("--apply")) return applySeed(valueAfter("--plan"));
  if (args.has("--rollback")) return rollback(valueAfter("--rollback"));
  console.log("Nenhuma escrita executada. Use --self-test para validar o aplicador. A aplicacao futura exige --apply --confirm-apply e uma credencial temporaria de homologacao.");
}

main().catch((error) => {
  console.error(`BLOQUEADO/FALHOU: ${error.message}`);
  process.exitCode = 1;
});
