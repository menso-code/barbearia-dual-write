import assert from "node:assert/strict";
import test from "node:test";
import {
  HOSTNAME_INDEX_COLLECTION,
  HOSTNAME_RESOLUTION_KINDS,
  hostnameIndexPath,
  resolveGoEstudioHostname,
  slugTenantCacheKey,
  tenantIdentityCacheKey,
} from "./hostname-resolution.mjs";

class Snapshot {
  constructor(data) { this.value = data; this.exists = data !== undefined; }
  data() { return structuredClone(this.value); }
}

class MemoryFirestore {
  constructor(seed = {}) { this.documents = new Map(Object.entries(structuredClone(seed))); }
  doc(path) { return { path, get: async () => new Snapshot(this.documents.get(path)) }; }
}

const tenantId = "tenant-a";
const activeSeed = {
  [`${HOSTNAME_INDEX_COLLECTION}/studio.example`]: { tenantId },
  [`barbearias/${tenantId}`]: { slug: "studio-public", status: "ACTIVE" },
};

test("hostname index path normaliza hostname sem derivar slug", () => {
  assert.equal(hostnameIndexPath("Studio.Example:443"), "tenant_hostnames/studio.example");
  assert.equal(hostnameIndexPath("studio.example."), "tenant_hostnames/studio.example");
});

test("hostname inválido falha fechado", () => {
  for (const hostname of ["", "tenant/example", "tenant.example:99999", "tenant.example/path"]) {
    assert.throws(() => hostnameIndexPath(hostname));
  }
});

test("hostname resolve tenantId e obtém slug somente do documento do tenant", async () => {
  assert.deepEqual(await resolveGoEstudioHostname({ db: new MemoryFirestore(activeSeed), hostname: "studio.example" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.ACTIVE,
    hostname: "studio.example",
    slug: "studio-public",
    tenantId,
  });
});

test("hostname index ausente ou inválido falha fechado", async () => {
  const db = new MemoryFirestore({
    [`${HOSTNAME_INDEX_COLLECTION}/invalid.example`]: { tenantId: "tenant/invalid" },
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "unknown.example" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND,
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "invalid.example" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE,
    hostname: "invalid.example",
  });
});

test("tenant ausente ou inativo fica indisponível", async () => {
  const db = new MemoryFirestore({
    [`${HOSTNAME_INDEX_COLLECTION}/inactive.example`]: { tenantId },
    [`barbearias/${tenantId}`]: { slug: "inactive-public", status: "SUSPENDED" },
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "inactive.example" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE,
    hostname: "inactive.example",
  });
});

test("slug inválido no tenant falha fechado", async () => {
  const db = new MemoryFirestore({
    [`${HOSTNAME_INDEX_COLLECTION}/public.example`]: { tenantId },
    [`barbearias/${tenantId}`]: { slug: "INVALID/SLUG", status: "ACTIVE" },
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "public.example" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE,
    hostname: "public.example",
  });
});

test("cache keys são namespaced por slug e tenant", () => {
  assert.equal(slugTenantCacheKey("Studio Public"), "slug:studiopublic:tenant");
  assert.equal(tenantIdentityCacheKey("tenant-a"), "tenant:tenant-a:identity");
});

test("fundação permanece fora do dispatcher e o resolver usa índice de hostname", async () => {
  const [{ readFile }, { default: path }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
  const [tenantSource, firebaseSource, contextSource, indexSource, runtimeSource, resolverSource] = await Promise.all([
    readFile(path.join(root, "public", "js", "tenant.js"), "utf8"),
    readFile(path.join(root, "public", "js", "firebase-config.js"), "utf8"),
    readFile(path.join(root, "public", "js", "tenant-context.js"), "utf8"),
    readFile(path.join(root, "functions", "index.js"), "utf8"),
    readFile(path.join(root, "functions", "dual-write.js"), "utf8"),
    readFile(path.join(root, "functions", "hostname-resolution.mjs"), "utf8"),
  ]);
  assert.match(tenantSource, /BARBEARIA_PADRAO_ID/);
  assert.doesNotMatch(firebaseSource, /BARBEARIA_ATUAL_ID|BARBEARIA_ATUAL_SLUG|getBarbeariaAtual|getSlugBarbeariaAtual|\.\/tenant\.js/);
  assert.match(contextSource, /registerTrustedTenantHostnameResolver/);
  assert.match(indexSource, /resolveTenantHostname.*hostname-resolution-endpoint/);
  assert.doesNotMatch(runtimeSource, /resolveGoEstudioHostname|hostname-resolution/);
  assert.doesNotMatch(resolverSource, /LEGACY_FIREBASE_HOSTS|ANTUNES_TENANT_SLUG|parseGoEstudioTenantHostname|tenant_slugs/);
  assert.match(resolverSource, /HOSTNAME_INDEX_COLLECTION|hostnameIndexPath/);
});
