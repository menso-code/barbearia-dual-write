import test from "node:test";
import assert from "node:assert/strict";
import { fixturePlan, parseArgs, provision, reset, tenantIdForSlug, validateOptions } from "./hml-fixture-provisioner.mjs";

test("dry-run é padrão e exige projeto e tenant explícitos", async () => {
  const options = parseArgs(["--project=teste-483f6", "--tenant-slug=qa-slice32", "--admin-email=a@example.invalid", "--barber-email=b@example.invalid", "--client-email=c@example.invalid"]);
  assert.equal(options.dryRun, true);
  const result = await provision(options);
  assert.equal(result.mode, "dry-run");
  assert.equal(result.writes, 0);
});

test("produção e fallback Antunes são rejeitados", () => {
  assert.throws(() => validateOptions({ project: "barber-a01e7", tenantSlug: "qa-slice32", apply: false }), /HML_PROJECT_REQUIRED/);
  assert.throws(() => tenantIdForSlug("antunes"), /IMPLICIT_ANTUNES/);
  assert.throws(() => validateOptions({ project: "teste-483f6", tenantSlug: "antunes", apply: false }), /IMPLICIT_ANTUNES/);
});

test("tenant ID é determinístico e caminhos são tenant-scoped", () => {
  const plan = fixturePlan({ project: "teste-483f6", tenantSlug: "qa-slice32", apply: false });
  assert.equal(plan.tenantId, tenantIdForSlug("qa-slice32"));
  assert.ok(plan.resources.every((item) => item.memberPath.startsWith(`barbearias/${plan.tenantId}/`)));
});

test("apply exige confirmação explícita e reset exige manifesto", () => {
  assert.throws(() => validateOptions({ project: "teste-483f6", tenantSlug: "qa-slice32", apply: true, confirm: false }), /CONFIRMATION/);
  assert.doesNotThrow(() => validateOptions({ project: "teste-483f6", tenantSlug: "qa-slice32", reset: true, apply: false, manifest: "x" }));
});

test("reset dry-run não acessa SDK nem escreve", async () => {
  const manifest = { kind: "HML_FIXTURE_MANIFEST", project: "teste-483f6", tenantId: tenantIdForSlug("qa-slice32"), slug: "qa-slice32", resources: [], users: {} };
  const fs = await import("node:fs/promises");
  const path = `${process.cwd()}/.tmp-hml-fixture-manifest.json`;
  await fs.writeFile(path, JSON.stringify(manifest));
  const result = await reset({ project: "teste-483f6", tenantSlug: "qa-slice32", reset: true, apply: false, dryRun: true, manifest: path });
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
    await assert.rejects(() => provision({ project: "teste-483f6", tenantSlug: "qa-slice32", apply: true, dryRun: false, confirm: true, adminEmail: "a@example.invalid", barberEmail: "b@example.invalid", clientEmail: "c@example.invalid" }, { sdk: async () => ({ auth, db }) }), /INJECTED_FIRESTORE_FAILURE/);
    assert.deepEqual(deleted.sort(), ["created-1", "created-2", "created-3"]);
  } finally {
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
