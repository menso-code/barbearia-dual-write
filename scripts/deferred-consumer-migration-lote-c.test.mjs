import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  TENANT_CONTEXT_STATES,
  tenantContextIsReady,
} from "../public/js/tenant-context-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const directLegacyRead = /(?:collection|doc)\(db,\s*"(?:clientes|barbeiros|servicos|agendamentos|bloqueios|configuracoes|fechamentos_globais|planos_assinatura|solicitacoes_assinatura|historico_assinaturas)"/;
const fixedTenantReference = /BARBEARIA_ATUAL_ID|BARBEARIA_ATUAL_SLUG|BARBEARIA_PADRAO_ID|BARBEARIA_PADRAO_SLUG|tnt_80b2fda7ad644a1dbeff050aa8e0d595/;

test("Barbeiro aguarda TenantContext READY antes de Auth, leituras e listeners", async () => {
  const source = await read("public/js/barber.js");
  const initialization = source.indexOf("const resolvedTenantContext = await initializeTenantContext()");
  const readyGate = source.indexOf("if (!tenantContextIsReady(resolvedTenantContext))", initialization);
  const tenantAssignment = source.indexOf("tenantContext = resolvedTenantContext", readyGate);
  const authListener = source.indexOf("onAuthStateChanged(auth", tenantAssignment);
  const firstLoad = source.indexOf("await carregarServicos()", authListener);
  const agendaStart = source.indexOf("assinarAgenda()", firstLoad);

  assert.ok(initialization > 0 && readyGate > initialization);
  assert.ok(tenantAssignment > readyGate && authListener > tenantAssignment);
  assert.ok(firstLoad > authListener && agendaStart > firstLoad);
  assert.match(source, /createTenantScopedAgenda\(tenantContext\)/);
  assert.match(source, /tenantCollection\("barbeiros"\)/);
  assert.match(source, /tenantCollection\("servicos"\)/);
  assert.match(source, /tenantCollection\("agendamentos"\)/);
  assert.match(source, /tenantCollection\("bloqueios"\)/);
  assert.doesNotMatch(source, directLegacyRead);
  assert.doesNotMatch(source, fixedTenantReference);
});

test("Barbeiro encerra listeners em troca de período, saída e falha", async () => {
  const source = await read("public/js/barber.js");
  assert.match(source, /function pararAgendaListeners\(\)[\s\S]*cancelarAgendaListener\?\.\(\)[\s\S]*cancelarBloqueioListener\?\.\(\)/);
  assert.match(source, /async function assinarAgenda\(\) \{\s*pararAgendaListeners\(\)/);
  assert.match(source, /onAuthStateChanged\(auth, async \(user\) => \{\s*const generation = \+\+barberAuthGeneration;\s*pararAgendaListeners\(\);\s*if \(!user\)/);
  assert.match(source, /catch \(erro\) \{\s*pararAgendaListeners\(\)/);
  assert.match(source, /iniciarPainelBarbeiro\(\)\.catch\(\(erro\) => \{\s*pararAgendaListeners\(\)/);
  assert.match(source, /let agendaListenerGeneration = 0/);
  assert.match(source, /let barberAuthGeneration = 0/);
  assert.match(source, /let barberInterfaceMounted = false/);
  assert.match(source, /if \(!currentBarberBootstrap\(user, generation\)\) return/);
  assert.match(source, /const generation = agendaListenerGeneration/);
  assert.match(source, /if \(generation !== agendaListenerGeneration\) return/);
  assert.equal((source.match(/onSnapshot\(/g) || []).length, 2);
});

test("Conta preserva dados globais antes do gate e restringe dados tenant-scoped", async () => {
  const source = await read("public/js/account.js");
  const authListener = source.indexOf("onAuthStateChanged(auth");
  const globalRender = source.indexOf("renderGlobalAccountData(current)", authListener);
  const initialization = source.indexOf("await initializeTenantContext()", globalRender);
  const readyGate = source.indexOf("if(!tenantContextIsReady(resolvedTenantContext))", initialization);
  const tenantAssignment = source.indexOf("tenantContext=resolvedTenantContext", readyGate);
  const tenantLoad = source.indexOf("await loadOptions(current,generation)", tenantAssignment);

  assert.ok(authListener > 0 && globalRender > authListener);
  assert.ok(initialization > globalRender && readyGate > initialization);
  assert.ok(tenantAssignment > readyGate && tenantLoad > tenantAssignment);
  assert.match(source, /function renderGlobalAccountData\(current\)/);
  assert.match(source, /function ensureTenantAccountReady\(messageId\)/);
  assert.match(source, /let accountBootstrapGeneration = 0/);
  assert.match(source, /function assertCurrentAccountBootstrap\(current, generation\)/);
  assert.match(source, /if\(!currentAccountBootstrap\(current,generation\)\)return/);
  assert.match(source, /clientUid=current\.uid/);
  assert.match(source, /tenantDocument\("clientes", clientUid\)/);
  assert.doesNotMatch(source, /obterUidOperacional/);
  assert.match(source, /tenantCollection\("agendamentos"\)/);
  assert.match(source, /tenantCollection\("barbeiros"\)/);
  assert.match(source, /tenantCollection\("servicos"\)/);
  assert.doesNotMatch(source, directLegacyRead);
  assert.doesNotMatch(source, fixedTenantReference);
});

test("Admin legado usa somente caminhos V2 após TenantContext e membership ADMIN", async () => {
  const source = await read("public/js/admin.js");
  const initialization = source.indexOf("const tenantContext = await initializeTenantContext()");
  const readyGate = source.indexOf("if (!tenantContextIsReady(tenantContext))", initialization);
  const accessGate = source.indexOf("const access = await getCurrentUserAccess(user)", readyGate);
  const adminGate = source.indexOf("if (!access.isAdmin)", accessGate);
  const tenantAssignment = source.indexOf("adminTenantContext = tenantContext", adminGate);
  const firstLoad = source.indexOf("await carregarBarbeiros()", tenantAssignment);

  assert.ok(initialization > 0 && readyGate > initialization);
  assert.ok(accessGate > readyGate && adminGate > accessGate);
  assert.ok(tenantAssignment > adminGate && firstLoad > tenantAssignment);
  assert.match(source, /createTenantScopedAgenda\(adminTenantContext\)/);
  assert.match(source, /fechamentos_globais: "fechamentos"/);
  assert.match(source, /solicitacoes_assinatura: "assinaturas"/);
  assert.doesNotMatch(source, directLegacyRead);
  assert.doesNotMatch(source, fixedTenantReference);
});

test("Conta e Barbeiro usam identidades compatíveis com as Rules V2", async () => {
  const [account, barber, rules] = await Promise.all([
    read("public/js/account.js"),
    read("public/js/barber.js"),
    read("firestore.rules"),
  ]);
  assert.match(account, /clientUid=current\.uid/);
  assert.match(account, /where\("cliente_id", "==", clientUid\)/);
  assert.match(rules, /match \/clientes\/\{uid\}[\s\S]*allow get: if uid == request\.auth\.uid/);
  assert.match(rules, /match \/agendamentos\/\{id\}[\s\S]*resource\.data\.cliente_id == request\.auth\.uid/);
  assert.match(barber, /where\("barbeiro_id", "==", barbeiroAtual\.id\)/);
  assert.match(rules, /match \/agendamentos\/\{id\}[\s\S]*v2Barbeiro\(tenantId\)[\s\S]*resource\.data\.barbeiro_id == v2BarbeiroId\(tenantId\)/);
});

test("Estados de tenant com falha iniciam zero consumidores tenant-scoped", () => {
  for (const status of [
    TENANT_CONTEXT_STATES.NOT_FOUND,
    TENANT_CONTEXT_STATES.UNAVAILABLE,
    TENANT_CONTEXT_STATES.ERROR,
  ]) {
    let reads = 0;
    let listeners = 0;
    let operations = 0;
    if (tenantContextIsReady({ status, tenantId: "tenant-a" })) {
      reads += 1;
      listeners += 1;
      operations += 1;
    }
    assert.deepEqual({ reads, listeners, operations }, { reads: 0, listeners: 0, operations: 0 });
  }
});

test("Lote C não cria cache cross-tenant nem expande compatibilidade fixa", async () => {
  const [barber, account, admin, tenant, context, firebaseConfig] = await Promise.all([
    read("public/js/barber.js"),
    read("public/js/account.js"),
    read("public/js/admin.js"),
    read("public/js/tenant.js"),
    read("public/js/tenant-context.js"),
    read("public/js/firebase-config.js"),
  ]);
  const migrated = `${barber}\n${account}\n${admin}`;
  assert.doesNotMatch(migrated, /localStorage|sessionStorage|indexedDB/);
  assert.doesNotMatch(migrated, fixedTenantReference);
  assert.doesNotMatch(migrated, /\btenantId\s*:/);
  assert.match(tenant, /BARBEARIA_PADRAO_ID/);
  assert.match(context, /LEGACY_FIREBASE_COMPAT/);
  assert.match(firebaseConfig, /BARBEARIA_ATUAL_ID/);
});

test("Nomes e envelopes dos comandos operacionais permanecem sem tenantId", async () => {
  const [barber, account, admin] = await Promise.all([
    read("public/js/barber.js"),
    read("public/js/account.js"),
    read("public/js/admin.js"),
  ]);
  const source = `${barber}\n${account}\n${admin}`;
  const names = new Set(
    [...source.matchAll(/executarComandoOperacional\((?:`([^`$]+)`|"([^"]+)")/g)]
      .map((match) => match[1] || match[2]),
  );
  assert.deepEqual(names, new Set([
    "admin.assinatura.aprovar",
    "admin.assinatura.recusar",
    "admin.barbeiro.ativar",
    "admin.barbeiro.remover",
    "admin.barbeiro.salvar",
    "admin.fechamento.remover",
    "admin.fechamento.salvar",
    "admin.funcionamento.salvar",
    "admin.plano.ativar",
    "admin.plano.inicial",
    "admin.plano.salvar",
    "admin.servico.remover",
    "admin.servico.salvar",
    "cliente.atualizar-perfil",
    "cliente.garantir-perfil",
  ]));
  assert.doesNotMatch(source, /executarComandoOperacional\([^)]*\btenantId\s*:/s);
});
