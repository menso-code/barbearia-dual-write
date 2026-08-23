import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const identity = await readFile(new URL("../public-hml/js/homologation-identity.js", import.meta.url), "utf8");
const app = await readFile(new URL("../public-hml/js/app.js", import.meta.url), "utf8");
const barber = await readFile(new URL("../public-hml/js/barber.js", import.meta.url), "utf8");

const TENANT = "tenant-hml";

class BootstrapStore {
  constructor() { this.mapping = null; this.legacy = null; this.v2 = null; this.member = null; this.admin = false; this.audit = new Map(); }
  snapshot() { return structuredClone({ mapping: this.mapping, legacy: this.legacy, v2: this.v2, member: this.member, admin: this.admin, audit: this.audit }); }
  restore(snapshot) { Object.assign(this, snapshot); }
  run(requestId, failAt = "", work) {
    if (this.audit.has(requestId)) return { duplicate: true, ...this.audit.get(requestId) };
    const before = this.snapshot();
    const write = (stage, fn) => { if (stage === failAt) throw new Error(`INJECTED_${stage}`); fn(); };
    try {
      const result = work(write);
      this.audit.set(requestId, result);
      return { duplicate: false, ...result };
    } catch (error) { this.restore(before); throw error; }
  }
}

function bootstrap(store, { authUid, requestId, failAt = "", payload = {} }) {
  if (Object.keys(payload).some((key) => ["uid", "operationalUid", "tenantId", "papel", "roles", "admin", "barbeiro"].includes(key))) throw new Error("INVALID_BOOTSTRAP_PAYLOAD");
  return store.run(requestId, failAt, (write) => {
    if (store.mapping && (store.mapping.tenant_id !== TENANT || store.mapping.uid_producao_referencia !== authUid)) throw new Error("MAPPING_INCONSISTENT");
    if (store.admin) throw new Error("PRIVILEGED_MEMBER");
    if (!store.mapping) write("mapping", () => { store.mapping = { ativo: true, tenant_id: TENANT, uid_producao_referencia: authUid, papeis_teste: ["CLIENTE"] }; });
    if (store.member?.papeis?.some((role) => ["ADMIN", "BARBEIRO"].includes(role))) throw new Error("PRIVILEGED_MEMBER");
    write("legacy", () => { store.legacy = { uid: authUid, nome: payload.nome || "Cliente" }; });
    write("v2", () => { store.v2 = { uid: authUid, nome: payload.nome || "Cliente" }; });
    write("membership", () => { store.member = { uid: authUid, papeis: ["CLIENTE"], tenant_id: TENANT }; });
    return { clientId: authUid, created: true };
  });
}

test("bootstrap HML é explicitamente limitado ao comando e projeto corretos", () => {
  assert.match(runtime, /const allowClientBootstrap = projectId === "teste-483f6" && command === "cliente\.garantir-perfil"/);
  assert.match(runtime, /resolveOperationalUid\(authUid, projectId, allowClientBootstrap\)/);
  assert.match(runtime, /if \(!mapping\.exists && allowClientBootstrap\) return authUid/);
  assert.match(runtime, /bootstrapHml: allowClientBootstrap && projectId === "teste-483f6"/);
  assert.doesNotMatch(runtime, /resolveOperationalUid\([^\n]+, true\)/);
});

test("novo cliente cria mapping, perfil Legado/V2 e membership somente CLIENTE", () => {
  const store = new BootstrapStore();
  const result = bootstrap(store, { authUid: "auth-client", requestId: "bootstrap-1", payload: { nome: "Cliente" } });
  assert.equal(result.duplicate, false);
  assert.deepEqual(store.mapping, { ativo: true, tenant_id: TENANT, uid_producao_referencia: "auth-client", papeis_teste: ["CLIENTE"] });
  assert.deepEqual(store.legacy, store.v2);
  assert.deepEqual(store.member.papeis, ["CLIENTE"]);
  assert.equal(store.member.papeis.includes("ADMIN"), false);
  assert.equal(store.member.papeis.includes("BARBEIRO"), false);
});

test("UID, tenant e papel controlados pelo cliente são rejeitados", () => {
  for (const field of ["uid", "operationalUid", "tenantId", "papel", "roles", "admin", "barbeiro"]) {
    assert.throws(() => bootstrap(new BootstrapStore(), { authUid: "auth-client", requestId: `bad-${field}`, payload: { [field]: "attacker" } }), /INVALID_BOOTSTRAP_PAYLOAD/);
  }
});

test("mapping inconsistente ou membership privilegiado aborta", () => {
  const mapped = new BootstrapStore();
  mapped.mapping = { ativo: true, tenant_id: "other-tenant", uid_producao_referencia: "auth-client" };
  assert.throws(() => bootstrap(mapped, { authUid: "auth-client", requestId: "wrong-tenant" }), /MAPPING_INCONSISTENT/);
  const privileged = new BootstrapStore();
  privileged.member = { papeis: ["BARBEIRO"] };
  assert.throws(() => bootstrap(privileged, { authUid: "auth-client", requestId: "privileged" }), /PRIVILEGED_MEMBER/);
  const adminRecord = new BootstrapStore();
  adminRecord.admin = true;
  assert.throws(() => bootstrap(adminRecord, { authUid: "auth-client", requestId: "admin-record" }), /PRIVILEGED_MEMBER/);
});

test("bootstrap é idempotente e recuperação repara o estado observado", () => {
  const store = new BootstrapStore();
  const first = bootstrap(store, { authUid: "auth-client", requestId: "same-request" });
  const snapshot = store.snapshot();
  const replay = bootstrap(store, { authUid: "auth-client", requestId: "same-request", payload: { nome: "outra" } });
  assert.equal(first.duplicate, false);
  assert.equal(replay.duplicate, true);
  assert.deepEqual(store.snapshot(), snapshot);
  const secondRequest = bootstrap(store, { authUid: "auth-client", requestId: "new-request" });
  assert.equal(secondRequest.duplicate, false);
  assert.equal(store.mapping.uid_producao_referencia, "auth-client");
});

test("falha em qualquer etapa não deixa mapping, perfil ou membership parciais", () => {
  for (const failAt of ["mapping", "legacy", "v2", "membership"]) {
    const store = new BootstrapStore();
    assert.throws(() => bootstrap(store, { authUid: "auth-client", requestId: `failure-${failAt}`, failAt }), /INJECTED_/);
    assert.equal(store.mapping, null);
    assert.equal(store.legacy, null);
    assert.equal(store.v2, null);
    assert.equal(store.member, null);
  }
});

test("produção não entra no caminho especial", () => {
  assert.match(runtime, /if \(projectId !== "teste-483f6"\) return authUid/);
  assert.match(runtime, /const allowClientBootstrap = projectId === "teste-483f6"/);
});

test("frontend separa bootstrap de CLIENTE do first-link de BARBEIRO", () => {
  assert.match(identity, /obterUidOperacionalComBootstrapCliente/);
  assert.match(identity, /cliente\.garantir-perfil/);
  assert.match(identity, /obterUidOperacionalComPrimeiroVinculo/);
  assert.match(identity, /barbeiro\.vincular-primeiro-acesso/);
  assert.match(app, /obterUidOperacionalComBootstrapCliente/);
  assert.match(barber, /obterUidOperacionalComPrimeiroVinculo/);
});
