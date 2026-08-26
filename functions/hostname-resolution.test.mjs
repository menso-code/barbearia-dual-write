import assert from "node:assert/strict";
import test from "node:test";
import {
  GOESTUDIO_PUBLIC_BASE_DOMAINS,
  HOSTNAME_RESOLUTION_KINDS,
  parseGoEstudioTenantHostname,
  resolveGoEstudioHostname,
  slugTenantCacheKey,
  tenantIdentityCacheKey,
} from "./hostname-resolution.mjs";

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
  }
  doc(path) {
    return { path, get: async () => new Snapshot(this.documents.get(path)) };
  }
}

const tenantId = "tenant-a";
const activeSeed = {
  "tenant_slugs/barbeariaantunes": { tenantId, status: "ACTIVE" },
  [`barbearias/${tenantId}`]: { slug: "barbeariaantunes", status: "ACTIVE" },
};

test("hostname válido produz slug canônico, remove porta e normaliza caixa", () => {
  assert.equal(Object.isFrozen(GOESTUDIO_PUBLIC_BASE_DOMAINS), true);
  assert.deepEqual(GOESTUDIO_PUBLIC_BASE_DOMAINS, ["goestudio.com.br"]);
  assert.deepEqual(parseGoEstudioTenantHostname("BarbeariaAntunes.GoEstudio.Com.Br:443"), {
    hostname: "barbeariaantunes.goestudio.com.br",
    baseDomain: "goestudio.com.br",
    slug: "barbeariaantunes",
  });
});

test("allowlist rejeita raiz, reservado, múltiplos níveis, sufixos falsos, xn-- e host inválido", () => {
  const invalidHosts = [
    "goestudio.com.br",
    "www.goestudio.com.br",
    "foo.bar.goestudio.com.br",
    "evilgoestudio.com.br",
    "goestudio.com.br.evil.com",
    "xn--tenant.goestudio.com.br",
    "tenant_goestudio.com.br",
    "tenant.goestudio.com.br:99999",
  ];
  invalidHosts.forEach((hostname) => assert.throws(() => parseGoEstudioTenantHostname(hostname)));
});

test("localhost não possui fallback de tenant", async () => {
  const result = await resolveGoEstudioHostname({ db: new MemoryFirestore(activeSeed), hostname: "localhost:8080" });
  assert.deepEqual(result, { kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND });
});

test("slug ACTIVE resolve tenantId somente após tenant ativo e consistente", async () => {
  const result = await resolveGoEstudioHostname({
    db: new MemoryFirestore(activeSeed),
    hostname: "barbeariaantunes.goestudio.com.br",
    tenantId: "client-controlled-ignored",
  });
  assert.deepEqual(result, {
    kind: HOSTNAME_RESOLUTION_KINDS.ACTIVE,
    slug: "barbeariaantunes",
    tenantId,
  });
});

test("REDIRECT retorna destino explícito sem resolver contexto tenant", async () => {
  const db = new MemoryFirestore({
    "tenant_slugs/slugantigo": { tenantId, status: "REDIRECT", redirectToSlug: "slugnovo" },
    "tenant_slugs/slugnovo": { tenantId, status: "ACTIVE" },
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "slugantigo.goestudio.com.br" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.REDIRECT,
    slug: "slugantigo",
    redirectToSlug: "slugnovo",
  });
});

test("RETIRED fica indisponível e slug desconhecido retorna not found", async () => {
  const db = new MemoryFirestore({
    "tenant_slugs/slugretired": { tenantId, status: "RETIRED" },
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "slugretired.goestudio.com.br" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE,
    slug: "slugretired",
  });
  assert.deepEqual(await resolveGoEstudioHostname({ db, hostname: "slugunknown.goestudio.com.br" }), {
    kind: HOSTNAME_RESOLUTION_KINDS.NOT_FOUND,
    slug: "slugunknown",
  });
});

test("tenant ausente, inativo ou inconsistente falha fechado", async () => {
  const variants = [
    { "tenant_slugs/tenantpublic": { tenantId, status: "ACTIVE" } },
    {
      "tenant_slugs/tenantpublic": { tenantId, status: "ACTIVE" },
      [`barbearias/${tenantId}`]: { slug: "tenantpublic", status: "SUSPENDED" },
    },
    {
      "tenant_slugs/tenantpublic": { tenantId, status: "ACTIVE" },
      [`barbearias/${tenantId}`]: { slug: "outroslug", status: "ACTIVE" },
    },
  ];
  for (const seed of variants) {
    assert.deepEqual(
      await resolveGoEstudioHostname({ db: new MemoryFirestore(seed), hostname: "tenantpublic.goestudio.com.br" }),
      { kind: HOSTNAME_RESOLUTION_KINDS.UNAVAILABLE, slug: "tenantpublic" },
    );
  }
});

test("cache keys são sempre namespaced por slug e tenant", () => {
  assert.equal(slugTenantCacheKey("Barbearia Antunes"), "slug:barbeariaantunes:tenant");
  assert.equal(tenantIdentityCacheKey("tenant-a"), "tenant:tenant-a:identity");
});

test("camada permanece isolada do bootstrap global, dispatcher e Functions exportadas", async () => {
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
  assert.doesNotMatch(contextSource, /parseGoEstudioTenantHostname|GOESTUDIO_PUBLIC_BASE_DOMAINS/);
  assert.doesNotMatch(indexSource, /resolveGoEstudioHostname|hostname-resolution/);
  assert.doesNotMatch(runtimeSource, /resolveGoEstudioHostname|hostname-resolution/);
  assert.doesNotMatch(resolverSource, /x-forwarded-host|forwarded-host/i);
});
