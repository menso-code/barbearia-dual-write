import { functions } from "./firebase-config.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const command = httpsCallable(functions, "executeOperationalCommand");

function requestId() {
  return globalThis.crypto?.randomUUID?.().replace(/-/g, "")
    || `${Date.now()}${Math.random().toString(36).slice(2)}`;
}

/**
 * Executa um comando fechado no backend. O navegador nunca informa caminhos
 * Firestore nem dados de permissão; apenas o comando e os campos permitidos.
 */
export async function executarComandoOperacional(commandName, payload = {}) {
  const { requestId: suppliedRequestId, ...commandPayload } = payload;
  if (Object.hasOwn(commandPayload, "context")) {
    throw new TypeError("OPERATIONAL_CONTEXT_IS_RUNTIME_DERIVED");
  }
  const hostname = String(globalThis.location?.hostname || "").trim().toLowerCase();
  const result = await command({
    command: commandName,
    requestId: suppliedRequestId || requestId(),
    ...(hostname && commandName !== "agenda.disponibilidade.obter" ? { context: { hostname } } : {}),
    ...commandPayload,
  });
  return result.data;
}
