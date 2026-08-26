import {
  TENANT_SLUG_STATUSES,
  TenantSlugError,
  normalizeTenantSlug,
  resolveTenantSlug,
} from "./tenant-slug.mjs";

export const GOESTUDIO_PUBLIC_BASE_DOMAINS = Object.freeze(["goestudio.com.br"]);
export const HOSTNAME_RESOLUTION_KINDS = Object.freeze({
  ACTIVE: "ACTIVE",
  REDIRECT: "REDIRECT",
  NOT_FOUND: "NOT_FOUND",
  UNAVAILABLE: "UNAVAILABLE",
});

export class HostnameResolutionError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "HostnameResolutionError";
    this.code = code;
  }
}

function fail(code, message = "Hostname inválido.") {
  throw new HostnameResolutionError(code, message);
}

function normalizeHostnameInput(value) {
  if (typeof value !== "string") fail("INVALID_HOSTNAME");
  let hostname = value.trim().toLowerCase();
  if (!hostname || /[\u0000-\u0020\u007f/@?#%\\]/.test(hostname)) fail("INVALID_HOSTNAME");

  const portMatch = hostname.match(/:(\d+)$/);
  if (portMatch) {
    const port = Number(portMatch[1]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail("INVALID_PORT");
    hostname = hostname.slice(0, -portMatch[0].length);
  }
  if (hostname.includes(":")) fail("INVALID_HOSTNAME");
  hostname = hostname.replace(/\.$/, "");
  if (!hostname || hostname.length > 253) fail("INVALID_HOSTNAME");
  return hostname;
}

export function parseGoEstudioTenantHostname(value) {
  const hostname = normalizeHostnameInput(value);
  const baseDomain = GOESTUDIO_PUBLIC_BASE_DOMAINS.find(
    (candidate) => hostname.endsWith(`.${candidate}`),
  );
  if (!baseDomain) fail("BASE_DOMAIN_NOT_ALLOWED");

  const subdomain = hostname.slice(0, -(baseDomain.length + 1));
  if (!subdomain) fail("ROOT_DOMAIN_NOT_TENANT");
  if (subdomain.includes(".")) fail("MULTI_LEVEL_SUBDOMAIN");

  let slug;
  try {
    slug = normalizeTenantSlug(subdomain);
  } catch (cause) {
    fail(cause?.code === "RESERVED_SLUG" ? "RESERVED_SUBDOMAIN" : "INVALID_SUBDOMAIN");
  }
  if (slug !== subdomain) fail("NON_CANONICAL_SUBDOMAIN");
  return { hostname, baseDomain, slug };
}

export function slugTenantCacheKey(slug) {
  return `slug:${normalizeTenantSlug(slug)}:tenant`;
}

export function tenantIdentityCacheKey(tenantId) {
  const normalizedTenantId = String(tenantId ?? "").trim();
  if (!normalizedTenantId || normalizedTenantId.includes("/")) fail("INVALID_TENANT_ID");
  return `tenant:${normalizedTenantId}:identity`;
}

function slugFailureResult(error, slug) {
  if (!(error instanceof TenantSlugError)) throw error;
  if (error.code === "SLUG_NOT_FOUND") {
    return { kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND, slug };
  }
  if ([
    "SLUG_RETIRED",
    "SLUG_NOT_ACTIVE",
    "TENANT_SLUG_MISMATCH",
    "SLUG_REDIRECT_LOOP",
    "SLUG_REDIRECT_INVALID",
  ].includes(error.code)) {
    return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, slug };
  }
  throw error;
}

export async function resolveGoEstudioHostname({ db, hostname }) {
  let parsed;
  try {
    parsed = parseGoEstudioTenantHostname(hostname);
  } catch (error) {
    if (error instanceof HostnameResolutionError) {
      return { kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND };
    }
    throw error;
  }

  const { slug } = parsed;
  let slugResolution;
  try {
    slugResolution = await resolveTenantSlug({ db, slug });
  } catch (error) {
    return slugFailureResult(error, slug);
  }

  if (slugResolution.status === TENANT_SLUG_STATUSES.REDIRECT) {
    return {
      kind: HOSTNAME_RESOLUTION_KINDS.REDIRECT,
      slug,
      redirectToSlug: slugResolution.redirectToSlug,
    };
  }

  const tenantId = slugResolution.tenantId;
  const tenantSnapshot = await db.doc(`barbearias/${tenantId}`).get();
  if (!tenantSnapshot.exists) return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, slug };
  const tenant = tenantSnapshot.data();
  if (tenant?.slug !== slug || tenant?.status !== TENANT_SLUG_STATUSES.ACTIVE) {
    return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, slug };
  }

  return { kind: HOSTNAME_RESOLUTION_KINDS.ACTIVE, slug, tenantId };
}
