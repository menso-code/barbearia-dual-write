import test from "node:test";
import assert from "node:assert/strict";
import {
  AGENDA_AVAILABILITY_CODES,
  AgendaAvailabilityError,
  getDerivedAgendaAvailability,
} from "./agenda-availability.mjs";

class MemorySnapshot {
  constructor(value) {
    this.value = value;
    this.exists = value !== undefined;
  }

  data() {
    return this.value;
  }
}

class ReadOnlyMemoryDb {
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

function fixture({
  slug = "estudio-teste",
  tenantId = "tenant-a",
  uid = "client-a",
  tenantStatus = "ACTIVE",
  member = { ativo: true, papeis: ["CLIENTE"] },
  config = {
    dias_fechados_semana: { 0: true },
    periodos_semana: { 1: [{ inicio: "09:00", fim: "18:00" }] },
  },
  closure,
  opening,
  data = "2026-08-24",
} = {}) {
  const entries = {
    [`tenant_slugs/${slug}`]: { tenantId, status: "ACTIVE" },
    [`barbearias/${tenantId}`]: { slug, status: tenantStatus },
    [`barbearias/${tenantId}/configuracoes/funcionamento`]: config,
  };
  if (member !== undefined) entries[`barbearias/${tenantId}/membros/${uid}`] = member;
  if (closure !== undefined) entries[`barbearias/${tenantId}/fechamentos/${data}`] = closure;
  if (opening !== undefined) entries[`barbearias/${tenantId}/fechamentos/abertura_${data}`] = opening;
  return { db: new ReadOnlyMemoryDb(entries), slug, tenantId, uid, data };
}

async function read(options = {}) {
  const context = fixture(options);
  return {
    context,
    result: await getDerivedAgendaAvailability({
      db: context.db,
      slug: context.slug,
      uid: context.uid,
      data: context.data,
    }),
  };
}

async function rejectsCode(promise, code) {
  await assert.rejects(promise, (error) => {
    assert.ok(error instanceof AgendaAvailabilityError);
    assert.equal(error.code, code);
    return true;
  });
}

test("VALID_CLIENT_CAN_GET_DERIVED_AVAILABILITY", async () => {
  const { result } = await read();
  assert.deepEqual(result, {
    data: "2026-08-24",
    closed: false,
    effectiveOpenPeriods: [{ inicio: "09:00", fim: "18:00" }],
    publicMessageCode: AGENDA_AVAILABILITY_CODES.AVAILABLE,
  });
});

test("NON_MEMBER_REJECTED", async () => {
  const context = fixture({ member: null });
  await rejectsCode(getDerivedAgendaAvailability({
    db: context.db, slug: context.slug, uid: context.uid, data: context.data,
  }), "CLIENT_MEMBERSHIP_REQUIRED");
});

test("CROSS_TENANT_READ_REJECTED", async () => {
  const context = fixture({ tenantId: "tenant-b", uid: "client-from-tenant-a", member: null });
  context.db.entries.set("barbearias/tenant-a/membros/client-from-tenant-a", { ativo: true, papeis: ["CLIENTE"] });
  await rejectsCode(getDerivedAgendaAvailability({
    db: context.db, slug: context.slug, uid: context.uid, data: context.data,
  }), "CLIENT_MEMBERSHIP_REQUIRED");
});

test("RAW_CLOSURE_DOCUMENT_NOT_RETURNED", async () => {
  const { result } = await read({
    closure: { ativo: true, motivo: "Motivo administrativo", criado_por: "admin", criado_em: "secret", fechamento_id: "internal" },
  });
  assert.deepEqual(Object.keys(result).sort(), ["closed", "data", "effectiveOpenPeriods", "publicMessageCode"]);
});

test("CREATED_BY_NOT_RETURNED", async () => {
  const { result } = await read({ closure: { ativo: true, criado_por: "admin-secret" } });
  assert.equal(Object.hasOwn(result, "criado_por"), false);
  assert.equal(JSON.stringify(result).includes("admin-secret"), false);
});

test("MOTIVO_NOT_RETURNED", async () => {
  const { result } = await read({ closure: { ativo: true, motivo: "conteudo-interno" } });
  assert.equal(Object.hasOwn(result, "motivo"), false);
  assert.equal(JSON.stringify(result).includes("conteudo-interno"), false);
});

test("CLOSURE_ID_NOT_RETURNED", async () => {
  const { result } = await read({ closure: { ativo: true, fechamento_id: "closure-secret" } });
  assert.equal(Object.hasOwn(result, "fechamento_id"), false);
  assert.equal(JSON.stringify(result).includes("closure-secret"), false);
});

test("WEEKLY_CLOSED_DAY", async () => {
  const { result } = await read({ data: "2026-08-23" });
  assert.equal(result.closed, true);
  assert.deepEqual(result.effectiveOpenPeriods, []);
  assert.equal(result.publicMessageCode, AGENDA_AVAILABILITY_CODES.CLOSED);
});

test("EXCEPTIONAL_CLOSURE", async () => {
  const { result } = await read({ closure: { ativo: true, tipo: "fechamento" } });
  assert.equal(result.closed, true);
  assert.deepEqual(result.effectiveOpenPeriods, []);
});

test("EXCEPTIONAL_OPENING", async () => {
  const { result } = await read({
    data: "2026-08-23",
    opening: { ativo: true, tipo: "abertura", inicio_horario: "10:00", fim_horario: "14:00" },
  });
  assert.equal(result.closed, false);
  assert.deepEqual(result.effectiveOpenPeriods, [{ inicio: "10:00", fim: "14:00" }]);
});

test("NORMAL_OPEN_DAY", async () => {
  const { result } = await read();
  assert.equal(result.closed, false);
  assert.deepEqual(result.effectiveOpenPeriods, [{ inicio: "09:00", fim: "18:00" }]);
});

test("INVALID_DATE_REJECTED", async () => {
  const context = fixture({ data: "2026-02-30" });
  await rejectsCode(getDerivedAgendaAvailability({
    db: context.db, slug: context.slug, uid: context.uid, data: context.data,
  }), "INVALID_DATE");
});

test("INACTIVE_TENANT_REJECTED", async () => {
  const context = fixture({ tenantStatus: "SUSPENDED" });
  await rejectsCode(getDerivedAgendaAvailability({
    db: context.db, slug: context.slug, uid: context.uid, data: context.data,
  }), "TENANT_UNAVAILABLE");
});

test("derived availability adapter exposes no write capability or side effect", async () => {
  const { context } = await read();
  assert.equal(typeof context.db.runTransaction, "undefined");
  assert.equal(context.db.reads.some((path) => path.includes("audit_logs")), false);
});
