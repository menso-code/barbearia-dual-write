import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  HML_PROJECT,
  PRODUCTION_PROJECT,
  buildProvisioningPlan,
  createResetManifest,
  generateTenantId,
  hashDocument,
  parseArgs,
  provisionTenant,
  resetTenantFromManifest,
  validateOptions,
  writeManifest,
} from "./tenant-provisioner.mjs";

const TENANT_ID = "tnt_0123456789abcdef0123456789abcdef";
const INPUT = Object.freeze({
  project: HML_PROJECT,
  slug: "goestudioapp-qa-b",
  hostname: "goestudioapp-qa-b.web.app",
  name: "GoEstudio QA B",
});
const APPLY_INPUT = Object.freeze({ ...INPUT, confirmation: `${HML_PROJECT}:APPLY` });

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function snapshot(value) {
  return Object.freeze({
    exists: value !== undefined,
    data: () => value,
  });
}

class MemoryFirestore {
  constructor(seed = {}) {
    this.store = new Map(Object.entries(clone(seed)));
    this.writes = [];
  }

  doc(path) {
    return { path };
  }

  async runTransaction(callback) {
    const tx = {
      get: async (ref) => snapshot(this.store.has(ref.path) ? this.store.get(ref.path) : undefined),
      create: (ref, data) => {
        if (this.store.has(ref.path)) throw new Error("already-exists");
        this.store.set(ref.path, clone(data));
        this.writes.push(["create", ref.path]);
      },
      delete: (ref) => {
        this.store.delete(ref.path);
        this.writes.push(["delete", ref.path]);
      },
    };
    return callback(tx);
  }
}

function fixedPlan() {
  return buildProvisioningPlan({ ...INPUT, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" });
}

test("happy path creates exactly the canonical tenant triplet", async () => {
  const db = new MemoryFirestore();
  const result = await provisionTenant({ db, options: APPLY_INPUT, dryRun: false, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" });
  assert.equal(result.status, "CREATED");
  assert.equal(db.writes.length, 3);
  assert.equal(db.store.get("barbearias/" + TENANT_ID).writeMode, undefined);
  assert.equal(db.store.get("tenant_slugs/goestudioapp-qa-b").tenantId, TENANT_ID);
  assert.equal(db.store.get("tenant_hostnames/goestudioapp-qa-b.web.app").tenantId, TENANT_ID);
});

test("dry-run has no writes and does not accept an external tenant id", async () => {
  const db = new MemoryFirestore();
  const result = await provisionTenant({ db, options: INPUT, dryRun: true, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" });
  assert.equal(result.status, "DRY_RUN");
  assert.equal(result.writes, 0);
  assert.equal(db.writes.length, 0);
  assert.throws(() => parseArgs(["--project=teste-483f6", "--tenant-id=attacker"]), /UNKNOWN_OPTION/);
  assert.match(generateTenantId(), /^tnt_[a-f0-9]{32}$/);
});

test("duplicate slug, hostname, partial state and divergent indexes fail closed", async (t) => {
  const plan = fixedPlan();
  const cases = [
    ["duplicate slug", { [plan.paths.slugIndex]: plan.documents.slugIndex }],
    ["duplicate hostname", { [plan.paths.hostnameIndex]: plan.documents.hostnameIndex }],
    ["partial tenant", { [plan.paths.tenant]: plan.documents.tenant }],
    ["divergent indexes", {
      [plan.paths.slugIndex]: plan.documents.slugIndex,
      [plan.paths.hostnameIndex]: { ...plan.documents.hostnameIndex, tenantId: "tnt_abcdefabcdefabcdefabcdefabcdefab" },
    }],
  ];
  for (const [name, seed] of cases) {
    await t.test(name, async () => {
      const db = new MemoryFirestore(seed);
      await assert.rejects(
        provisionTenant({ db, options: APPLY_INPUT, dryRun: false, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" }),
        /PARTIAL_STATE|DIVERGENT_INDEXES|DIVERGENT_EXISTING_STATE/,
      );
      assert.equal(db.writes.length, 0);
    });
  }
});

test("same canonical state is idempotent and never overwrites", async () => {
  const first = new MemoryFirestore();
  const created = await provisionTenant({ db: first, options: APPLY_INPUT, dryRun: false, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" });
  const before = clone(Object.fromEntries(first.store));
  first.writes.length = 0;
  const replay = await provisionTenant({ db: first, options: APPLY_INPUT, dryRun: false, tenantIdFactory: () => "tnt_fedcbafedcbafedcbafedcbafedcbafe", clock: () => "different-time" });
  assert.equal(created.status, "CREATED");
  assert.equal(replay.status, "IDEMPOTENT");
  assert.equal(first.writes.length, 0);
  assert.deepEqual(Object.fromEntries(first.store), before);
});

test("project guard rejects production and other projects", () => {
  assert.throws(() => validateOptions({ ...INPUT, project: PRODUCTION_PROJECT }), /PRODUCTION_PROJECT_FORBIDDEN/);
  assert.throws(() => validateOptions({ ...INPUT, project: "other-project" }), /HML_PROJECT_REQUIRED/);
});

test("apply and reset require explicit confirmations", () => {
  assert.throws(() => validateOptions({ ...INPUT, apply: true, confirmation: "" }), /EXPLICIT_HML_APPLY_CONFIRMATION_REQUIRED/);
  assert.throws(() => validateOptions({ project: HML_PROJECT, reset: true, manifest: "x", confirmation: "" }), /EXPLICIT_RESET_CONFIRMATION_REQUIRED/);
});

test("reset uses the manifest, verifies hashes, and blocks dependencies", async () => {
  const db = new MemoryFirestore();
  const plan = fixedPlan();
  const result = await provisionTenant({ db, options: APPLY_INPUT, dryRun: false, tenantIdFactory: () => TENANT_ID, clock: () => "fixed-time" });
  const manifest = createResetManifest({ plan, result: result.result, createdAt: "fixed" });
  const blocked = await assert.rejects(
    resetTenantFromManifest({ db, manifest, dependencyChecker: async () => true }),
    /RESET_DEPENDENCIES_EXIST/,
  );
  assert.equal(blocked, undefined);
  assert.equal(db.store.size, 3);
  const reset = await resetTenantFromManifest({ db, manifest, dependencyChecker: async () => false });
  assert.equal(reset.status, "RESET");
  assert.equal(db.store.size, 0);
  const replay = await resetTenantFromManifest({ db, manifest, dependencyChecker: async () => false });
  assert.equal(replay.status, "ALREADY_RESET");
});

test("reset blocks changed resources and manifest persistence contains no secret fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tenant-provisioner-"));
  try {
    const plan = fixedPlan();
    const manifest = createResetManifest({ plan, createdAt: "fixed" });
    const path = join(directory, "manifest.json");
    await writeManifest(path, manifest);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.resetSupported, true);
    assert.equal(Object.hasOwn(persisted, "password"), false);
    assert.equal(Object.hasOwn(persisted, "token"), false);
    const db = new MemoryFirestore({
      [plan.paths.tenant]: { ...plan.documents.tenant, nome: "changed" },
      [plan.paths.slugIndex]: plan.documents.slugIndex,
      [plan.paths.hostnameIndex]: plan.documents.hostnameIndex,
    });
    await assert.rejects(
      resetTenantFromManifest({ db, manifest, dependencyChecker: async () => false }),
      /RESET_RESOURCE_CHANGED/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("plan has canonical V2-only compatibility and no legacy dependency", () => {
  const plan = fixedPlan();
  assert.equal(plan.writeModePersisted, false);
  assert.equal(plan.expectedRuntimeWriteMode, "V2_ONLY");
  assert.equal(plan.documents.tenant.writeMode, undefined);
  assert.equal(plan.documents.tenant.tenant_id, TENANT_ID);
  assert.equal(hashDocument(plan.documents.tenant), hashDocument({ ...plan.documents.tenant, createdAt: "other", updatedAt: "other" }));
});
