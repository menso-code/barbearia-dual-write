import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";

import {
  TENANT_CONTEXT_STATES,
  createTenantContextManager,
  tenantContextIsReady,
} from "../public/js/tenant-context-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("App aguarda TenantContext READY antes de Auth e listeners", async () => {
  const source = await read("public/js/app.js");
  const initialization = source.indexOf("const tenantContext = await initializeTenantContext()");
  const readyGate = source.indexOf("if (!tenantContextIsReady(tenantContext))", initialization);
  const startGuard = source.indexOf("else if (!appTenantConsumersStarted)", readyGate);
  const authListener = source.indexOf("onAuthStateChanged(auth", startGuard);
  const firstUiListener = source.indexOf("addEventListener", startGuard);

  assert.ok(initialization > 0 && readyGate > initialization);
  assert.ok(startGuard > readyGate && authListener > startGuard && firstUiListener > startGuard);
  assert.match(source, /renderTenantFailure\(tenantContext\.status\)/);
});

test("App usa somente referências V2 derivadas do TenantContext", async () => {
  const source = await read("public/js/app.js");
  assert.match(source, /collection\(db, "barbearias", tenantContext\.tenantId, name\)/);
  assert.match(source, /doc\(db, "barbearias", tenantContext\.tenantId, name, id\)/);
  assert.match(source, /tenantCollection\("barbeiros"\)/);
  assert.match(source, /tenantCollection\("servicos"\)/);
  assert.match(source, /tenantCollection\("planos_assinatura"\)/);
  assert.match(source, /tenantCollection\("assinaturas"\)/);
  assert.match(source, /tenantCollection\("agendamentos"\)/);
  assert.doesNotMatch(source, /BARBEARIA_ATUAL|BARBEARIA_PADRAO|tnt_80b2|\bantunes\b|obterUidOperacional/i);
  assert.doesNotMatch(source, /collection\(db, "(?:barbeiros|servicos|planos_assinatura|solicitacoes_assinatura|agendamentos)"\)/);
});

test("Agenda exige adaptador tenant-scoped e não mantém leitura root", async () => {
  const source = await read("public/js/agenda.js");
  assert.match(source, /export function createTenantScopedAgenda\(tenantContext\)/);
  assert.match(source, /if \(!tenantContextIsReady\(tenantContext\)\) throw new Error\("TENANT_CONTEXT_NOT_READY"\)/);
  assert.match(source, /export async function obterFechamentoGlobal\(_db, data, \{ tenantContext \} = \{\}\) \{\s*const context = requireTenantScope\(tenantContext\)/);
  assert.match(source, /export async function horariosDisponiveis\([^\n]+\{ tenantContext \} = \{\}\) \{\s*const context = requireTenantScope\(tenantContext\)/);
  assert.match(source, /doc\(db, "barbearias", context\.tenantId, collectionName, id\)/);
  assert.match(source, /V2_COLLECTIONS\.ocupacoes/);
  assert.match(source, /executarComandoOperacional\("agenda\.disponibilidade\.obter"/);
  assert.doesNotMatch(source, /doc\(db, "(?:configuracoes|fechamentos_globais|ocupacoes)"/);
  assert.doesNotMatch(source, /CONFIG_FUNCIONAMENTO|fechamentoSemanal|if \(tenantContext\)/);
  assert.doesNotMatch(source, /BARBEARIA_ATUAL|BARBEARIA_PADRAO|tnt_80b2|\bantunes\b/i);
});

test("callers runtime da Agenda usam somente o adaptador tenant-scoped", async () => {
  const [app, admin, barber, controlCenter] = await Promise.all([
    read("public/js/app.js"),
    read("public/js/admin.js"),
    read("public/js/barber.js"),
    read("public/js/admin-control-center.js"),
  ]);
  const runtime = `${app}\n${admin}\n${barber}\n${controlCenter}`;
  assert.match(app, /createTenantScopedAgenda\(tenantContext\)/);
  assert.match(admin, /createTenantScopedAgenda\(adminTenantContext\)/);
  assert.match(barber, /createTenantScopedAgenda\(tenantContext\)/);
  assert.match(controlCenter, /const \{ dataLocalHoje, horariosCandidatos \} = await import\("\.\/agenda\.js"\)/);
  assert.doesNotMatch(runtime, /import\s*\{[^}]*\b(?:obterFechamentoGlobal|horariosDisponiveis)\b[^}]*\}\s*from\s*"\.\/agenda\.js"/s);
});

test("AGENDA_NO_DIRECT_CLOSURE_GETDOC e backend derived read", async () => {
  const source = await read("public/js/agenda.js");
  assert.doesNotMatch(source, /tenantDocument\([^\n]*fechamentos/);
  assert.doesNotMatch(source, /"barbearias"[^\n]*"fechamentos"/);
  assert.match(source, /agenda\.disponibilidade\.obter/);
  assert.match(source, /data: \{ data, slug: context\.slug \}/);
  assert.match(source, /periodosEfetivos: availability\.effectiveOpenPeriods/);
  assert.match(source, /periodosEfetivosDoBarbeiro\(barbeiro, data, periodosGlobais\)/);
  assert.match(source, /Array\.isArray\(configuracao\) \? intersectarPeriodos\(periodosGlobais, configuracao\) : periodosGlobais/);
  assert.match(source, /horariosCandidatos\(barbeiro, data, Number\(duracao\), disponibilidade\.periodosEfetivos\)/);
});

test("APP_NO_DIRECT_CLOSURE_GETDOC e integração usa Agenda tenant-scoped", async () => {
  const source = await read("public/js/app.js");
  assert.doesNotMatch(source, /tenantDocument\("fechamentos"/);
  assert.doesNotMatch(source, /tenantCollection\("fechamentos"/);
  assert.match(source, /createTenantScopedAgenda\(tenantContext\)/);
  assert.match(source, /obterFechamentoGlobal/);
  assert.match(source, /disponibilidadeGlobal: fechamento/);
  assert.match(source, /duracao, disponibilidadeGlobal/);
});

test("NOT_FOUND, UNAVAILABLE e ERROR iniciam zero consumidores tenant-scoped", () => {
  for (const status of [
    TENANT_CONTEXT_STATES.NOT_FOUND,
    TENANT_CONTEXT_STATES.UNAVAILABLE,
    TENANT_CONTEXT_STATES.ERROR,
  ]) {
    let starts = 0;
    if (tenantContextIsReady({ status, tenantId: "tenant-a" })) starts += 1;
    assert.equal(starts, 0);
  }
});

test("bootstrap parcial limpa estado e bloqueia callbacks antigos", async () => {
  const source = await read("public/js/app.js");
  assert.match(source, /const generation = \+\+appBootstrapGeneration/);
  assert.match(source, /function resetTenantScopedState\(\)/);
  assert.match(source, /function assertCurrentGeneration\(generation = appBootstrapGeneration\)/);
  assert.match(source, /if \(!currentBootstrap\(user, generation\)\) return;[\s\S]*resetTenantScopedState\(\);[\s\S]*renderTenantFailure\(TENANT_CONTEXT_STATES\.ERROR\)/);
  assert.match(source, /const snap = await getDocs\(q\);\s*assertCurrentGeneration\(generation\);/);
});

test("proteção contra listeners duplicados é explícita", async () => {
  const source = await read("public/js/app.js");
  assert.match(source, /let appTenantConsumersStarted = false/);
  assert.match(source, /else if \(!appTenantConsumersStarted\) \{\s*appTenantConsumersStarted = true/);
  assert.equal((source.match(/onAuthStateChanged\(auth/g) || []).length, 1);
});

test("TenantContext rejeita segundo tenant na mesma sessão", async () => {
  const manager = createTenantContextManager({
    legacyCompat: { tenantId: "tenant-a", slug: "studio-a", hostnames: ["a.example"] },
  });
  const first = await manager.initialize({ hostname: "a.example", mode: "production" });
  assert.equal(first.tenantId, "tenant-a");
  await assert.rejects(
    manager.initialize({ hostname: "b.example", mode: "production" }),
    (error) => error?.code === "SECOND_TENANT_INITIALIZATION",
  );
});

test("payloads e nomes dos comandos operacionais permanecem sem tenantId", async () => {
  const [agenda, app] = await Promise.all([
    read("public/js/agenda.js"),
    read("public/js/app.js"),
  ]);
  const names = new Set(
    [...`${agenda}\n${app}`.matchAll(/executarComandoOperacional\("([^"]+)"/g)]
      .map((match) => match[1]),
  );
  assert.deepEqual(names, new Set([
    "agenda.disponibilidade.obter",
    "agenda.criar",
    "agenda.reagendar",
    "agenda.concluir",
    "agenda.cancelar",
    "agenda.nao_compareceu",
    "bloqueio.criar",
    "bloqueio.remover",
    "cliente.garantir-perfil",
    "assinatura.solicitar",
  ]));
  assert.doesNotMatch(`${agenda}\n${app}`, /\btenantId\s*:/);
});

test("cache/storage não cria estado global ou cross-tenant", async () => {
  const [agenda, app] = await Promise.all([
    read("public/js/agenda.js"),
    read("public/js/app.js"),
  ]);
  assert.doesNotMatch(`${agenda}\n${app}`, /localStorage|sessionStorage|indexedDB/);
});

test("compatibilidade fixa permanece somente nos adaptadores adiados", async () => {
  const [firebaseConfig, tenant, context, agenda, app] = await Promise.all([
    read("public/js/firebase-config.js"),
    read("public/js/tenant.js"),
    read("public/js/tenant-context.js"),
    read("public/js/agenda.js"),
    read("public/js/app.js"),
  ]);
  assert.doesNotMatch(firebaseConfig, /BARBEARIA_ATUAL_ID|BARBEARIA_ATUAL_SLUG|getBarbeariaAtual|getSlugBarbeariaAtual|\.\/tenant\.js/);
  assert.match(tenant, /BARBEARIA_PADRAO_ID/);
  assert.match(context, /LEGACY_FIREBASE_COMPAT/);
  assert.doesNotMatch(`${agenda}\n${app}`, /BARBEARIA_ATUAL_ID|BARBEARIA_PADRAO_ID/);
});
