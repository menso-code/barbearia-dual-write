import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  TENANT_CONTEXT_SOURCES,
  TENANT_CONTEXT_STATES,
  createTenantContextManager,
  tenantScopedCacheKey,
} from "../public/js/tenant-context-core.mjs";

const fixture = Object.freeze({ tenantId: "tenant-a", slug: "studio-a" });
const legacyCompat = Object.freeze({
  ...fixture,
  hostnames: Object.freeze(["legacy.example.test"]),
});

test("TenantContext inicializa uma vez e compartilha a mesma promise", async () => {
  let release;
  const resolver = new Promise((resolve) => { release = resolve; });
  const manager = createTenantContextManager({ resolveHostname: () => resolver });
  const first = manager.initialize({ hostname: "studio-a.goestudio.com.br" });
  const replay = manager.initialize({ hostname: "studio-a.goestudio.com.br" });
  assert.strictEqual(first, replay);
  assert.equal(manager.get().status, TENANT_CONTEXT_STATES.RESOLVING);
  release({ kind: "ACTIVE", ...fixture });
  assert.deepEqual(await first, {
    status: TENANT_CONTEXT_STATES.READY,
    ...fixture,
    source: TENANT_CONTEXT_SOURCES.HOSTNAME,
  });
  assert.deepEqual(manager.requireReady(), await replay);
});

test("hostname desconhecido não possui fallback para Antunes", async () => {
  const manager = createTenantContextManager();
  const context = await manager.initialize({ hostname: "desconhecido.example.com" });
  assert.equal(context.status, TENANT_CONTEXT_STATES.NOT_FOUND);
  assert.equal(context.tenantId, "");
  assert.throws(() => manager.requireReady(), /não está disponível/);
});

test("tenant indisponível e erro bloqueiam bootstrap de dados", async () => {
  const unavailable = createTenantContextManager({
    resolveHostname: async () => ({ kind: "UNAVAILABLE" }),
  });
  assert.equal(
    (await unavailable.initialize({ hostname: "offline.goestudio.com.br" })).status,
    TENANT_CONTEXT_STATES.UNAVAILABLE,
  );
  assert.throws(() => unavailable.requireReady());

  const failed = createTenantContextManager({
    resolveHostname: async () => { throw new Error("network"); },
  });
  assert.equal(
    (await failed.initialize({ hostname: "erro.goestudio.com.br" })).status,
    TENANT_CONTEXT_STATES.ERROR,
  );
  assert.throws(() => failed.requireReady());
});

test("redirect de slug não inicia contexto tenant na mesma página", async () => {
  const manager = createTenantContextManager({
    resolveHostname: async () => ({ kind: "REDIRECT", redirectToSlug: "novo-slug" }),
  });
  const context = await manager.initialize({ hostname: "antigo.goestudio.com.br" });
  assert.equal(context.status, TENANT_CONTEXT_STATES.UNAVAILABLE);
  assert.equal(context.tenantId, "");
  assert.throws(() => manager.requireReady());
});

test("fixture local é explícita e não fica disponível em modo produção", async () => {
  const development = createTenantContextManager({ devFixture: fixture });
  assert.deepEqual(await development.initialize({ hostname: "localhost", mode: "development" }), {
    status: TENANT_CONTEXT_STATES.READY,
    ...fixture,
    source: TENANT_CONTEXT_SOURCES.DEV_FIXTURE,
  });

  const production = createTenantContextManager({ devFixture: fixture });
  assert.equal(
    (await production.initialize({ hostname: "localhost", mode: "production" })).status,
    TENANT_CONTEXT_STATES.NOT_FOUND,
  );

  const implicit = createTenantContextManager();
  assert.equal(
    (await implicit.initialize({ hostname: "localhost", mode: "development" })).status,
    TENANT_CONTEXT_STATES.NOT_FOUND,
  );
});

test("LEGACY_COMPAT aceita somente hostname explicitamente permitido", async () => {
  const allowed = createTenantContextManager({ legacyCompat });
  assert.deepEqual(await allowed.initialize({ hostname: "legacy.example.test" }), {
    status: TENANT_CONTEXT_STATES.READY,
    ...fixture,
    source: TENANT_CONTEXT_SOURCES.LEGACY_COMPAT,
  });
  const denied = createTenantContextManager({ legacyCompat });
  assert.equal(
    (await denied.initialize({ hostname: "unknown.example.test" })).status,
    TENANT_CONTEXT_STATES.NOT_FOUND,
  );
});

test("segunda tentativa de tenant na mesma sessão é rejeitada", async () => {
  const manager = createTenantContextManager({ legacyCompat });
  await manager.initialize({ hostname: "legacy.example.test" });
  await assert.rejects(
    manager.initialize({ hostname: "outro.example.test" }),
    { code: "SECOND_TENANT_INITIALIZATION" },
  );
  assert.equal(manager.requireReady().tenantId, fixture.tenantId);
});

test("cache tenant-scoped não permite namespace global", () => {
  assert.equal(tenantScopedCacheKey("tenant-a", "identity"), "tenant:tenant-a:identity");
  assert.throws(() => tenantScopedCacheKey("", "identity"));
  assert.throws(() => tenantScopedCacheKey("tenant-a", ""));
});

test("integração frontend mantém autorização no servidor e compatibilidade isolada", async () => {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFile(new URL(path, root), "utf8");
  const [browser, core, studio, admin, firebaseConfig, tenant, commands, runtime] = await Promise.all([
    read("public/js/tenant-context.js"),
    read("public/js/tenant-context-core.mjs"),
    read("public/js/admin-studio-settings.js"),
    read("public/js/admin.js"),
    read("public/js/firebase-config.js"),
    read("public/js/tenant.js"),
    read("public/js/operational-commands.js"),
    read("functions/dual-write.js"),
  ]);

  assert.match(browser, /barber-a01e7\.web\.app/);
  assert.match(browser, /registerTrustedTenantHostnameResolver/);
  assert.doesNotMatch(`${browser}\n${core}`, /localStorage|sessionStorage|URLSearchParams/);
  assert.doesNotMatch(core, /tnt_80b2|\bantunes\b/i);
  assert.match(tenant, /BARBEARIA_PADRAO_ID/);
  assert.match(firebaseConfig, /BARBEARIA_ATUAL_ID = getBarbeariaAtual\(\)/);
  assert.doesNotMatch(studio, /BARBEARIA_ATUAL_ID/);
  assert.match(studio, /initializeTenantContext\(\)/);
  assert.match(studio, /tenantContext\.status !== TENANT_CONTEXT_STATES\.READY/);
  assert.match(studio, /doc\(db, "barbearias", tenantContext\.tenantId, "configuracoes", "identidade"\)/);
  assert.match(studio, /await waitForAdminAccessGuard\(\)/);
  assert.match(admin, /admin:access-state/);
  assert.doesNotMatch(commands, /tenantId\s*:/);
  assert.doesNotMatch(runtime, /tenant-context|CLIENT_TENANT_CONTEXT/);
});
