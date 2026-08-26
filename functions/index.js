/**
 * Auditor confiável do Dual Read.
 *
 * O legado continua sendo a fonte de verdade. Esta função só compara as duas
 * projeções quando system/version.mode é "dual-read" e grava um evento técnico
 * mínimo caso exista divergência. Não recebe dados do navegador e não escreve
 * nenhum documento operacional.
 */
import { createHash } from "node:crypto";
import { initializeApp, getApps } from "firebase-admin/app";
import { getFirestore, Timestamp } from "firebase-admin/firestore";
import { logger, setGlobalOptions } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
export { executeOperationalCommand } from "./dual-write.js";
export { resolveTenantHostname } from "./hostname-resolution-endpoint.mjs";

const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const ALLOWED_PROJECTS = new Set(["barber-a01e7", "teste-483f6"]);
const LEGACY_COLLECTIONS = [
  "admins", "vinculos_barbeiro", "clientes", "barbeiros", "servicos",
  "agendamentos", "ocupacoes", "bloqueios", "configuracoes",
  "fechamentos_globais", "planos_assinatura", "solicitacoes_assinatura",
  "historico_assinaturas",
];
const COLLECTION_MAP = new Map([
  ["clientes", "clientes"],
  ["barbeiros", "barbeiros"],
  ["servicos", "servicos"],
  ["agendamentos", "agendamentos"],
  ["ocupacoes", "ocupacoes"],
  ["bloqueios", "bloqueios"],
  ["configuracoes", "configuracoes"],
  ["fechamentos_globais", "fechamentos"],
  ["planos_assinatura", "planos_assinatura"],
  ["solicitacoes_assinatura", "assinaturas"],
  ["historico_assinaturas", "historico_assinaturas"],
]);

const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
if (projectId && !ALLOWED_PROJECTS.has(projectId)) {
  throw new Error("Projeto não autorizado para o auditor Dual Read.");
}

// O uso de uma conta dedicada evita a conta Compute Engine padrão, que possui
// permissões amplas. A conta é criada sem chave JSON e recebe somente leitura
// de entidades + criação de logs técnicos.
// Parâmetro de deploy: o Firebase o resolve antes de criar o serviço Cloud Run.
// Isso impede que a descoberta da Function recaia em uma conta antiga/padrão.
const runtimeServiceAccount = defineString("DUAL_READ_RUNTIME_SERVICE_ACCOUNT");
setGlobalOptions({ region: "southamerica-east1", maxInstances: 1, serviceAccount: runtimeServiceAccount });

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalize(value) {
  if (value instanceof Timestamp) return value.toDate().toISOString();
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
  }
  return value;
}

function fieldsEqual(left, right) {
  return JSON.stringify(normalize(left)) === JSON.stringify(normalize(right));
}

function archivedLegacyAppointment(item) {
  return item.status === "legacy_unresolved"
    && item.arquivado_legado === true
    && item.excluir_migracao === true
    && typeof item.motivo_arquivamento === "string"
    && item.motivo_arquivamento.length > 0;
}

function addRole(members, uid, role, barberId = "") {
  if (!uid) return;
  const current = members.get(String(uid)) || { papeis: new Set(), barbeiroIds: new Set() };
  current.papeis.add(role);
  if (barberId) current.barbeiroIds.add(barberId);
  members.set(String(uid), current);
}

function identityFields(item) {
  const allowed = ["nome", "nome_completo", "email", "foto_url", "photoURL", "criado_em", "created_at"];
  return Object.fromEntries(allowed.filter((key) => item[key] !== undefined).map((key) => [key, item[key]]));
}

function addExpected(expected, path, data, source) {
  if (expected.has(path)) throw new Error(`Projeção duplicada: ${path} (${source}).`);
  expected.set(path, { data: normalize(data), source });
}

function buildExpectedProjection(source, environment) {
  const expected = new Map();
  const members = new Map();
  const identities = new Map();
  const tenantRoot = `barbearias/${TENANT_ID}`;

  for (const [legacy, target] of COLLECTION_MAP) {
    for (const item of source.get(legacy) || []) {
      if (legacy === "agendamentos" && archivedLegacyAppointment(item.data)) continue;
      addExpected(expected, `${tenantRoot}/${target}/${item.id}`, item.data, `${legacy}/${item.id}`);
    }
  }
  for (const item of source.get("clientes") || []) {
    addRole(members, item.id, "CLIENTE");
    identities.set(item.id, { ...(identities.get(item.id) || {}), ...identityFields(item.data) });
  }
  for (const item of source.get("admins") || []) {
    addRole(members, item.id, "ADMIN");
    identities.set(item.id, { ...(identities.get(item.id) || {}), ...identityFields(item.data) });
  }
  for (const item of source.get("barbeiros") || []) {
    const uid = item.data.uid_usuario;
    if (!uid) continue;
    addRole(members, uid, "BARBEIRO", item.id);
    identities.set(String(uid), { ...(identities.get(String(uid)) || {}), ...identityFields(item.data) });
  }
  for (const [uid, member] of members) {
    if (member.barbeiroIds.size > 1) throw new Error("Vínculo ambíguo de barbeiro detectado; auditor interrompido.");
    const barberId = [...member.barbeiroIds][0];
    addExpected(expected, `${tenantRoot}/membros/${uid}`, {
      uid,
      papeis: [...member.papeis].sort(),
      ativo: true,
      ...(barberId ? { barbeiro_id: barberId } : {}),
      origem_migracao: "legacy-antunes-v1",
    }, "generated/member");
    addExpected(expected, `usuarios/${uid}`, {
      uid,
      ...(identities.get(uid) || {}),
      origem_migracao: "legacy-antunes-v1",
    }, "generated/identity");
  }
  addExpected(expected, tenantRoot, {
    tenant_id: TENANT_ID,
    nome: "Barbearia Antunes",
    slug: "antunes",
    logo: "",
    ativa: true,
    status: "ACTIVE",
    plano: environment === "producao" ? "ATUAL" : "HOMOLOGACAO",
    dominio: environment === "producao" ? "barber-a01e7.web.app" : "teste-483f6.web.app",
    timezone: "America/Sao_Paulo",
    schema: 2,
    ambiente: environment === "producao" ? "PRODUCAO" : "HOMOLOGACAO",
  }, "generated/tenant");
  return expected;
}

async function readLegacy() {
  const result = new Map();
  for (const collection of LEGACY_COLLECTIONS) {
    const snapshot = await db.collection(collection).get();
    result.set(collection, snapshot.docs.map((doc) => ({ id: doc.id, data: normalize(doc.data()) })));
  }
  return result;
}

async function compareLegacyWithV2(environment) {
  const expected = buildExpectedProjection(await readLegacy(), environment);
  const missing = [];
  const divergent = [];
  const unexpected = [];
  let equivalent = 0;
  for (const [relativePath, expectedItem] of expected) {
    const doc = await db.doc(relativePath).get();
    if (!doc.exists) {
      missing.push({ source: expectedItem.source, fingerprint: sha256(relativePath).slice(0, 16) });
    } else if (!fieldsEqual(doc.data(), expectedItem.data)) {
      divergent.push({ source: expectedItem.source, fingerprint: sha256(relativePath).slice(0, 16) });
    } else {
      equivalent += 1;
    }
  }

  // A comparação também precisa detectar documentos que existem apenas na V2.
  // audit_logs e migration_logs são técnicos e deliberadamente ficam fora do
  // escopo operacional comparado.
  const actualScopes = [
    "usuarios",
    `barbearias/${TENANT_ID}/membros`,
    ...new Set([...COLLECTION_MAP.values()].map((collection) => `barbearias/${TENANT_ID}/${collection}`)),
  ];
  for (const scope of actualScopes) {
    const snapshot = await db.collection(scope).get();
    for (const doc of snapshot.docs) {
      if (!expected.has(doc.ref.path)) {
        unexpected.push({ source: "v2/unexpected", fingerprint: sha256(doc.ref.path).slice(0, 16) });
      }
    }
  }
  return { expected: expected.size, equivalent, missing, divergent, unexpected };
}

async function writeAuditEvent(result, environment, reason = "DIVERGENCE") {
  const now = new Date();
  const event = {
    schema: 1,
    event_type: "DUAL_READ_DIVERGENCE",
    reason,
    source: "legacy",
    comparison: "v2",
    tenant_id: TENANT_ID,
    environment,
    severity: "HIGH",
    generated_at: now.toISOString(),
    counts: {
      expected: result.expected,
      equivalent: result.equivalent,
      missing: result.missing.length,
      divergent: result.divergent.length,
      unexpected: result.unexpected.length,
    },
    affected: [...result.missing, ...result.divergent, ...result.unexpected].slice(0, 50),
    contains_personal_data: false,
  };
  await db.collection(`barbearias/${TENANT_ID}/audit_logs`).doc(`dual-read-${now.toISOString().replace(/[:.]/g, "-")}`).create(event);
  return event;
}

export const auditDualRead = onSchedule(
  { schedule: "every 15 minutes", timeZone: "America/Sao_Paulo", retryCount: 0 },
  async () => {
    const version = await db.doc("system/version").get();
    if (!version.exists || version.get("mode") !== "dual-read") {
      logger.info("Auditor Dual Read ignorado: modo diferente de dual-read.");
      return;
    }
    const environment = projectId === "barber-a01e7" ? "producao" : "homologacao";
    const result = await compareLegacyWithV2(environment);
    if (result.missing.length || result.divergent.length || result.unexpected.length) {
      const event = await writeAuditEvent(result, environment);
      logger.error("Divergência Dual Read detectada.", { counts: event.counts, tenant_id: TENANT_ID });
      return;
    }
    logger.info("Dual Read equivalente.", { expected: result.expected, tenant_id: TENANT_ID });
  },
);

// Exportado somente para testes locais. Não é um endpoint nem recebe navegador.
export const __test__ = { normalize, fieldsEqual, archivedLegacyAppointment, buildExpectedProjection };
