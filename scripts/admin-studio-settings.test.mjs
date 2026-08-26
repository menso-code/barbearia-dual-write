import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  STUDIO_SETTINGS_DEFAULTS,
  studioIdentityToForm,
  studioSettingsToBackendPayload,
  isSafePreviewReference,
  isValidInstagram,
  isValidPhone,
  studioSettingsChanged,
  validateStudioSettings,
} from "../public/js/admin-studio-settings-core.mjs";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const [html, js, css] = await Promise.all([
  read("public/admin.html"),
  read("public/js/admin-studio-settings.js"),
  read("public/css/admin-studio-settings.css"),
]);

assert.match(html, /data-view="configuracoes"/);
assert.match(html, /id="studio-settings-form"/);
assert.match(html, /id="studio-preview-shell"/);
assert.match(html, /class="studio-settings-notice"[\s\S]*Identidade do estabelecimento/);
assert.match(html, /id="studio-settings-save"/);
assert.match(html, /id="studio-settings-discard"/);
assert.doesNotMatch(html, /Salvamento indisponível nesta V1|salvamento será habilitado/);
for (const section of ["Identidade", "Aparência", "Contato", "Localização", "Institucional"]) {
  assert.match(html, new RegExp(`<legend>${section}</legend>`));
}
assert.match(html, /Logo do estabelecimento/);
assert.doesNotMatch(html, /id="studio-favicon"|id="studio-preview-favicon"|name="favicon"/);
assert.match(html, /Telefone comercial/);
assert.match(html, /WhatsApp para clientes/);
assert.match(html, /referência HTTPS ou um caminho relativo seguro/);
assert.match(html, /Cor principal[\s\S]*Usada nos principais destaques/);
assert.match(html, /Cor de destaque[\s\S]*Usada em elementos secundários e detalhes visuais/);
assert.match(html, /css\/admin-studio-settings\.css/);
assert.match(html, /js\/admin-studio-settings\.js/);
assert.match(js, /studioSettingsChanged/);
assert.match(js, /addEventListener\("input", render\)/);
assert.match(js, /getDoc\(identityRef\)/);
assert.match(js, /admin\.estudio\.identidade\.salvar/);
assert.match(js, /studioSettingsToBackendPayload/);
assert.doesNotMatch(js, /favicon/i);
assert.match(js, /preserveError/);
assert.match(js, /Suas alterações foram preservadas/);
assert.match(js, /state = "LOADING"/);
for (const state of ["READY", "DIRTY", "SAVING", "SAVED", "ERROR"]) assert.match(js, new RegExp(`${state}:`));
assert.match(css, /grid-template-columns: minmax\(0, 1\.2fr\)/);
assert.match(css, /@media \(min-width: 901px\)[\s\S]*position: sticky/);
assert.match(css, /@media \(max-width: 600px\)/);
assert.doesNotMatch(js, /setDoc|addDoc|updateDoc|deleteDoc/);
assert.doesNotMatch(js, /window\.(?:alert|confirm|prompt)/);
assert.doesNotMatch(js, /document\.documentElement/);
assert.doesNotMatch(await read("public/js/admin-studio-settings-core.mjs"), /favicon/i);

assert.equal(validateStudioSettings(STUDIO_SETTINGS_DEFAULTS).valid, true);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, name: "" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, primaryColor: "green" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, phone: "123" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, instagram: "not a handle" }).valid, false);
assert.equal(isValidPhone("(11) 99999-9999"), true);
assert.equal(isValidInstagram("@goestudio"), true);
assert.equal(isValidInstagram("https://instagram.com/goestudio"), true);
assert.equal(isSafePreviewReference("javascript:alert(1)"), false);
assert.equal(isSafePreviewReference("data:image/png;base64,abc"), false);
assert.equal(isSafePreviewReference("https://cdn.example/logo.png"), true);
assert.equal(isSafePreviewReference("img/logo.png"), true);
assert.equal(isSafePreviewReference("http://cdn.example/logo.png"), false);
assert.equal(studioSettingsChanged(STUDIO_SETTINGS_DEFAULTS), false);
assert.equal(studioSettingsChanged({ ...STUDIO_SETTINGS_DEFAULTS, name: "Novo nome" }), true);

const backendIdentity = studioSettingsToBackendPayload({
  ...STUDIO_SETTINGS_DEFAULTS,
  name: "Studio A",
  shortName: "A",
  primaryColor: "#abcdef",
  phone: "(11) 99999-9999",
  address: "Rua A",
});
assert.equal(backendIdentity.nome, "Studio A");
assert.equal(backendIdentity.nomeCurto, "A");
assert.equal(backendIdentity.primaryColor, "#ABCDEF");
assert.equal(backendIdentity.telefone, "(11) 99999-9999");
assert.equal("tenantId" in backendIdentity, false);
assert.equal("updatedAt" in backendIdentity, false);
assert.equal("updatedBy" in backendIdentity, false);
assert.deepEqual(studioIdentityToForm({ nome: "Persistido", primaryColor: "#abcdef" }), {
  ...STUDIO_SETTINGS_DEFAULTS,
  name: "Persistido",
  primaryColor: "#ABCDEF",
});
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, institutional: "x".repeat(2001) }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, logo: "data:text/html,alert(1)" }).valid, false);

console.log("admin studio settings tests: PASS");
