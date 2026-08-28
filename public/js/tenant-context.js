import {
  TENANT_CONTEXT_SOURCES,
  TENANT_CONTEXT_STATES,
  createTenantContextManager,
  tenantContextIsReady,
  tenantScopedCacheKey,
} from "./tenant-context-core.mjs";
import {
  redirectToCanonicalTenantHostname,
  resolveTenantHostname,
} from "./tenant-hostname-resolver.js";

export {
  TENANT_CONTEXT_SOURCES,
  TENANT_CONTEXT_STATES,
  tenantContextIsReady,
  tenantScopedCacheKey,
};

let trustedHostnameResolver = null;
let redirectStarted = false;
let initializationPromise = null;
const manager = createTenantContextManager({
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
  if (trustedHostnameResolver) throw new Error("TENANT_HOSTNAME_RESOLVER_ALREADY_REGISTERED");
  trustedHostnameResolver = resolver;
}

registerTrustedTenantHostnameResolver(resolveTenantHostname);

export function initializeTenantContext() {
  const hostname = runtimeHostname();
  if (!initializationPromise) {
    initializationPromise = manager
      .initialize({ hostname, mode: runtimeMode(hostname) })
      .then((context) => {
        if (context.status === TENANT_CONTEXT_STATES.REDIRECT && !redirectStarted) {
          redirectStarted = true;
          redirectToCanonicalTenantHostname({ redirectToSlug: context.redirectToSlug });
        }
        return context;
      });
  }
  return initializationPromise;
}

export function getTenantContext() {
  return manager.get();
}

export function requireTenantContext() {
  return manager.requireReady();
}
