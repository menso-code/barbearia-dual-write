import { createHash } from "node:crypto";
import {
  HOSTNAME_RESOLUTION_KINDS,
  resolveGoEstudioHostname,
} from "./hostname-resolution.mjs";
import {
  TENANT_SLUG_STATUSES,
  TenantSlugError,
  normalizeTenantSlug,
  resolveTenantSlug,
} from "./tenant-slug.mjs";

export const ANTUNES_TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
export const ANTUNES_TENANT_SLUG = "antunes";

export const OPERATIONAL_CONTEXT_MODES = Object.freeze({
  ANTUNES_DUAL_WRITE: "ANTUNES_DUAL_WRITE",
  V2_ONLY: "V2_ONLY",
  READ_ONLY: "READ_ONLY",
});

export const DYNAMIC_TENANT_COMMANDS = Object.freeze([
  "agenda.disponibilidade.obter",
  "bloqueio.criar",
  "bloqueio.remover",
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
  "admin.estudio.identidade.salvar",
  "admin.funcionamento.salvar",
  "admin.servico.salvar",
  "admin.servico.remover",
  "admin.barbeiro.ativar",
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.plano.ativar",
  "admin.plano.inicial",
  "admin.plano.salvar",
  "admin.assinatura.recusar",
  "admin.assinatura.cancelar",
  "admin.assinatura.expirar",
]);

const DYNAMIC_TENANT_COMMAND_SET = new Set(DYNAMIC_TENANT_COMMANDS);
const CLIENT_BOOTSTRAP_COMMAND = "cliente.garantir-perfil";
const ROLE_BY_COMMAND = new Map([
  ["agenda.disponibilidade.obter", "CLIENTE"],
  ["admin.estudio.identidade.salvar", "ADMIN"],
  ["admin.funcionamento.salvar", "ADMIN"],
  ["admin.servico.salvar", "ADMIN"],
  ["admin.servico.remover", "ADMIN"],
  ["admin.barbeiro.ativar", "ADMIN"],
  ["admin.abertura.salvar", "ADMIN"],
  ["admin.abertura.remover", "ADMIN"],
  ["admin.plano.ativar", "ADMIN"],
  ["admin.plano.inicial", "ADMIN"],
  ["admin.plano.salvar", "ADMIN"],
  ["admin.assinatura.recusar", "ADMIN"],
  ["admin.assinatura.cancelar", "ADMIN"],
  ["admin.assinatura.expirar", "ADMIN"],
]);
const ALWAYS_V2_ONLY_COMMANDS = new Set(["admin.estudio.identidade.salvar"]);
const HML_ANTUNES_COMPAT_COMMANDS = new Set([
  "bloqueio.criar",
  "bloqueio.remover",
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
  "admin.funcionamento.salvar",
  "admin.servico.salvar",
  "admin.servico.remover",
  "admin.barbeiro.ativar",
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.plano.ativar",
  "admin.plano.inicial",
  "admin.plano.salvar",
  "admin.assinatura.recusar",
  "admin.assinatura.cancelar",
  "admin.assinatura.expirar",
]);
const FORBIDDEN_CLIENT_KEYS = new Set([
  "tenantId", "tenant_id", "path", "documentPath", "collectionPath",
  "legacyMode", "tenantMode", "writeMode", "write_mode",
]);
const LEGACY_FIREBASE_HOSTS = new Map([
  ["barber-a01e7.web.app", "barber-a01e7"],
  ["barber-a01e7.firebaseapp.com", "barber-a01e7"],
  ["teste-483f6.web.app", "teste-483f6"],
  ["teste-483f6.firebaseapp.com", "teste-483f6"],
]);

export class OperationalContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "OperationalContextError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new OperationalContextError(code, message);
}

function snapshotData(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

function normalizeActorUid(value) {
  const uid = String(value ?? "").trim();
  if (!uid || uid.length > 200 || uid.includes("/")) {
    fail("MEMBERSHIP_REQUIRED", "Acesso não autorizado.");
  }
  return uid;
}

function normalizeHostname(value) {
  const hostname = String(value ?? "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 260 || /[\u0000-\u0020\u007f/@?#%\\]/.test(hostname)) {
    fail("INVALID_TENANT_LOCATOR", "Estabelecimento inválido.");
  }
  return hostname;
}

function walkClientValue(value, seen = new Set()) {
  if (!value || typeof value !== "object") return;
  if (seen.has(value)) fail("INVALID_ARGUMENT", "Dados inválidos.");
  seen.add(value);
  for (const [key, nested] of Object.entries(value)) {
    if (FORBIDDEN_CLIENT_KEYS.has(key)) {
      fail("FORBIDDEN_TENANT_OVERRIDE", "Campo de contexto não permitido.");
    }
    walkClientValue(nested, seen);
  }
  seen.delete(value);
}

export function validateOperationalEnvelope(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    fail("INVALID_ARGUMENT", "Dados inválidos.");
  }
  walkClientValue(payload);
  const context = payload.context;
  if (context !== undefined) {
    if (!context || typeof context !== "object" || Array.isArray(context)) {
      fail("INVALID_TENANT_LOCATOR", "Contexto do estabelecimento inválido.");
    }
    const keys = Object.keys(context);
    if (keys.some((key) => key !== "hostname" && key !== "slug") || keys.length !== 1) {
      fail("INVALID_TENANT_LOCATOR", "Contexto do estabelecimento inválido.");
    }
  }
  return payload;
}

function locatorFrom(payload, command) {
  const context = payload.context || {};
  const dataSlug = command === "agenda.disponibilidade.obter" ? payload.data?.slug : undefined;
  const supplied = [context.hostname, context.slug, dataSlug].filter((value) => value !== undefined && value !== null && String(value).trim());
  if (supplied.length > 1) fail("AMBIGUOUS_TENANT_LOCATOR", "Contexto do estabelecimento ambíguo.");
  if (context.hostname) return { type: "hostname", value: normalizeHostname(context.hostname) };
  if (context.slug || dataSlug) {
    try {
      return { type: "slug", value: normalizeTenantSlug(context.slug || dataSlug) };
    } catch {
      fail("INVALID_TENANT_LOCATOR", "Estabelecimento inválido.");
    }
  }
  return null;
}

async function resolveBySlug(db, slug) {
  let resolution;
  try {
    resolution = await resolveTenantSlug({ db, slug });
  } catch (cause) {
    if (cause instanceof TenantSlugError && cause.code === "SLUG_NOT_FOUND") {
      fail("TENANT_NOT_FOUND", "Estabelecimento não encontrado.");
    }
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }
  if (resolution?.status !== TENANT_SLUG_STATUSES.ACTIVE || !resolution.tenantId) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }
  return { tenantId: resolution.tenantId, slug, source: "SLUG" };
}

async function resolveByHostname(db, hostname, projectId) {
  const legacyProject = LEGACY_FIREBASE_HOSTS.get(hostname);
  if (legacyProject) {
    if (legacyProject !== projectId) fail("TENANT_NOT_FOUND", "Estabelecimento não encontrado.");
    return { tenantId: ANTUNES_TENANT_ID, slug: ANTUNES_TENANT_SLUG, source: "LEGACY_FIREBASE_HOST" };
  }
  const resolution = await resolveGoEstudioHostname({ db, hostname });
  if (resolution.kind === HOSTNAME_RESOLUTION_KINDS.NOT_FOUND) {
    fail("TENANT_NOT_FOUND", "Estabelecimento não encontrado.");
  }
  if (resolution.kind !== HOSTNAME_RESOLUTION_KINDS.ACTIVE || !resolution.tenantId || !resolution.slug) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }
  return { tenantId: resolution.tenantId, slug: resolution.slug, source: "HOSTNAME" };
}

function memberRoles(member) {
  return Array.isArray(member?.papeis)
    ? [...new Set(member.papeis.filter((role) => typeof role === "string"))].sort()
    : [];
}

function immutableContext({ projectId, command, tenantId, slug, source, authUid, roles, mode }) {
  const membershipPath = `barbearias/${tenantId}/membros/${authUid}`;
  return Object.freeze({
    schema: 1,
    projectId,
    command,
    mode,
    tenant: Object.freeze({ id: tenantId, slug, status: TENANT_SLUG_STATUSES.ACTIVE, source }),
    actor: Object.freeze({ uid: authUid, roles: Object.freeze([...roles]), membershipPath }),
  });
}

async function validateTenantAndMembership({ db, tenantId, slug, authUid, requiredRole }) {
  const tenantPath = `barbearias/${tenantId}`;
  const membershipPath = `${tenantPath}/membros/${authUid}`;
  const [tenantSnapshot, membershipSnapshot] = await Promise.all([
    db.doc(tenantPath).get(),
    db.doc(membershipPath).get(),
  ]);
  const tenant = snapshotData(tenantSnapshot);
  if (!tenant || tenant.status !== TENANT_SLUG_STATUSES.ACTIVE || tenant.slug !== slug) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }
  const member = snapshotData(membershipSnapshot);
  const roles = memberRoles(member);
  if (!member || member.ativo !== true || !roles.length || (requiredRole && !roles.includes(requiredRole))) {
    fail("MEMBERSHIP_REQUIRED", "Acesso não autorizado.");
  }
  return roles;
}

export async function resolveOperationalContext({ db, projectId, authUid: rawAuthUid, command, payload }) {
  if (!db?.doc) fail("INVALID_ADAPTER", "Serviço indisponível.");
  const authUid = normalizeActorUid(rawAuthUid);
  validateOperationalEnvelope(payload);
  const locator = locatorFrom(payload, command);
  const dynamicCommand = DYNAMIC_TENANT_COMMAND_SET.has(command);

  if (!locator) {
    const hmlAntunesCompat = projectId === "teste-483f6" && HML_ANTUNES_COMPAT_COMMANDS.has(command);
    if (dynamicCommand && !hmlAntunesCompat) fail("TENANT_CONTEXT_REQUIRED", "Contexto do estabelecimento obrigatório.");
    const hmlClientBootstrap = projectId === "teste-483f6" && command === CLIENT_BOOTSTRAP_COMMAND;
    const roles = hmlClientBootstrap
      ? []
      : await validateTenantAndMembership({
        db,
        tenantId: ANTUNES_TENANT_ID,
        slug: ANTUNES_TENANT_SLUG,
        authUid,
        requiredRole: hmlAntunesCompat ? ROLE_BY_COMMAND.get(command) : null,
      });
    return immutableContext({
      projectId,
      command,
      tenantId: ANTUNES_TENANT_ID,
      slug: ANTUNES_TENANT_SLUG,
      source: "LEGACY_COMMAND_COMPAT",
      authUid,
      roles,
      mode: OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE,
    });
  }

  const resolved = locator.type === "hostname"
    ? await resolveByHostname(db, locator.value, projectId)
    : await resolveBySlug(db, locator.value);
  const requiredRole = ROLE_BY_COMMAND.get(command) || null;
  const isAntunes = resolved.tenantId === ANTUNES_TENANT_ID;

  if (!dynamicCommand && !isAntunes) {
    await validateTenantAndMembership({ db, ...resolved, authUid, requiredRole: null });
    fail("COMMAND_NOT_AVAILABLE_FOR_TENANT", "Comando ainda não disponível para este estabelecimento.");
  }

  const antunesClientBootstrap = isAntunes && command === CLIENT_BOOTSTRAP_COMMAND;
  const roles = antunesClientBootstrap
    ? []
    : await validateTenantAndMembership({ db, ...resolved, authUid, requiredRole });
  const mode = command === "agenda.disponibilidade.obter"
    ? OPERATIONAL_CONTEXT_MODES.READ_ONLY
    : ALWAYS_V2_ONLY_COMMANDS.has(command) || (dynamicCommand && !isAntunes)
      ? OPERATIONAL_CONTEXT_MODES.V2_ONLY
      : OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE;
  return immutableContext({ projectId, command, ...resolved, authUid, roles, mode });
}

function contextTenantId(context) {
  const tenantId = String(context?.tenant?.id || "").trim();
  if (!tenantId || tenantId.includes("/")) fail("INVALID_CONTEXT", "Contexto operacional inválido.");
  return tenantId;
}

export function tenantOperationLogPath(context, requestId) {
  const normalizedRequestId = String(requestId || "");
  if (!/^[a-zA-Z0-9_-]{16,120}$/.test(normalizedRequestId)) {
    fail("INVALID_ARGUMENT", "Identificador da operação inválido.");
  }
  return `barbearias/${contextTenantId(context)}/audit_logs/operation-${normalizedRequestId}`;
}

export function tenantV2DocumentPath(context, collection, id) {
  const safeCollection = String(collection || "").trim();
  const safeId = String(id || "").trim();
  if (!safeCollection || safeCollection.includes("/") || !safeId || safeId.includes("/")) {
    fail("INVALID_CONTEXT", "Referência V2 inválida.");
  }
  return `barbearias/${contextTenantId(context)}/${safeCollection}/${safeId}`;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
  }
  return value;
}

export function operationalPayloadFingerprint(value) {
  return createHash("sha256").update(JSON.stringify(canonicalize(value))).digest("hex");
}

export function assertIdempotentReplay(previous, operation, requestFingerprint) {
  if (previous?.operation !== operation) {
    fail("REQUEST_ID_COLLISION", "Identificador de operação já utilizado.");
  }
  if (previous?.request_fingerprint && previous.request_fingerprint !== requestFingerprint) {
    fail("REQUEST_ID_COLLISION", "Identificador de operação já utilizado.");
  }
}
