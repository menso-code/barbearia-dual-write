import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const source = await readFile(new URL("public-hml/js/operational-commands.js", root), "utf8");
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadHarness() {
  const calls = [];
  const context = vm.createContext({
    __calls: calls,
    __state: { status: "READY", tenantId: "tenant-a", slug: "studio-a" },
    __command: async (envelope) => {
      calls.push(envelope);
      return { data: { ok: true } };
    },
    crypto: { randomUUID: () => "generated-request-id" },
    location: { hostname: "teste-483f6.web.app" },
    console,
  });
  const executable = source
    .replace(/import[\s\S]*?from\s+["'][^"']+["'];\r?\n/g, "")
    .replace(/const command = httpsCallable\(functions, "executeOperationalCommand"\);/, "const command = globalThis.__command;")
    .replace(/export async function/g, "async function")
    .replace(/export function/g, "function");
  vm.runInContext(`
    const initializeTenantContext = async () => globalThis.__state;
    const tenantContextIsReady = (value) => value?.status === "READY" && Boolean(value?.tenantId);
    ${executable}
    globalThis.__api = { executarComandoOperacional };
  `, context);
  return { context, calls, execute: context.__api.executarComandoOperacional };
}

test("anexa o hostname do TenantContext e preserva requestId/payload", async () => {
  const harness = loadHarness();
  await harness.execute("admin.plano.inicial", {
    requestId: "provided-request-id",
    data: { id: "plan-a", nome: "Plano QA" },
  });
  assert.equal(harness.calls.length, 1);
  assert.deepEqual(plain(harness.calls[0]), {
    command: "admin.plano.inicial",
    requestId: "provided-request-id",
    context: { hostname: "teste-483f6.web.app" },
    data: { id: "plan-a", nome: "Plano QA" },
  });
});

test("Tenant A e Tenant B enviam seus próprios hostnames", async () => {
  const harness = loadHarness();
  await harness.execute("cliente.atualizar-perfil", { data: { nome: "A" } });
  harness.context.location.hostname = "goestudioapp-qa-b.web.app";
  harness.context.__state = { status: "READY", tenantId: "tenant-b", slug: "studio-b" };
  await harness.execute("cliente.atualizar-perfil", { data: { nome: "B" } });
  assert.deepEqual(plain(harness.calls.map(({ context }) => context)), [
    { hostname: "teste-483f6.web.app" },
    { hostname: "goestudioapp-qa-b.web.app" },
  ]);
});

test("caller não sobrescreve contexto nem injeta tenantId/slug", async () => {
  const harness = loadHarness();
  for (const payload of [
    { context: { hostname: "outro.web.app" } },
    { hostname: "outro.web.app" },
    { tenantId: "tenant-b" },
    { data: { tenant_id: "tenant-b" } },
    { data: { slug: "outro-slug" } },
  ]) {
    await assert.rejects(harness.execute("cliente.atualizar-perfil", payload), /RUNTIME_DERIVED/);
  }
  assert.equal(harness.calls.length, 0);
});

test("TenantContext não READY bloqueia o envio", async () => {
  const harness = loadHarness();
  harness.context.__state = { status: "NOT_FOUND", tenantId: "", slug: "" };
  await assert.rejects(
    harness.execute("cliente.atualizar-perfil", { data: { nome: "não deve enviar" } }),
    /TENANT_CONTEXT_NOT_READY/,
  );
  assert.equal(harness.calls.length, 0);
});

test("disponibilidade remove apenas o slug legado substituído pelo hostname", async () => {
  const harness = loadHarness();
  await harness.execute("agenda.disponibilidade.obter", {
    data: { data: "2026-08-28", slug: "slug-injetado" },
  });
  assert.deepEqual(plain(harness.calls[0].context), { hostname: "teste-483f6.web.app" });
  assert.deepEqual(plain(harness.calls[0].data), { data: "2026-08-28" });
});

test("não há fallback ou tenant fixo no wrapper HML", () => {
  assert.match(source, /initializeTenantContext\(\)/);
  assert.match(source, /tenantContextIsReady/);
  assert.match(source, /context: \{ hostname \}/);
  assert.doesNotMatch(source, /LEGACY_FIREBASE_HOSTS|ANTUNES_TENANT_SLUG|tnt_80b2|goestudioapp-qa-b/);
});

console.log("HML operational commands contract: PASS");
