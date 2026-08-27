import test from "node:test";
import assert from "node:assert/strict";
import {
  ANTUNES_TENANT_ID,
  DYNAMIC_TENANT_COMMANDS,
  OPERATIONAL_CONTEXT_MODES,
  OperationalContextError,
  assertIdempotentReplay,
  operationalPayloadFingerprint,
  resolveOperationalContext,
  tenantOperationLogPath,
  tenantV2DocumentPath,
  validateOperationalEnvelope,
} from "./operational-context.mjs";

class MemorySnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this.value;
  }
}

class MemoryDb {
  constructor(entries = {}) {
    this.entries = new Map(Object.entries(entries));
    this.reads = [];
  }

  doc(path) {
    return {
      get: async () => {
        this.reads.push(path);
        return new MemorySnapshot(this.entries.get(path));
      },
    };
  }
}

function tenantEntries({ slug, tenantId, uid, roles = ["ADMIN", "CLIENTE"], status = "ACTIVE" }) {
  return {
    [`tenant_slugs/${slug}`]: { tenantId, status: "ACTIVE" },
    [`barbearias/${tenantId}`]: { slug, status },
    [`barbearias/${tenantId}/membros/${uid}`]: { ativo: true, papeis: roles },
  };
}

function fixture() {
  return new MemoryDb({
    ...tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "admin-a" }),
    ...tenantEntries({ slug: "studio-b", tenantId: "tenant-b", uid: "admin-b" }),
  });
}

async function identityContext(db, slug, uid) {
  return resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: uid,
    command: "admin.estudio.identidade.salvar",
    payload: {
      command: "admin.estudio.identidade.salvar",
      requestId: `identity-${slug}-request-0001`,
      context: { hostname: `${slug}.goestudio.com.br` },
      data: { nome: slug },
    },
  });
}

const SLICE_2_COMMANDS = Object.freeze([
  "admin.funcionamento.salvar",
  "admin.servico.salvar",
  "admin.servico.remover",
  "admin.barbeiro.ativar",
]);

const SLICE_3_COMMANDS = Object.freeze([
  "admin.abertura.salvar",
  "admin.abertura.remover",
  "admin.plano.ativar",
]);

const SLICE_4_COMMANDS = Object.freeze([
  "admin.plano.inicial",
  "admin.plano.salvar",
]);

const SLICE_5_COMMANDS = Object.freeze([
  "bloqueio.remover",
]);

const SLICE_6_COMMANDS = Object.freeze([
  "agenda.cliente_chegou",
  "agenda.em_atendimento",
]);

const SLICE_7_COMMANDS = Object.freeze([
  "bloqueio.criar",
]);

const SLICE_8_COMMANDS = Object.freeze([
  "admin.assinatura.recusar",
]);

const SLICE_9_COMMANDS = Object.freeze([
  "admin.assinatura.cancelar",
]);

const SLICE_10_COMMANDS = Object.freeze([
  "admin.assinatura.expirar",
]);

const SLICE_11_COMMANDS = Object.freeze([
  "assinatura.solicitar",
]);

const MIGRATED_ADMIN_COMMANDS = Object.freeze([...SLICE_2_COMMANDS, ...SLICE_3_COMMANDS, ...SLICE_4_COMMANDS, ...SLICE_8_COMMANDS]);

const ALL_OPERATIONAL_COMMANDS = Object.freeze([
  "cliente.garantir-perfil", "cliente.atualizar-perfil", "assinatura.solicitar",
  "agenda.disponibilidade.obter", "agenda.criar", "agenda.reagendar", "agenda.cliente_chegou",
  "agenda.em_atendimento", "agenda.concluir", "agenda.cancelar", "agenda.nao_compareceu",
  "bloqueio.criar", "bloqueio.remover", "admin.funcionamento.salvar", "admin.abertura.salvar",
  "admin.abertura.remover", "admin.fechamento.salvar", "admin.fechamento.remover",
  "admin.barbeiro.salvar", "admin.barbeiro.ativar", "admin.barbeiro.remover",
  "admin.servico.salvar", "admin.servico.remover", "admin.plano.salvar", "admin.plano.inicial",
  "admin.plano.ativar", "admin.assinatura.aprovar", "admin.assinatura.recusar",
  "admin.assinatura.renovar", "admin.assinatura.cancelar", "admin.assinatura.expirar",
  "admin.estudio.identidade.salvar",
]);

async function adminContext(db, command, slug, uid, data = {}) {
  return resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: uid,
    command,
    payload: {
      command,
      requestId: `dynamic-${slug}-${command.replaceAll(".", "-")}-0001`,
      context: { hostname: `${slug}.goestudio.com.br` },
      data,
    },
  });
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (cause) => {
    assert.ok(cause instanceof OperationalContextError);
    assert.equal(cause.code, code);
    return true;
  });
}

test("TENANT_A_COMMAND_WORKS e TENANT_B_COMMAND_WORKS", async () => {
  assert.deepEqual(DYNAMIC_TENANT_COMMANDS, [
    "agenda.disponibilidade.obter",
    ...SLICE_7_COMMANDS,
    ...SLICE_5_COMMANDS,
    ...SLICE_6_COMMANDS,
    "admin.estudio.identidade.salvar",
    ...SLICE_2_COMMANDS,
    ...SLICE_3_COMMANDS,
    ...SLICE_4_COMMANDS,
    ...SLICE_8_COMMANDS,
    ...SLICE_9_COMMANDS,
    ...SLICE_10_COMMANDS,
    ...SLICE_11_COMMANDS,
  ]);
  const db = fixture();
  const tenantA = await identityContext(db, "studio-a", "admin-a");
  const tenantB = await identityContext(db, "studio-b", "admin-b");
  assert.equal(tenantA.tenant.id, "tenant-a");
  assert.equal(tenantB.tenant.id, "tenant-b");
  assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  assert.deepEqual(tenantA.actor.roles, ["ADMIN", "CLIENTE"]);
});

test("TENANT_A_COMMANDS_PASS e TENANT_B_COMMANDS_PASS no Slice 2", async () => {
  const db = fixture();
  for (const command of SLICE_2_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a");
    const tenantB = await adminContext(db, command, "studio-b", "admin-b");
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_COMMANDS_PASS e TENANT_B_COMMANDS_PASS no Slice 3", async () => {
  const db = fixture();
  for (const command of SLICE_3_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a");
    const tenantB = await adminContext(db, command, "studio-b", "admin-b");
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_COMMANDS_PASS e TENANT_B_COMMANDS_PASS no Slice 4", async () => {
  const db = fixture();
  for (const command of SLICE_4_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a");
    const tenantB = await adminContext(db, command, "studio-b", "admin-b");
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_BLOQUEIO_REMOVE_PASS e TENANT_B_BLOQUEIO_REMOVE_PASS", async () => {
  const db = fixture();
  for (const command of SLICE_5_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a");
    const tenantB = await adminContext(db, command, "studio-b", "admin-b");
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_BLOQUEIO_CREATE_PASS e TENANT_B_BLOQUEIO_CREATE_PASS", async () => {
  const db = fixture();
  for (const command of SLICE_7_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a", {
      barbeiro_id: "barber-a",
      data: "2030-01-02",
      inicio: "10:00",
      fim: "11:00",
    });
    const tenantB = await adminContext(db, command, "studio-b", "admin-b", {
      barbeiro_id: "barber-b",
      data: "2030-01-02",
      inicio: "10:00",
      fim: "11:00",
    });
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_AGENDA_TRANSITIONS_PASS e TENANT_B_AGENDA_TRANSITIONS_PASS", async () => {
  const db = fixture();
  for (const command of SLICE_6_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a", { appointmentId: "appointment-a" });
    const tenantB = await adminContext(db, command, "studio-b", "admin-b", { appointmentId: "appointment-b" });
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
  }
});

test("TENANT_A_ASSINATURA_RECUSAR_PASS e TENANT_B_ASSINATURA_RECUSAR_PASS", async () => {
  const db = fixture();
  for (const command of SLICE_8_COMMANDS) {
    const tenantA = await adminContext(db, command, "studio-a", "admin-a", { id: "subscription-a" });
    const tenantB = await adminContext(db, command, "studio-b", "admin-b", { id: "subscription-b" });
    assert.equal(tenantA.tenant.id, "tenant-a");
    assert.equal(tenantB.tenant.id, "tenant-b");
    assert.equal(tenantA.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.equal(tenantB.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
    assert.deepEqual(tenantA.actor.roles, ["ADMIN", "CLIENTE"]);
  }
});

test("ANTUNES_DUAL_WRITE_PRESERVED para os comandos dos Slices 2, 3, 4, 5, 6, 7 e 8", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/admin-antunes`]: { ativo: true, papeis: ["ADMIN"] },
  });
  for (const command of [...MIGRATED_ADMIN_COMMANDS, ...SLICE_5_COMMANDS, ...SLICE_6_COMMANDS, ...SLICE_7_COMMANDS]) {
    const context = await resolveOperationalContext({
      db,
      projectId: "barber-a01e7",
      authUid: "admin-antunes",
      command,
      payload: {
        command,
        requestId: `dynamic-antunes-${command.replaceAll(".", "-")}-01`,
        context: { hostname: "barber-a01e7.web.app" },
        data: {},
      },
    });
    assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
    assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE);
  }
});

test("compatibilidade sem locator fica restrita ao projeto HML e exige ADMIN", async () => {
  const entries = {
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/admin-antunes`]: { ativo: true, papeis: ["ADMIN"] },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/client-antunes`]: { ativo: true, papeis: ["CLIENTE"] },
  };
  for (const command of MIGRATED_ADMIN_COMMANDS) {
    const payload = {
      command,
      requestId: `hml-compat-${command.replaceAll(".", "-")}-01`,
      data: {},
    };
    const context = await resolveOperationalContext({
      db: new MemoryDb(entries),
      projectId: "teste-483f6",
      authUid: "admin-antunes",
      command,
      payload,
    });
    assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
    assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE);
    await rejectsCode(resolveOperationalContext({
      db: new MemoryDb(entries),
      projectId: "teste-483f6",
      authUid: "client-antunes",
      command,
      payload,
    }), "MEMBERSHIP_REQUIRED");
    await rejectsCode(resolveOperationalContext({
      db: new MemoryDb(entries),
      projectId: "barber-a01e7",
      authUid: "admin-antunes",
      command,
      payload,
    }), "TENANT_CONTEXT_REQUIRED");
  }
});

test("NON_ADMIN_DENIED nos comandos administrativos migrados", async () => {
  const db = new MemoryDb(tenantEntries({
    slug: "studio-a",
    tenantId: "tenant-a",
    uid: "client-a",
    roles: ["CLIENTE"],
  }));
  for (const command of MIGRATED_ADMIN_COMMANDS) {
    await rejectsCode(adminContext(db, command, "studio-a", "client-a"), "MEMBERSHIP_REQUIRED");
  }
});

test("CROSS_TENANT_DENIED e INACTIVE_TENANT_DENIED nos comandos migrados", async () => {
  const crossTenantDb = fixture();
  const inactiveDb = new MemoryDb(tenantEntries({
    slug: "studio-a",
    tenantId: "tenant-a",
    uid: "admin-a",
    status: "INACTIVE",
  }));
  for (const command of MIGRATED_ADMIN_COMMANDS) {
    await rejectsCode(adminContext(crossTenantDb, command, "studio-b", "admin-a"), "MEMBERSHIP_REQUIRED");
    await rejectsCode(adminContext(inactiveDb, command, "studio-a", "admin-a"), "TENANT_UNAVAILABLE");
  }
});

test("agenda.disponibilidade.obter resolve slug e exige CLIENTE", async () => {
  const db = new MemoryDb(tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "client-a", roles: ["CLIENTE"] }));
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "client-a",
    command: "agenda.disponibilidade.obter",
    payload: {
      command: "agenda.disponibilidade.obter",
      requestId: "availability-request-0001",
      data: { data: "2026-08-26", slug: "studio-a" },
    },
  });
  assert.equal(context.tenant.id, "tenant-a");
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.READ_ONLY);
});

test("TENANT_A_CANNOT_ACCESS_B", async () => {
  const db = fixture();
  await rejectsCode(identityContext(db, "studio-b", "admin-a"), "MEMBERSHIP_REQUIRED");
});

test("TENANT_ID_PAYLOAD_REJECTED e path do payload rejeitado", () => {
  assert.throws(
    () => validateOperationalEnvelope({ command: "x", tenantId: "tenant-b" }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
  assert.throws(
    () => validateOperationalEnvelope({ command: "x", data: { path: "barbearias/tenant-b" } }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
  assert.throws(
    () => validateOperationalEnvelope({ command: "x", data: { nested: { write_mode: "V2_ONLY" } } }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
});

test("CROSS_TENANT_REQUEST_ID_ISOLATED", async () => {
  const db = fixture();
  const tenantA = await identityContext(db, "studio-a", "admin-a");
  const tenantB = await identityContext(db, "studio-b", "admin-b");
  const requestId = "shared-request-id-0001";
  assert.notEqual(tenantOperationLogPath(tenantA, requestId), tenantOperationLogPath(tenantB, requestId));
  assert.equal(tenantOperationLogPath(tenantA, requestId), `barbearias/tenant-a/audit_logs/operation-${requestId}`);
});

test("SAME_TENANT_REQUEST_ID_COLLISION_PROTECTED", () => {
  const first = operationalPayloadFingerprint({ nome: "Studio A", primaryColor: "#112233" });
  const equivalent = operationalPayloadFingerprint({ primaryColor: "#112233", nome: "Studio A" });
  const changed = operationalPayloadFingerprint({ nome: "Studio B", primaryColor: "#112233" });
  assert.equal(first, equivalent);
  assert.doesNotThrow(() => assertIdempotentReplay({ operation: "admin.estudio.identidade.salvar", request_fingerprint: first }, "admin.estudio.identidade.salvar", equivalent));
  assert.throws(
    () => assertIdempotentReplay({ operation: "admin.estudio.identidade.salvar", request_fingerprint: first }, "admin.estudio.identidade.salvar", changed),
    (cause) => cause instanceof OperationalContextError && cause.code === "REQUEST_ID_COLLISION",
  );
});

test("NON_MEMBER_REJECTED", async () => {
  const db = new MemoryDb({
    "tenant_slugs/studio-a": { tenantId: "tenant-a", status: "ACTIVE" },
    "barbearias/tenant-a": { slug: "studio-a", status: "ACTIVE" },
  });
  await rejectsCode(identityContext(db, "studio-a", "admin-a"), "MEMBERSHIP_REQUIRED");
});

test("INACTIVE_TENANT_REJECTED", async () => {
  const db = new MemoryDb(tenantEntries({ slug: "studio-a", tenantId: "tenant-a", uid: "admin-a", status: "INACTIVE" }));
  await rejectsCode(identityContext(db, "studio-a", "admin-a"), "TENANT_UNAVAILABLE");
});

test("LEGACY_MODE_CANNOT_BE_CLIENT_SELECTED", () => {
  assert.throws(
    () => validateOperationalEnvelope({ command: "agenda.criar", context: { hostname: "studio-a.goestudio.com.br" }, writeMode: "ANTUNES_DUAL_WRITE" }),
    (cause) => cause instanceof OperationalContextError && cause.code === "FORBIDDEN_TENANT_OVERRIDE",
  );
});

test("LEGACY_COMMAND_BLOCKED_FOR_NEW_TENANT", async () => {
  const db = fixture();
  await rejectsCode(resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "admin-a",
    command: "agenda.criar",
    payload: {
      command: "agenda.criar",
      requestId: "legacy-command-request-0001",
      context: { hostname: "studio-a.goestudio.com.br" },
      data: {},
    },
  }), "COMMAND_NOT_AVAILABLE_FOR_TENANT");
});

test("OTHER_13_COMMANDS_FAIL_CLOSED_FOR_NEW_TENANTS", async () => {
  assert.equal(ALL_OPERATIONAL_COMMANDS.length, 32);
  const remaining = ALL_OPERATIONAL_COMMANDS.filter((command) => !DYNAMIC_TENANT_COMMANDS.includes(command));
  assert.equal(remaining.length, 13);
  for (const command of remaining) {
    await rejectsCode(resolveOperationalContext({
      db: fixture(),
      projectId: "barber-a01e7",
      authUid: "admin-a",
      command,
      payload: {
        command,
        requestId: `blocked-${command.replaceAll(".", "-")}-0001`,
        context: { hostname: "studio-a.goestudio.com.br" },
        data: {},
      },
    }), "COMMAND_NOT_AVAILABLE_FOR_TENANT");
  }
});

test("comando legado preserva compatibilidade Antunes sem localizador", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/legacy-user`]: { ativo: true, papeis: ["CLIENTE"] },
  });
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "legacy-user",
    command: "agenda.criar",
    payload: { command: "agenda.criar", requestId: "legacy-antunes-request-01", data: {} },
  });
  assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.ANTUNES_DUAL_WRITE);
});

test("omitir localizador não seleciona Antunes para membro de outro tenant", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    "barbearias/tenant-b": { slug: "studio-b", status: "ACTIVE" },
    "barbearias/tenant-b/membros/user-b": { ativo: true, papeis: ["CLIENTE"] },
  });
  await rejectsCode(resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "user-b",
    command: "agenda.criar",
    payload: { command: "agenda.criar", requestId: "omitted-context-request-01", data: {} },
  }), "MEMBERSHIP_REQUIRED");
});

test("host Firebase legado é allowlist exata e identidade continua V2-only", async () => {
  const db = new MemoryDb({
    [`barbearias/${ANTUNES_TENANT_ID}`]: { slug: "antunes", status: "ACTIVE" },
    [`barbearias/${ANTUNES_TENANT_ID}/membros/admin-antunes`]: { ativo: true, papeis: ["ADMIN"] },
  });
  const context = await resolveOperationalContext({
    db,
    projectId: "barber-a01e7",
    authUid: "admin-antunes",
    command: "admin.estudio.identidade.salvar",
    payload: {
      command: "admin.estudio.identidade.salvar",
      requestId: "legacy-host-identity-01",
      context: { hostname: "barber-a01e7.web.app" },
      data: { nome: "Antunes" },
    },
  });
  assert.equal(context.tenant.id, ANTUNES_TENANT_ID);
  assert.equal(context.mode, OPERATIONAL_CONTEXT_MODES.V2_ONLY);
});

test("OperationalContext e referências tenant-scoped são imutáveis e isoladas", async () => {
  const context = await identityContext(fixture(), "studio-a", "admin-a");
  assert.equal(Object.isFrozen(context), true);
  assert.equal(Object.isFrozen(context.tenant), true);
  assert.equal(Object.isFrozen(context.actor.roles), true);
  assert.throws(() => { context.tenant.id = "tenant-b"; }, TypeError);
  assert.equal(tenantV2DocumentPath(context, "configuracoes", "identidade"), "barbearias/tenant-a/configuracoes/identidade");
});
