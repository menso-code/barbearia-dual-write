import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("access-control aguarda TenantContext e usa membership tenant-scoped", async () => {
  const source = await read("public/js/access-control.js");
  assert.match(source, /await initializeTenantContext\(\)/);
  assert.match(source, /!tenantContextIsReady\(tenantContext\)/);
  assert.match(source, /doc\(db, "barbearias", tenantContext\.tenantId, "membros", user\.uid\)/);
  assert.doesNotMatch(source, /collection\(db, "barbeiros"\)|doc\(db, "admins"/);
});

test("Admin recente só inicia dados depois de tenant READY e membership ADMIN", async () => {
  const source = await read("public/js/admin.js");
  const tenantGate = source.indexOf("const tenantContext = await initializeTenantContext()");
  const accessGate = source.indexOf("const access = await getCurrentUserAccess(user)");
  const firstLoad = source.indexOf("await carregarBarbeiros()", accessGate);
  assert.ok(tenantGate > 0 && accessGate > tenantGate && firstLoad > accessGate);
  assert.match(source, /!tenantContextIsReady\(tenantContext\)/);
  assert.match(source, /if \(!access\.isAdmin\)/);
});

test("Control Center e Clientes registram consumidores somente após tenant READY", async () => {
  const [controlCenter, customers] = await Promise.all([
    read("public/js/admin-control-center.js"),
    read("public/js/admin-customers.js"),
  ]);
  for (const source of [controlCenter, customers]) {
    const gate = source.indexOf("const tenantContext = await initializeTenantContext()");
    const ready = source.indexOf("tenantContextIsReady(tenantContext)", gate);
    const listener = source.indexOf("addEventListener", ready);
    assert.ok(gate > 0 && ready > gate && listener > ready);
    assert.doesNotMatch(source, /BARBEARIA_ATUAL_ID|BARBEARIA_ATUAL_SLUG|tnt_80b2|\bantunes\b/i);
  }
  assert.match(controlCenter, /await import\("\.\/agenda\.js"\)/);
  assert.doesNotMatch(controlCenter, /^import .*agenda\.js/m);
});

test("estados não READY iniciam zero consumidores tenant-scoped", async () => {
  const {
    TENANT_CONTEXT_STATES,
    tenantContextIsReady,
  } = await import("../public/js/tenant-context-core.mjs");
  for (const status of [
    TENANT_CONTEXT_STATES.NOT_FOUND,
    TENANT_CONTEXT_STATES.UNAVAILABLE,
    TENANT_CONTEXT_STATES.ERROR,
  ]) {
    let starts = 0;
    if (tenantContextIsReady({ status, tenantId: "tenant-a" })) starts += 1;
    assert.equal(starts, 0);
  }
  assert.equal(tenantContextIsReady({ status: TENANT_CONTEXT_STATES.READY, tenantId: "tenant-a" }), true);
  assert.equal(tenantContextIsReady({ status: TENANT_CONTEXT_STATES.READY, tenantId: "" }), false);
});

test("compatibilidade fixa permanece isolada no tenant context", async () => {
  const [firebaseConfig, tenant, context, access, controlCenter, customers] = await Promise.all([
    read("public/js/firebase-config.js"),
    read("public/js/tenant.js"),
    read("public/js/tenant-context.js"),
    read("public/js/access-control.js"),
    read("public/js/admin-control-center.js"),
    read("public/js/admin-customers.js"),
  ]);
  assert.doesNotMatch(firebaseConfig, /BARBEARIA_ATUAL_ID|BARBEARIA_ATUAL_SLUG|getBarbeariaAtual|getSlugBarbeariaAtual|\.\/tenant\.js/);
  assert.match(tenant, /BARBEARIA_PADRAO_ID/);
  assert.doesNotMatch(context, /LEGACY_FIREBASE_COMPAT|LEGACY_COMPAT_TENANT_/);
  assert.doesNotMatch(`${access}\n${controlCenter}\n${customers}`, /BARBEARIA_ATUAL_ID|BARBEARIA_PADRAO_ID/);
});
