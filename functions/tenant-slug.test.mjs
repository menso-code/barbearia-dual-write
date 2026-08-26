import assert from "node:assert/strict";
import test from "node:test";
import {
  TENANT_SLUG_STATUSES,
  activateTenantSlug,
  normalizeTenantSlug,
  reserveTenantSlug,
  resolveTenantSlug,
  tenantSlugIndexPath,
  transitionTenantSlug,
} from "./tenant-slug.mjs";

class Snapshot {
  constructor(data) {
    this.value = data;
    this.exists = data !== undefined;
  }
  data() { return structuredClone(this.value); }
}

class MemoryFirestore {
  constructor(seed = {}) {
    this.documents = new Map(Object.entries(structuredClone(seed)));
    this.queue = Promise.resolve();
  }
  doc(path) {
    return {
      path,
      get: async () => new Snapshot(this.documents.get(path)),
    };
  }
  runTransaction(work) {
    const execute = async () => {
      const pending = [];
      const tx = {
        get: async (ref) => new Snapshot(this.documents.get(ref.path)),
        create: (ref, data) => pending.push({ type: "create", path: ref.path, data }),
        update: (ref, data) => pending.push({ type: "update", path: ref.path, data }),
        set: (ref, data, options) => pending.push({ type: "set", path: ref.path, data, options }),
      };
      const result = await work(tx);
      for (const write of pending) {
        const current = this.documents.get(write.path);
        if (write.type === "create" && current !== undefined) throw new Error("already exists");
        if (write.type === "update" && current === undefined) throw new Error("not found");
        const merge = write.type === "update" || write.options?.merge;
        this.documents.set(write.path, merge ? { ...(current || {}), ...structuredClone(write.data) } : structuredClone(write.data));
      }
      return result;
    };
    const result = this.queue.then(execute, execute);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
}

const tenantId = "tenant-a";
const tenantPath = `barbearias/${tenantId}`;
const fixedClock = () => "2026-08-25T12:00:00.000Z";

test("normalização é determinística, remove acentos e espaços", () => {
  assert.equal(normalizeTenantSlug("  Barbearia Ántunes  "), "barbeariaantunes");
  assert.equal(normalizeTenantSlug("Barbearia---Antunes"), "barbearia-antunes");
});

test("política rejeita reservados, xn--, tamanhos, caracteres perigosos e slug sem letra", () => {
  assert.throws(() => normalizeTenantSlug("admin"), { code: "RESERVED_SLUG" });
  assert.throws(() => normalizeTenantSlug("xn--tenant"), { code: "XN_PREFIX_FORBIDDEN" });
  assert.throws(() => normalizeTenantSlug("ab"), { code: "SLUG_TOO_SHORT" });
  assert.throws(() => normalizeTenantSlug("a".repeat(49)), { code: "SLUG_TOO_LONG" });
  assert.throws(() => normalizeTenantSlug("tenant/example"), { code: "INVALID_SLUG" });
  assert.throws(() => normalizeTenantSlug("12345"), { code: "INVALID_SLUG" });
});

test("reserva é create-only, transacional e vincula índice ao slug canônico", async () => {
  const db = new MemoryFirestore({ [tenantPath]: { nome: "Tenant A" } });
  const result = await reserveTenantSlug({ db, slug: "Tenant A", tenantId, clock: fixedClock });
  assert.deepEqual(result, { slug: "tenanta", tenantId, status: TENANT_SLUG_STATUSES.PROVISIONING });
  assert.equal(db.documents.get(tenantPath).slug, "tenanta");
  assert.deepEqual(db.documents.get(tenantSlugIndexPath("tenanta")), {
    tenantId,
    status: TENANT_SLUG_STATUSES.PROVISIONING,
    createdAt: fixedClock(),
    updatedAt: fixedClock(),
  });
  await assert.rejects(reserveTenantSlug({ db, slug: "tenanta", tenantId, clock: fixedClock }), { code: "SLUG_UNAVAILABLE" });
});

test("duas reservas concorrentes produzem exatamente um vencedor", async () => {
  const db = new MemoryFirestore({
    "barbearias/tenant-a": { nome: "A" },
    "barbearias/tenant-b": { nome: "B" },
  });
  const results = await Promise.allSettled([
    reserveTenantSlug({ db, slug: "slug-concorrente", tenantId: "tenant-a", clock: fixedClock }),
    reserveTenantSlug({ db, slug: "slug-concorrente", tenantId: "tenant-b", clock: fixedClock }),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  assert.equal(results.filter(({ status }) => status === "rejected").length, 1);
});

test("ativação exige correspondência entre índice e tenant", async () => {
  const db = new MemoryFirestore({ [tenantPath]: { nome: "A" } });
  await reserveTenantSlug({ db, slug: "tenant-a-public", tenantId, clock: fixedClock });
  await activateTenantSlug({ db, slug: "tenant-a-public", tenantId, clock: fixedClock });
  assert.deepEqual(await resolveTenantSlug({ db, slug: "tenant-a-public" }), {
    tenantId,
    status: TENANT_SLUG_STATUSES.ACTIVE,
  });
  db.documents.set(tenantPath, { ...db.documents.get(tenantPath), slug: "outro-slug" });
  await assert.rejects(resolveTenantSlug({ db, slug: "tenant-a-public" }), { code: "TENANT_SLUG_MISMATCH" });
});

test("resolver distingue redirect, retired e unknown", async () => {
  const db = new MemoryFirestore({
    "tenant_slugs/slug-antigo": { tenantId, status: "REDIRECT", redirectToSlug: "slug-novo" },
    "tenant_slugs/slug-novo": { tenantId, status: "ACTIVE" },
    "tenant_slugs/slug-retired": { tenantId, status: "RETIRED" },
  });
  assert.deepEqual(await resolveTenantSlug({ db, slug: "slug-antigo" }), {
    status: TENANT_SLUG_STATUSES.REDIRECT,
    redirectToSlug: "slug-novo",
  });
  await assert.rejects(resolveTenantSlug({ db, slug: "slug-retired" }), { code: "SLUG_RETIRED" });
  await assert.rejects(resolveTenantSlug({ db, slug: "slug-unknown" }), { code: "SLUG_NOT_FOUND" });
});

test("resolver falha fechado para self-redirect, redirect quebrado e status desconhecido", async () => {
  const db = new MemoryFirestore({
    "tenant_slugs/slug-loop": { tenantId, status: "REDIRECT", redirectToSlug: "slug-loop" },
    "tenant_slugs/slug-broken": { tenantId, status: "REDIRECT", redirectToSlug: "slug-missing" },
    "tenant_slugs/slug-invalid": { tenantId, status: "UNKNOWN" },
  });
  await assert.rejects(resolveTenantSlug({ db, slug: "slug-loop" }), { code: "SLUG_REDIRECT_LOOP" });
  await assert.rejects(resolveTenantSlug({ db, slug: "slug-broken" }), { code: "SLUG_REDIRECT_INVALID" });
  await assert.rejects(resolveTenantSlug({ db, slug: "slug-invalid" }), { code: "SLUG_NOT_ACTIVE" });
});

test("transição preserva slug antigo como redirect e impede reutilização", async () => {
  const db = new MemoryFirestore({ [tenantPath]: { nome: "A" } });
  await reserveTenantSlug({ db, slug: "slug-antigo", tenantId, clock: fixedClock });
  await activateTenantSlug({ db, slug: "slug-antigo", tenantId, clock: fixedClock });
  await transitionTenantSlug({ db, tenantId, oldSlug: "slug-antigo", newSlug: "slug-novo", clock: fixedClock });
  assert.equal(db.documents.get("tenant_slugs/slug-antigo").status, TENANT_SLUG_STATUSES.REDIRECT);
  assert.equal(db.documents.get("tenant_slugs/slug-antigo").redirectToSlug, "slug-novo");
  assert.equal(db.documents.get(tenantPath).slug, "slug-novo");
  await assert.rejects(reserveTenantSlug({ db, slug: "slug-antigo", tenantId, clock: fixedClock }), { code: "SLUG_UNAVAILABLE" });
});

test("helpers não são expostos como Function ou comando de ADMIN comum", async () => {
  const [{ readFile }, { default: path }] = await Promise.all([import("node:fs/promises"), import("node:path")]);
  const root = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/(.:)/, "$1"));
  const [indexSource, runtimeSource] = await Promise.all([
    readFile(path.join(root, "functions", "index.js"), "utf8"),
    readFile(path.join(root, "functions", "dual-write.js"), "utf8"),
  ]);
  assert.doesNotMatch(indexSource, /tenantSlug|reserveTenantSlug|resolveTenantSlug/);
  assert.doesNotMatch(runtimeSource, /admin\.tenant|admin\.slug|tenant\.slug/);
});
