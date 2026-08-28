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
    "tenant_hostnames/estudio.example": { tenantId },
    [`barbearias/${tenantId}`]: { slug: "estudio-renamed", status: "ACTIVE" },
  });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore,
    data: { hostname: "estudio.example" },
  }), {
    kind: "ACTIVE",
    hostname: "estudio.example",
    slug: "estudio-renamed",
    tenantId,
  });
  await assert.rejects(
    resolveTenantHostnameRequest({
      firestore,
      data: { hostname: "estudio.example", tenantId: "tenant-b" },
    }),
    /Campos não permitidos/,
  );
});

test("endpoint falha fechado para hostname ausente e tenant indisponível", async () => {
  const unavailableDb = new ReadOnlyFirestore({
    "tenant_hostnames/estudio-inativo.example": { tenantId },
    [`barbearias/${tenantId}`]: { slug: "estudio-inativo", status: "RETIRED" },
  });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore: unavailableDb,
    data: { hostname: "estudio-inativo.example" },
  }), { kind: "UNAVAILABLE", hostname: "estudio-inativo.example" });
  assert.deepEqual(await resolveTenantHostnameRequest({
    firestore: unavailableDb,
    data: { hostname: "desconhecido.example" },
  }), { kind: "NOT_FOUND" });
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
