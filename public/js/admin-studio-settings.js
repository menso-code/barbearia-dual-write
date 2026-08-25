import {
  STUDIO_SETTINGS_DEFAULTS,
  studioSettingsChanged,
  validateStudioSettings,
} from "./admin-studio-settings-core.mjs";

const form = document.getElementById("studio-settings-form");
if (!form) {
  // The module is shared by the shell only when the settings view exists.
} else {
  const status = document.getElementById("studio-settings-status");
  const feedback = document.getElementById("studio-settings-feedback");
  const saveButton = document.getElementById("studio-settings-save");
  const fieldNames = Object.keys(STUDIO_SETTINGS_DEFAULTS);
  const fields = Object.fromEntries(fieldNames.map((name) => [name, form.elements.namedItem(name)]));
  const preview = {
    shell: document.getElementById("studio-preview-shell"),
    name: document.getElementById("studio-preview-name"),
    shortName: document.getElementById("studio-preview-short-name"),
    logo: document.getElementById("studio-preview-logo"),
    address: document.getElementById("studio-preview-address"),
    phone: document.getElementById("studio-preview-phone"),
    instagram: document.getElementById("studio-preview-instagram"),
    institutional: document.getElementById("studio-preview-institutional"),
  };
  const initial = { ...STUDIO_SETTINGS_DEFAULTS };

  function readValues() {
    return Object.fromEntries(fieldNames.map((name) => [name, fields[name]?.value || ""]));
  }

  function setFeedback(message = "", type = "") {
    feedback.textContent = message;
    feedback.dataset.state = type;
  }

  function renderPreview(result) {
    const values = result.values;
    preview.name.textContent = values.name || "Nome do estabelecimento";
    preview.shortName.textContent = values.shortName || "Nome curto";
    preview.address.textContent = values.address || "Endereço ainda não informado";
    preview.phone.textContent = values.phone || "Telefone não informado";
    preview.instagram.textContent = values.instagram || "Instagram não informado";
    preview.institutional.textContent = values.institutional || "Adicione uma apresentação para visualizar o texto institucional.";
    preview.shell.style.setProperty("--studio-preview-primary", result.valid ? values.primaryColor : "#4da3ff");
    preview.shell.style.setProperty("--studio-preview-accent", result.valid ? values.accentColor : "#7fc1ff");
    if (result.valid && values.logo) {
      preview.logo.hidden = false;
      preview.logo.src = values.logo;
    } else {
      preview.logo.hidden = true;
      preview.logo.removeAttribute("src");
    }
    preview.logo.alt = values.name ? `Logo de ${values.name}` : "Logo do estabelecimento";
  }

  function render() {
    const result = validateStudioSettings(readValues());
    for (const name of fieldNames) {
      const field = fields[name];
      if (!field) continue;
      const message = result.errors[name] || "";
      field.setAttribute("aria-invalid", message ? "true" : "false");
      field.closest(".field")?.querySelector(".studio-settings-field-error")?.remove();
      if (message) {
        const error = document.createElement("small");
        error.className = "studio-settings-field-error";
        error.textContent = message;
        field.closest(".field")?.appendChild(error);
      }
    }
    const changed = studioSettingsChanged(result.values, initial);
    saveButton.disabled = true;
    status.textContent = changed ? "Alterações locais não salvas" : "Somente visualização";
    status.dataset.state = changed ? "unsaved" : "readonly";
    setFeedback(result.valid ? "Pré-visualização atualizada localmente." : "Revise os campos destacados para atualizar a prévia.", result.valid ? "success" : "error");
    renderPreview(result);
  }

  for (const field of Object.values(fields)) field?.addEventListener("input", render);
  for (const [textName, pickerName] of [["primaryColor", "primaryColorPicker"], ["accentColor", "accentColorPicker"]]) {
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
  form.addEventListener("submit", (event) => event.preventDefault());
  render();
}
