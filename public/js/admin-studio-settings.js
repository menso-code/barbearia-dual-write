import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { BARBEARIA_ATUAL_ID, db } from "./firebase-config.js";
import { executarComandoOperacional } from "./operational-commands.js";
import {
  STUDIO_SETTINGS_DEFAULTS,
  STUDIO_SETTINGS_FIELDS,
  isSafePreviewReference,
  studioIdentityToForm,
  studioSettingsChanged,
  studioSettingsToBackendPayload,
  validateStudioSettings,
} from "./admin-studio-settings-core.mjs";

const form = document.getElementById("studio-settings-form");
if (form) {
  const status = document.getElementById("studio-settings-status");
  const feedback = document.getElementById("studio-settings-feedback");
  const saveButton = document.getElementById("studio-settings-save");
  const discardButton = document.getElementById("studio-settings-discard");
  const fieldNames = STUDIO_SETTINGS_FIELDS;
  const fields = Object.fromEntries(fieldNames.map((name) => [name, form.elements.namedItem(name)]));
  const preview = {
    shell: document.getElementById("studio-preview-shell"),
    name: document.getElementById("studio-preview-name"),
    shortName: document.getElementById("studio-preview-short-name"),
    logo: document.getElementById("studio-preview-logo"),
    favicon: document.getElementById("studio-preview-favicon"),
    address: document.getElementById("studio-preview-address"),
    phone: document.getElementById("studio-preview-phone"),
    instagram: document.getElementById("studio-preview-instagram"),
    institutional: document.getElementById("studio-preview-institutional"),
  };
  let persisted = { ...STUDIO_SETTINGS_DEFAULTS };
  let state = "LOADING";

  function readValues() {
    return Object.fromEntries(fieldNames.map((name) => [name, fields[name]?.value || ""]));
  }

  function setValues(values) {
    for (const name of fieldNames) {
      if (fields[name]) fields[name].value = values[name] || "";
    }
    for (const textName of ["primaryColor", "accentColor"]) {
      const picker = document.getElementById(`studio-${textName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-picker`);
      if (picker) picker.value = values[textName] || STUDIO_SETTINGS_DEFAULTS[textName];
    }
  }

  function setStatus(nextState) {
    state = nextState;
    const labels = {
      LOADING: "Carregando identidade...",
      READY: "Identidade salva",
      DIRTY: "Alterações não salvas",
      SAVING: "Salvando alterações...",
      SAVED: "Alterações salvas",
      ERROR: "Não foi possível salvar",
    };
    status.textContent = labels[nextState] || nextState;
    status.dataset.state = nextState.toLowerCase();
    const busy = ["LOADING", "SAVING"].includes(nextState);
    saveButton.disabled = busy || !studioSettingsChanged(readValues(), persisted);
    discardButton.disabled = busy || !studioSettingsChanged(readValues(), persisted);
  }

  function setFeedback(message = "", type = "") {
    feedback.textContent = message;
    feedback.dataset.state = type;
  }

  function renderFieldErrors(result) {
    for (const name of fieldNames) {
      const field = fields[name];
      if (!field) continue;
      const message = result.errors[name] || "";
      const wrapper = field.closest(".field");
      wrapper?.querySelector(".studio-settings-field-error")?.remove();
      field.setAttribute("aria-invalid", message ? "true" : "false");
      field.removeAttribute("aria-errormessage");
      if (!message) continue;
      const error = document.createElement("small");
      error.className = "studio-settings-field-error";
      error.id = `studio-${name}-error`;
      error.textContent = message;
      wrapper?.appendChild(error);
      field.setAttribute("aria-errormessage", error.id);
    }
  }

  function renderPreview(result) {
    const values = result.values;
    preview.name.textContent = values.name || "Nome do estabelecimento";
    preview.shortName.textContent = values.shortName || "Nome curto";
    preview.address.textContent = values.address || "Endereço ainda não informado";
    preview.phone.textContent = values.phone || "Telefone não informado";
    preview.instagram.textContent = values.instagram || "Instagram não informado";
    preview.institutional.textContent = values.institutional || "Adicione uma apresentação para visualizar o texto institucional.";
    preview.shell.style.setProperty("--studio-primary", result.valid ? values.primaryColor : STUDIO_SETTINGS_DEFAULTS.primaryColor);
    preview.shell.style.setProperty("--studio-accent", result.valid ? values.accentColor : STUDIO_SETTINGS_DEFAULTS.accentColor);
    if (result.valid && values.logo && isSafePreviewReference(values.logo)) {
      preview.logo.hidden = false;
      preview.logo.src = values.logo;
    } else {
      preview.logo.hidden = true;
      preview.logo.removeAttribute("src");
    }
    preview.logo.alt = values.name ? `Logo de ${values.name}` : "Logo do estabelecimento";
    if (result.valid && values.favicon && isSafePreviewReference(values.favicon)) {
      preview.favicon.hidden = false;
      preview.favicon.src = values.favicon;
    } else {
      preview.favicon.hidden = true;
      preview.favicon.removeAttribute("src");
    }
  }

  function render(options = {}) {
    const result = validateStudioSettings(readValues());
    renderFieldErrors(result);
    const preserveError = options.preserveError === true && state === "ERROR";
    if (!preserveError && !["LOADING", "SAVING", "SAVED"].includes(state)) {
      setStatus(studioSettingsChanged(result.values, persisted) ? "DIRTY" : "READY");
    } else {
      const busy = ["LOADING", "SAVING"].includes(state);
      saveButton.disabled = busy || !result.valid || !studioSettingsChanged(result.values, persisted);
      discardButton.disabled = busy || !studioSettingsChanged(result.values, persisted);
    }
    if (state !== "LOADING" && !preserveError) {
      setFeedback(result.valid ? "Pré-visualização atualizada." : "Revise os campos destacados para atualizar a prévia.", result.valid ? "success" : "error");
    }
    renderPreview(result);
  }

  async function loadIdentity() {
    setStatus("LOADING");
    setFeedback("Carregando identidade do estabelecimento...");
    try {
      const identityRef = doc(db, "barbearias", BARBEARIA_ATUAL_ID, "configuracoes", "identidade");
      const snapshot = await getDoc(identityRef);
      persisted = snapshot.exists() ? studioIdentityToForm(snapshot.data()) : { ...STUDIO_SETTINGS_DEFAULTS };
      setValues(persisted);
      setStatus("READY");
      setFeedback(snapshot.exists() ? "Identidade carregada." : "Configuração ainda não cadastrada; usando valores seguros.", "success");
      renderPreview(validateStudioSettings(persisted));
    } catch (error) {
      persisted = { ...STUDIO_SETTINGS_DEFAULTS };
      setValues(persisted);
      setStatus("ERROR");
      setFeedback("Não foi possível carregar a identidade. Os valores seguros foram mantidos.", "error");
      renderPreview(validateStudioSettings(persisted));
      console.error("Falha ao carregar identidade do estabelecimento.", error);
    }
    render({ preserveError: state === "ERROR" });
  }

  async function saveIdentity() {
    if (state === "SAVING") return;
    const result = validateStudioSettings(readValues());
    renderFieldErrors(result);
    if (!result.valid) {
      setStatus("ERROR");
      setFeedback("Revise os campos destacados antes de salvar.", "error");
      renderPreview(result);
      return;
    }
    if (!studioSettingsChanged(result.values, persisted)) return;
    setStatus("SAVING");
    setFeedback("Salvando identidade do estabelecimento...");
    try {
      await executarComandoOperacional("admin.estudio.identidade.salvar", {
        data: studioSettingsToBackendPayload(result.values),
      });
      persisted = { ...result.values };
      setStatus("SAVED");
      setFeedback("Identidade salva com sucesso.", "success");
      renderPreview(validateStudioSettings(persisted));
      window.setTimeout(() => {
        if (state === "SAVED") setStatus("READY");
      }, 800);
    } catch (error) {
      setStatus("ERROR");
      setFeedback("Não foi possível salvar. Suas alterações foram preservadas.", "error");
    }
    render({ preserveError: state === "ERROR" });
  }

  function discardChanges() {
    if (state === "SAVING") return;
    setValues(persisted);
    setStatus("READY");
    setFeedback("Alterações descartadas.", "success");
    render();
  }

  for (const field of Object.values(fields)) field?.addEventListener("input", render);
  for (const textName of ["primaryColor", "accentColor"]) {
    const textField = fields[textName];
    const picker = document.getElementById(`studio-${textName.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}-picker`);
    picker?.addEventListener("input", () => {
      textField.value = picker.value;
      render();
    });
  }
  preview.logo.addEventListener("error", () => {
    preview.logo.hidden = true;
    setFeedback("A referência da logo não pôde ser carregada na prévia.", "error");
  });
  preview.favicon.addEventListener("error", () => {
    preview.favicon.hidden = true;
    setFeedback("A referência do favicon não pôde ser carregada na prévia.", "error");
  });
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void saveIdentity();
  });
  saveButton.addEventListener("click", () => void saveIdentity());
  discardButton.addEventListener("click", discardChanges);
  void loadIdentity();
}
