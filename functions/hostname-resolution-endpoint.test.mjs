import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { resolveTenantHostnameRequest } from "./hostname-resolution-endpoint.mjs";

class Snapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return structuredClone(this.value);
  }
}

class ReadOnlyFirestore {
  constructor(seed = {}) {
    this.documents = new Map(Object.entries(structuredClone(seed)));
    this.readPaths = [];
  }

  doc(path) {
    return {
      get: async () => {
        this.readPaths.push(path);
        return new Snapshot(this.documents.get(path));
      },
    };
  }
}

const tenantId = "tenant-a";

test("endpoint read-only resolve ACTIVE sem aceitar tenantId do cliente", async () => {
  const firestore = new ReadOnlyFirestore({
    "tenant_slugs/estudioativo": { tenantId, status: "ACTIVE" },
    [`barbearias/${tenantId}`]: { slug: "estudioativo", status: "ACTIVE" },
  });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore,
    data: { hostname: "estudioativo.goestudio.com.br" },
  }), {
    kind: "ACTIVE",
    slug: "estudioativo",
    tenantId,
  });
  await assert.rejects(
    resolveTenantHostnameRequest({
      firestore,
      data: { hostname: "estudioativo.goestudio.com.br", tenantId: "tenant-b" },
    }),
    /Campos não permitidos/,
  );
});

test("endpoint preserva REDIRECT e falha fechado para UNKNOWN/UNAVAILABLE", async () => {
  const redirectDb = new ReadOnlyFirestore({
    "tenant_slugs/slugantigo": { tenantId, status: "REDIRECT", redirectToSlug: "slugnovo" },
    "tenant_slugs/slugnovo": { tenantId, status: "ACTIVE" },
  });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore: redirectDb,
    data: { hostname: "slugantigo.goestudio.com.br" },
  }), { kind: "REDIRECT", slug: "slugantigo", redirectToSlug: "slugnovo" });

  const unavailableDb = new ReadOnlyFirestore({
    "tenant_slugs/estudioinativo": { tenantId, status: "RETIRED" },
  });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore: unavailableDb,
    data: { hostname: "estudioinativo.goestudio.com.br" },
  }), { kind: "UNAVAILABLE", slug: "estudioinativo" });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore: unavailableDb,
    data: { hostname: "desconhecido.goestudio.com.br" },
  }), { kind: "NOT_FOUND", slug: "desconhecido" });
});

test("endpoint não entra no dispatcher operacional nem possui efeitos de escrita", async () => {
  const root = new URL("./", import.meta.url);
  const [endpoint, index, dispatcher] = await Promise.all([
    readFile(new URL("hostname-resolution-endpoint.mjs", root), "utf8"),
    readFile(new URL("index.js", root), "utf8"),
    readFile(new URL("dual-write.js", root), "utf8"),
  ]);
  assert.match(index, /export \{ resolveTenantHostname \} from "\.\/hostname-resolution-endpoint\.mjs"/);
  assert.doesNotMatch(dispatcher, /resolveTenantHostname|agenda\.hostname|hostname\.resolver/i);
  assert.doesNotMatch(endpoint, /executeOperationalCommand|requestId|idempot/i);
  assert.doesNotMatch(endpoint, /\.(?:set|create|update|delete)\s*\(/);
  assert.doesNotMatch(endpoint, /runTransaction|x-forwarded-host|forwarded-host/i);
});
