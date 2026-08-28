import test from "node:test";
import assert from "node:assert/strict";
import {
  fixturePlan,
  parseArgs,
  provision,
  reset,
  resolveOfficialTenant,
  HML_TENANT_ENVIRONMENT,
  validateOptions,
} from "./hml-fixture-provisioner.mjs";

const OFFICIAL_TENANT_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";

function memoryDb(documents) {
  return {
    doc(path) {
      return {
        path,
        async get() {
          const value = documents[path];
          return { exists: value !== undefined, data: () => value };
        },
      };
    },
  };
}

function officialDocuments(overrides = {}) {
  return {
    "tenant_slugs/goestudioapp": {
      tenantId: OFFICIAL_TENANT_ID,
      status: "ACTIVE",
    },
    [`barbearias/${OFFICIAL_TENANT_ID}`]: {
      tenant_id: OFFICIAL_TENANT_ID,
      slug: "goestudioapp",
      status: "ACTIVE",
      ambiente: HML_TENANT_ENVIRONMENT,
    },
    ...overrides,
  };
}

test("dry-run é padrão e exige projeto e tenant explícitos", async () => {
  const options = parseArgs(["--project=teste-483f6", "--tenant-slug=qa-slice32", "--admin-email=a@example.invalid", "--barber-email=b@example.invalid", "--client-email=c@example.invalid"]);
  assert.equal(options.dryRun, true);
  const result = await provision(options, {
    sdk: async () => ({ db: memoryDb({
      "tenant_slugs/qa-slice32": { tenantId: "tenant-qa", status: "ACTIVE" },
      "barbearias/tenant-qa": { tenant_id: "tenant-qa", slug: "qa-slice32", status: "ACTIVE", ambiente: HML_TENANT_ENVIRONMENT },
    }) }),
  });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.writes, 0);
});

test("produção e fallback Antunes são rejeitados", () => {
  assert.throws(() => validateOptions({ project: "barber-a01e7", tenantSlug: "qa-slice32", apply: false }), /HML_PROJECT_REQUIRED/);
  assert.throws(() => validateOptions({ project: "teste-483f6", tenantSlug: "antunes", apply: false }), /IMPLICIT_ANTUNES/);
});

test("slug oficial resolve o tenant existente e o plano não gera qa_*", async () => {
  const resolution = await resolveOfficialTenant({ db: memoryDb(officialDocuments()), tenantSlug: "goestudioapp" });
  assert.deepEqual(resolution, {
    tenantId: OFFICIAL_TENANT_ID,
    slug: "goestudioapp",
    source: "tenant_slugs/goestudioapp",
  });
  const plan = fixturePlan({ project: "teste-483f6", tenantSlug: "goestudioapp", apply: false }, resolution);
  assert.equal(plan.tenantId, OFFICIAL_TENANT_ID);
  assert.doesNotMatch(plan.tenantId, /^qa_/);
  assert.ok(plan.resources.every((item) => item.memberPath.startsWith(`barbearias/${plan.tenantId}/`)));
});

test("slug inexistente falha fechado", async () => {
  await assert.rejects(
    resolveOfficialTenant({ db: memoryDb({}), tenantSlug: "unknown-tenant" }),
    /TENANT_RESOLUTION_FAILED:SLUG_NOT_FOUND/,
  );
});

test("índice inconsistente falha fechado", async () => {
  await assert.rejects(
    resolveOfficialTenant({
      db: memoryDb(officialDocuments({
        [`barbearias/${OFFICIAL_TENANT_ID}`]: { tenant_id: OFFICIAL_TENANT_ID, slug: "other-slug", status: "ACTIVE", ambiente: HML_TENANT_ENVIRONMENT },
      })),
      tenantSlug: "goestudioapp",
    }),
    /TENANT_RESOLUTION_FAILED:TENANT_SLUG_MISMATCH/,
  );
});

test("tenant inativo falha fechado", async () => {
  await assert.rejects(
    resolveOfficialTenant({
      db: memoryDb(officialDocuments({
        [`barbearias/${OFFICIAL_TENANT_ID}`]: { tenant_id: OFFICIAL_TENANT_ID, slug: "goestudioapp", status: "INACTIVE", ambiente: HML_TENANT_ENVIRONMENT },
      })),
      tenantSlug: "goestudioapp",
    }),
    /TENANT_DOCUMENT_MISMATCH/,
  );
});

test("dry-run usa o tenant oficial resolvido pelo índice canônico", async () => {
  const options = parseArgs([
    "--project=teste-483f6",
    "--tenant-slug=goestudioapp",
    "--admin-email=admin@example.invalid",
    "--barber-email=barber@example.invalid",
    "--client-email=client@example.invalid",
  ]);
  const result = await provision(options, { sdk: async () => ({ db: memoryDb(officialDocuments()) }) });
  assert.equal(result.mode, "dry-run");
  assert.equal(result.plan.tenantId, OFFICIAL_TENANT_ID);
  assert.equal(result.plan.slug, "goestudioapp");
  assert.doesNotMatch(result.plan.tenantId, /^qa_/);
});

test("apply exige confirmação explícita e reset exige manifesto", () => {
  assert.throws(() => validateOptions({ project: "teste-483f6", tenantSlug: "qa-slice32", apply: true, confirm: false }), /CONFIRMATION/);
  assert.doesNotThrow(() => validateOptions({ project: "teste-483f6", tenantSlug: "qa-slice32", reset: true, apply: false, manifest: "x" }));
});

test("reset dry-run não acessa SDK nem escreve", async () => {
  const manifest = { kind: "HML_FIXTURE_MANIFEST", project: "teste-483f6", tenantId: OFFICIAL_TENANT_ID, slug: "goestudioapp", resources: [], users: {} };
  const fs = await import("node:fs/promises");
  const path = `${process.cwd()}/.tmp-hml-fixture-manifest.json`;
  await fs.writeFile(path, JSON.stringify(manifest));
  const result = await reset(
    { project: "teste-483f6", tenantSlug: "goestudioapp", reset: true, apply: false, dryRun: true, manifest: path },
    { sdk: async () => ({ db: memoryDb(officialDocuments()) }) },
  );
  assert.equal(result.mode, "dry-run");
  await fs.rm(path);
});

test("falha após criação de Auth remove apenas usuários recém-criados", async () => {
  const deleted = [];
  let nextUid = 0;
  const auth = {
    async getUserByEmail() { const error = new Error("missing"); error.code = "auth/user-not-found"; throw error; },
    async createUser() { nextUid += 1; return { uid: `created-${nextUid}` }; },
    async deleteUser(uid) { deleted.push(uid); },
  };
  const db = { doc(path) { return { path }; }, async runTransaction() { throw new Error("INJECTED_FIRESTORE_FAILURE"); } };
  const previous = Object.fromEntries(["ADMIN", "BARBER", "CLIENT"].map((role) => [`HML_FIXTURE_${role}_PASSWORD`, process.env[`HML_FIXTURE_${role}_PASSWORD`]]));
  for (const key of Object.keys(previous)) process.env[key] = "synthetic-only";
  try {
    await assert.rejects(() => provision({ project: "teste-483f6", tenantSlug: "goestudioapp", apply: true, dryRun: false, confirm: true, adminEmail: "a@example.invalid", barberEmail: "b@example.invalid", clientEmail: "c@example.invalid" }, {
      sdk: async () => ({ auth, db }),
      resolveTenant: async () => ({ tenantId: OFFICIAL_TENANT_ID, slug: "goestudioapp", source: "tenant_slugs/goestudioapp" }),
    }), /INJECTED_FIRESTORE_FAILURE/);
    assert.deepEqual(deleted.sort(), ["created-1", "created-2", "created-3"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
