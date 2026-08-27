import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  ANTUNES_TENANT_ID,
  OPERATIONAL_CONTEXT_MODES,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  tenantOperationLogPath,
  tenantV2DocumentPath,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

const runtime = await readFile(new URL("./dual-write.js", import.meta.url), "utf8");
const SELECTED_COMMANDS = Object.freeze([
  "admin.funcionamento.salvar",
  "admin.servico.salvar",
  "admin.servico.remover",
  "admin.barbeiro.ativar",
]);

function sourceBetween(start, end) {
  const from = runtime.indexOf(start);
  const to = runtime.indexOf(end, from + start.length);
  assert.notEqual(from, -1, `marcador inicial ausente: ${start}`);
  assert.notEqual(to, -1, `marcador final ausente: ${end}`);
  return runtime.slice(from, to);
}

function context(tenantId, mode) {
  return Object.freeze({
    tenant: Object.freeze({ id: tenantId, slug: tenantId }),
    actor: Object.freeze({ uid: `admin-${tenantId}`, roles: Object.freeze(["ADMIN"]) }),
    mode,
  });
}

class AtomicMutationModel {
  constructor() {
    this.legacy = new Map();
    this.v2 = new Map();
    this.members = new Map();
  }

  snapshot() {
    return structuredClone({ legacy: this.legacy, v2: this.v2, members: this.members });
  }

  transaction(work, failAt = "") {
    const before = this.snapshot();
    const write = (stage, callback) => {
      if (stage === failAt) throw new Error(`INJECTED_${stage}`);
      callback();
    };
    try {
      return work(write);
    } catch (cause) {
      this.legacy = before.legacy;
      this.v2 = before.v2;
      this.members = before.members;
      throw cause;
    }
  }

  save(mode, tenantId, collection, id, value) {
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) {
      this.legacy.set(`${collection}/${id}`, structuredClone(value));
    }
    this.v2.set(`barbearias/${tenantId}/${collection}/${id}`, structuredClone(value));
  }

  remove(mode, tenantId, collection, id) {
    if (mode === OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE) this.legacy.delete(`${collection}/${id}`);
    this.v2.delete(`barbearias/${tenantId}/${collection}/${id}`);
  }

  activateBarber(mode, tenantId, barberId, uid, active, failAt = "") {
    return this.transaction((write) => {
      write("barber", () => this.save(mode, tenantId, "barbeiros", barberId, { uid_usuario: uid, ativo: active }));
      write("membership", () => this.members.set(`barbearias/${tenantId}/membros/${uid}`, { ativo: active }));
      return { barberId };
    }, failAt);
  }
}

test("Slice 2 mantém registrados os quatro comandos administrativos selecionados", () => {
  const setSource = sourceBetween("const TENANT_SCOPED_ADMIN_ACTIONS", `]);`);
  for (const command of SELECTED_COMMANDS) {
    assert.match(setSource, new RegExp(`"${command.replace("admin.", "").replaceAll(".", "\\.")}"`));
  }
});

test("tenant selector payload é rejeitado inclusive quando aninhado", () => {
  for (const forbidden of [
    { tenantId: "tenant-b" },
    { data: { path: "barbearias/tenant-b" } },
    { data: { nested: { writeMode: "ANTUNES_DUAL_WRITE" } } },
  ]) {
    assert.throws(
      () => validateOperationalEnvelope({ command: SELECTED_COMMANDS[0], ...forbidden }),
      (cause) => cause?.code === "FORBIDDEN_TENANT_OVERRIDE",
    );
  }
});

test("ADMIN tenant-scoped é obrigatório e root ADMIN fica restrito a Antunes", () => {
  const guard = sourceBetween("async function requireContextAdmin", "async function tenantScopedAdminCommand");
  assert.match(guard, /context\.tenant\.id === ANTUNES_TENANT_ID/);
  assert.match(guard, /requireAdmin\(tx, uid\)/);
  assert.match(guard, /requireTenantAdminMembership\(tx, uid, context\.tenant\.id\)/);
});

test("novos tenants usam somente V2 e Antunes preserva dual-write", () => {
  const store = new AtomicMutationModel();
  store.save(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "servicos", "service-a", { nome: "A" });
  store.save(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-b", "configuracoes", "funcionamento", { intervalo: 30 });
  assert.equal(store.legacy.size, 0);
  assert.equal(store.v2.has("barbearias/tenant-a/servicos/service-a"), true);
  assert.equal(store.v2.has("barbearias/tenant-b/configuracoes/funcionamento"), true);

  store.save(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "servicos", "service-antunes", { nome: "Antunes" });
  assert.deepEqual(store.legacy.get("servicos/service-antunes"), store.v2.get(`barbearias/${ANTUNES_TENANT_ID}/servicos/service-antunes`));
  store.remove(OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE, ANTUNES_TENANT_ID, "servicos", "service-antunes");
  assert.equal(store.legacy.has("servicos/service-antunes"), false);
  assert.equal(store.v2.has(`barbearias/${ANTUNES_TENANT_ID}/servicos/service-antunes`), false);
});

test("barber activation atualiza barbeiro e membership atomicamente no mesmo tenant", () => {
  const store = new AtomicMutationModel();
  store.activateBarber(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barber-a", "uid-a", true);
  assert.equal(store.v2.get("barbearias/tenant-a/barbeiros/barber-a").ativo, true);
  assert.equal(store.members.get("barbearias/tenant-a/membros/uid-a").ativo, true);
  assert.equal(store.v2.has("barbearias/tenant-b/barbeiros/barber-a"), false);

  const before = store.snapshot();
  assert.throws(
    () => store.activateBarber(OPERATIONAL_CONTEXT_MODES.V2_ONLY, "tenant-a", "barber-a", "uid-a", false, "membership"),
    /INJECTED_membership/,
  );
  assert.deepEqual(store.snapshot(), before);

  const branch = sourceBetween('if (action === "barbeiro.ativar")', 'error("internal", "Comando tenant-scoped não suportado.")');
  assert.match(branch, /tenantUpdate\(tx, context, "barbeiros"/);
  assert.match(branch, /barbearias\/\$\{context\.tenant\.id\}\/membros\/\$\{linkedUid\}/);
});

test("requestId e fingerprint ficam isolados por tenant e protegem colisão", () => {
  const tenantA = context("tenant-a", OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  const tenantB = context("tenant-b", OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  const requestId = "slice2-shared-request-0001";
  assert.notEqual(tenantOperationLogPath(tenantA, requestId), tenantOperationLogPath(tenantB, requestId));
  assert.equal(tenantV2DocumentPath(tenantA, "servicos", "service-1"), "barbearias/tenant-a/servicos/service-1");

  const fingerprint = operationalPayloadFingerprint({ id: "service-1", ativo: true });
  assert.doesNotThrow(() => assertIdempotentReplay({ operation: SELECTED_COMMANDS[1], request_fingerprint: fingerprint }, SELECTED_COMMANDS[1], fingerprint));
  assert.throws(
    () => assertIdempotentReplay({ operation: SELECTED_COMMANDS[1], request_fingerprint: fingerprint }, SELECTED_COMMANDS[1], operationalPayloadFingerprint({ id: "service-1", ativo: false })),
    (cause) => cause?.code === "REQUEST_ID_COLLISION",
  );
});

test("runtime conecta contexto, audit e referências tenant-scoped sem alterar contagem", () => {
  const handler = sourceBetween('if (action === "funcionamento.salvar")', 'if (action === "barbeiro.salvar")');
  assert.doesNotMatch(handler, /legacyRef|mirrorSet|mirrorUpdate|mirrorDelete/);
  assert.match(handler, /tenantSet\(tx, context/);
  assert.match(handler, /tenantUpdate\(tx, context/);
  assert.match(handler, /tenantDelete\(tx, context/);
  assert.match(runtime, /context,\s*requestFingerprint:/);
  assert.match(runtime, /tenantOperationLogPath\(context, requestId\)/);
  assert.match(runtime, /event_type: context \? "OPERATIONAL_TENANT_WRITE"/);
  assert.match(runtime, /tenant_id: context\?\.tenant\?\.id \|\| TENANT_ID/);
  assert.match(runtime, /return tenantScopedAdminCommand\(\{ uid, action, incoming, requestId, context \}\)/);
  assert.equal((runtime.match(/^\s*case "[^"]+":/gm) || []).length, 32);
});
