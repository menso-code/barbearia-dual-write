const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const STUDIO_SETTINGS_DEFAULTS = Object.freeze({
  name: "Barbearia Antunes",
  shortName: "Antunes",
  logo: "img/logo.png",
  favicon: "img/favicon-round.png",
  primaryColor: "#4da3ff",
  accentColor: "#7fc1ff",
  phone: "",
  whatsapp: "",
  address: "",
  instagram: "",
  institutional: "",
});

export function normalizeStudioSettings(input = {}) {
  return Object.fromEntries(Object.keys(STUDIO_SETTINGS_DEFAULTS).map((key) => [
    key,
    String(input?.[key] ?? STUDIO_SETTINGS_DEFAULTS[key]).trim(),
  ]));
}

export function isSafePreviewReference(value) {
  const reference = String(value ?? "").trim();
  if (!reference) return true;
  if (/^javascript:/i.test(reference)) return false;
  if (/^(https?:\/\/|\/|\.\/|\.\.\/|[a-z0-9_-]+\/)/i.test(reference)) return true;
  return false;
}

export function isValidPhone(value) {
  const phone = String(value ?? "").trim();
  if (!phone) return true;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13;
}

export function isValidInstagram(value) {
  const instagram = String(value ?? "").trim();
  if (!instagram) return true;
  return /^@?[a-z0-9._]{1,30}$/i.test(instagram)
    || /^https?:\/\/(?:www\.)?instagram\.com\/[a-z0-9._]+\/?$/i.test(instagram);
}

export function validateStudioSettings(input = {}) {
  const values = normalizeStudioSettings(input);
  const errors = {};
  if (!values.name) errors.name = "Informe o nome do estabelecimento.";
  if (values.name.length > 120) errors.name = "Use no máximo 120 caracteres.";
  if (values.shortName.length > 48) errors.shortName = "Use no máximo 48 caracteres.";
  for (const key of ["logo", "favicon"]) {
    if (!isSafePreviewReference(values[key])) errors[key] = "Use uma URL HTTP(S) ou uma referência local segura.";
  }
  for (const key of ["primaryColor", "accentColor"]) {
    if (!HEX_COLOR.test(values[key])) errors[key] = "Use uma cor no formato #RRGGBB.";
  }
  if (!isValidPhone(values.phone)) errors.phone = "Informe um telefone válido.";
  if (!isValidPhone(values.whatsapp)) errors.whatsapp = "Informe um WhatsApp válido.";
  if (!isValidInstagram(values.instagram)) errors.instagram = "Informe um @usuário ou URL válida do Instagram.";
  return { valid: Object.keys(errors).length === 0, values, errors };
}

export function studioSettingsChanged(current, initial = STUDIO_SETTINGS_DEFAULTS) {
  const next = normalizeStudioSettings(current);
  const base = normalizeStudioSettings(initial);
  return Object.keys(STUDIO_SETTINGS_DEFAULTS).some((key) => next[key] !== base[key]);
}
