import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  STUDIO_SETTINGS_DEFAULTS,
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
assert.match(html, /class="studio-settings-notice"[\s\S]*Pré-visualização local/);
assert.doesNotMatch(html, /id="studio-settings-save"/);
assert.match(html, /Salvamento indisponível nesta V1/);
for (const section of ["Identidade", "Aparência", "Contato", "Localização", "Institucional"]) {
  assert.match(html, new RegExp(`<legend>${section}</legend>`));
}
assert.match(html, /Logo do estabelecimento/);
assert.match(html, /Favicon/);
assert.match(html, /Telefone comercial/);
assert.match(html, /WhatsApp para clientes/);
assert.match(html, /Upload será disponibilizado em uma próxima versão/);
assert.match(html, /Cor principal[\s\S]*Usada nos principais destaques/);
assert.match(html, /Cor de destaque[\s\S]*Usada em elementos secundários e detalhes visuais/);
assert.match(html, /css\/admin-studio-settings\.css/);
assert.match(html, /js\/admin-studio-settings\.js/);
assert.match(js, /studioSettingsChanged/);
assert.match(js, /addEventListener\("input", render\)/);
assert.match(css, /grid-template-columns: minmax\(0, 1\.2fr\)/);
assert.match(css, /@media \(min-width: 901px\)[\s\S]*position: sticky/);
assert.match(css, /@media \(max-width: 600px\)/);
assert.doesNotMatch(js, /getDoc|getDocs|setDoc|addDoc|executeOperationalCommand/);

assert.equal(validateStudioSettings(STUDIO_SETTINGS_DEFAULTS).valid, true);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, name: "" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, primaryColor: "green" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, phone: "123" }).valid, false);
assert.equal(validateStudioSettings({ ...STUDIO_SETTINGS_DEFAULTS, instagram: "not a handle" }).valid, false);
assert.equal(isValidPhone("(11) 99999-9999"), true);
assert.equal(isValidInstagram("@goestudio"), true);
assert.equal(isValidInstagram("https://instagram.com/goestudio"), true);
assert.equal(isSafePreviewReference("javascript:alert(1)"), false);
assert.equal(isSafePreviewReference("https://cdn.example/logo.png"), true);
assert.equal(isSafePreviewReference("img/logo.png"), true);
assert.equal(studioSettingsChanged(STUDIO_SETTINGS_DEFAULTS), false);
assert.equal(studioSettingsChanged({ ...STUDIO_SETTINGS_DEFAULTS, name: "Novo nome" }), true);

console.log("admin studio settings tests: PASS");
