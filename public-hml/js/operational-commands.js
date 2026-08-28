import { functions } from "./firebase-config.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import {
  initializeTenantContext,
  tenantContextIsReady,
} from "./tenant-context.js";

const command = httpsCallable(functions, "executeOperationalCommand");
const AVAILABILITY_COMMAND = "agenda.disponibilidade.obter";
const FORBIDDEN_CONTEXT_KEYS = new Set([
  "context",
  "hostname",
  "tenantId",
  "tenant_id",
  "path",
  "documentPath",
  "collectionPath",
  "legacyMode",
  "tenantMode",
  "writeMode",
  "write_mode",
]);

function requestId() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    || `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

function sanitizeCommandValue(value, commandName, path = [], seen = new Set()) {
  if (!value || typeof value !== "object") return value;
  if (seen.has(value)) throw new TypeError("INVALID_COMMAND_PAYLOAD");
  seen.add(value);

  if (Array.isArray(value)) {
    const result = value.map((item, index) => sanitizeCommandValue(item, commandName, [...path, index], seen));
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    if (key === "slug" && commandName === AVAILABILITY_COMMAND && path.length === 1 && path[0] === "data") {
      continue;
    }
    if (FORBIDDEN_CONTEXT_KEYS.has(key) || key === "slug") {
      throw new TypeError("OPERATIONAL_CONTEXT_IS_RUNTIME_DERIVED");
    }
    result[key] = sanitizeCommandValue(nested, commandName, [...path, key], seen);
  }
  seen.delete(value);
  return result;
}

async function resolvedHostname() {
  const tenantContext = await initializeTenantContext();
  if (!tenantContextIsReady(tenantContext)) {
    throw new TypeError("TENANT_CONTEXT_NOT_READY");
  }
  const hostname = String(globalThis.location?.hostname || "").trim().toLowerCase();
  if (!hostname) throw new TypeError("TENANT_CONTEXT_NOT_READY");
  return hostname;
}

/**
 * Executa um comando fechado no backend. O navegador nunca informa caminhos
 * Firestore nem dados de permissão; apenas o comando e os campos permitidos.
 */
export async function executarComandoOperacional(commandName, payload = {}) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new TypeError("INVALID_COMMAND_PAYLOAD");
  }
  const { requestId: suppliedRequestId, ...rawCommandPayload } = payload;
  const hostname = await resolvedHostname();
  const commandPayload = sanitizeCommandValue(rawCommandPayload, commandName);
  const result = await command({
    command: commandName,
    requestId: suppliedRequestId || requestId(),
    context: { hostname },
    ...commandPayload,
  });
  return result.data;
}
