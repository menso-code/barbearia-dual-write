#!/usr/bin/env node

/**
 * Provisionador controlado de identidades e perfis sintéticos para HML.
 *
 * Dry-run é o padrão. O modo apply aceita somente teste-483f6, exige um
 * tenant-slug explícito e nunca registra senhas, tokens ou e-mails.
 */
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export const HML_PROJECT = "teste-483f6";
export const PRODUCTION_PROJECT = "barber-a01e7";
export const DEFAULT_MANIFEST_DIR = "reports/hml-fixtures";
export const REQUIRED_ROLES = Object.freeze({ admin: "ADMIN", barber: "BARBEIRO", client: "CLIENTE" });
const requireFromFunctions = createRequire(new URL("../functions/package.json", import.meta.url));

export function parseArgs(argv = process.argv.slice(2)) {
  const value = (name) => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) || "";
  return {
    project: value("--project"),
    tenantSlug: value("--tenant-slug"),
    adminEmail: value("--admin-email"),
    barberEmail: value("--barber-email"),
    clientEmail: value("--client-email"),
    manifest: value("--manifest"),
    dryRun: !argv.includes("--apply"),
    apply: argv.includes("--apply"),
    reset: argv.includes("--reset"),
    confirm: value("--confirm") === "teste-483f6:APPLY",
  };
}

export function validateOptions(options) {
  if (options.project !== HML_PROJECT) throw new Error(`HML_PROJECT_REQUIRED:${HML_PROJECT}`);
  if (options.project === PRODUCTION_PROJECT) throw new Error("PRODUCTION_PROJECT_FORBIDDEN");
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(String(options.tenantSlug || ""))) {
    throw new Error("TENANT_SLUG_REQUIRED_AND_INVALID");
  }
  if (String(options.tenantSlug).toLowerCase() === "antunes") throw new Error("IMPLICIT_ANTUNES_TENANT_FORBIDDEN");
  if (options.apply && !options.confirm) throw new Error("EXPLICIT_HML_APPLY_CONFIRMATION_REQUIRED");
  if (options.reset && !options.manifest) throw new Error("MANIFEST_REQUIRED_FOR_RESET");
  return true;
}

export function tenantIdForSlug(slug) {
  const normalized = String(slug || "").trim().toLowerCase();
  if (!/^[a-z][a-z0-9-]{1,30}[a-z0-9]$/.test(normalized)) throw new Error("TENANT_SLUG_REQUIRED_AND_INVALID");
  if (normalized === "antunes") throw new Error("IMPLICIT_ANTUNES_TENANT_FORBIDDEN");
  return `qa_${createHash("sha256").update(`hml:${normalized}`).digest("hex").slice(0, 24)}`;
}

export function safeEmail(value, role) {
  const email = String(value || "").trim().toLowerCase();
  if (!email || email.length > 254 || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new Error(`${role.toUpperCase()}_EMAIL_REQUIRED`);
  }
  return email;
}

export function fixturePlan(options) {
  validateOptions({ ...options, apply: false });
  const tenantId = tenantIdForSlug(options.tenantSlug);
  const host = `${options.tenantSlug}.hml.goestudio.invalid`;
  return {
    project: HML_PROJECT,
    tenantId,
    slug: String(options.tenantSlug).trim().toLowerCase(),
    tenantPath: `barbearias/${tenantId}`,
    hostname: host,
    resources: [
      { role: "ADMIN", auth: "admin", memberPath: `barbearias/${tenantId}/membros/{adminUid}` },
      { role: "BARBEIRO", auth: "barber", memberPath: `barbearias/${tenantId}/membros/{barberUid}`, profilePath: `barbearias/${tenantId}/barbeiros/{barberId}` },
      { role: "CLIENTE", auth: "client", memberPath: `barbearias/${tenantId}/membros/{clientUid}`, profilePath: `barbearias/${tenantId}/clientes/{clientUid}` },
    ],
    writes: 1 + 3 + 2,
  };
}

function fixtureFields(role, uid, plan, ids) {
  if (role === "ADMIN") return { uid, papeis: ["ADMIN"], ativo: true, fixture: true, fixture_purpose: "HML_QA" };
  if (role === "BARBEIRO") return { uid, papeis: ["BARBEIRO"], barbeiro_id: ids.barberId, ativo: true, fixture: true, fixture_purpose: "HML_QA" };
  return { uid, papeis: ["CLIENTE"], ativo: true, fixture: true, fixture_purpose: "HML_QA" };
}

function redactedManifest({ plan, users, paths, createdAuthUids }) {
  return {
    kind: "HML_FIXTURE_MANIFEST",
    project: plan.project,
    tenantId: plan.tenantId,
    slug: plan.slug,
    createdAt: new Date().toISOString(),
    users: Object.fromEntries(Object.entries(users).map(([role, user]) => [role, { uid: user.uid, created: createdAuthUids.includes(user.uid) }])),
    resources: paths,
  };
}

async function sdk() {
  const { getApps, initializeApp } = requireFromFunctions("firebase-admin/app");
  const { getAuth } = requireFromFunctions("firebase-admin/auth");
  const { getFirestore, FieldValue } = requireFromFunctions("firebase-admin/firestore");
  const app = getApps()[0] || initializeApp({ projectId: HML_PROJECT });
  return { auth: getAuth(app), db: getFirestore(app), FieldValue };
}

async function getOrCreateUser(auth, email, password, displayName) {
  try { return { user: await auth.getUserByEmail(email), created: false }; }
  catch (error) {
    if (error.code !== "auth/user-not-found") throw error;
    if (!password) throw new Error("FIXTURE_PASSWORD_ENV_REQUIRED");
    return { user: await auth.createUser({ email, password, displayName }), created: true };
  }
}

async function ensureResources({ db, plan, users, apply }) {
  const ids = { barberId: `qa-barber-${users.barber.uid.slice(0, 12)}` };
  const refs = {
    tenant: db.doc(plan.tenantPath),
    adminMember: db.doc(`barbearias/${plan.tenantId}/membros/${users.admin.uid}`),
    barberMember: db.doc(`barbearias/${plan.tenantId}/membros/${users.barber.uid}`),
    clientMember: db.doc(`barbearias/${plan.tenantId}/membros/${users.client.uid}`),
    barber: db.doc(`barbearias/${plan.tenantId}/barbeiros/${ids.barberId}`),
    client: db.doc(`barbearias/${plan.tenantId}/clientes/${users.client.uid}`),
  };
  if (!apply) return { ids, paths: Object.values(refs).map((ref) => ref.path) };
  await db.runTransaction(async (tx) => {
    const snapshots = await Promise.all(Object.values(refs).map((ref) => tx.get(ref)));
    const tenant = snapshots[0].exists ? snapshots[0].data() : null;
    if (tenant && (tenant.status !== "ACTIVE" || tenant.slug !== plan.slug || tenant.ambiente !== "HML")) throw new Error("TENANT_EXISTING_DATA_MISMATCH");
    if (tenant && tenant.fixture_purpose !== "HML_QA") throw new Error("EXISTING_NON_QA_TENANT_FORBIDDEN");
    for (const snapshot of snapshots.slice(1)) {
      if (snapshot.exists && snapshot.data()?.fixture_purpose !== "HML_QA") throw new Error("EXISTING_NON_QA_RESOURCE_FORBIDDEN");
    }
    tx.set(refs.tenant, { tenant_id: plan.tenantId, slug: plan.slug, status: "ACTIVE", schema: 2, ambiente: "HML", fixture: true, fixture_purpose: "HML_QA" }, { merge: true });
    tx.set(refs.adminMember, fixtureFields("ADMIN", users.admin.uid, plan, ids), { merge: true });
    tx.set(refs.barberMember, fixtureFields("BARBEIRO", users.barber.uid, plan, ids), { merge: true });
    tx.set(refs.clientMember, fixtureFields("CLIENTE", users.client.uid, plan, ids), { merge: true });
    tx.set(refs.barber, { id: ids.barberId, nome: "QA Barber", uid_usuario: users.barber.uid, ativo: true, fixture: true, fixture_purpose: "HML_QA" }, { merge: true });
    tx.set(refs.client, { uid: users.client.uid, nome: "QA Client", ativo: true, fixture: true, fixture_purpose: "HML_QA" }, { merge: true });
  });
  return { ids, paths: Object.values(refs).map((ref) => ref.path) };
}

export async function provision(options, dependencies = {}) {
  validateOptions(options);
  const plan = fixturePlan(options);
  const emails = {
    admin: safeEmail(options.adminEmail, "admin"),
    barber: safeEmail(options.barberEmail, "barber"),
    client: safeEmail(options.clientEmail, "client"),
  };
  if (new Set(Object.values(emails)).size !== 3) throw new Error("FIXTURE_EMAILS_MUST_BE_DISTINCT");
  if (options.dryRun) return { mode: "dry-run", plan, emails: Object.fromEntries(Object.keys(emails).map((role) => [role, "provided"])), writes: 0 };
  const { auth, db } = dependencies.sdk ? await dependencies.sdk() : await sdk();
  const createdAuthUids = [];
  const users = {};
  try {
    for (const [role, email] of Object.entries(emails)) {
      const envName = `HML_FIXTURE_${role.toUpperCase()}_PASSWORD`;
      const result = await getOrCreateUser(auth, email, process.env[envName], `GOESTUDIO HML QA ${role}`);
      users[role] = result.user;
      if (result.created) createdAuthUids.push(result.user.uid);
    }
    const ensured = await ensureResources({ db, plan, users, apply: true });
    const manifest = redactedManifest({ plan, users, paths: ensured.paths, createdAuthUids });
    const manifestPath = resolve(options.manifest || DEFAULT_MANIFEST_DIR, `fixture-${plan.slug}.json`);
    await mkdir(dirname(manifestPath), { recursive: true });
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    return { mode: "apply", project: HML_PROJECT, tenantId: plan.tenantId, manifestPath, resourceCount: ensured.paths.length };
  } catch (error) {
    for (const uid of createdAuthUids) { try { await auth.deleteUser(uid); } catch { /* preserve original failure */ } }
    throw error;
  }
}

export async function reset(options, dependencies = {}) {
  validateOptions(options);
  if (!options.reset) throw new Error("RESET_FLAG_REQUIRED");
  const manifestPath = resolve(options.manifest);
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  if (manifest.kind !== "HML_FIXTURE_MANIFEST" || manifest.project !== HML_PROJECT || !manifest.tenantId || !Array.isArray(manifest.resources) || !manifest.users) throw new Error("INVALID_HML_FIXTURE_MANIFEST");
  if (manifest.tenantId !== tenantIdForSlug(options.tenantSlug) || manifest.slug !== String(options.tenantSlug).trim().toLowerCase()) throw new Error("MANIFEST_TENANT_MISMATCH");
  if (Object.values(manifest.users).some((user) => !user || !/^[A-Za-z0-9_-]{10,128}$/.test(String(user.uid || "")) || typeof user.created !== "boolean")) throw new Error("INVALID_MANIFEST_USER");
  const tenantPrefix = `barbearias/${manifest.tenantId}/`;
  const allowedResource = new RegExp(`^barbearias/${manifest.tenantId}/(?:membros|barbeiros|clientes)/[^/]+$`);
  if (new Set(manifest.resources).size !== manifest.resources.length || manifest.resources.some((resource) => typeof resource !== "string" || resource.includes("..") || (resource !== `barbearias/${manifest.tenantId}` && !allowedResource.test(resource)))) throw new Error("MANIFEST_RESOURCE_OUT_OF_TENANT_SCOPE");
  if (options.dryRun) return { mode: "dry-run", project: HML_PROJECT, tenantId: manifest.tenantId, resources: manifest.resources.length, authDeletes: Object.values(manifest.users).filter((user) => user.created).length };
  const { auth, db } = dependencies.sdk ? await dependencies.sdk() : await sdk();
  await db.runTransaction(async (tx) => {
    for (const path of [...manifest.resources].sort((a, b) => b.length - a.length)) tx.delete(db.doc(path));
  });
  for (const user of Object.values(manifest.users)) if (user.created) await auth.deleteUser(user.uid);
  return { mode: "apply", project: HML_PROJECT, tenantId: manifest.tenantId, resourcesDeleted: manifest.resources.length, authDeleted: Object.values(manifest.users).filter((user) => user.created).length };
}

async function main() {
  const options = parseArgs();
  const result = options.reset ? await reset(options) : await provision(options);
  console.log(JSON.stringify({ ...result, sensitiveDataLogged: false }));
}

if (process.argv[1]?.endsWith("hml-fixture-provisioner.mjs")) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
