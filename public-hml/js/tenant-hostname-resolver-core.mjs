export const GOESTUDIO_PUBLIC_BASE_DOMAIN = "goestudio.com.br";

const RESOLUTION_KINDS = new Set(["ACTIVE", "REDIRECT", "NOT_FOUND", "UNAVAILABLE"]);
const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const FORBIDDEN_HOSTNAME_INPUT = /[\u0000-\u0020\u007f/:@?#%\\]/;

function validSlug(value) {
  const slug = String(value || "").trim().toLowerCase();
  return slug.length >= 3 && slug.length <= 48 && SLUG_FORMAT.test(slug) ? slug : "";
}

function validTenantId(value) {
  const tenantId = String(value || "").trim();
  return tenantId && tenantId.length <= 200 && !tenantId.includes("/") ? tenantId : "";
}

function normalizeHostname(value) {
  const hostname = String(value || "").trim().toLowerCase().replace(/\.$/, "");
  if (!hostname || hostname.length > 253 || FORBIDDEN_HOSTNAME_INPUT.test(hostname)) {
    throw new TypeError("INVALID_TENANT_HOSTNAME");
  }
  return hostname;
}

export function normalizeTenantHostnameResolution(value) {
  const kind = String(value?.kind || "").trim().toUpperCase();
  if (!RESOLUTION_KINDS.has(kind)) throw new TypeError("INVALID_TENANT_HOSTNAME_RESOLUTION");

  if (kind === "ACTIVE") {
    const tenantId = validTenantId(value.tenantId);
    const slug = validSlug(value.slug);
    if (!tenantId || !slug) throw new TypeError("INVALID_ACTIVE_TENANT_RESOLUTION");
    return Object.freeze({ kind, tenantId, slug });
  }

  if (kind === "REDIRECT") {
    const slug = validSlug(value.slug);
    const redirectToSlug = validSlug(value.redirectToSlug);
    if (!slug || !redirectToSlug || slug === redirectToSlug) {
      throw new TypeError("INVALID_TENANT_REDIRECT_RESOLUTION");
    }
    return Object.freeze({ kind, slug, redirectToSlug });
  }

  const slug = validSlug(value.slug);
  return Object.freeze({ kind, ...(slug ? { slug } : {}) });
}

export function createTrustedTenantHostnameResolver({ invoke }) {
  if (typeof invoke !== "function") throw new TypeError("INVALID_TENANT_RESOLVER_INVOKER");
  return async ({ hostname }) => {
    const response = await invoke({ hostname: normalizeHostname(hostname) });
    return normalizeTenantHostnameResolution(response);
  };
}

export function canonicalTenantRedirectUrl({ redirectToSlug, location }) {
  const slug = validSlug(redirectToSlug);
  if (!slug) throw new TypeError("INVALID_TENANT_REDIRECT_TARGET");
  const pathname = String(location?.pathname || "/");
  const search = String(location?.search || "");
  const hash = String(location?.hash || "");
  const safePathname = pathname.startsWith("/") && !pathname.startsWith("//") ? pathname : "/";
  const safeSearch = !search || search.startsWith("?") ? search : "";
  const safeHash = !hash || hash.startsWith("#") ? hash : "";
  return `https://${slug}.${GOESTUDIO_PUBLIC_BASE_DOMAIN}${safePathname}${safeSearch}${safeHash}`;
}

export function executeCanonicalTenantRedirect({ redirectToSlug, location }) {
  if (typeof location?.replace !== "function") throw new TypeError("TENANT_REDIRECT_UNAVAILABLE");
  const target = canonicalTenantRedirectUrl({ redirectToSlug, location });
  location.replace(target);
  return target;
}
