export const TENANT_CONTEXT_STATES = Object.freeze({
  IDLE: "IDLE",
  RESOLVING: "RESOLVING",
  READY: "READY",
  NOT_FOUND: "NOT_FOUND",
  UNAVAILABLE: "UNAVAILABLE",
  ERROR: "ERROR",
});

export const TENANT_CONTEXT_SOURCES = Object.freeze({
  HOSTNAME: "HOSTNAME",
  DEV_FIXTURE: "DEV_FIXTURE",
  LEGACY_COMPAT: "LEGACY_COMPAT",
});

export class TenantContextError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TenantContextError";
    this.code = code;
  }
}

function frozenContext(status, values = {}) {
  return Object.freeze({
    status,
    tenantId: values.tenantId || "",
    slug: values.slug || "",
    source: values.source || "",
  });
}

// `window.location.hostname` já exclui porta. Esta função só canonicaliza a
// comparação exata de localhost/hosts legados; parsing de subdomínio e slug
// permanece exclusivamente na fundação de hostname injetada pelo adaptador.
function normalizeExactHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  return !hostname || /[\u0000-\u0020\u007f/:@?#%\\]/.test(hostname) ? "" : hostname;
}

function normalizeReadyCandidate(candidate, source) {
  const tenantId = String(candidate?.tenantId || "").trim();
  const slug = String(candidate?.slug || "").trim().toLowerCase();
  if (!tenantId || tenantId.includes("/") || !slug) {
    throw new TenantContextError("INVALID_TENANT_RESOLUTION", "Contexto de estabelecimento inválido.");
  }
  return frozenContext(TENANT_CONTEXT_STATES.READY, { tenantId, slug, source });
}

function localDevelopmentHostname(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

export function tenantScopedCacheKey(tenantId, suffix) {
  const normalizedTenantId = String(tenantId || "").trim();
  const normalizedSuffix = String(suffix || "").trim();
  if (!normalizedTenantId || normalizedTenantId.includes("/") || !normalizedSuffix) {
    throw new TenantContextError("INVALID_CACHE_KEY", "Chave de cache tenant-scoped inválida.");
  }
  return `tenant:${normalizedTenantId}:${normalizedSuffix}`;
}

export function tenantContextIsReady(context) {
  return context?.status === TENANT_CONTEXT_STATES.READY
    && Boolean(String(context.tenantId || "").trim());
}

export function createTenantContextManager({ resolveHostname, devFixture, legacyCompat } = {}) {
  let context = frozenContext(TENANT_CONTEXT_STATES.IDLE);
  let initializationPromise = null;
  let initializationKey = "";
  const legacyHosts = new Set(
    (legacyCompat?.hostnames || []).map(normalizeExactHostname).filter(Boolean),
  );

  async function resolveContext({ hostname: rawHostname = "", mode = "production" } = {}) {
    const hostname = normalizeExactHostname(rawHostname);
    if (!hostname) return frozenContext(TENANT_CONTEXT_STATES.NOT_FOUND);

    if (localDevelopmentHostname(hostname)) {
      if (mode !== "development" || !devFixture) {
        return frozenContext(TENANT_CONTEXT_STATES.NOT_FOUND);
      }
      return normalizeReadyCandidate(devFixture, TENANT_CONTEXT_SOURCES.DEV_FIXTURE);
    }

    if (legacyCompat && legacyHosts.has(hostname)) {
      return normalizeReadyCandidate(legacyCompat, TENANT_CONTEXT_SOURCES.LEGACY_COMPAT);
    }

    if (typeof resolveHostname !== "function") {
      return frozenContext(TENANT_CONTEXT_STATES.NOT_FOUND);
    }

    const resolution = await resolveHostname({ hostname });
    if (resolution?.kind === "ACTIVE") {
      return normalizeReadyCandidate(resolution, TENANT_CONTEXT_SOURCES.HOSTNAME);
    }
    if (resolution?.kind === "NOT_FOUND") {
      return frozenContext(TENANT_CONTEXT_STATES.NOT_FOUND);
    }
    if (["UNAVAILABLE", "REDIRECT"].includes(resolution?.kind)) {
      return frozenContext(TENANT_CONTEXT_STATES.UNAVAILABLE);
    }
    throw new TenantContextError("INVALID_HOSTNAME_RESOLUTION", "Resposta de resolução inválida.");
  }

  function initialize(options = {}) {
    const hostname = normalizeExactHostname(options.hostname);
    const mode = options.mode === "development" ? "development" : "production";
    const requestedKey = `${mode}:${hostname}`;

    if (initializationPromise) {
      if (requestedKey !== initializationKey) {
        return Promise.reject(new TenantContextError(
          "SECOND_TENANT_INITIALIZATION",
          "A sessão já iniciou outro estabelecimento.",
        ));
      }
      return initializationPromise;
    }

    initializationKey = requestedKey;
    context = frozenContext(TENANT_CONTEXT_STATES.RESOLVING);
    initializationPromise = (async () => {
      try {
        context = await resolveContext({ hostname, mode });
      } catch {
        context = frozenContext(TENANT_CONTEXT_STATES.ERROR);
      }
      return context;
    })();
    return initializationPromise;
  }

  function get() {
    return context;
  }

  function requireReady() {
    if (context.status !== TENANT_CONTEXT_STATES.READY) {
      throw new TenantContextError(
        `TENANT_CONTEXT_${context.status}`,
        "O estabelecimento ainda não está disponível.",
      );
    }
    return context;
  }

  return Object.freeze({ initialize, get, requireReady });
}
