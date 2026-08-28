import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { access } from "node:fs/promises";
import test from "node:test";

const root = new URL("../", import.meta.url);
const read = (relativePath) => readFile(new URL(relativePath, root), "utf8");
const exists = async (relativePath) => {
  try {
    await access(new URL(relativePath, root));
    return true;
  } catch {
    return false;
  }
};

const hmlRuntimeFiles = [
  "public-hml/js/tenant-context-core.mjs",
  "public-hml/js/tenant-context.js",
  "public-hml/js/tenant-hostname-resolver-core.mjs",
  "public-hml/js/tenant-hostname-resolver.js",
  "public-hml/js/access-control.js",
  "public-hml/js/account.js",
  "public-hml/js/admin.js",
  "public-hml/js/agenda.js",
  "public-hml/js/app.js",
  "public-hml/js/barber.js",
];

test("HML possui o runtime TenantContext e resolver confiáveis", async () => {
  for (const file of hmlRuntimeFiles) assert.equal(await exists(file), true, file);

  const config = await read("public-hml/js/firebase-config.js");
  assert.match(config, /["']projectId["']:\s*"teste-483f6"/);
  assert.match(config, /authDomain":\s*"teste-483f6\.firebaseapp\.com"/);
  assert.doesNotMatch(config, /\.\/tenant\.js|BARBEARIA_ATUAL|BARBEARIA_PADRAO|getBarbeariaAtual|getSlugBarbeariaAtual/);
  assert.equal(await exists("public-hml/js/tenant.js"), false);

  const context = await read("public-hml/js/tenant-context.js");
  const resolver = await read("public-hml/js/tenant-hostname-resolver.js");
  const resolverCore = await read("public-hml/js/tenant-hostname-resolver-core.mjs");
  const contextRuntime = `${context}\n${resolver}\n${resolverCore}`;
  assert.match(context, /createTenantContextManager/);
  assert.match(context, /registerTrustedTenantHostnameResolver\(resolveTenantHostname\)/);
  assert.match(resolver, /httpsCallable\(functions, "resolveTenantHostname"\)/);
  assert.doesNotMatch(contextRuntime, /LEGACY_FIREBASE_HOSTS|ANTUNES_TENANT_SLUG|BARBEARIA_PADRAO|tnt_80b2fda7ad644a1dbeff050aa8e0d595|\bantunes\b|\bgoestudioapp\b/i);

  for (const file of [
    "public-hml/js/access-control.js",
    "public-hml/js/account.js",
    "public-hml/js/admin.js",
    "public-hml/js/agenda.js",
    "public-hml/js/app.js",
    "public-hml/js/barber.js",
  ]) {
    const source = await read(file);
    assert.match(source, /tenant-context\.js/);
    assert.doesNotMatch(source, /collection\(db,\s*["'](?:clientes|barbeiros|servicos|agendamentos|ocupacoes|bloqueios|configuracoes|fechamentos|fechamentos_globais|planos_assinatura|assinaturas|solicitacoes_assinatura|historico_assinaturas)["']\s*\)/);
    assert.doesNotMatch(source, /doc\(db,\s*["'](?:clientes|barbeiros|servicos|agendamentos|ocupacoes|bloqueios|configuracoes|fechamentos|fechamentos_globais|planos_assinatura|assinaturas|solicitacoes_assinatura|historico_assinaturas)["']\s*,/);
  }
});

test("shells HML usam somente os consumidores reconciliados", async () => {
  const pages = {
    "public-hml/app.html": "js/app.js",
    "public-hml/admin.html": "js/admin.js",
    "public-hml/account.html": "js/account.js",
    "public-hml/barber.html": "js/barber.js",
  };
  for (const [file, script] of Object.entries(pages)) {
    const source = await read(file);
    assert.match(source, new RegExp(`src=["']${script.replace(".", "\\.")}`), file);
    assert.doesNotMatch(source, /js\/tenant\.js/);
  }
  for (const id of [
    "modal-operacional-confirmacao",
    "operational-modal-eyebrow",
    "operational-modal-title",
    "operational-modal-description",
    "operational-modal-details",
    "btn-operational-cancel",
    "btn-operational-confirm",
  ]) assert.match(await read("public-hml/admin.html"), new RegExp(`id=["']${id}["']`));
});

test("recursos HML específicos permanecem presentes", async () => {
  for (const file of [
    "public-hml/js/homologation-identity.js",
    "public-hml/js/operational-commands.js",
    "public-hml/js/pwa-install.js",
    "public-hml/manifest.webmanifest",
    "public-hml/sw.js",
  ]) assert.equal(await exists(file), true, file);
});
