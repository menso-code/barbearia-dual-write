import assert from "node:assert/strict";
import test from "node:test";
import { inspectTenantMembershipRequest } from "./tenant-membership-inspection.mjs";

class Snapshot {
  constructor(value) { this.value = value; this.exists = value !== undefined; }
  data() { return structuredClone(this.value); }
}

class ReadOnlyFirestore {
  constructor(documents = {}, failures = new Map()) {
    this.documents = new Map(Object.entries(structuredClone(documents)));
    this.failures = failures;
    this.reads = [];
  }
  doc(path) {
    return { get: async () => {
      this.reads.push(path);
      if (this.failures.has(path)) throw this.failures.get(path);
      return new Snapshot(this.documents.get(path));
    } };
  }
}

const tenantId = "tenant-b";
const authUid = "auth-user";
const operationalUid = "operational-user";
const hostname = "tenant-b.example.test";
const origin = `https://${hostname}`;
const memberPath = `barbearias/${tenantId}/membros/${operationalUid}`;

function seed(overrides = {}) {
  return {
    [`tenant_hostnames/${hostname}`]: { tenantId },
    [`barbearias/${tenantId}`]: { slug: "tenant-b", status: "ACTIVE" },
    [`homologacao_mapeamentos/${authUid}`]: { ativo: true, tenant_id: tenantId, uid_producao_referencia: operationalUid },
    [memberPath]: { ativo: true, papeis: ["CLIENTE", "ADMIN"] },
    ...overrides,
  };
}

function inspect(firestore, overrides = {}) {
  return inspectTenantMembershipRequest({
    firestore, authUid, origin,
    data: { context: { hostname }, surface: "CLIENTE" },
    ...overrides,
  });
}

test("membership ativa retorna somente o estado mínimo", async () => {
  const firestore = new ReadOnlyFirestore(seed());
  assert.deepEqual(await inspect(firestore), { schema: 1, state: "ACTIVE" });
  assert.deepEqual(firestore.reads, [
    `tenant_hostnames/${hostname}`, `barbearias/${tenantId}`,
    `homologacao_mapeamentos/${authUid}`, memberPath,
  ]);
});

test("auth obrigatória e projeto fora de HML são recusados", async () => {
  await assert.rejects(inspect(new ReadOnlyFirestore(seed()), { authUid: "" }), { code: "unauthenticated" });
  await assert.rejects(inspect(new ReadOnlyFirestore(seed()), { projectId: "barber-a01e7" }), { code: "failed-precondition" });
});

test("hostname desconhecido, tenant inativo e origem divergente falham fechados", async () => {
  await assert.rejects(inspect(new ReadOnlyFirestore(seed()), {
    data: { context: { hostname: "unknown.example.test" }, surface: "CLIENTE" }, origin: "https://unknown.example.test",
  }), { code: "not-found" });
  await assert.rejects(inspect(new ReadOnlyFirestore(seed({ [`barbearias/${tenantId}`]: { slug: "tenant-b", status: "INACTIVE" } }))), { code: "unavailable" });
  await assert.rejects(inspect(new ReadOnlyFirestore(seed()), { origin: "https://tenant-a.example.test" }), { code: "permission-denied" });
});

test("mapping ausente ou de outro tenant retorna NOT_MEMBER", async () => {
  const missing = seed(); delete missing[`homologacao_mapeamentos/${authUid}`];
  assert.deepEqual(await inspect(new ReadOnlyFirestore(missing)), { schema: 1, state: "NOT_MEMBER" });
  assert.deepEqual(await inspect(new ReadOnlyFirestore(seed({ [`homologacao_mapeamentos/${authUid}`]: { ativo: true, tenant_id: "tenant-a", uid_producao_referencia: operationalUid } }))), { schema: 1, state: "NOT_MEMBER" });
});

test("membership inexistente, inativa e papel insuficiente são distintos", async () => {
  const missing = seed(); delete missing[memberPath];
  assert.deepEqual(await inspect(new ReadOnlyFirestore(missing)), { schema: 1, state: "NOT_MEMBER" });
  assert.deepEqual(await inspect(new ReadOnlyFirestore(seed({ [memberPath]: { ativo: false, papeis: ["CLIENTE"] } }))), { schema: 1, state: "INACTIVE" });
  assert.deepEqual(await inspect(new ReadOnlyFirestore(seed({ [memberPath]: { ativo: true, papeis: ["BARBEIRO"] } }))), { schema: 1, state: "ROLE_INSUFFICIENT" });
});

test("tenant, slug, UID, roles e campos extras do cliente são recusados", async () => {
  const firestore = new ReadOnlyFirestore(seed());
  for (const data of [
    { context: { hostname, tenantId }, surface: "CLIENTE" },
    { context: { hostname }, surface: "CLIENTE", tenantId },
    { context: { hostname }, surface: "CLIENTE", slug: "tenant-b" },
    { context: { hostname }, surface: "CLIENTE", uid: "other" },
    { context: { hostname }, surface: "CLIENTE", operationalUid },
    { context: { hostname }, surface: "CLIENTE", roles: ["ADMIN"] },
  ]) await assert.rejects(inspect(firestore, { data }), { code: "invalid-argument" });
});

test("falha técnica é MEMBERSHIP_UNAVAILABLE sem vazar erro interno", async () => {
  const firestore = new ReadOnlyFirestore(seed(), new Map([[memberPath, new Error("permission denied detail")]]));
  await assert.rejects(inspect(firestore), (error) => {
    assert.equal(error.code, "unavailable");
    assert.equal(error.message, "Não foi possível validar seu acesso neste estabelecimento.");
    return true;
  });
});

test("endpoint não contém escrita, auditoria, dispatcher ou dados de membership na resposta", async () => {
  const source = await import("node:fs/promises").then(({ readFile }) => readFile(new URL("./tenant-membership-inspection.mjs", import.meta.url), "utf8"));
  assert.doesNotMatch(source, /executeOperationalCommand|requestId|idempot|runTransaction|\.set\s*\(|\.create\s*\(|\.update\s*\(|\.delete\s*\(/);
});
