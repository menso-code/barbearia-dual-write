import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import { deniedAccessRoute, evaluateTenantPageAccess } from "../public-hml/js/tenant-membership-gate-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const access = (overrides = {}) => ({
  isAuthenticated: true,
  tenantStatus: "READY",
  membershipStatus: "ACTIVE",
  roles: ["CLIENTE"],
  ...overrides,
});

test("membership ausente bloqueia antes do shell", () => {
  assert.deepEqual(evaluateTenantPageAccess(access({ membershipStatus: "MISSING", roles: [] }), "CLIENTE"), {
    allowed: false,
    code: "MEMBERSHIP_MISSING",
    message: "Você ainda não possui cadastro nessa barbearia.",
  });
});

test("membership inativa bloqueia o acesso", () => {
  assert.equal(evaluateTenantPageAccess(access({ membershipStatus: "INACTIVE", roles: [] }), "CLIENTE").code, "MEMBERSHIP_INACTIVE");
});

test("role insuficiente bloqueia a área", () => {
  assert.equal(evaluateTenantPageAccess(access({ roles: ["CLIENTE"] }), "ADMIN").code, "ROLE_INSUFFICIENT");
});

test("membership e role válidas liberam a área", () => {
  assert.deepEqual(evaluateTenantPageAccess(access({ roles: ["ADMIN", "BARBEIRO"] }), "BARBEIRO"), {
    allowed: true,
    code: "READY",
    message: "",
  });
});

test("membership de outro tenant não libera o shell atual", () => {
  assert.equal(
    evaluateTenantPageAccess(access({ tenantContext: { tenantId: "tenant-b" }, membershipStatus: "MISSING", roles: [] }), "CLIENTE").code,
    "MEMBERSHIP_MISSING",
  );
  assert.equal(
    evaluateTenantPageAccess(access({ tenantContext: { tenantId: "tenant-a" }, membershipStatus: "MISSING", roles: [] }), "CLIENTE").code,
    "MEMBERSHIP_MISSING",
  );
});

test("cada página usa o gate central antes de exibir o shell", async () => {
  const [app, admin, barber, account] = await Promise.all([
    read("public-hml/js/app.js"),
    read("public-hml/js/admin.js"),
    read("public-hml/js/barber.js"),
    read("public-hml/js/account.js"),
  ]);
  for (const source of [app, admin, barber, account]) {
    assert.match(source, /resolveTenantPageAccess\(/);
    assert.match(source, /renderTenantAccessGate\(/);
  }
  assert.match(app, /id=\"app-shell\"|getElementById\("app-shell"\)/);
  assert.match(account, /getElementById\("account-shell"\)|\$\("#account-shell"\)/);
  const appListener = app.slice(app.lastIndexOf("onAuthStateChanged("));
  const barberListener = barber.slice(barber.lastIndexOf("onAuthStateChanged("));
  const accountListener = account.slice(account.lastIndexOf("onAuthStateChanged("));
  const adminListener = admin.slice(admin.lastIndexOf("onAuthStateChanged("));
  assert.ok(appListener.indexOf("resolveTenantPageAccess(") < appListener.indexOf("obterUidOperacionalComBootstrapCliente("));
  assert.ok(appListener.indexOf("currentBootstrap(user, generation)") < appListener.indexOf("renderTenantAccessGate("));
  assert.ok(barberListener.indexOf("resolveTenantPageAccess(") < barberListener.indexOf("obterUidOperacionalComPrimeiroVinculo("));
  assert.ok(barberListener.indexOf("currentBarberBootstrap(user, generation)") < barberListener.indexOf("renderTenantAccessGate("));
  assert.ok(accountListener.indexOf("resolveTenantPageAccess(") < accountListener.indexOf("renderGlobalAccountData("));
  assert.ok(adminListener.indexOf("resolveTenantPageAccess(") < adminListener.indexOf('style.display = "block"'));
});

test("shells protegidos começam ocultos no HTML", async () => {
  const [app, admin, barber, account] = await Promise.all([
    read("public-hml/app.html"),
    read("public-hml/admin.html"),
    read("public-hml/barber.html"),
    read("public-hml/account.html"),
  ]);
  assert.match(app, /id="app-shell" hidden/);
  assert.match(admin, /id="admin-shell" style="display: none"/);
  assert.match(barber, /id="barber-shell" style="display:none"/);
  assert.match(account, /id="account-shell" hidden/);
});

test("gate não aceita tenantId, slug ou role do caller", async () => {
  const source = await read("public-hml/js/tenant-membership-gate.js");
  assert.doesNotMatch(source, /tenantId\s*:/);
  assert.doesNotMatch(source, /slug\s*:/);
  assert.doesNotMatch(source, /options/);
  assert.doesNotMatch(source, /localStorage|sessionStorage/);
});

test("saída de acesso negado é pública e determinística", async () => {
  assert.equal(deniedAccessRoute("MEMBERSHIP_MISSING"), "access-denied.html?reason=MEMBERSHIP_MISSING");
  assert.equal(deniedAccessRoute("UNTRUSTED_REDIRECT"), "access-denied.html?reason=MEMBERSHIP_UNAVAILABLE");
  const [app, admin, barber, account, denied, deniedJs, index] = await Promise.all([
    read("public-hml/app.html"),
    read("public-hml/admin.html"),
    read("public-hml/barber.html"),
    read("public-hml/account.html"),
    read("public-hml/access-denied.html"),
    read("public-hml/js/access-denied.js"),
    read("public-hml/index.html"),
  ]);
  for (const source of [app, admin, barber, account]) {
    assert.match(source, /data-tenant-denied-exit[^>]+href="access-denied\.html"/);
  }
  assert.doesNotMatch(denied, /onAuthStateChanged|app\.html|admin\.html|barber\.html|account\.html/);
  assert.doesNotMatch(deniedJs, /location\.href|location\.assign|history\.back/);
  assert.match(deniedJs, /signOut\(auth\)/);
  assert.match(index, /window\.location\.href = "app\.html"/);
});
