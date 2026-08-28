#!/usr/bin/env node

/**
 * Provisionador genérico, HML-only, de tenants V2.
 *
 * O comando é dry-run por padrão. O modo apply exige a confirmação explícita
 * do projeto e cria somente os três documentos canônicos do tenant. Auth,
 * memberships, perfis e dados operacionais ficam fora deste fluxo.
 */
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { hostnameIndexPath } from "../functions/hostname-resolution.mjs";
import {
  TENANT_SLUG_STATUSES,
  normalizeTenantSlug,
  tenantRootPath,
  tenantSlugIndexPath,
} from "../functions/tenant-slug.mjs";

export const HML_PROJECT = "teste-483f6";
export const PRODUCTION_PROJECT = "barber-a01e7";
export const HML_ENVIRONMENT = "HOMOLOGACAO";
export const TENANT_SCHEMA_VERSION = 2;
export const TENANT_ID_PATTERN = /^tnt_[a-f0-9]{32}$/;
export const DEFAULT_TIMEZONE = "America/Sao_Paulo";
export const DEFAULT_MANIFEST_DIR = "reports/tenant-provisioning";
export const MANIFEST_KIND = "TENANT_PROVISION_MANIFEST";
export const MANIFEST_VERSION = 1;

const requireFromFunctions = createRequire(new URL("../functions/package.json", import.meta.url));
const HOSTNAME_PREFIX = "tenant_hostnames/";

export class TenantProvisioningError extends Error {
  constructor(code, message = code) {
    super(message);
    this.name = "TenantProvisioningError";
    this.code = code;
  }
}

function fail(code, message = code) {
  throw new TenantProvisioningError(code, message);
}

function cleanText(value, code, maxLength) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maxLength) fail(code);
  return text;
}

export function normalizeHostname(value) {
  const path = hostnameIndexPath(value);
  const normalized = path.slice(HOSTNAME_PREFIX.length);
  if (!normalized || normalized.includes("/")) fail("INVALID_HOSTNAME");
  return normalized;
}

export function generateTenantId() {
  const tenantId = `tnt_${randomUUID().replaceAll("-", "")}`;
  if (!TENANT_ID_PATTERN.test(tenantId)) fail("TENANT_ID_GENERATION_FAILED");
  return tenantId;
}

function parseOption(arg) {
  const equals = arg.indexOf("=");
  if (equals < 0) return [arg, ""];
  return [arg.slice(0, equals), arg.slice(equals + 1)];
}

export function parseArgs(argv = process.argv.slice(2)) {
  const options = {
    project: "",
    slug: "",
    hostname: "",
    name: "",
    manifest: "",
    apply: false,
    reset: false,
    dryRun: true,
    confirmation: "",
  };
  const known = new Set([
    "--project", "--slug", "--hostname", "--name", "--manifest", "--confirm",
    "--apply", "--dry-run", "--reset",
  ]);
  for (const arg of argv) {
    const [key, value] = parseOption(String(arg));
    if (!known.has(key)) fail("UNKNOWN_OPTION");
    if (["--apply", "--dry-run", "--reset"].includes(key)) {
      if (value) fail("INVALID_FLAG_VALUE");
      if (key === "--apply") { options.apply = true; options.dryRun = false; }
      if (key === "--dry-run") { options.dryRun = true; options.apply = false; }
      if (key === "--reset") options.reset = true;
      continue;
    }
    if (!value) fail("OPTION_VALUE_REQUIRED");
    if (key === "--project") options.project = value;
    if (key === "--slug") options.slug = value;
    if (key === "--hostname") options.hostname = value;
    if (key === "--name") options.name = value;
    if (key === "--manifest") options.manifest = value;
    if (key === "--confirm") options.confirmation = value;
  }
  if (options.apply && options.dryRun) fail("CONFLICTING_MODES");
  if (options.reset && options.apply) fail("CONFLICTING_MODES");
  return Object.freeze(options);
}

export function validateOptions(options) {
  if (options?.project === PRODUCTION_PROJECT) fail("PRODUCTION_PROJECT_FORBIDDEN");
  if (options?.project !== HML_PROJECT) fail("HML_PROJECT_REQUIRED");
  if (options.reset) {
    if (!options.manifest) fail("MANIFEST_REQUIRED_FOR_RESET");
    if (options.confirmation !== `${HML_PROJECT}:RESET`) fail("EXPLICIT_RESET_CONFIRMATION_REQUIRED");
    return true;
  }
  if (!options?.slug) fail("SLUG_REQUIRED");
  if (!options?.hostname) fail("HOSTNAME_REQUIRED");
  if (!options?.name) fail("NAME_REQUIRED");
  normalizeTenantSlug(options.slug);
  normalizeHostname(options.hostname);
  cleanText(options.name, "NAME_REQUIRED", 120);
  if (options.apply && options.confirmation !== `${HML_PROJECT}:APPLY`) {
    fail("EXPLICIT_HML_APPLY_CONFIRMATION_REQUIRED");
  }
  return true;
}

function nowValue(clock) {
  if (typeof clock === "function") return clock();
  const { FieldValue } = requireFromFunctions("firebase-admin/firestore");
  return FieldValue.serverTimestamp();
}

function withoutTimestamps(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["createdAt", "updatedAt"].includes(key))
    .map(([key, entry]) => [key, withoutTimestamps(entry)]));
}

export function canonicalize(value) {
  if (value instanceof Date) return value.toISOString();
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(canonicalize);
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]));
}

export function hashDocument(value) {
  const material = JSON.stringify(canonicalize(withoutTimestamps(value)));
  return createHash("sha256").update(material).digest("hex");
}

function ensureTenantId(tenantId) {
  if (!TENANT_ID_PATTERN.test(String(tenantId || ""))) fail("INVALID_GENERATED_TENANT_ID");
  return tenantId;
}

export function buildTenantDocuments({ tenantId, slug, hostname, name, clock }) {
  const safeTenantId = ensureTenantId(tenantId);
  const safeSlug = normalizeTenantSlug(slug);
  const safeHostname = normalizeHostname(hostname);
  const safeName = cleanText(name, "NAME_REQUIRED", 120);
  const timestamp = nowValue(clock);
  const tenant = {
    tenant_id: safeTenantId,
    nome: safeName,
    slug: safeSlug,
    logo: "",
    ativa: true,
    status: TENANT_SLUG_STATUSES.ACTIVE,
    plano: HML_ENVIRONMENT,
    dominio: safeHostname,
    timezone: DEFAULT_TIMEZONE,
    schema: TENANT_SCHEMA_VERSION,
    ambiente: HML_ENVIRONMENT,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const slugIndex = {
    tenantId: safeTenantId,
    status: TENANT_SLUG_STATUSES.ACTIVE,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  const hostnameIndex = { tenantId: safeTenantId };
  return Object.freeze({ tenant, slugIndex, hostnameIndex });
}

export function buildProvisioningPlan({ slug, hostname, name, tenantIdFactory = generateTenantId, clock }) {
  const normalizedSlug = normalizeTenantSlug(slug);
  const normalizedHostname = normalizeHostname(hostname);
  const tenantId = ensureTenantId(tenantIdFactory());
  const documents = buildTenantDocuments({
    tenantId, slug: normalizedSlug, hostname: normalizedHostname, name, clock,
  });
  const paths = Object.freeze({
    tenant: tenantRootPath(tenantId),
    slugIndex: tenantSlugIndexPath(normalizedSlug),
    hostnameIndex: hostnameIndexPath(normalizedHostname),
  });
  return Object.freeze({
    project: HML_PROJECT,
    tenantId,
    slug: normalizedSlug,
    hostname: normalizedHostname,
    paths,
    documents,
    writeModePersisted: false,
    expectedRuntimeWriteMode: "V2_ONLY",
    writes: 3,
  });
}

function dataOf(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

function isExactDocument(actual, expected) {
  return hashDocument(actual) === hashDocument(expected);
}

function snapshotFor(db, tx, path) {
  return tx.get(db.doc(path));
}

async function inspectExistingState({ db, tx, plan }) {
  const [slugSnapshot, hostnameSnapshot, candidateTenantSnapshot] = await Promise.all([
    snapshotFor(db, tx, plan.paths.slugIndex),
    snapshotFor(db, tx, plan.paths.hostnameIndex),
    snapshotFor(db, tx, plan.paths.tenant),
  ]);
  const slugIndex = dataOf(slugSnapshot);
  const hostnameIndex = dataOf(hostnameSnapshot);
  const candidateTenant = dataOf(candidateTenantSnapshot);
  if (!slugIndex && !hostnameIndex && !candidateTenant) {
    return { kind: "EMPTY" };
  }
  if (!slugIndex || !hostnameIndex) fail("PARTIAL_STATE");
  const slugTenantId = String(slugIndex.tenantId || "");
  const hostnameTenantId = String(hostnameIndex.tenantId || "");
  if (!slugTenantId || slugTenantId !== hostnameTenantId) fail("DIVERGENT_INDEXES");
  const linkedTenantSnapshot = slugTenantId === plan.tenantId
    ? candidateTenantSnapshot
    : await snapshotFor(db, tx, tenantRootPath(slugTenantId));
  const linkedTenant = dataOf(linkedTenantSnapshot);
  if (!linkedTenant) fail("PARTIAL_STATE");
  const expected = buildTenantDocuments({
    tenantId: slugTenantId,
    slug: plan.slug,
    hostname: plan.hostname,
    name: plan.documents.tenant.nome,
    clock: () => undefined,
  });
  if (
    !isExactDocument(slugIndex, expected.slugIndex)
    || !isExactDocument(hostnameIndex, expected.hostnameIndex)
    || !isExactDocument(linkedTenant, expected.tenant)
  ) fail("DIVERGENT_EXISTING_STATE");
  return { kind: "IDEMPOTENT", tenantId: slugTenantId, documents: { tenant: linkedTenant, slugIndex, hostnameIndex } };
}

export async function provisionTenant({ db, options, dryRun = true, tenantIdFactory = generateTenantId, clock }) {
  validateOptions({ ...options, apply: !dryRun, reset: false });
  if (!db?.doc || !db?.runTransaction) fail("FIRESTORE_ADAPTER_REQUIRED");
  const plan = buildProvisioningPlan({ ...options, tenantIdFactory, clock });
  if (dryRun) return Object.freeze({ status: "DRY_RUN", plan, writes: 0 });

  const result = await db.runTransaction(async (tx) => {
    const state = await inspectExistingState({ db, tx, plan });
    if (state.kind === "IDEMPOTENT") return state;
    const { tenant, slugIndex, hostnameIndex } = plan.documents;
    tx.create(db.doc(plan.paths.tenant), tenant);
    tx.create(db.doc(plan.paths.slugIndex), slugIndex);
    tx.create(db.doc(plan.paths.hostnameIndex), hostnameIndex);
    return { kind: "CREATED", tenantId: plan.tenantId, documents: plan.documents };
  });
  return Object.freeze({ status: result.kind, plan, writes: result.kind === "CREATED" ? 3 : 0, result });
}

export function createResetManifest({ plan, result, createdAt = new Date().toISOString() }) {
  const documents = result?.documents || plan.documents;
  return Object.freeze({
    kind: MANIFEST_KIND,
    version: MANIFEST_VERSION,
    project: HML_PROJECT,
    tenantId: plan.tenantId,
    slug: plan.slug,
    hostname: plan.hostname,
    resources: [plan.paths.tenant, plan.paths.slugIndex, plan.paths.hostnameIndex],
    fingerprints: {
      [plan.paths.tenant]: hashDocument(documents.tenant),
      [plan.paths.slugIndex]: hashDocument(documents.slugIndex),
      [plan.paths.hostnameIndex]: hashDocument(documents.hostnameIndex),
    },
    createdAt,
    resetSupported: true,
  });
}

function expectedResourcePaths(manifest) {
  const tenantPath = tenantRootPath(manifest.tenantId);
  const slugPath = tenantSlugIndexPath(manifest.slug);
  const hostnamePath = hostnameIndexPath(manifest.hostname);
  return [tenantPath, slugPath, hostnamePath];
}

function validateManifest(manifest) {
  if (!manifest || manifest.kind !== MANIFEST_KIND || manifest.version !== MANIFEST_VERSION) {
    fail("INVALID_RESET_MANIFEST");
  }
  if (manifest.project !== HML_PROJECT || manifest.resetSupported !== true) fail("INVALID_RESET_MANIFEST");
  ensureTenantId(manifest.tenantId);
  const slug = normalizeTenantSlug(manifest.slug);
  const hostname = normalizeHostname(manifest.hostname);
  const expectedPaths = expectedResourcePaths({ tenantId: manifest.tenantId, slug, hostname });
  if (JSON.stringify(manifest.resources) !== JSON.stringify(expectedPaths)) fail("INVALID_RESET_MANIFEST");
  if (!manifest.fingerprints || expectedPaths.some((path) => !/^[a-f0-9]{64}$/.test(manifest.fingerprints[path] || ""))) {
    fail("INVALID_RESET_MANIFEST");
  }
  return { ...manifest, slug, hostname, resources: expectedPaths };
}

const TENANT_DEPENDENCY_COLLECTIONS = Object.freeze([
  "membros", "clientes", "barbeiros", "servicos", "agendamentos", "ocupacoes", "bloqueios",
  "configuracoes", "fechamentos", "planos_assinatura", "assinaturas", "historico_assinaturas",
  "audit_logs", "vinculos_barbeiro", "email_acesso_index",
]);

async function defaultDependencyChecker({ db, tx, tenantId }) {
  if (!db?.collection) fail("DEPENDENCY_CHECK_ADAPTER_REQUIRED");
  for (const collection of TENANT_DEPENDENCY_COLLECTIONS) {
    const snapshot = await tx.get(db.collection(`barbearias/${tenantId}/${collection}`).limit(1));
    if (snapshot.size > 0) return true;
  }
  return false;
}

export async function resetTenantFromManifest({ db, manifest, dependencyChecker = defaultDependencyChecker }) {
  const safeManifest = validateManifest(manifest);
  if (!db?.doc || !db?.runTransaction) fail("FIRESTORE_ADAPTER_REQUIRED");
  return db.runTransaction(async (tx) => {
    const snapshots = await Promise.all(safeManifest.resources.map((path) => snapshotFor(db, tx, path)));
    const present = snapshots.map((snapshot) => snapshot.exists);
    if (present.every((value) => !value)) return { status: "ALREADY_RESET", deleted: 0 };
    if (present.some((value) => !value)) fail("PARTIAL_RESET_STATE");
    snapshots.forEach((snapshot, index) => {
      const path = safeManifest.resources[index];
      if (hashDocument(snapshot.data()) !== safeManifest.fingerprints[path]) fail("RESET_RESOURCE_CHANGED");
    });
    if (await dependencyChecker({ db, tx, tenantId: safeManifest.tenantId, manifest: safeManifest })) {
      fail("RESET_DEPENDENCIES_EXIST");
    }
    for (const path of safeManifest.resources) tx.delete(db.doc(path));
    return { status: "RESET", deleted: safeManifest.resources.length };
  });
}

export function defaultManifestPath(slug) {
  return resolve(process.cwd(), DEFAULT_MANIFEST_DIR, `${normalizeTenantSlug(slug)}.json`);
}

export async function writeManifest(path, manifest) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  const temporary = `${target}.tmp`;
  await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  await rename(temporary, target);
  return target;
}

export async function readManifest(path) {
  return JSON.parse(await readFile(resolve(path), "utf8"));
}

async function createAdminDb(project) {
  const { getApps, initializeApp, cert } = requireFromFunctions("firebase-admin/app");
  const { getFirestore } = requireFromFunctions("firebase-admin/firestore");
  if (getApps().length === 0) initializeApp({ projectId: project });
  return getFirestore();
}

async function runCli(argv) {
  const options = parseArgs(argv);
  validateOptions(options);
  const db = await createAdminDb(options.project);
  if (options.reset) {
    const manifest = await readManifest(options.manifest);
    const result = await resetTenantFromManifest({ db, manifest });
    console.log(`RESET_STATUS=${result.status} DELETED=${result.deleted}`);
    return;
  }
  const result = await provisionTenant({ db, options, dryRun: options.dryRun });
  if (result.status === "DRY_RUN") {
    console.log(JSON.stringify({
      status: result.status,
      project: result.plan.project,
      tenantId: result.plan.tenantId,
      slug: result.plan.slug,
      hostname: result.plan.hostname,
      writes: 0,
      resetSupported: true,
    }));
    return;
  }
  const manifestPath = options.manifest || defaultManifestPath(result.plan.slug);
  await writeManifest(manifestPath, createResetManifest({ plan: result.plan, result: result.result }));
  console.log(`PROVISION_STATUS=${result.status} TENANT_ID=${result.plan.tenantId} WRITES=${result.writes} MANIFEST_CREATED=1`);
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runCli(process.argv.slice(2)).catch((error) => {
    console.error(`TENANT_PROVISIONING_FAILED=${error.code || "UNKNOWN"}`);
    process.exitCode = 1;
  });
}
