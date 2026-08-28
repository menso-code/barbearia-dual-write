import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  deniedAccessRoute,
  evaluateTenantPageAccess,
  resolveTenantMembershipAccess,
  withAccessTimeout,
} from "../public-hml/js/tenant-membership-gate-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

const access = (overrides = {}) => ({
  isAuthenticated: true,
  tenantStatus: "READY",
  membershipStatus: "ACTIVE",
  roles: ["CLIENTE"],
  ...overrides,
});

const validUser = { uid: "qa-user" };
const validTenantContext = {
  status: "READY",
  tenantId: "tenant-b",
  hostname: "tenant-b.example.test",
};
const validMember = {
  ativo: true,
  papeis: ["ADMIN", "BARBEIRO", "CLIENTE"],
  barbeiro_id: "barber-b",
};

const resolveAccess = (overrides = {}) => resolveTenantMembershipAccess({
  user: validUser,
  resolveTenantContext: () => Promise.resolve(validTenantContext),
  resolveOperationalUid: () => Promise.resolve("operational-qa-user"),
  readMembership: () => Promise.resolve(validMember),
  timeoutMs: 20,
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
  assert.match(index, /resolveLoginTenantAccess/);
  assert.match(index, /if \(!access\.allowed\)/);
  assert.match(index, /window\.location\.replace\("app\.html"\)/);
});

test("membership válida libera CLIENTE, BARBEIRO e ADMIN", async () => {
  const result = await resolveAccess();
  assert.equal(result.membershipStatus, "ACTIVE");
  assert.deepEqual(result.roles, ["ADMIN", "BARBEIRO", "CLIENTE"]);
  for (const role of ["CLIENTE", "BARBEIRO", "ADMIN"]) {
    assert.equal(evaluateTenantPageAccess(result, role).allowed, true);
  }
});

test("mapeamento ausente continua sendo ausência de membership, não indisponibilidade", async () => {
  const result = await resolveAccess({
    resolveOperationalUid: () => Promise.reject(new Error("MAPEAMENTO_HOMOLOGACAO_AUSENTE")),
  });
  assert.equal(result.membershipStatus, "MISSING");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").code, "MEMBERSHIP_MISSING");
});

test("membership inativa bloqueia antes da role", async () => {
  const result = await resolveAccess({
    readMembership: () => Promise.resolve({ ativo: false, papeis: ["ADMIN"] }),
  });
  assert.equal(result.membershipStatus, "INACTIVE");
  assert.equal(evaluateTenantPageAccess(result, "ADMIN").code, "MEMBERSHIP_INACTIVE");
});

test("role insuficiente bloqueia uma membership ativa", async () => {
  const result = await resolveAccess({
    readMembership: () => Promise.resolve({ ativo: true, papeis: ["CLIENTE"] }),
  });
  assert.equal(result.membershipStatus, "ACTIVE");
  assert.equal(evaluateTenantPageAccess(result, "ADMIN").code, "ROLE_INSUFFICIENT");
});

test("TenantContext pendente termina em MEMBERSHIP_UNAVAILABLE", async () => {
  const result = await resolveAccess({ resolveTenantContext: () => new Promise(() => {}) });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").code, "MEMBERSHIP_UNAVAILABLE");
});

test("mapeamento pendente termina em MEMBERSHIP_UNAVAILABLE", async () => {
  const result = await resolveAccess({ resolveOperationalUid: () => new Promise(() => {}) });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").code, "MEMBERSHIP_UNAVAILABLE");
});

test("membership pendente termina em MEMBERSHIP_UNAVAILABLE", async () => {
  const result = await resolveAccess({ readMembership: () => new Promise(() => {}) });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").code, "MEMBERSHIP_UNAVAILABLE");
});

test("erro técnico do Firestore não é confundido com ausência de membership", async () => {
  const result = await resolveAccess({
    readMembership: () => Promise.reject(new Error("permission-denied")),
  });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").code, "MEMBERSHIP_UNAVAILABLE");
});

test("resolução tardia após timeout não pode liberar acesso", async () => {
  let resolveLate;
  const result = await resolveAccess({
    timeoutMs: 5,
    readMembership: () => new Promise((resolve) => { resolveLate = resolve; }),
  });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "ADMIN").allowed, false);
  resolveLate(validMember);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "ADMIN").allowed, false);
});

test("timeout limpa o timer ao concluir e nenhum resultado permanece LOADING", async () => {
  assert.equal(await withAccessTimeout(Promise.resolve("ready"), 100, "TEST"), "ready");
  const [valid, missing, unavailable] = await Promise.all([
    resolveAccess(),
    resolveAccess({ readMembership: () => Promise.resolve(null) }),
    resolveAccess({ resolveTenantContext: () => new Promise(() => {}) }),
  ]);
  assert.notEqual(valid.membershipStatus, "LOADING");
  assert.notEqual(missing.membershipStatus, "LOADING");
  assert.notEqual(unavailable.membershipStatus, "LOADING");
  const core = await read("public-hml/js/tenant-membership-gate-core.mjs");
  assert.match(core, /clearTimeout\(timer\)/);
  assert.doesNotMatch(core, /membershipStatus\s*[:=]\s*["']LOADING["']/);
});

test("controle de acesso usa timeout central e não usa allSettled sem limite", async () => {
  const [core, accessControl] = await Promise.all([
    read("public-hml/js/tenant-membership-gate-core.mjs"),
    read("public-hml/js/access-control.js"),
  ]);
  assert.match(core, /resolveTenantMembershipAccess/);
  assert.match(core, /TENANT_CONTEXT/);
  assert.match(core, /HML_MAPPING/);
  assert.match(core, /MEMBERSHIP/);
  assert.match(accessControl, /resolveTenantMembershipAccess/);
  assert.doesNotMatch(accessControl, /Promise\.allSettled/);
});

test("membership é inspecionada pelo backend, sem UID controlado pelo navegador", async () => {
  const [accessControl, operationalContext] = await Promise.all([
    read("public-hml/js/access-control.js"),
    read("functions/operational-context.mjs"),
  ]);
  assert.match(accessControl, /httpsCallable\(functions, "inspectTenantMembership"\)/);
  assert.doesNotMatch(accessControl, /obterUidOperacional|getDoc|tenantId\s*:/);
  assert.match(operationalContext, /membros\/\$\{authUid\}/);
});

test("login só redireciona após membership CLIENTE permitida", async () => {
  const [index, auth] = await Promise.all([
    read("public-hml/index.html"),
    read("public-hml/js/auth.js"),
  ]);
  assert.match(auth, /export async function resolveLoginTenantAccess\(user\)/);
  assert.match(auth, /resolveTenantPageAccess\(user, "CLIENTE"\)/);
  assert.match(index, /resolveLoginTenantAccess/);
  assert.match(index, /if \(!access\.allowed\)/);
  assert.match(index, /showLoginAccessMessage\(access\.message/);
  assert.match(index, /window\.location\.replace\("app\.html"\)/);
  assert.ok(index.indexOf("if (!access.allowed)") < index.indexOf('window.location.replace("app.html")'));
});

test("login preserva fail-closed e não substitui o gate interno", async () => {
  const [index, app, admin, barber, account] = await Promise.all([
    read("public-hml/index.html"),
    read("public-hml/js/app.js"),
    read("public-hml/js/admin.js"),
    read("public-hml/js/barber.js"),
    read("public-hml/js/account.js"),
  ]);
  assert.match(index, /Não foi possível validar seu acesso neste estabelecimento\./);
  assert.doesNotMatch(index, /tenantId\s*[:=]|slug\s*[:=]|hostname\s*[:=]/);
  for (const source of [app, admin, barber, account]) {
    assert.match(source, /resolveTenantPageAccess\(/);
    assert.match(source, /renderTenantAccessGate\(/);
  }
});

test("resposta da callable é estrita e não aceita campos de tenant injetados", async () => {
  const result = await resolveTenantMembershipAccess({
    user: validUser,
    requiredRole: "CLIENTE",
    resolveTenantContext: () => Promise.resolve(validTenantContext),
    inspectMembership: () => Promise.resolve({ schema: 1, state: "ACTIVE", tenantId: "tenant-forged" }),
    timeoutMs: 20,
  });
  assert.equal(result.membershipStatus, "UNAVAILABLE");
  assert.equal(evaluateTenantPageAccess(result, "CLIENTE").allowed, false);
});

test("access-control consulta a callable apenas com hostname e superfície", async () => {
  const accessControl = await read("public-hml/js/access-control.js");
  assert.match(accessControl, /inspectTenantMembership\(\{ context: \{ hostname \}, surface \}\)/);
  assert.doesNotMatch(accessControl, /tenantId\s*:|slug\s*:|uid\s*:|operationalUid\s*:|roles\s*:/);
});
