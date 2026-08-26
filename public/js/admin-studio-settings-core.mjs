const HEX_COLOR = /^#[0-9a-f]{6}$/i;

export const STUDIO_SETTINGS_DEFAULTS = Object.freeze({
  name: "Barbearia Antunes",
  shortName: "",
  logo: "",
  favicon: "",
  primaryColor: "#64748B",
  accentColor: "#94A3B8",
  phone: "",
  whatsapp: "",
  address: "",
  instagram: "",
  institutional: "",
});

export const STUDIO_SETTINGS_FIELDS = Object.freeze(Object.keys(STUDIO_SETTINGS_DEFAULTS));

const BACKEND_FIELD_BY_FORM_FIELD = Object.freeze({
  name: "nome",
  shortName: "nomeCurto",
  logo: "logo",
  favicon: "favicon",
  primaryColor: "primaryColor",
  accentColor: "accentColor",
  phone: "telefone",
  whatsapp: "whatsapp",
  instagram: "instagram",
  address: "endereco",
  institutional: "institucional",
});

export function normalizeStudioSettings(input = {}, fallback = STUDIO_SETTINGS_DEFAULTS) {
  return Object.fromEntries(STUDIO_SETTINGS_FIELDS.map((key) => {
    const value = String(input?.[key] ?? fallback[key] ?? "").trim();
    return [key, ["primaryColor", "accentColor"].includes(key) ? value.toUpperCase() : value];
  }));
}

export function studioIdentityToForm(identity = {}, fallback = STUDIO_SETTINGS_DEFAULTS) {
  const values = Object.fromEntries(Object.entries(BACKEND_FIELD_BY_FORM_FIELD).map(([formKey, backendKey]) => [
    formKey,
    identity?.[backendKey],
  ]));
  return normalizeStudioSettings(values, fallback);
}

export function studioSettingsToBackendPayload(input = {}) {
  const values = normalizeStudioSettings(input);
  return Object.fromEntries(STUDIO_SETTINGS_FIELDS.map((formKey) => [
    BACKEND_FIELD_BY_FORM_FIELD[formKey],
    values[formKey],
  ]));
}

export function isSafePreviewReference(value) {
  const reference = String(value ?? "").trim();
  if (!reference) return true;
  if (/^(?:javascript|data|vbscript):/i.test(reference)) return false;
  if (/[\\\s]/.test(reference) || reference.startsWith("//")) return false;
  if (reference.startsWith("/") || /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~%-]+)*(?:[?#][^\s]*)?$/.test(reference)) return true;
  try {
    return new URL(reference).protocol === "https:";
  } catch {
    return false;
  }
}

export function isValidPhone(value) {
  const phone = String(value ?? "").trim();
  if (!phone) return true;
  if (phone.length > 20) return false;
  const digits = phone.replace(/\D/g, "");
  return digits.length >= 10 && digits.length <= 13;
}

export function isValidInstagram(value) {
  const instagram = String(value ?? "").trim();
  if (!instagram) return true;
  if (instagram.length > 2048) return false;
  return /^@?[a-z0-9._]{1,30}$/i.test(instagram)
    || /^https:\/\/(?:www\.)?instagram\.com\/[a-z0-9._]+\/?$/i.test(instagram);
}

export function validateStudioSettings(input = {}) {
  const values = normalizeStudioSettings(input);
  const errors = {};
  if (!values.name) errors.name = "Informe o nome do estabelecimento.";
  if (values.name.length > 120) errors.name = "Use no máximo 120 caracteres.";
  if (values.shortName.length > 48) errors.shortName = "Use no máximo 48 caracteres.";
  for (const key of ["logo", "favicon"]) {
    if (values[key].length > 2048 || !isSafePreviewReference(values[key])) {
      errors[key] = "Use uma URL HTTPS ou uma referência local segura.";
    }
  }
  for (const key of ["primaryColor", "accentColor"]) {
    if (!HEX_COLOR.test(values[key])) errors[key] = "Use uma cor no formato #RRGGBB.";
  }
  for (const key of ["phone", "whatsapp"]) {
    if (!isValidPhone(values[key])) errors[key] = "Informe um telefone válido com até 20 caracteres.";
  }
  if (!isValidInstagram(values.instagram)) errors.instagram = "Informe um @usuário ou URL HTTPS válida do Instagram.";
  if (values.address.length > 240) errors.address = "Use no máximo 240 caracteres.";
  if (values.institutional.length > 2000) errors.institutional = "Use no máximo 2000 caracteres.";
  return { valid: Object.keys(errors).length === 0, values, errors };
}

export function studioSettingsChanged(current, initial = STUDIO_SETTINGS_DEFAULTS) {
  const next = normalizeStudioSettings(current);
  const base = normalizeStudioSettings(initial);
  return STUDIO_SETTINGS_FIELDS.some((key) => next[key] !== base[key]);
}
