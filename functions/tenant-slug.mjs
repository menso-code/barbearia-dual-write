const SLUG_MIN_LENGTH = 3;
const SLUG_MAX_LENGTH = 48;
const SLUG_FORMAT = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
const SLUG_HAS_LETTER = /[a-z]/;
const FORBIDDEN_HOSTNAME_INPUT = /[\u0000-\u001f\u007f./\\:@?#%]/;

export const TENANT_SLUG_STATUSES = Object.freeze({
  PROVISIONING: "PROVISIONING",
  ACTIVE: "ACTIVE",
  REDIRECT: "REDIRECT",
  RETIRED: "RETIRED",
});

export const TENANT_SLUG_RESERVED_POLICY_VERSION = 1;
export const TENANT_SLUG_RESERVED = new Set([
  "account", "admin", "api", "app", "assets", "auth", "billing", "cadastro",
  "cdn", "checkout", "conta", "dashboard", "dev", "docs", "firebase", "goestudio",
  "help", "hml", "homologacao", "imap", "login", "mail", "media", "oauth", "painel",
  "pop", "security", "signup", "smtp", "staging", "static", "status", "suporte",
  "support", "test", "webhook", "webhooks", "www",
]);

export class TenantSlugError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TenantSlugError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new TenantSlugError(code, message);
}

function requireTenantId(value) {
  const tenantId = String(value ?? "").trim();
  if (!tenantId || tenantId.length > 200 || tenantId.includes("/")) {
    fail("INVALID_TENANT_ID", "Tenant inválido.");
  }
  return tenantId;
}

export function normalizeTenantSlug(value) {
  if (typeof value !== "string") fail("INVALID_SLUG", "Slug inválido.");
  const raw = value.trim();
  if (!raw || FORBIDDEN_HOSTNAME_INPUT.test(raw)) fail("INVALID_SLUG", "Slug inválido.");

  let normalized = raw
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9-]/g, "");

  if (normalized.startsWith("xn--")) fail("XN_PREFIX_FORBIDDEN", "Slug reservado.");
  normalized = normalized.replace(/-+/g, "-").replace(/^-+|-+$/g, "");
  if (normalized.length < SLUG_MIN_LENGTH) fail("SLUG_TOO_SHORT", "Slug muito curto.");
  if (normalized.length > SLUG_MAX_LENGTH) fail("SLUG_TOO_LONG", "Slug muito longo.");
  if (!SLUG_FORMAT.test(normalized) || !SLUG_HAS_LETTER.test(normalized)) {
    fail("INVALID_SLUG", "Slug inválido.");
  }
  if (TENANT_SLUG_RESERVED.has(normalized)) fail("RESERVED_SLUG", "Slug reservado.");
  return normalized;
}

export function tenantSlugIndexPath(slug) {
  return `tenant_slugs/${normalizeTenantSlug(slug)}`;
}

export function tenantRootPath(tenantId) {
  return `barbearias/${requireTenantId(tenantId)}`;
}

function nowValue(clock) {
  return typeof clock === "function" ? clock() : new Date();
}

function snapshotData(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

export async function reserveTenantSlug({ db, slug, tenantId, clock }) {
  if (!db?.runTransaction || !db?.doc) fail("INVALID_ADAPTER", "Adaptador inválido.");
  const normalizedSlug = normalizeTenantSlug(slug);
  const normalizedTenantId = requireTenantId(tenantId);

  return db.runTransaction(async (tx) => {
    const slugRef = db.doc(`tenant_slugs/${normalizedSlug}`);
    const tenantRef = db.doc(`barbearias/${normalizedTenantId}`);
    const [slugSnapshot, tenantSnapshot] = await Promise.all([tx.get(slugRef), tx.get(tenantRef)]);
    if (slugSnapshot.exists) fail("SLUG_UNAVAILABLE", "Slug indisponível.");
    if (!tenantSnapshot.exists) fail("TENANT_NOT_FOUND", "Tenant não encontrado.");

    const tenant = snapshotData(tenantSnapshot);
    if (tenant.slug && tenant.slug !== normalizedSlug) {
      fail("TENANT_SLUG_CONFLICT", "Tenant já possui outro slug.");
    }

    const timestamp = nowValue(clock);
    tx.create(slugRef, {
      tenantId: normalizedTenantId,
      status: TENANT_SLUG_STATUSES.PROVISIONING,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    tx.set(tenantRef, { slug: normalizedSlug, slugUpdatedAt: timestamp }, { merge: true });
    return { slug: normalizedSlug, tenantId: normalizedTenantId, status: TENANT_SLUG_STATUSES.PROVISIONING };
  });
}

export async function activateTenantSlug({ db, slug, tenantId, clock }) {
  const normalizedSlug = normalizeTenantSlug(slug);
  const normalizedTenantId = requireTenantId(tenantId);
  return db.runTransaction(async (tx) => {
    const slugRef = db.doc(`tenant_slugs/${normalizedSlug}`);
    const tenantRef = db.doc(`barbearias/${normalizedTenantId}`);
    const [slugSnapshot, tenantSnapshot] = await Promise.all([tx.get(slugRef), tx.get(tenantRef)]);
    const index = snapshotData(slugSnapshot);
    const tenant = snapshotData(tenantSnapshot);
    if (!index || index.tenantId !== normalizedTenantId || index.status !== TENANT_SLUG_STATUSES.PROVISIONING) {
      fail("SLUG_LINK_MISMATCH", "Vínculo de slug inconsistente.");
    }
    if (!tenant || tenant.slug !== normalizedSlug) fail("TENANT_SLUG_MISMATCH", "Slug canônico inconsistente.");
    tx.update(slugRef, { status: TENANT_SLUG_STATUSES.ACTIVE, updatedAt: nowValue(clock) });
    return { slug: normalizedSlug, tenantId: normalizedTenantId, status: TENANT_SLUG_STATUSES.ACTIVE };
  });
}

export async function resolveTenantSlug({ db, slug }) {
  if (!db?.doc) fail("INVALID_ADAPTER", "Adaptador inválido.");
  const normalizedSlug = normalizeTenantSlug(slug);
  const slugSnapshot = await db.doc(`tenant_slugs/${normalizedSlug}`).get();
  const index = snapshotData(slugSnapshot);
  if (!index) fail("SLUG_NOT_FOUND", "Slug não encontrado.");

  if (index.status === TENANT_SLUG_STATUSES.REDIRECT) {
    const redirectToSlug = normalizeTenantSlug(index.redirectToSlug);
    if (redirectToSlug === normalizedSlug) fail("SLUG_REDIRECT_LOOP", "Redirecionamento de slug inválido.");
    const redirectSnapshot = await db.doc(`tenant_slugs/${redirectToSlug}`).get();
    const redirectIndex = snapshotData(redirectSnapshot);
    if (
      !redirectIndex
      || redirectIndex.status !== TENANT_SLUG_STATUSES.ACTIVE
      || redirectIndex.tenantId !== index.tenantId
    ) {
      fail("SLUG_REDIRECT_INVALID", "Redirecionamento de slug inválido.");
    }
    return { status: TENANT_SLUG_STATUSES.REDIRECT, redirectToSlug };
  }
  if (index.status === TENANT_SLUG_STATUSES.RETIRED) fail("SLUG_RETIRED", "Slug indisponível.");
  if (index.status !== TENANT_SLUG_STATUSES.ACTIVE) fail("SLUG_NOT_ACTIVE", "Slug indisponível.");

  const tenantId = requireTenantId(index.tenantId);
  const tenantSnapshot = await db.doc(`barbearias/${tenantId}`).get();
  const tenant = snapshotData(tenantSnapshot);
  if (!tenant || tenant.slug !== normalizedSlug) fail("TENANT_SLUG_MISMATCH", "Slug canônico inconsistente.");
  return { tenantId, status: TENANT_SLUG_STATUSES.ACTIVE };
}

export async function transitionTenantSlug({ db, tenantId, oldSlug, newSlug, clock }) {
  const normalizedTenantId = requireTenantId(tenantId);
  const normalizedOldSlug = normalizeTenantSlug(oldSlug);
  const normalizedNewSlug = normalizeTenantSlug(newSlug);
  if (normalizedOldSlug === normalizedNewSlug) fail("SLUG_UNCHANGED", "Slug não alterado.");

  return db.runTransaction(async (tx) => {
    const oldRef = db.doc(`tenant_slugs/${normalizedOldSlug}`);
    const newRef = db.doc(`tenant_slugs/${normalizedNewSlug}`);
    const tenantRef = db.doc(`barbearias/${normalizedTenantId}`);
    const [oldSnapshot, newSnapshot, tenantSnapshot] = await Promise.all([
      tx.get(oldRef), tx.get(newRef), tx.get(tenantRef),
    ]);
    const oldIndex = snapshotData(oldSnapshot);
    const tenant = snapshotData(tenantSnapshot);
    if (!oldIndex || oldIndex.status !== TENANT_SLUG_STATUSES.ACTIVE || oldIndex.tenantId !== normalizedTenantId) {
      fail("SLUG_LINK_MISMATCH", "Vínculo de slug inconsistente.");
    }
    if (newSnapshot.exists) fail("SLUG_UNAVAILABLE", "Slug indisponível.");
    if (!tenant || tenant.slug !== normalizedOldSlug) fail("TENANT_SLUG_MISMATCH", "Slug canônico inconsistente.");

    const timestamp = nowValue(clock);
    tx.create(newRef, {
      tenantId: normalizedTenantId,
      status: TENANT_SLUG_STATUSES.ACTIVE,
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    tx.update(oldRef, {
      status: TENANT_SLUG_STATUSES.REDIRECT,
      redirectToSlug: normalizedNewSlug,
      updatedAt: timestamp,
    });
    tx.set(tenantRef, { slug: normalizedNewSlug, slugUpdatedAt: timestamp }, { merge: true });
    return { tenantId: normalizedTenantId, oldSlug: normalizedOldSlug, newSlug: normalizedNewSlug };
  });
}
