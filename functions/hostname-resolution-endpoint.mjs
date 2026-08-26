import { getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";
import { logger } from "firebase-functions";
import { defineString } from "firebase-functions/params";
import { HttpsError, onCall } from "firebase-functions/v2/https";
import { resolveGoEstudioHostname } from "./hostname-resolution.mjs";

const ALLOWED_PROJECTS = new Set(["barber-a01e7", "teste-483f6"]);
const ALLOWED_REQUEST_FIELDS = new Set(["hostname"]);
const hostnameResolverRuntimeServiceAccount = defineString("DUAL_READ_RUNTIME_SERVICE_ACCOUNT");

if (getApps().length === 0) initializeApp();
const db = getFirestore();

function requireRuntimeProject() {
  const projectId = process.env.GCLOUD_PROJECT || process.env.GCP_PROJECT || "";
  if (!ALLOWED_PROJECTS.has(projectId)) {
    throw new HttpsError("failed-precondition", "Projeto não autorizado.");
  }
}

function requireRequestData(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new HttpsError("invalid-argument", "Dados inválidos.");
  }
  const keys = Object.keys(value);
  if (keys.some((key) => !ALLOWED_REQUEST_FIELDS.has(key))) {
    throw new HttpsError("invalid-argument", "Campos não permitidos.");
  }
  if (typeof value.hostname !== "string" || !value.hostname.trim() || value.hostname.length > 260) {
    throw new HttpsError("invalid-argument", "Hostname inválido.");
  }
  return { hostname: value.hostname };
}

export async function resolveTenantHostnameRequest({ firestore, data }) {
  if (!firestore?.doc) throw new HttpsError("internal", "Resolver indisponível.");
  const { hostname } = requireRequestData(data);
  return resolveGoEstudioHostname({ db: firestore, hostname });
}

export const resolveTenantHostname = onCall(
  {
    region: "southamerica-east1",
    serviceAccount: hostnameResolverRuntimeServiceAccount,
    enforceAppCheck: false,
    maxInstances: 10,
  },
  async (request) => {
    try {
      requireRuntimeProject();
      return await resolveTenantHostnameRequest({ firestore: db, data: request.data });
    } catch (cause) {
      if (cause instanceof HttpsError) throw cause;
      logger.error("Falha no resolvedor público de estabelecimento.", {
        error_type: String(cause?.name || "Error"),
      });
      throw new HttpsError("internal", "Não foi possível resolver o estabelecimento.");
    }
  },
);
