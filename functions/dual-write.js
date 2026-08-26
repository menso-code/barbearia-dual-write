/**
 * Comandos operacionais do Dual Write.
 *
 * Esta camada é deliberadamente fechada: cada comando possui um contrato
 * próprio e reconstrói os dados confiáveis no servidor. Ela nunca aceita uma
 * coleção/caminho/campo livre enviado pelo navegador.
 */
import { createHash } from "node:crypto";
import { getApps, initializeApp } from "firebase-admin/app";
import { FieldValue, getFirestore } from "firebase-admin/firestore";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import { emailAutorizado, normalizarEmail, unirPapeisPrimeiroVinculo } from "./first-link-policy.mjs";

const TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
const STUDIO_IDENTITY_ID = "identidade";
export const STUDIO_IDENTITY_FIELDS = Object.freeze([
  "nome", "nomeCurto", "logo", "primaryColor", "accentColor",
  "telefone", "whatsapp", "instagram", "endereco", "institucional",
]);
const ALLOWED_PROJECTS = new Set(["barber-a01e7", "teste-483f6"]);
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
const dualWriteRuntimeServiceAccount = defineString("DUAL_WRITE_RUNTIME_SERVICE_ACCOUNT");
if (getApps().length === 0) initializeApp();
const db = getFirestore();
const SAMUEL_HML_BARBER_ID = "YMJrJJ58I6N9bMl4jsgy";
const SAMUEL_HML_EMAIL = "menso333+samuelhml@gmail.com";

function error(code, message) {
  throw new HttpsError(code, message);
}


function sha256(value) {
  return createHash("sha256").update(String(value)).digest("hex");
}

export function normalizeAccessEmail(value) {
  return String(value ?? "").trim().toLowerCase();
}

export function emailAccessIndexPath(email) {
  const normalized = normalizeAccessEmail(email);
  return normalized ? `barbearias/${TENANT_ID}/email_acesso_index/${sha256(normalized)}` : "";
}

function ensureProject() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  if (!ALLOWED_PROJECTS.has(projectId)) error("failed-precondition", "Projeto não autorizado.");
  return projectId;
}

function requireAuth(request) {
  if (!request.auth?.uid) error("unauthenticated", "Autenticação obrigatória.");
  return request.auth.uid;
}

// Em homologação, as contas de teste usam UIDs próprios. O vínculo criado na
// Shadow Migration é resolvido apenas aqui, no backend, para que permissões e
// dados operacionais continuem ancorados no perfil migrado. Em produção o UID
// autenticado segue sendo a identidade operacional, sem conversão.
async function resolveOperationalUid(authUid, projectId, allowClientBootstrap = false) {
  if (projectId !== "teste-483f6") return authUid;

  const mapping = await db.doc(`homologacao_mapeamentos/${authUid}`).get();
  if (!mapping.exists && allowClientBootstrap) return authUid;
  if (!mapping.exists || mapping.get("ativo") !== true) {
    error("permission-denied", "Conta de homologação não está vinculada a um perfil operacional.");
  }

  const operationalUid = cleanText(mapping.get("uid_producao_referencia"), 200);
  if (!operationalUid) error("failed-precondition", "Mapeamento de homologação inválido.");
  return operationalUid;
}

function requireObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    error("invalid-argument", "Dados inválidos.");
  }
  return value;
}

export function extractCommandData(payload) {
  return requireObject(payload?.data);
}

export function requireAppointmentId(data) {
  const appointmentId = data?.appointmentId;
  if (typeof appointmentId !== "string" || appointmentId.trim() === "") {
    error("invalid-argument", "appointmentId obrigatório.");
  }
  return appointmentId;
}

export function extractRebookCommand(payload) {
  const data = extractCommandData(payload);
  const appointmentId = requireAppointmentId(payload);
  onlyFields(data, new Set(["servico_id", "data", "horario", "cliente_nome", "cliente_whatsapp"]));
  return { appointmentId, data };
}

function cleanText(value, max = 500) {
  const text = String(value ?? "").trim();
  if (text.length > max) error("invalid-argument", "Texto inválido.");
  return text;
}

function cleanPhone(value) {
  const digits = String(value ?? "").replace(/\D/g, "");
  if (!digits) return "";
  const phone = digits.startsWith("55") ? digits : `55${digits}`;
  if (!/^55\d{10,11}$/.test(phone)) error("invalid-argument", "WhatsApp inválido.");
  return phone;
}

function cleanIdentityReference(value) {
  const text = cleanText(value, 2048);
  if (!text) return "";
  if (/^(?:javascript|data|vbscript):/i.test(text) || /[\\\s]/.test(text) || text.startsWith("//")) {
    error("invalid-argument", "Referência de identidade inválida.");
  }
  if (text.startsWith("/") || /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%-]+)*(?:[?#][^\s]*)?$/.test(text)) return text;
  try {
    const url = new URL(text);
    if (url.protocol !== "https:") error("invalid-argument", "Referência de identidade inválida.");
    return text;
  } catch {
    error("invalid-argument", "Referência de identidade inválida.");
  }
}

function cleanIdentityColor(value) {
  const color = cleanText(value, 7);
  if (!color) return "";
  if (!/^#[0-9a-f]{6}$/i.test(color)) error("invalid-argument", "Cor de identidade inválida.");
  return color.toUpperCase();
}

function cleanIdentityInstagram(value) {
  const instagram = cleanText(value, 2048);
  if (!instagram) return "";
  if (/^@?[a-z0-9._]{1,30}$/i.test(instagram)) return instagram;
  try {
    const url = new URL(instagram);
    if (url.protocol !== "https:" || !["instagram.com", "www.instagram.com"].includes(url.hostname.toLowerCase())) {
      error("invalid-argument", "Instagram inválido.");
    }
    return instagram;
  } catch {
    error("invalid-argument", "Instagram inválido.");
  }
}

export function normalizeStudioIdentityData(input = {}) {
  const incoming = requireObject(input);
  onlyFields(incoming, new Set(STUDIO_IDENTITY_FIELDS));
  const normalized = { nome: cleanText(incoming.nome, 120) };
  if (!normalized.nome) error("invalid-argument", "Nome do estabelecimento obrigatório.");
  if (Object.hasOwn(incoming, "nomeCurto")) normalized.nomeCurto = cleanText(incoming.nomeCurto, 48);
  if (Object.hasOwn(incoming, "logo")) normalized.logo = cleanIdentityReference(incoming.logo);
  if (Object.hasOwn(incoming, "primaryColor")) normalized.primaryColor = cleanIdentityColor(incoming.primaryColor);
  if (Object.hasOwn(incoming, "accentColor")) normalized.accentColor = cleanIdentityColor(incoming.accentColor);
  if (Object.hasOwn(incoming, "telefone")) normalized.telefone = cleanPhone(incoming.telefone);
  if (Object.hasOwn(incoming, "whatsapp")) normalized.whatsapp = cleanPhone(incoming.whatsapp);
  if (Object.hasOwn(incoming, "instagram")) normalized.instagram = cleanIdentityInstagram(incoming.instagram);
  if (Object.hasOwn(incoming, "endereco")) normalized.endereco = cleanText(incoming.endereco, 240);
  if (Object.hasOwn(incoming, "institucional")) normalized.institucional = cleanText(incoming.institucional, 2000);
  return normalized;
}

export function isTenantAdminMemberData(member, memberTenantId, resolvedTenantId) {
  return memberTenantId === resolvedTenantId
    && member?.ativo === true
    && Array.isArray(member?.papeis)
    && member.papeis.includes("ADMIN");
}

function requestIdFrom(data) {
  const requestId = String(data.requestId || "");
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(requestId)) {
    error("invalid-argument", "Identificador da operação inválido.");
  }
  return requestId;
}

function v2Ref(collection, id) {
  const mapped = COLLECTION_MAP.get(collection);
  if (!mapped) error("internal", "Coleção sem espelho V2.");
  return db.doc(`barbearias/${TENANT_ID}/${mapped}/${id}`);
}

function tenantConfigRef(tenantId, id) {
  return db.doc(`barbearias/${tenantId}/configuracoes/${id}`);
}

function legacyRef(collection, id) {
  return db.collection(collection).doc(id);
}

function operationLogRef(requestId) {
  return db.doc(`barbearias/${TENANT_ID}/audit_logs/operation-${requestId}`);
}

function auditRecord({ operation, actorUid, requestId, result }) {
  return {
    schema: 1,
    event_type: "OPERATIONAL_DUAL_WRITE",
    operation,
    tenant_id: TENANT_ID,
    actor_fingerprint: sha256(actorUid).slice(0, 16),
    request_id: requestId,
    result,
    generated_at: FieldValue.serverTimestamp(),
    contains_personal_data: false,
  };
}

function nowTimestampField() {
  return FieldValue.serverTimestamp();
}

function cleanDate(value) {
  const date = cleanText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) error("invalid-argument", "Data inválida.");
  return date;
}

function cleanTime(value) {
  const time = cleanText(value, 5);
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) error("invalid-argument", "Horário inválido.");
  return time;
}

function minutes(value) {
  const [hour, minute] = cleanTime(value).split(":").map(Number);
  return hour * 60 + minute;
}

function timeFromMinutes(value) {
  return `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;
}

function appointmentBlocks(start, duration) {
  const total = Number(duration);
  if (!Number.isInteger(total) || total < 30 || total % 30 !== 0) error("invalid-argument", "Duração inválida.");
  const initial = minutes(start);
  return Array.from({ length: total / 30 }, (_, index) => timeFromMinutes(initial + index * 30));
}

function occupancyId(barberId, date, time) {
  return `${barberId}_${date}_${time}`;
}

function dateToday() {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Sao_Paulo", year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const part = (type) => parts.find((item) => item.type === type)?.value;
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function clientDateAllowed(date) {
  const today = dateToday();
  const [year, month, day] = today.split("-").map(Number);
  const maxDate = new Date(year, month - 1, day + 10);
  const max = `${maxDate.getFullYear()}-${String(maxDate.getMonth() + 1).padStart(2, "0")}-${String(maxDate.getDate()).padStart(2, "0")}`;
  return date >= today && date <= max;
}

const DEFAULT_PERIODS_LEGACY = (date) => {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  if (weekday === 0) return [];
  const end = weekday >= 1 && weekday <= 4 ? "19:30" : "20:30";
  return [{ inicio: "08:30", fim: "12:00" }, { inicio: "13:00", fim: end }];
};
function defaultPeriods(date, config) {
  const day = new Date(`${date}T12:00:00`).getDay();
  const configured = config?.periodos_semana?.[day];
  if (Array.isArray(configured)) return configured;
  return DEFAULT_PERIODS_LEGACY(date);
}
function intersectPeriods(globalPeriods, personalPeriods) {
  const result = [];
  for (const global of globalPeriods) for (const personal of personalPeriods) {
    const start = Math.max(minutes(global.inicio), minutes(personal.inicio));
    const end = Math.min(minutes(global.fim), minutes(personal.fim));
    if (end > start) result.push({ inicio: timeFromMinutes(start), fim: timeFromMinutes(end) });
  }
  return result;
}
function barberPeriods(barber, date, config, exception) {
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const closed = config?.dias_fechados_semana?.[weekday] === true;
  const global = exception?.tipo === "abertura" ? exception.periods : (closed ? [] : defaultPeriods(date, config));
  if (!global.length) return [];
  const configured = barber?.horarios_trabalho?.[weekday];
  if (configured === false) return [];
  return Array.isArray(configured) ? intersectPeriods(global, configured) : global;
}

function validBarberSlots(barber, date, config, exception) {
  const slots = new Set();
  for (const period of barberPeriods(barber, date, config, exception)) {
    for (let point = minutes(period.inicio); point < minutes(period.fim); point += 30) slots.add(timeFromMinutes(point));
  }
  return slots;
}
function openingPeriods(snapshot) {
  if (!snapshot?.exists || snapshot.get("ativo") === false || snapshot.get("tipo") !== "abertura") return null;
  const start = cleanTime(snapshot.get("inicio_horario") || "08:30");
  const end = cleanTime(snapshot.get("fim_horario") || "21:00");
  if (minutes(end) <= minutes(start)) error("failed-precondition", "ABERTURA_INVALIDA");
  return [{ inicio: start, fim: end }];
}

function creditsUpdated(credits, creditId, changes) {
  const credit = credits?.[creditId];
  if (!credit) return null;
  return {
    ...credits,
    [creditId]: {
      ...credit,
      ...Object.fromEntries(Object.entries(changes).map(([key, delta]) => [key, Number(credit[key] || 0) + delta])),
    },
  };
}

function creditsExhausted(credits) {
  const list = Object.values(credits || {});
  return list.length > 0 && list.every((credit) => Number(credit.restantes) <= 0);
}

function memberRoles(member) {
  return Array.isArray(member?.get?.("papeis"))
    ? member.get("papeis").filter((role) => typeof role === "string")
    : [];
}

function rolesWith(member, role) {
  return [...new Set([...memberRoles(member), role])].sort();
}

function rolesWithout(member, role) {
  return memberRoles(member).filter((current) => current !== role).sort();
}

async function transactionalCommand({ operation, actorUid, requestId, execute }) {
  return db.runTransaction(async (tx) => {
    const logRef = operationLogRef(requestId);
    const previous = await tx.get(logRef);
    if (previous.exists) {
      if (previous.get("operation") !== operation) error("already-exists", "Identificador de operação já utilizado.");
      return { duplicate: true, ...(previous.get("result") || {}) };
    }
    const result = await execute(tx);
    tx.create(logRef, auditRecord({ operation, actorUid, requestId, result }));
    return { duplicate: false, ...result };
  });
}

function clientIdentity(uid, data) {
  const identity = { uid, origem_migracao: "legacy-antunes-v1" };
  ["nome", "nome_completo", "email", "foto_url", "photoURL", "criado_em", "created_at"].forEach((field) => {
    if (data[field] !== undefined) identity[field] = data[field];
  });
  return identity;
}

async function ensureClientProfile({ uid, email, displayName, extras, requestId, bootstrapHml = false }) {
  const suppliedExtras = requireObject(extras || {});
  const allowedExtras = new Set(["nome", "email", "telefone"]);
  if (Object.keys(suppliedExtras).some((key) => !allowedExtras.has(key))) {
    error("permission-denied", "Campo não permitido.");
  }
  const safeExtras = Object.fromEntries(Object.entries(suppliedExtras).filter(([key]) => allowedExtras.has(key)));
  const nome = cleanText(safeExtras.nome || displayName || "", 120);
  const telefone = cleanPhone(safeExtras.telefone || "");
  const clientRef = legacyRef("clientes", uid);
  return transactionalCommand({
    operation: "cliente.garantir-perfil",
    actorUid: uid,
    requestId,
    execute: async (tx) => {
      const mappingRef = bootstrapHml ? db.doc(`homologacao_mapeamentos/${uid}`) : null;
      const mapping = mappingRef ? await tx.get(mappingRef) : null;
      const adminRecord = bootstrapHml ? await tx.get(legacyRef("admins", uid)) : null;
      const clientV2Ref = v2Ref("clientes", uid);
      const current = await tx.get(clientRef);
      const currentV2 = await tx.get(clientV2Ref);
      const memberRef = db.doc(`barbearias/${TENANT_ID}/membros/${uid}`);
      const member = await tx.get(memberRef);

      if (bootstrapHml && adminRecord?.exists) {
        error("permission-denied", "Conta de cliente HML possui papel privilegiado.");
      }
      if (bootstrapHml) {
        if (mapping.exists) {
          if (mapping.get("ativo") !== true || mapping.get("tenant_id") !== TENANT_ID || mapping.get("uid_producao_referencia") !== uid) {
            error("failed-precondition", "Mapeamento de cliente HML inconsistente.");
          }
        }
      }
      if (current.exists !== currentV2.exists) {
        error("failed-precondition", "Perfil de cliente Legado/V2 inconsistente.");
      }
      if (bootstrapHml && member.exists && memberRoles(member).some((role) => ["ADMIN", "BARBEIRO"].includes(role))) {
        error("permission-denied", "Conta de cliente HML possui papel privilegiado.");
      }
      const initial = !current.exists;
      const next = initial
        ? { nome, email: String(email || ""), telefone, data_de_criacao: FieldValue.serverTimestamp() }
        : Object.fromEntries(Object.entries(safeExtras).filter(([field]) => field !== "email"));
      const profileNeedsWrite = initial || Object.keys(next).length > 0;
      const mappingNeedsWrite = bootstrapHml && !mapping.exists;
      const memberNeedsWrite = !member.exists || !memberRoles(member).includes("CLIENTE");
      if (!profileNeedsWrite && !mappingNeedsWrite && !memberNeedsWrite) return { clientId: uid, created: false };
      if (mappingNeedsWrite) {
        tx.create(mappingRef, {
          ativo: true,
          papeis_teste: ["CLIENTE"],
          somente_homologacao: true,
          tenant_id: TENANT_ID,
          uid_producao_referencia: uid,
          criado_em: nowTimestampField(),
          atualizado_em: nowTimestampField(),
        });
      }
      if (profileNeedsWrite) {
        tx.set(clientRef, next, { merge: !initial });
        tx.set(clientV2Ref, next, { merge: !initial });
      }
      if (!member.exists) {
        tx.create(memberRef, { uid, papeis: ["CLIENTE"], ativo: true, origem_migracao: "legacy-antunes-v1" });
      } else if (!Array.isArray(member.get("papeis")) || !member.get("papeis").includes("CLIENTE")) {
        const existingRoles = Array.isArray(member.get("papeis")) ? member.get("papeis") : [];
        tx.update(memberRef, { papeis: [...new Set([...existingRoles, "CLIENTE"])] });
      }
      const currentData = current.exists ? current.data() : {};
      if (profileNeedsWrite) tx.set(db.doc(`usuarios/${uid}`), clientIdentity(uid, { ...currentData, ...next }), { merge: true });
      return { clientId: uid, created: initial };
    },
  });
}

async function updateClientProfile({ uid, data, requestId }) {
  const incoming = requireObject(data);
  const allowed = new Set([
    "nome", "telefone", "data_nascimento", "avatar_data", "barbeiro_favorito_id",
    "servico_favorito_id", "periodo_preferido", "observacoes",
  ]);
  if (Object.keys(incoming).some((key) => !allowed.has(key))) error("permission-denied", "Campo não permitido.");
  const changes = {
    ...(incoming.nome !== undefined ? { nome: cleanText(incoming.nome, 120) } : {}),
    ...(incoming.telefone !== undefined ? { telefone: cleanPhone(incoming.telefone) } : {}),
    ...(incoming.data_nascimento !== undefined ? { data_nascimento: cleanText(incoming.data_nascimento, 10) } : {}),
    ...(incoming.avatar_data !== undefined ? { avatar_data: cleanText(incoming.avatar_data, 800000) } : {}),
    ...(incoming.barbeiro_favorito_id !== undefined ? { barbeiro_favorito_id: cleanText(incoming.barbeiro_favorito_id, 200) } : {}),
    ...(incoming.servico_favorito_id !== undefined ? { servico_favorito_id: cleanText(incoming.servico_favorito_id, 200) } : {}),
    ...(incoming.periodo_preferido !== undefined ? { periodo_preferido: cleanText(incoming.periodo_preferido, 100) } : {}),
    ...(incoming.observacoes !== undefined ? { observacoes: cleanText(incoming.observacoes, 1000) } : {}),
  };
  if (!Object.keys(changes).length) error("invalid-argument", "Nenhuma alteração válida.");
  const clientRef = legacyRef("clientes", uid);
  return transactionalCommand({
    operation: "cliente.atualizar-perfil",
    actorUid: uid,
    requestId,
    execute: async (tx) => {
      const current = await tx.get(clientRef);
      if (!current.exists) error("failed-precondition", "Perfil não encontrado.");
      tx.update(clientRef, changes);
      tx.set(v2Ref("clientes", uid), changes, { merge: true });
      if (changes.nome !== undefined) tx.set(db.doc(`usuarios/${uid}`), { nome: changes.nome }, { merge: true });
      return { clientId: uid, updated: Object.keys(changes).sort() };
    },
  });
}

async function requestSubscription({ uid, planId, requestId }) {
  const safePlanId = cleanText(planId, 200);
  if (!safePlanId) error("invalid-argument", "Plano inválido.");
  const planRef = legacyRef("planos_assinatura", safePlanId);
  const clientRef = legacyRef("clientes", uid);
  const subscriptionId = `${uid}_${safePlanId}`;
  const subscriptionRef = legacyRef("solicitacoes_assinatura", subscriptionId);
  return transactionalCommand({
    operation: "assinatura.solicitar",
    actorUid: uid,
    requestId,
    execute: async (tx) => {
      const [plan, client, existing] = await Promise.all([tx.get(planRef), tx.get(clientRef), tx.get(subscriptionRef)]);
      if (!plan.exists || plan.get("ativo") !== true) error("failed-precondition", "Plano indisponível.");
      if (!client.exists || !cleanText(client.get("nome"), 120)) error("failed-precondition", "Cliente indisponível.");
      if (existing.exists && existing.get("status") === "PENDENTE") error("already-exists", "Solicitação existente.");
      const planData = plan.data();
      if (!Number.isInteger(planData.preco_centavos) || planData.preco_centavos <= 0 || !Array.isArray(planData.servicos_ids) || !planData.servicos_ids.length) {
        error("failed-precondition", "Plano indisponível.");
      }
      const subscription = {
        cliente_id: uid,
        cliente_nome: cleanText(client.get("nome"), 120),
        plano_id: safePlanId,
        plano_nome: cleanText(planData.nome, 160),
        plano_preco_centavos: planData.preco_centavos,
        status: "PENDENTE",
        solicitado_em: FieldValue.serverTimestamp(),
        termos_aceitos: true,
        termos_aceitos_em: FieldValue.serverTimestamp(),
      };
      tx.set(subscriptionRef, subscription);
      tx.set(v2Ref("solicitacoes_assinatura", subscriptionId), subscription);
      return { subscriptionId, status: "PENDENTE" };
    },
  });
}

async function isAdmin(tx, uid) {
  return (await tx.get(legacyRef("admins", uid))).exists;
}

async function requireTenantAdmin(tx, uid, tenantId) {
  if (!await isAdmin(tx, uid)) error("permission-denied", "Acesso administrativo necessário.");
  const member = await tx.get(db.doc(`barbearias/${tenantId}/membros/${uid}`));
  const memberData = member.exists ? member.data() : null;
  if (!member.exists || !isTenantAdminMemberData(memberData, tenantId, tenantId)) {
    error("permission-denied", "Acesso administrativo necessário.");
  }
}

async function barberOwnedBy(tx, uid, barberId) {
  const barber = await tx.get(legacyRef("barbeiros", barberId));
  return barber.exists && String(barber.get("uid_usuario") || "") === uid;
}

async function ensureAppointmentPermission(tx, uid, appointment, action) {
  const admin = await isAdmin(tx, uid);
  if (admin) return;
  if (appointment.cliente_id && appointment.cliente_id === uid && ["cancelar"].includes(action)) return;
  if (appointment.barbeiro_id && await barberOwnedBy(tx, uid, appointment.barbeiro_id)) return;
  error("permission-denied", "Permissão insuficiente.");
}

function mirrorSet(tx, collection, id, data, options = {}) {
  tx.set(legacyRef(collection, id), data, options);
  tx.set(v2Ref(collection, id), data, options);
}

function mirrorUpdate(tx, collection, id, data) {
  tx.update(legacyRef(collection, id), data);
  tx.set(v2Ref(collection, id), data, { merge: true });
}

function mirrorDelete(tx, collection, id) {
  tx.delete(legacyRef(collection, id));
  tx.delete(v2Ref(collection, id));
}

async function createAppointment({ uid, authUid, data, requestId }) {
  const incoming = requireObject(data);
  const barberId = cleanText(incoming.barbeiro_id, 200);
  const serviceId = cleanText(incoming.servico_id, 200);
  const date = cleanDate(incoming.data);
  const time = cleanTime(incoming.horario);
  // O cliente da sessão de homologação é traduzido para o perfil operacional
  // já migrado; Admin e barbeiro continuam podendo informar um cliente real.
  const suppliedClientId = cleanText(incoming.cliente_id || "", 200);
  const clientId = suppliedClientId === authUid ? uid : suppliedClientId;
  const source = cleanText(incoming.origem || "cliente", 80);
  const isSubscription = source === "assinatura";
  const id = `${barberId}_${date}_${time}`;
  return transactionalCommand({
    operation: "agenda.criar",
    actorUid: uid,
    requestId,
    execute: async (tx) => {
      const barberRef = legacyRef("barbeiros", barberId);
      const serviceRef = legacyRef("servicos", serviceId);
      const clientRef = clientId ? legacyRef("clientes", clientId) : null;
      const configRef = legacyRef("configuracoes", "funcionamento");
      const closeRef = legacyRef("fechamentos_globais", date);
      const openingRef = legacyRef("fechamentos_globais", `abertura_${date}`);
      const appointmentRef = legacyRef("agendamentos", id);
      const [barberSnap, serviceSnap, clientSnap, configSnap, closeSnap, openingSnap, existingSnap] = await Promise.all([
        tx.get(barberRef), tx.get(serviceRef), clientRef ? tx.get(clientRef) : Promise.resolve(null), tx.get(configRef), tx.get(closeRef), tx.get(openingRef), tx.get(appointmentRef),
      ]);
      if (!barberSnap.exists || barberSnap.get("ativo") === false) error("failed-precondition", "BARBEIRO_INDISPONIVEL");
      if (!serviceSnap.exists || serviceSnap.get("ativo") === false) error("failed-precondition", "SERVICO_INDISPONIVEL");
      const isAdminUser = await isAdmin(tx, uid);
      const isOwnBarber = await barberOwnedBy(tx, uid, barberId);
      if (clientId && clientId !== uid && !isAdminUser && !isOwnBarber) error("permission-denied", "Permissão insuficiente.");
      if (!clientId && !isAdminUser && !isOwnBarber) error("permission-denied", "Permissão insuficiente.");
      if (clientId && !clientSnap?.exists) error("failed-precondition", "CLIENTE_INDISPONIVEL");
      if (!isAdminUser && !isOwnBarber && !clientDateAllowed(date)) error("failed-precondition", "DATA_FORA_DA_JANELA");
      const weekday = new Date(`${date}T12:00:00`).getDay();
      const opening = openingPeriods(openingSnap);
      const closedWeekly = configSnap.exists && configSnap.get("dias_fechados_semana")?.[weekday] === true;
      if ((closeSnap.exists && closeSnap.get("ativo") !== false) || (!opening && (closedWeekly || (!configSnap.exists && weekday === 0)))) error("failed-precondition", "BARBEARIA_FECHADA");
      if (existingSnap.exists && !["cancelado", "nao_compareceu"].includes(existingSnap.get("status"))) error("already-exists", "HORARIO_OCUPADO");
      const barber = barberSnap.data();
      const service = serviceSnap.data();
      const duration = Number(service.duracao || incoming.duracao || 30);
      const slots = appointmentBlocks(time, duration);
      const validSlots = validBarberSlots(barber, date, configSnap.data(), opening ? { tipo: "abertura", periods: opening } : null);
      if (slots.some((slot) => !validSlots.has(slot))) error("failed-precondition", "HORARIO_INDISPONIVEL");
      const occupancyRefs = slots.map((slot) => legacyRef("ocupacoes", occupancyId(barberId, date, slot)));
      const occupancySnapshots = await Promise.all(occupancyRefs.map((ref) => tx.get(ref)));
      if (occupancySnapshots.some((snap) => snap.exists)) error("already-exists", "HORARIO_OCUPADO");

      let subscription = null;
      let subscriptionId = "";
      let creditType = "";
      if (isSubscription) {
        subscriptionId = cleanText(incoming.assinatura_id, 260);
        creditType = cleanText(incoming.assinatura_credito_tipo, 200);
        if (!clientId || !subscriptionId || creditType !== serviceId) error("failed-precondition", "CREDITO_INDISPONIVEL");
        const subscriptionRef = legacyRef("solicitacoes_assinatura", subscriptionId);
        const subscriptionSnap = await tx.get(subscriptionRef);
        const current = subscriptionSnap.data();
        const dueAt = current?.vencimento_em?.toDate?.();
        const credit = current?.creditos_mensais?.[creditType];
        if (!subscriptionSnap.exists || current.cliente_id !== clientId || current.status !== "ATIVA" || !dueAt || dueAt <= new Date() || !Array.isArray(current.servicos_ids) || !current.servicos_ids.includes(serviceId) || !credit || credit.servico_id !== serviceId || Number(credit.restantes) - Number(credit.reservados) < 1) error("failed-precondition", "CREDITO_INDISPONIVEL");
        subscription = { id: subscriptionId, data: current, creditType };
      }
      const client = clientSnap?.data() || {};
      const appointment = {
        cliente_id: clientId,
        cliente_nome: clientId ? cleanText(client.nome || "Cliente", 120) : cleanText(incoming.cliente_nome, 120),
        cliente_whatsapp: clientId ? cleanPhone(client.telefone || "") : cleanPhone(incoming.cliente_whatsapp || ""),
        cliente_tipo: clientId ? "cliente" : "presencial",
        barbeiro_id: barberId,
        barbeiro_nome: cleanText(barber.nome || "Barbeiro", 120),
        servico_id: serviceId,
        servico_nome: cleanText(service.nome || "Serviço", 160),
        servico_preco: service.preco ?? service.preco_centavos ?? "",
        data: date,
        horario: time,
        duracao: duration,
        origem: source,
        criado_por: uid,
        criado_por_tipo: isAdminUser ? "admin" : isOwnBarber ? "barbeiro" : "cliente",
        status: "agendado",
        criado_em: nowTimestampField(),
        ...(subscription ? { assinatura_id: subscriptionId, assinatura_plano_id: subscription.data.plano_id, assinatura_credito_tipo: creditType, credito_assinatura_reservado: true } : {}),
      };
      mirrorSet(tx, "agendamentos", id, appointment);
      slots.forEach((slot) => mirrorSet(tx, "ocupacoes", occupancyId(barberId, date, slot), { barbeiro_id: barberId, data: date, horario: slot, agendamento_id: id, criado_em: nowTimestampField() }));
      if (subscription) {
        const credits = creditsUpdated(subscription.data.creditos_mensais, creditType, { reservados: 1 });
        mirrorUpdate(tx, "solicitacoes_assinatura", subscriptionId, { creditos_mensais: credits, ultima_reserva_agendamento_id: id, ultima_reserva_em: nowTimestampField() });
      }
      return { appointmentId: id, slots: slots.length };
    },
  });
}

// Reagendamento é um único comando: a nova vaga e o cancelamento da antiga
// nunca ficam visíveis isoladamente para as duas projeções.
async function rebookAppointment({ uid, appointmentId, data, requestId }) {
  const originalId = cleanText(appointmentId, 300);
  const incoming = requireObject(data);
  onlyFields(incoming, new Set(["servico_id", "data", "horario", "cliente_nome", "cliente_whatsapp"]));
  const date = cleanDate(incoming.data);
  const time = cleanTime(incoming.horario);
  const serviceId = cleanText(incoming.servico_id, 200);
  return transactionalCommand({
    operation: "agenda.reagendar", actorUid: uid, requestId,
    execute: async (tx) => {
      const originalSnap = await tx.get(legacyRef("agendamentos", originalId));
      if (!originalSnap.exists) error("not-found", "AGENDAMENTO_INDISPONIVEL");
      const original = originalSnap.data();
      await ensureAppointmentPermission(tx, uid, original, "atender");
      if (!["agendado", "cliente_chegou"].includes(original.status)) error("failed-precondition", "AGENDAMENTO_INDISPONIVEL");
      if (original.origem === "assinatura" && serviceId !== original.servico_id) error("failed-precondition", "SERVICO_ASSINATURA_INALTERAVEL");
      const barberId = original.barbeiro_id;
      const newId = `${barberId}_${date}_${time}`;
      if (newId === originalId) error("failed-precondition", "AGENDAMENTO_SEM_ALTERACAO");
      const oldSlots = appointmentBlocks(original.horario, Number(original.duracao || 30));
      const refs = {
        barber: legacyRef("barbeiros", barberId), service: legacyRef("servicos", serviceId), config: legacyRef("configuracoes", "funcionamento"),
        closure: legacyRef("fechamentos_globais", date), opening: legacyRef("fechamentos_globais", `abertura_${date}`), target: legacyRef("agendamentos", newId),
      };
      const [barberSnap, serviceSnap, configSnap, closureSnap, openingSnap, targetSnap] = await Promise.all([
        tx.get(refs.barber), tx.get(refs.service), tx.get(refs.config), tx.get(refs.closure), tx.get(refs.opening), tx.get(refs.target),
      ]);
      if (!barberSnap.exists || barberSnap.get("ativo") === false || !serviceSnap.exists || serviceSnap.get("ativo") === false) error("failed-precondition", "HORARIO_INDISPONIVEL");
      const weekday = new Date(`${date}T12:00:00`).getDay();
      const opening = openingPeriods(openingSnap);
      if ((closureSnap.exists && closureSnap.get("ativo") !== false) || (!opening && ((configSnap.exists && configSnap.get("dias_fechados_semana")?.[weekday] === true) || (!configSnap.exists && weekday === 0)))) error("failed-precondition", "BARBEARIA_FECHADA");
      if (targetSnap.exists && !["cancelado", "nao_compareceu"].includes(targetSnap.get("status"))) error("already-exists", "HORARIO_OCUPADO");
      const duration = Number(serviceSnap.get("duracao") || original.duracao || 30);
      const newSlots = appointmentBlocks(time, duration);
      if (newSlots.some((slot) => !validBarberSlots(barberSnap.data(), date, configSnap.data(), opening ? { tipo: "abertura", periods: opening } : null).has(slot))) error("failed-precondition", "HORARIO_INDISPONIVEL");
      const occupancyRefs = newSlots.map((slot) => legacyRef("ocupacoes", occupancyId(barberId, date, slot)));
      const occupancySnaps = await Promise.all(occupancyRefs.map((ref) => tx.get(ref)));
      if (occupancySnaps.some((snap) => snap.exists && snap.get("agendamento_id") !== originalId)) error("already-exists", "HORARIO_OCUPADO");
      const replacement = {
        ...original, id: undefined, servico_id: serviceId, servico_nome: cleanText(serviceSnap.get("nome") || "Serviço", 160),
        servico_preco: serviceSnap.get("preco") ?? serviceSnap.get("preco_centavos") ?? "", data: date, horario: time, duracao: duration,
        status: "agendado", reagendado_de: originalId, criado_em: nowTimestampField(), reagendado_em: nowTimestampField(),
        ...(original.cliente_id ? {} : { cliente_nome: cleanText(incoming.cliente_nome || original.cliente_nome, 120), cliente_whatsapp: cleanPhone(incoming.cliente_whatsapp || original.cliente_whatsapp || "") }),
      };
      delete replacement.id;
      mirrorSet(tx, "agendamentos", newId, replacement);
      mirrorUpdate(tx, "agendamentos", originalId, { status: "cancelado", cancelado_em: nowTimestampField(), reagendado_para: newId, credito_liberado_por_reagendamento: false });
      oldSlots.forEach((slot) => {
        const oldOccupancyId = occupancyId(original.barbeiro_id, original.data, slot);
        if (!newSlots.includes(slot) || original.data !== date) mirrorDelete(tx, "ocupacoes", oldOccupancyId);
      });
      newSlots.forEach((slot) => mirrorSet(tx, "ocupacoes", occupancyId(barberId, date, slot), { barbeiro_id: barberId, data: date, horario: slot, agendamento_id: newId, criado_em: nowTimestampField() }));
      return { appointmentId: newId, replacedAppointmentId: originalId, slots: newSlots.length };
    },
  });
}

async function transitionAppointment({ uid, appointmentId, action, requestId }) {
  const id = cleanText(appointmentId, 300);
  const actions = new Set(["cliente_chegou", "em_atendimento", "concluir", "cancelar", "nao_compareceu"]);
  if (!actions.has(action)) error("invalid-argument", "Ação inválida.");
  return transactionalCommand({
    operation: `agenda.${action}`,
    actorUid: uid,
    requestId,
    execute: async (tx) => {
      const appointmentRef = legacyRef("agendamentos", id);
      const appointmentSnap = await tx.get(appointmentRef);
      if (!appointmentSnap.exists) error("not-found", "AGENDAMENTO_INDISPONIVEL");
      const appointment = appointmentSnap.data();
      await ensureAppointmentPermission(tx, uid, appointment, action === "cancelar" ? "cancelar" : "atender");
      const active = ["agendado", "cliente_chegou", "em_atendimento"];
      if (!active.includes(appointment.status)) error("failed-precondition", "AGENDAMENTO_INDISPONIVEL");
      if (action === "cliente_chegou" || action === "em_atendimento") {
        if (action === "cliente_chegou" && appointment.status !== "agendado") error("failed-precondition", "AGENDAMENTO_INDISPONIVEL");
        if (action === "em_atendimento" && appointment.status !== "cliente_chegou") error("failed-precondition", "AGENDAMENTO_INDISPONIVEL");
        const patch = action === "cliente_chegou" ? { status: action, checked_in_at: nowTimestampField() } : { status: action, started_at: nowTimestampField() };
        mirrorUpdate(tx, "agendamentos", id, patch);
        return { appointmentId: id, status: action };
      }
      const duration = Number(appointment.duracao || 30);
      const slots = appointmentBlocks(appointment.horario, duration);
      const subscriptionId = String(appointment.assinatura_id || "");
      const creditType = String(appointment.assinatura_credito_tipo || "");
      const subscriptionRef = subscriptionId ? legacyRef("solicitacoes_assinatura", subscriptionId) : null;
      const consumes = ["concluir", "nao_compareceu"].includes(action) && appointment.origem === "assinatura" && subscriptionId && creditType;
      const releases = action === "cancelar" && appointment.credito_assinatura_reservado === true && appointment.credito_assinatura_consumido !== true && subscriptionId && creditType;
      const subscriptionSnap = subscriptionRef ? await tx.get(subscriptionRef) : null;
      if (consumes || releases) {
        const subscription = subscriptionSnap?.data();
        const credit = subscription?.creditos_mensais?.[creditType];
        if (!subscriptionSnap?.exists || !credit) error("failed-precondition", "CREDITO_INDISPONIVEL");
        const dueAt = subscription?.vencimento_em?.toDate?.();
        if (consumes && (subscription.status !== "ATIVA" || !dueAt || dueAt <= new Date())) {
          error("failed-precondition", "CREDITO_INDISPONIVEL");
        }
        if (consumes && (appointment.credito_assinatura_consumido === true || Number(credit.restantes) < 1 || Number(credit.reservados) < 1)) error("failed-precondition", "CREDITO_INDISPONIVEL");
        if (releases && Number(credit.reservados) < 1) error("failed-precondition", "CREDITO_INDISPONIVEL");
        const credits = creditsUpdated(subscription.creditos_mensais, creditType, consumes ? { utilizados: 1, restantes: -1, reservados: -1 } : { reservados: -1 });
        const subscriptionPatch = consumes ? {
          creditos_mensais: credits,
          ultimo_consumo_agendamento_id: id,
          ultimo_consumo_em: nowTimestampField(),
          ...(creditsExhausted(credits) ? { status: "EXPIRADA", expirada_em: nowTimestampField(), motivo_expiracao: "CREDITOS_ESGOTADOS" } : {}),
        } : { creditos_mensais: credits, ultima_liberacao_agendamento_id: id, ultima_liberacao_em: nowTimestampField() };
        mirrorUpdate(tx, "solicitacoes_assinatura", subscriptionId, subscriptionPatch);
        if (consumes) mirrorSet(tx, "historico_assinaturas", `${id}_credito`, { assinatura_id: subscriptionId, cliente_id: appointment.cliente_id, plano_id: appointment.assinatura_plano_id || "", agendamento_id: id, servico_nome: appointment.servico_nome || "Serviço", barbeiro_id: appointment.barbeiro_id, barbeiro_nome: appointment.barbeiro_nome || "Barbeiro", credito_tipo: creditType, creditos_consumidos: 1, utilizado_em: nowTimestampField() });
      }
      const status = action === "concluir" ? "concluido" : action === "cancelar" ? "cancelado" : "nao_compareceu";
      const statusAt = action === "concluir" ? "completed_at" : `${status}_em`;
      mirrorUpdate(tx, "agendamentos", id, { status, [statusAt]: nowTimestampField(), ...(consumes ? { credito_assinatura_consumido: true } : {}) });
      if (action !== "concluir") slots.forEach((slot) => {
        const occupancyIdValue = occupancyId(appointment.barbeiro_id, appointment.data, slot);
        mirrorDelete(tx, "ocupacoes", occupancyIdValue);
      });
      return { appointmentId: id, status };
    },
  });
}

async function createBlock({ uid, data, requestId }) {
  const incoming = requireObject(data);
  const barberId = cleanText(incoming.barbeiro_id, 200);
  const date = cleanDate(incoming.data);
  const start = cleanTime(incoming.inicio);
  const end = cleanTime(incoming.fim);
  const duration = minutes(end) - minutes(start);
  if (duration <= 0 || duration % 30) error("invalid-argument", "BLOQUEIO_INVALIDO");
  const id = `${barberId}_${date}_${start}`;
  return transactionalCommand({ operation: "bloqueio.criar", actorUid: uid, requestId, execute: async (tx) => {
    if (!await isAdmin(tx, uid) && !await barberOwnedBy(tx, uid, barberId)) error("permission-denied", "Permissão insuficiente.");
    const [barberSnap, configSnap, closeSnap, openingSnap] = await Promise.all([
      tx.get(legacyRef("barbeiros", barberId)),
      tx.get(legacyRef("configuracoes", "funcionamento")),
      tx.get(legacyRef("fechamentos_globais", date)),
      tx.get(legacyRef("fechamentos_globais", `abertura_${date}`)),
    ]);
    if (!barberSnap.exists) error("not-found", "BARBEIRO_INDISPONIVEL");
    const opening = openingPeriods(openingSnap);
    const weekday = new Date(`${date}T12:00:00`).getDay();
    if ((closeSnap.exists && closeSnap.get("ativo") !== false) || (!opening && ((configSnap.exists && configSnap.get("dias_fechados_semana")?.[weekday] === true) || (!configSnap.exists && weekday === 0)))) error("failed-precondition", "BLOQUEIO_FORA_DO_EXPEDIENTE");
    const slots = appointmentBlocks(start, duration);
    if (slots.some((slot) => !validBarberSlots(barberSnap.data(), date, configSnap.data(), opening ? { tipo: "abertura", periods: opening } : null).has(slot))) error("failed-precondition", "BLOQUEIO_FORA_DO_EXPEDIENTE");
    const refs = slots.map((slot) => legacyRef("ocupacoes", occupancyId(barberId, date, slot)));
    const occupied = await Promise.all(refs.map((ref) => tx.get(ref)));
    if (occupied.some((snap) => snap.exists)) error("already-exists", "HORARIO_OCUPADO");
    mirrorSet(tx, "bloqueios", id, { barbeiro_id: barberId, data: date, inicio: start, fim: end, duracao: duration, motivo: cleanText(incoming.motivo || "Bloqueado", 240), criado_em: nowTimestampField() });
    slots.forEach((slot) => mirrorSet(tx, "ocupacoes", occupancyId(barberId, date, slot), { barbeiro_id: barberId, data: date, horario: slot, bloqueio_id: id, tipo: "bloqueio", criado_em: nowTimestampField() }));
    return { blockId: id, slots: slots.length };
  }});
}

async function deleteBlock({ uid, blockId, requestId }) {
  const id = cleanText(blockId, 300);
  return transactionalCommand({ operation: "bloqueio.remover", actorUid: uid, requestId, execute: async (tx) => {
    const blockRef = legacyRef("bloqueios", id); const blockSnap = await tx.get(blockRef);
    if (!blockSnap.exists) error("not-found", "BLOQUEIO_INDISPONIVEL");
    const block = blockSnap.data();
    if (!await isAdmin(tx, uid) && !await barberOwnedBy(tx, uid, block.barbeiro_id)) error("permission-denied", "Permissão insuficiente.");
    const slots = appointmentBlocks(block.inicio, Number(block.duracao || minutes(block.fim) - minutes(block.inicio)));
    const occupancyRefs = slots.map((slot) => legacyRef("ocupacoes", occupancyId(block.barbeiro_id, block.data, slot)));
    const occupancies = await Promise.all(occupancyRefs.map((ref) => tx.get(ref)));
    mirrorDelete(tx, "bloqueios", id);
    occupancies.forEach((occupancy, index) => {
      if (occupancy.exists && occupancy.get("bloqueio_id") === id) {
        mirrorDelete(tx, "ocupacoes", occupancyId(block.barbeiro_id, block.data, slots[index]));
      }
    });
    return { blockId: id };
  }});
}

async function requireAdmin(tx, uid) {
  if (!await isAdmin(tx, uid)) error("permission-denied", "Acesso administrativo necessário.");
}

async function linkSamuelFirstAccess({ authUid, email, emailVerified, requestId, projectId }) {
  if (projectId !== "teste-483f6") error("failed-precondition", "Vínculo disponível somente em HML.");
  const normalizedEmail = normalizarEmail(email);
  if (!emailAutorizado(normalizedEmail, SAMUEL_HML_EMAIL)) error("permission-denied", "E-mail não autorizado.");
  return transactionalCommand({ operation: "barbeiro.vincular-primeiro-acesso", actorUid: authUid, requestId, execute: async (tx) => {
    const barber = await tx.get(legacyRef("barbeiros", SAMUEL_HML_BARBER_ID));
    if (!barber.exists || barber.get("ativo") !== true || String(barber.get("email_acesso") || "").trim().toLowerCase() !== normalizedEmail) error("failed-precondition", "BARBEIRO_NAO_ELEGIVEL");
    const linkedUid = cleanText(barber.get("uid_usuario") || "", 200);
    if (linkedUid && linkedUid !== authUid) error("already-exists", "BARBEIRO_JA_VINCULADO");
    const duplicate = await db.collection("barbeiros").where("uid_usuario", "==", authUid).get();
    if (duplicate.docs.some((doc) => doc.id !== SAMUEL_HML_BARBER_ID)) error("already-exists", "UID_JA_VINCULADO");
    const memberRef = db.doc(`barbearias/${TENANT_ID}/membros/${authUid}`);
    const member = await tx.get(memberRef);
    const roles = Array.isArray(member?.get("papeis")) ? member.get("papeis") : [];
    const nextRoles = unirPapeisPrimeiroVinculo(roles);
    mirrorUpdate(tx, "barbeiros", SAMUEL_HML_BARBER_ID, { uid_usuario: authUid, atualizado_em: nowTimestampField() });
    tx.set(legacyRef("vinculos_barbeiro", authUid), { barbeiro_id: SAMUEL_HML_BARBER_ID, atualizado_em: nowTimestampField() });
    tx.set(memberRef, { uid: authUid, papeis: nextRoles, barbeiro_id: SAMUEL_HML_BARBER_ID, ativo: true, atualizado_em: nowTimestampField() }, { merge: true });
    tx.set(legacyRef("homologacao_mapeamentos", authUid), { ativo: true, papeis_teste: nextRoles, somente_homologacao: true, tenant_id: TENANT_ID, uid_producao_referencia: authUid, barbeiro_id: SAMUEL_HML_BARBER_ID, atualizado_em: nowTimestampField() }, { merge: true });
    return { status: "VINCULADO", barbeiroId: SAMUEL_HML_BARBER_ID, requestId, email_verified_observado: emailVerified === true };
  }});
}

function onlyFields(data, allowed) {
  if (Object.keys(data).some((key) => !allowed.has(key))) error("permission-denied", "Campo não permitido.");
}
function validatePeriodsMap(periods) {
  const normalized = {};
  for (let day = 0; day < 7; day += 1) {
    const dayPeriods = periods?.[day];
    if (!Array.isArray(dayPeriods) || !dayPeriods.length || dayPeriods.length > 3) error("invalid-argument", "PERIODOS_INVALIDOS");
    normalized[day] = dayPeriods.map((period) => {
      const inicio = cleanTime(period?.inicio); const fim = cleanTime(period?.fim);
      if (minutes(inicio) >= minutes(fim) || minutes(inicio) % 30 || minutes(fim) % 30) error("invalid-argument", "PERIODO_INVALIDO");
      return { inicio, fim };
    });
  }
  return normalized;
}

function dueDateOneMonth() {
  const now = new Date();
  const result = new Date(now);
  result.setMonth(result.getMonth() + 1);
  return result;
}

function subscriptionCredits(plan, services) {
  const ids = [...new Set(Array.isArray(plan.servicos_ids) ? plan.servicos_ids.map(String) : [])];
  const uses = Number(plan.usos_mensais);
  if (!ids.length || !Number.isInteger(uses) || uses < 1 || uses % ids.length) error("failed-precondition", "PLANO_SEM_CREDITOS");
  const usesEach = uses / ids.length;
  return Object.fromEntries(ids.map((serviceId, index) => [serviceId, {
    servico_id: serviceId,
    nome: cleanText(services.get(serviceId)?.nome || plan.servicos_incluidos?.[index] || "Serviço incluído", 160),
    total: usesEach, utilizados: 0, restantes: usesEach, reservados: 0,
  }]));
}

async function adminCommand({ uid, action, data, requestId }) {
  const incoming = requireObject(data || {});
  return transactionalCommand({ operation: `admin.${action}`, actorUid: uid, requestId, execute: async (tx) => {
    await requireAdmin(tx, uid);

    if (action === "estudio.identidade.salvar") {
      const identity = normalizeStudioIdentityData(incoming);
      const resolvedTenantId = TENANT_ID;
      await requireTenantAdmin(tx, uid, resolvedTenantId);
      tx.set(tenantConfigRef(resolvedTenantId, STUDIO_IDENTITY_ID), {
        ...identity,
        updatedAt: nowTimestampField(),
        updatedBy: uid,
      }, { merge: true });
      return { tenantId: resolvedTenantId, configId: STUDIO_IDENTITY_ID };
    }

    if (action === "funcionamento.salvar") {
      onlyFields(incoming, new Set(["intervalo_minutos", "periodos_semana", "dias_fechados_semana"]));
      const weekly = requireObject(incoming.dias_fechados_semana);
      const days = Object.fromEntries(Array.from({ length: 7 }, (_, day) => [day, Boolean(weekly[day]) ]));
      if (Number(incoming.intervalo_minutos) !== 30) error("invalid-argument", "INTERVALO_INVALIDO");
      const periods = validatePeriodsMap(incoming.periodos_semana);
      mirrorSet(tx, "configuracoes", "funcionamento", { intervalo_minutos: 30, periodos_semana: periods, dias_fechados_semana: days, atualizado_em: nowTimestampField(), atualizado_por: uid }, { merge: true });
      return { updated: "funcionamento" };
    }

    if (action === "abertura.salvar") {
      onlyFields(incoming, new Set(["data", "inicio", "fim", "motivo"]));
      const date = cleanDate(incoming.data); const inicio = cleanTime(incoming.inicio); const fim = cleanTime(incoming.fim);
      if (minutes(inicio) >= minutes(fim) || minutes(inicio) % 30 || minutes(fim) % 30) error("invalid-argument", "ABERTURA_INVALIDA");
      mirrorSet(tx, "fechamentos_globais", `abertura_${date}`, { data: date, tipo: "abertura", inicio_horario: inicio, fim_horario: fim, motivo: cleanText(incoming.motivo || "Abertura excepcional", 240), ativo: true, criado_em: nowTimestampField(), criado_por: uid }, { merge: true });
      return { openingId: `abertura_${date}` };
    }

    if (action === "abertura.remover") {
      onlyFields(incoming, new Set(["data"]));
      const id = `abertura_${cleanDate(incoming.data)}`;
      mirrorDelete(tx, "fechamentos_globais", id);
      return { openingId: id, removed: true };
    }

    if (action === "fechamento.salvar") {
      onlyFields(incoming, new Set(["datas", "inicio", "fim", "motivo", "fechamento_id"]));
      const dates = Array.isArray(incoming.datas) ? [...new Set(incoming.datas.map(cleanDate))] : [];
      if (!dates.length || dates.length > 366) error("invalid-argument", "Fechamento inválido.");
      const closureId = cleanText(incoming.fechamento_id, 200);
      if (!closureId) error("invalid-argument", "Fechamento inválido.");
      const start = cleanDate(incoming.inicio); const end = cleanDate(incoming.fim);
      if (end < start) error("invalid-argument", "Período inválido.");
      for (const date of dates) mirrorSet(tx, "fechamentos_globais", date, {
        data: date, inicio: start, fim: end, motivo: cleanText(incoming.motivo, 240), tipo: start === end ? "dia" : "periodo",
        fechamento_id: closureId, ativo: true, criado_em: nowTimestampField(), criado_por: uid,
      });
      return { closureId, documents: dates.length };
    }

    if (action === "fechamento.remover") {
      onlyFields(incoming, new Set(["ids"]));
      const ids = Array.isArray(incoming.ids) ? [...new Set(incoming.ids.map((id) => cleanText(id, 100)))] : [];
      if (!ids.length || ids.length > 366) error("invalid-argument", "Fechamento inválido.");
      const snapshots = await Promise.all(ids.map((id) => tx.get(legacyRef("fechamentos_globais", id))));
      snapshots.forEach((snap, index) => { if (snap.exists) mirrorDelete(tx, "fechamentos_globais", ids[index]); });
      return { removed: snapshots.filter((snap) => snap.exists).length };
    }

    if (action === "barbeiro.salvar") {
      onlyFields(incoming, new Set(["id", "nome", "foto", "especialidade", "descricao", "uid_usuario", "email_acesso", "ativo", "uid_vinculo_original"]));
      const id = cleanText(incoming.id || "", 200) || db.collection("barbeiros").doc().id;
      const data = {
        nome: cleanText(incoming.nome, 120), foto: cleanText(incoming.foto || "", 900000), especialidade: cleanText(incoming.especialidade || "", 240),
        descricao: cleanText(incoming.descricao || "", 1200), uid_usuario: cleanText(incoming.uid_usuario || "", 200),
        email_acesso: cleanText(incoming.email_acesso || "", 320).toLowerCase(), ativo: Boolean(incoming.ativo),
      };
      if (!data.nome) error("invalid-argument", "Nome obrigatório.");
      if (data.email_acesso && !/^\S+@\S+\.\S+$/.test(data.email_acesso)) error("invalid-argument", "E-mail inválido.");
      const originalUid = cleanText(incoming.uid_vinculo_original || "", 200);
      const existing = await tx.get(legacyRef("barbeiros", id));
      const oldEmail = existing.exists ? normalizeAccessEmail(existing.get("email_acesso") || "") : "";
      const emailIndexRef = data.email_acesso ? db.doc(emailAccessIndexPath(data.email_acesso)) : null;
      const oldEmailIndexRef = oldEmail && oldEmail !== data.email_acesso ? db.doc(emailAccessIndexPath(oldEmail)) : null;
      const [emailMatches, emailIndex, oldEmailIndex] = await Promise.all([
        data.email_acesso ? tx.get(db.collection("barbeiros").where("email_acesso", "==", data.email_acesso)) : Promise.resolve(null),
        emailIndexRef ? tx.get(emailIndexRef) : Promise.resolve(null),
        oldEmailIndexRef ? tx.get(oldEmailIndexRef) : Promise.resolve(null),
      ]);
      if (emailMatches?.docs.some((doc) => doc.id !== id)) error("already-exists", "EMAIL_JA_VINCULADO");
      if (emailIndex?.exists && emailIndex.get("barbeiro_id") !== id) error("already-exists", "EMAIL_JA_VINCULADO");
      if (oldEmailIndex?.exists && oldEmailIndex.get("barbeiro_id") !== id) error("failed-precondition", "INDICE_EMAIL_INCONSISTENTE");
      if (data.uid_usuario) {
        const link = await tx.get(legacyRef("vinculos_barbeiro", data.uid_usuario));
        if (link.exists && link.get("barbeiro_id") !== id) error("already-exists", "UID_JA_VINCULADO");
      }
      const memberRef = data.uid_usuario ? db.doc(`barbearias/${TENANT_ID}/membros/${data.uid_usuario}`) : null;
      const originalMemberRef = originalUid && originalUid !== data.uid_usuario
        ? db.doc(`barbearias/${TENANT_ID}/membros/${originalUid}`)
        : null;
      const [memberSnapshot, originalMember] = await Promise.all([
        memberRef ? tx.get(memberRef) : Promise.resolve(null),
        originalMemberRef ? tx.get(originalMemberRef) : Promise.resolve(null),
      ]);
      if (emailIndexRef && !emailIndex?.exists) {
        tx.create(emailIndexRef, { email_acesso: data.email_acesso, barbeiro_id: id, tenant_id: TENANT_ID, criado_em: nowTimestampField() });
      }
      if (oldEmailIndexRef && oldEmailIndex?.exists) tx.delete(oldEmailIndexRef);
      mirrorSet(tx, "barbeiros", id, { ...data, ...(existing.exists ? {} : { criado_em: nowTimestampField() }) }, { merge: existing.exists });
      if (data.uid_usuario) {
        tx.set(legacyRef("vinculos_barbeiro", data.uid_usuario), { barbeiro_id: id, atualizado_em: nowTimestampField() });
        tx.set(memberRef, { uid: data.uid_usuario, papeis: rolesWith(memberSnapshot, "BARBEIRO"), barbeiro_id: id, ativo: data.ativo, atualizado_em: nowTimestampField() }, { merge: true });
      }
      if (originalUid && originalUid !== data.uid_usuario) {
        tx.delete(legacyRef("vinculos_barbeiro", originalUid));
        tx.set(originalMemberRef, { barbeiro_id: "", papeis: rolesWithout(originalMember, "BARBEIRO"), atualizado_em: nowTimestampField() }, { merge: true });
      }
      return { barberId: id, created: !existing.exists };
    }

    if (action === "barbeiro.ativar") {
      onlyFields(incoming, new Set(["id", "ativo"])); const id = cleanText(incoming.id, 200);
      const barber = await tx.get(legacyRef("barbeiros", id)); if (!barber.exists) error("not-found", "BARBEIRO_INDISPONIVEL");
      mirrorUpdate(tx, "barbeiros", id, { ativo: Boolean(incoming.ativo) });
      const linkedUid = cleanText(barber.get("uid_usuario") || "", 200);
      if (linkedUid) tx.set(db.doc(`barbearias/${TENANT_ID}/membros/${linkedUid}`), { ativo: Boolean(incoming.ativo), atualizado_em: nowTimestampField() }, { merge: true });
      return { barberId: id };
    }

    if (action === "barbeiro.remover") {
      onlyFields(incoming, new Set(["id"])); const id = cleanText(incoming.id, 200);
      const barber = await tx.get(legacyRef("barbeiros", id)); if (!barber.exists) return { barberId: id, removed: false };
      const linkedUid = cleanText(barber.get("uid_usuario") || "", 200);
      const email = normalizeAccessEmail(barber.get("email_acesso") || "");
      const emailIndexRef = email ? db.doc(emailAccessIndexPath(email)) : null;
      const emailIndex = emailIndexRef ? await tx.get(emailIndexRef) : null;
      if (emailIndex?.exists && emailIndex.get("barbeiro_id") !== id) error("failed-precondition", "INDICE_EMAIL_INCONSISTENTE");
      const memberRef = linkedUid ? db.doc(`barbearias/${TENANT_ID}/membros/${linkedUid}`) : null;
      const member = memberRef ? await tx.get(memberRef) : null;
      if (emailIndex?.exists) tx.delete(emailIndexRef);
      mirrorDelete(tx, "barbeiros", id);
      if (linkedUid) {
        tx.delete(legacyRef("vinculos_barbeiro", linkedUid));
        tx.set(memberRef, { barbeiro_id: "", papeis: rolesWithout(member, "BARBEIRO"), ativo: false, atualizado_em: nowTimestampField() }, { merge: true });
      }
      return { barberId: id, removed: true };
    }

    if (action === "servico.salvar") {
      onlyFields(incoming, new Set(["id", "nome", "descricao", "duracao", "preco", "ativo"]));
      const id = cleanText(incoming.id || "", 200) || db.collection("servicos").doc().id;
      const service = { nome: cleanText(incoming.nome, 160), descricao: cleanText(incoming.descricao || "", 1000), duracao: Number(incoming.duracao), preco: cleanText(incoming.preco, 80), ativo: incoming.ativo !== false };
      if (!service.nome || !Number.isInteger(service.duracao) || service.duracao < 30 || service.duracao % 30 || !service.preco) error("invalid-argument", "Serviço inválido.");
      const existing = await tx.get(legacyRef("servicos", id)); mirrorSet(tx, "servicos", id, { ...service, ...(existing.exists ? {} : { criado_em: nowTimestampField() }) }, { merge: existing.exists });
      return { serviceId: id, created: !existing.exists };
    }

    if (action === "servico.remover") {
      onlyFields(incoming, new Set(["id"])); const id = cleanText(incoming.id, 200); mirrorDelete(tx, "servicos", id); return { serviceId: id };
    }

    if (action === "plano.salvar") {
      onlyFields(incoming, new Set(["id", "nome", "descricao", "preco_centavos", "preco_definido", "usos_mensais", "servicos_ids", "ativo"]));
      const id = cleanText(incoming.id || "", 200) || db.collection("planos_assinatura").doc().id;
      const serviceIds = Array.isArray(incoming.servicos_ids) ? [...new Set(incoming.servicos_ids.map((item) => cleanText(item, 200)))] : [];
      const price = Number(incoming.preco_centavos); const uses = Number(incoming.usos_mensais);
      if (!cleanText(incoming.nome, 160) || !cleanText(incoming.descricao, 1000) || !Number.isInteger(price) || price < 0 || !Number.isInteger(uses) || uses < 1 || !serviceIds.length || uses % serviceIds.length) error("invalid-argument", "Plano inválido.");
      const serviceSnaps = await Promise.all(serviceIds.map((serviceId) => tx.get(legacyRef("servicos", serviceId))));
      if (serviceSnaps.some((snap) => !snap.exists)) error("failed-precondition", "SERVICO_INDISPONIVEL");
      const existing = await tx.get(legacyRef("planos_assinatura", id));
      const plan = { nome: cleanText(incoming.nome, 160), descricao: cleanText(incoming.descricao, 1000), preco_centavos: price, preco_definido: incoming.preco_definido !== false, usos_mensais: uses, servicos_ids: serviceIds, servicos_incluidos: serviceSnaps.map((snap) => cleanText(snap.get("nome"), 160)), ativo: Boolean(incoming.ativo), atualizado_em: nowTimestampField(), atualizado_por: uid, ...(existing.exists ? {} : { criado_em: nowTimestampField(), criado_por: uid }) };
      mirrorSet(tx, "planos_assinatura", id, plan, { merge: existing.exists }); return { planId: id, created: !existing.exists };
    }

    if (action === "plano.inicial") {
      onlyFields(incoming, new Set(["id", "nome", "descricao", "usos_mensais", "servicos_incluidos"]));
      const id = cleanText(incoming.id, 120);
      if (!new Set(["essencial", "prime", "premium"]).has(id)) error("invalid-argument", "Plano inicial inválido.");
      const existing = await tx.get(legacyRef("planos_assinatura", id));
      if (existing.exists) return { planId: id, created: false };
      const plan = { nome: cleanText(incoming.nome, 160), descricao: cleanText(incoming.descricao, 1000), usos_mensais: Number(incoming.usos_mensais), servicos_incluidos: Array.isArray(incoming.servicos_incluidos) ? incoming.servicos_incluidos.map((item) => cleanText(item, 160)) : [], servicos_ids: [], preco_centavos: 0, preco_definido: false, ativo: false, criado_em: nowTimestampField(), atualizado_em: nowTimestampField(), criado_por: uid, atualizado_por: uid };
      if (!plan.nome || !Number.isInteger(plan.usos_mensais) || plan.usos_mensais < 1) error("invalid-argument", "Plano inicial inválido.");
      mirrorSet(tx, "planos_assinatura", id, plan); return { planId: id, created: true };
    }

    if (action === "plano.ativar") {
      onlyFields(incoming, new Set(["id", "ativo"])); const id = cleanText(incoming.id, 200); const plan = await tx.get(legacyRef("planos_assinatura", id)); if (!plan.exists) error("not-found", "PLANO_INDISPONIVEL");
      if (incoming.ativo === true && (!Number.isInteger(plan.get("preco_centavos")) || plan.get("preco_centavos") <= 0 || !Array.isArray(plan.get("servicos_ids")) || !plan.get("servicos_ids").length)) error("failed-precondition", "PLANO_INDISPONIVEL");
      mirrorUpdate(tx, "planos_assinatura", id, { ativo: Boolean(incoming.ativo), atualizado_em: nowTimestampField(), atualizado_por: uid }); return { planId: id };
    }

    if (action === "assinatura.aprovar" || action === "assinatura.recusar") {
      onlyFields(incoming, new Set(["id"])); const id = cleanText(incoming.id, 300); const subscription = await tx.get(legacyRef("solicitacoes_assinatura", id));
      if (!subscription.exists || subscription.get("status") !== "PENDENTE") error("failed-precondition", "SOLICITACAO_INDISPONIVEL");
      if (action === "assinatura.recusar") { mirrorUpdate(tx, "solicitacoes_assinatura", id, { status: "RECUSADA", recusado_em: nowTimestampField(), recusado_por: uid }); return { subscriptionId: id, status: "RECUSADA" }; }
      const plan = await tx.get(legacyRef("planos_assinatura", cleanText(subscription.get("plano_id"), 200))); if (!plan.exists) error("failed-precondition", "PLANO_SEM_CREDITOS");
      const services = new Map(); for (const serviceId of plan.get("servicos_ids") || []) { const service = await tx.get(legacyRef("servicos", serviceId)); if (!service.exists) error("failed-precondition", "PLANO_SEM_CREDITOS"); services.set(serviceId, service.data()); }
      const planData = plan.data(); const credits = subscriptionCredits(planData, services);
      mirrorUpdate(tx, "solicitacoes_assinatura", id, { status: "ATIVA", ativado_em: nowTimestampField(), vencimento_em: dueDateOneMonth(), ativado_por: uid, servicos_ids: planData.servicos_ids, creditos_mensais: credits });
      return { subscriptionId: id, status: "ATIVA" };
    }

    if (action === "assinatura.renovar") {
      onlyFields(incoming, new Set(["id"]));
      const id = cleanText(incoming.id, 300);
      const subscription = await tx.get(legacyRef("solicitacoes_assinatura", id));
      if (!subscription.exists || !["ATIVA", "EXPIRADA"].includes(subscription.get("status"))) error("failed-precondition", "ASSINATURA_INDISPONIVEL");
      const plan = await tx.get(legacyRef("planos_assinatura", cleanText(subscription.get("plano_id"), 200)));
      if (!plan.exists) error("failed-precondition", "PLANO_SEM_CREDITOS");
      const services = new Map();
      for (const serviceId of plan.get("servicos_ids") || []) {
        const service = await tx.get(legacyRef("servicos", serviceId));
        if (!service.exists) error("failed-precondition", "PLANO_SEM_CREDITOS");
        services.set(serviceId, service.data());
      }
      mirrorUpdate(tx, "solicitacoes_assinatura", id, {
        status: "ATIVA", ativado_em: nowTimestampField(), vencimento_em: dueDateOneMonth(), renovado_em: nowTimestampField(), renovado_por: uid,
        servicos_ids: plan.get("servicos_ids"), creditos_mensais: subscriptionCredits(plan.data(), services),
      });
      return { subscriptionId: id, status: "ATIVA" };
    }

    if (action === "assinatura.cancelar") {
      onlyFields(incoming, new Set(["id", "motivo"]));
      const id = cleanText(incoming.id, 300);
      const subscription = await tx.get(legacyRef("solicitacoes_assinatura", id));
      if (!subscription.exists || !["PENDENTE", "ATIVA"].includes(subscription.get("status"))) error("failed-precondition", "ASSINATURA_INDISPONIVEL");
      mirrorUpdate(tx, "solicitacoes_assinatura", id, { status: "CANCELADA", cancelada_em: nowTimestampField(), cancelada_por: uid, motivo_cancelamento: cleanText(incoming.motivo || "Administrativo", 240) });
      return { subscriptionId: id, status: "CANCELADA" };
    }

    if (action === "assinatura.expirar") {
      onlyFields(incoming, new Set(["id"]));
      const id = cleanText(incoming.id, 300);
      const subscription = await tx.get(legacyRef("solicitacoes_assinatura", id));
      if (!subscription.exists || subscription.get("status") !== "ATIVA") error("failed-precondition", "ASSINATURA_INDISPONIVEL");
      const dueAt = subscription.get("vencimento_em")?.toDate?.();
      const exhausted = creditsExhausted(subscription.get("creditos_mensais"));
      if (!exhausted && (!dueAt || dueAt > new Date())) error("failed-precondition", "ASSINATURA_AINDA_ATIVA");
      mirrorUpdate(tx, "solicitacoes_assinatura", id, { status: "EXPIRADA", expirada_em: nowTimestampField(), motivo_expiracao: exhausted ? "CREDITOS_ESGOTADOS" : "VENCIMENTO" });
      return { subscriptionId: id, status: "EXPIRADA" };
    }

    error("invalid-argument", "Comando administrativo não suportado.");
  }});
}

async function dispatch(request) {
  const projectId = ensureProject();
  const authUid = requireAuth(request);
  const payload = requireObject(request.data);
  const command = String(payload.command || "");
  const requestId = requestIdFrom(payload);
  if (command === "barbeiro.vincular-primeiro-acesso") {
    return linkSamuelFirstAccess({ authUid, email: request.auth.token.email, emailVerified: request.auth.token.email_verified === true, requestId, projectId });
  }
  const allowClientBootstrap = projectId === "teste-483f6" && command === "cliente.garantir-perfil";
  const uid = await resolveOperationalUid(authUid, projectId, allowClientBootstrap);
  switch (command) {
    case "cliente.garantir-perfil":
      return ensureClientProfile({ uid, email: request.auth.token.email, displayName: request.auth.token.name, extras: payload.extras, requestId, bootstrapHml: allowClientBootstrap && projectId === "teste-483f6" });
    case "cliente.atualizar-perfil":
      return updateClientProfile({ uid, data: payload.data, requestId });
    case "assinatura.solicitar":
      return requestSubscription({ uid, planId: payload.planId, requestId });
    case "agenda.criar": {
      const data = extractCommandData(payload);
      return createAppointment({ uid, authUid, data, requestId });
    }
    case "agenda.reagendar": {
      const { appointmentId, data } = extractRebookCommand(payload);
      return rebookAppointment({ uid, appointmentId, data, requestId });
    }
    case "agenda.cliente_chegou":
    case "agenda.em_atendimento":
    case "agenda.concluir":
    case "agenda.cancelar":
    case "agenda.nao_compareceu": {
      const data = extractCommandData(payload);
      return transitionAppointment({ uid, appointmentId: requireAppointmentId(data), action: command.replace("agenda.", ""), requestId });
    }
    case "bloqueio.criar":
      return createBlock({ uid, data: payload.data, requestId });
    case "bloqueio.remover":
      return deleteBlock({ uid, blockId: payload.blockId, requestId });
    case "admin.funcionamento.salvar":
    case "admin.abertura.salvar":
    case "admin.abertura.remover":
    case "admin.fechamento.salvar":
    case "admin.fechamento.remover":
    case "admin.barbeiro.salvar":
    case "admin.barbeiro.ativar":
    case "admin.barbeiro.remover":
    case "admin.servico.salvar":
    case "admin.servico.remover":
    case "admin.plano.salvar":
    case "admin.plano.inicial":
    case "admin.plano.ativar":
    case "admin.assinatura.aprovar":
    case "admin.assinatura.recusar":
    case "admin.assinatura.renovar":
    case "admin.assinatura.cancelar":
    case "admin.assinatura.expirar":
    case "admin.estudio.identidade.salvar":
      return adminCommand({ uid, action: command.replace("admin.", ""), data: payload.data, requestId });
    default:
      error("invalid-argument", "Comando operacional não suportado.");
  }
}

export const executeOperationalCommand = onCall(
  { region: "southamerica-east1", serviceAccount: dualWriteRuntimeServiceAccount, enforceAppCheck: false },
  async (request) => {
    try {
      return await dispatch(request);
    } catch (cause) {
      if (cause instanceof HttpsError) throw cause;
      logger.error("Falha no comando operacional Dual Write.", {
        command: String(request.data?.command || ""),
        actor_fingerprint: request.auth?.uid ? sha256(request.auth.uid).slice(0, 16) : "anonymous",
        error: String(cause?.message || cause),
      });
      throw new HttpsError("internal", "Não foi possível concluir a operação.");
    }
  },
);
