import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import {
  canonicalTenantRedirectUrl,
  createTrustedTenantHostnameResolver,
  executeCanonicalTenantRedirect,
  normalizeTenantHostnameResolution,
} from "../public/js/tenant-hostname-resolver-core.mjs";

test("adapter envia somente hostname e normaliza ACTIVE", async () => {
  const calls = [];
  const resolver = createTrustedTenantHostnameResolver({
    invoke: async (payload) => {
      calls.push(payload);
      return { kind: "active", tenantId: "tenant-a", slug: "estudioativo" };
    },
  });
  assert.deepEqual(await resolver({
    hostname: "EstudioAtivo.GoEstudio.Com.Br",
    tenantId: "client-controlled-ignored",
  }), { kind: "ACTIVE", tenantId: "tenant-a", slug: "estudioativo" });
  assert.deepEqual(calls, [{ hostname: "estudioativo.goestudio.com.br" }]);
});

test("REDIRECT preserva destino e navegação canônica", () => {
  assert.deepEqual(normalizeTenantHostnameResolution({
    kind: "REDIRECT",
    slug: "slugantigo",
    redirectToSlug: "slugnovo",
  }), { kind: "REDIRECT", slug: "slugantigo", redirectToSlug: "slugnovo" });
  assert.equal(canonicalTenantRedirectUrl({
    redirectToSlug: "slugnovo",
    location: { pathname: "/admin.html", search: "?tab=agenda", hash: "#hoje" },
  }), "https://slugnovo.goestudio.com.br/admin.html?tab=agenda#hoje");

  let replacedWith = "";
  executeCanonicalTenantRedirect({
    redirectToSlug: "slugnovo",
    location: { pathname: "/", search: "", hash: "", replace: (target) => { replacedWith = target; } },
  });
  assert.equal(replacedWith, "https://slugnovo.goestudio.com.br/");
});

test("UNKNOWN e UNAVAILABLE permanecem fail-closed", () => {
  assert.deepEqual(normalizeTenantHostnameResolution({ kind: "NOT_FOUND" }), { kind: "NOT_FOUND" });
  assert.deepEqual(normalizeTenantHostnameResolution({ kind: "UNAVAILABLE", slug: "inativo" }), {
    kind: "UNAVAILABLE",
    slug: "inativo",
  });
  assert.throws(() => normalizeTenantHostnameResolution({ kind: "ACTIVE", slug: "estudioativo" }));
  assert.throws(() => normalizeTenantHostnameResolution({
    kind: "REDIRECT",
    slug: "mesmoslug",
    redirectToSlug: "mesmoslug",
  }));
});

test("wiring registra callable confiável antes do bootstrap e não mantém fallback de host", async () => {
  const root = new URL("../", import.meta.url);
  const read = (path) => readFile(new URL(path, root), "utf8");
  const [adapter, context, core, commands] = await Promise.all([
    read("public/js/tenant-hostname-resolver.js"),
    read("public/js/tenant-context.js"),
    read("public/js/tenant-context-core.mjs"),
    read("public/js/operational-commands.js"),
  ]);
  assert.match(adapter, /httpsCallable\(functions, "resolveTenantHostname"\)/);
  assert.doesNotMatch(adapter, /operational-commands|executeOperationalCommand|requestId|tenantId\s*:/);
  assert.ok(
    context.indexOf("registerTrustedTenantHostnameResolver(resolveTenantHostname)")
      < context.indexOf("export function initializeTenantContext"),
    "resolver deve ser registrado antes do bootstrap",
  );
  assert.doesNotMatch(context, /LEGACY_FIREBASE_COMPAT|barber-a01e7\.(?:web\.app|firebaseapp\.com)/);
  assert.match(context, /localhost/);
  assert.match(context, /127\.0\.0\.1/);
  assert.match(context, /redirectToCanonicalTenantHostname/);
  assert.match(core, /REDIRECT/);
  assert.doesNotMatch(`${adapter}\n${context}`, /x-forwarded-host|forwarded-host/i);
  assert.doesNotMatch(commands, /resolveTenantHostname/);
});
