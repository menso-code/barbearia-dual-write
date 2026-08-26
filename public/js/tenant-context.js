import {
  TENANT_CONTEXT_SOURCES,
  TENANT_CONTEXT_STATES,
  createTenantContextManager,
  tenantContextIsReady,
  tenantScopedCacheKey,
} from "./tenant-context-core.mjs";
import { BARBEARIA_PADRAO_ID, BARBEARIA_PADRAO_SLUG } from "./tenant.js";

export {
  TENANT_CONTEXT_SOURCES,
  TENANT_CONTEXT_STATES,
  tenantContextIsReady,
  tenantScopedCacheKey,
};

// Compatibilidade temporária concentrada em um único módulo. Estes valores só
// são aceitos para desenvolvimento local e para os hosts Firebase legados
// explicitamente conhecidos; host desconhecido nunca cai no tenant Antunes.
export const LEGACY_COMPAT_TENANT_ID = BARBEARIA_PADRAO_ID;
export const LEGACY_COMPAT_TENANT_SLUG = BARBEARIA_PADRAO_SLUG;

const LOCAL_DEV_TENANT_FIXTURE = Object.freeze({
  tenantId: LEGACY_COMPAT_TENANT_ID,
  slug: LEGACY_COMPAT_TENANT_SLUG,
});

const LEGACY_FIREBASE_COMPAT = Object.freeze({
  tenantId: LEGACY_COMPAT_TENANT_ID,
  slug: LEGACY_COMPAT_TENANT_SLUG,
  hostnames: Object.freeze([
    "barber-a01e7.web.app",
    "barber-a01e7.firebaseapp.com",
  ]),
});

let trustedHostnameResolver = null;
const manager = createTenantContextManager({
  devFixture: LOCAL_DEV_TENANT_FIXTURE,
  legacyCompat: LEGACY_FIREBASE_COMPAT,
  resolveHostname: ({ hostname }) => trustedHostnameResolver
    ? trustedHostnameResolver({ hostname })
    : Promise.resolve({ kind: "NOT_FOUND" }),
});

function runtimeHostname() {
  return globalThis.location?.hostname || "";
}

function runtimeMode(hostname) {
  return ["localhost", "127.0.0.1"].includes(String(hostname).toLowerCase())
    ? "development"
    : "production";
}

// Ponto futuro para conectar uma resolução confiável baseada na fundação de
// hostname. Não recebe tenantId do navegador e só pode ser configurado antes
// do bootstrap iniciar.
export function registerTrustedTenantHostnameResolver(resolver) {
  if (manager.get().status !== TENANT_CONTEXT_STATES.IDLE) {
    throw new Error("TENANT_CONTEXT_ALREADY_INITIALIZED");
  }
  if (typeof resolver !== "function") throw new TypeError("INVALID_TENANT_HOSTNAME_RESOLVER");
  trustedHostnameResolver = resolver;
}

export function initializeTenantContext() {
  const hostname = runtimeHostname();
  return manager.initialize({ hostname, mode: runtimeMode(hostname) });
}

export function getTenantContext() {
  return manager.get();
}

export function requireTenantContext() {
  return manager.requireReady();
}
