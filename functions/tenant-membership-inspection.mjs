import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { HOSTNAME_RESOLUTION_KINDS, resolveGoEstudioHostname } from "./hostname-resolution.mjs";

const HML_PROJECT = "teste-483f6";
const ALLOWED_FIELDS = new Set(["context", "surface"]);
const ALLOWED_CONTEXT_FIELDS = new Set(["hostname"]);
const SURFACES = new Set(["CLIENTE", "BARBEIRO", "ADMIN"]);
// Reutiliza a conta de leitura já exigida pelo resolvedor de hostname; não
// introduz uma nova credencial nem amplia permissões de escrita.
const runtimeServiceAccount = defineString("DUAL_READ_RUNTIME_SERVICE_ACCOUNT");

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function unavailable() {
  throw new HttpsError("unavailable", "Não foi possível validar seu acesso neste estabelecimento.");
}

function requireRuntimeProject(projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "") {
  if (projectId !== HML_PROJECT) {
    throw new HttpsError("failed-precondition", "Projeto não autorizado.");
  }
}

function requireAuthUid(authUid) {
  const uid = String(authUid || "").trim();
  if (!uid || uid.length > 200 || uid.includes("/")) {
    throw new HttpsError("unauthenticated", "Autenticação obrigatória.");
  }
  return uid;
}

function normalizeHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || /[\u0000-\u0020\u007f/@?#%\\]/.test(hostname)) {
    throw new HttpsError("invalid-argument", "Hostname inválido.");
  }
  return hostname;
}

function hostnameFromOrigin(origin) {
  if (typeof origin !== "string" || !origin.trim()) {
    throw new HttpsError("permission-denied", "Origem não autorizada.");
  }
  try {
    const parsed = new URL(origin);
    if (parsed.protocol !== "https:" || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      throw new Error("invalid origin");
    }
    return normalizeHostname(parsed.hostname);
  } catch {
    throw new HttpsError("permission-denied", "Origem não autorizada.");
  }
}

function requireRequestData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Dados inválidos.");
  }
  if (Object.keys(value).some((key) => !ALLOWED_FIELDS.has(key))) {
    throw new HttpsError("invalid-argument", "Campos não permitidos.");
  }
  if (!value.context || typeof value.context !== "object" || Array.isArray(value.context)) {
    throw new HttpsError("invalid-argument", "Contexto inválido.");
  }
  if (Object.keys(value.context).some((key) => !ALLOWED_CONTEXT_FIELDS.has(key))) {
    throw new HttpsError("invalid-argument", "Contexto inválido.");
  }
  const hostname = normalizeHostname(value.context.hostname);
  const surface = String(value.surface || "").trim().toUpperCase();
  if (!SURFACES.has(surface)) {
    throw new HttpsError("invalid-argument", "Superfície inválida.");
  }
  return { hostname, surface };
}

function snapshotData(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

function validOperationalUid(value) {
  const uid = String(value || "").trim();
  return uid && uid.length <= 200 && !uid.includes("/") ? uid : "";
}

async function resolveOperationalIdentity({ firestore, projectId, authUid, tenantId }) {
  if (projectId !== HML_PROJECT) return { kind: "ACTIVE", operationalUid: authUid };
  const mapping = snapshotData(await firestore.doc(`homologacao_mapeamentos/${authUid}`).get());
  if (!mapping || mapping.ativo !== true || mapping.tenant_id !== tenantId) {
    return { kind: "NOT_MEMBER" };
  }
  const operationalUid = validOperationalUid(mapping.uid_producao_referencia);
  if (!operationalUid) throw new HttpsError("failed-precondition", "Mapeamento de homologação inválido.");
  return { kind: "ACTIVE", operationalUid };
}

export async function inspectTenantMembershipRequest({ firestore, data, authUid, projectId = HML_PROJECT, origin }) {
  if (!firestore?.doc) unavailable();
  requireRuntimeProject(projectId);
  const uid = requireAuthUid(authUid);
  const { hostname, surface } = requireRequestData(data);
  if (hostnameFromOrigin(origin) !== hostname) {
    throw new HttpsError("permission-denied", "Origem não autorizada.");
  }

  let resolved;
  try {
    resolved = await resolveGoEstudioHostname({ db: firestore, hostname });
  } catch {
    unavailable();
  }
  if (resolved.kind === HOSTNAME_RESOLUTION_KINDS.NOT_FOUND) {
    throw new HttpsError("not-found", "Estabelecimento não encontrado.");
  }
  if (resolved.kind !== HOSTNAME_RESOLUTION_KINDS.ACTIVE || !resolved.tenantId) unavailable();

  let identity;
  try {
    identity = await resolveOperationalIdentity({ firestore, projectId, authUid: uid, tenantId: resolved.tenantId });
  } catch (error) {
    if (error instanceof HttpsError) throw error;
    unavailable();
  }
  if (identity.kind === "NOT_MEMBER") return Object.freeze({ schema: 1, state: "NOT_MEMBER" });

  let member;
  try {
    member = snapshotData(await firestore.doc(`barbearias/${resolved.tenantId}/membros/${identity.operationalUid}`).get());
  } catch {
    unavailable();
  }
  if (!member) return Object.freeze({ schema: 1, state: "NOT_MEMBER" });
  if (member.ativo !== true) return Object.freeze({ schema: 1, state: "INACTIVE" });
  const roles = Array.isArray(member.papeis) ? member.papeis.filter((role) => typeof role === "string") : [];
  if (!roles.includes(surface)) return Object.freeze({ schema: 1, state: "ROLE_INSUFFICIENT" });
  return Object.freeze({ schema: 1, state: "ACTIVE" });
}

export const inspectTenantMembership = onCall(
  { region: "southamerica-east1", serviceAccount: runtimeServiceAccount, enforceAppCheck: false },
  async (request) => {
    try {
      return await inspectTenantMembershipRequest({
        firestore: db,
        data: request.data,
        authUid: request.auth?.uid,
        origin: request.rawRequest?.headers?.origin,
      });
    } catch (error) {
      if (error instanceof HttpsError) throw error;
      logger.error("Falha na inspeção de membership do tenant.", { error_type: String(error?.name || "Error") });
      unavailable();
    }
  },
);
