import { TENANT_SLUG_STATUSES, normalizeTenantSlug } from "./tenant-slug.mjs";

export const HOSTNAME_INDEX_COLLECTION = "tenant_hostnames";
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

export function hostnameIndexPath(value) {
  return `${HOSTNAME_INDEX_COLLECTION}/${normalizeHostnameInput(value)}`;
}

export function slugTenantCacheKey(slug) {
  return `slug:${normalizeTenantSlug(slug)}:tenant`;
}

export function tenantIdentityCacheKey(tenantId) {
  const normalizedTenantId = String(tenantId ?? "").trim();
  if (!normalizedTenantId || normalizedTenantId.includes("/")) fail("INVALID_TENANT_ID");
  return `tenant:${normalizedTenantId}:identity`;
}

export async function resolveGoEstudioHostname({ db, hostname }) {
  try {
    hostname = normalizeHostnameInput(hostname);
  } catch (error) {
    if (error instanceof HostnameResolutionError) {
      return { kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND };
    }
    throw error;
  }

  const hostnameSnapshot = await db.doc(hostnameIndexPath(hostname)).get();
  if (!hostnameSnapshot.exists) return { kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND };
  const hostnameIndex = hostnameSnapshot.data();
  const tenantId = String(hostnameIndex?.tenantId ?? "").trim();
  if (!tenantId || tenantId.includes("/")) return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, hostname };
  const tenantSnapshot = await db.doc(`barbearias/${tenantId}`).get();
  if (!tenantSnapshot.exists) return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, hostname };
  const tenant = tenantSnapshot.data();
  if (tenant?.status !== TENANT_SLUG_STATUSES.ACTIVE) {
    return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, hostname };
  }
  let slug;
  try { slug = normalizeTenantSlug(tenant.slug); } catch { return { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, hostname }; }

  return { kind: HOSTNAME_RESOLUTION_KINDS.ACTIVE, hostname, tenantId, slug };
}
