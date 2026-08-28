import { getCurrentUserAccess } from "./access-control.js";
import { deniedAccessRoute, evaluateTenantPageAccess } from "./tenant-membership-gate-core.mjs";

export async function resolveTenantPageAccess(user, requiredRole) {
  const access = await getCurrentUserAccess(user, requiredRole);
  return Object.freeze({ ...access, ...evaluateTenantPageAccess(access, requiredRole) });
}

function hide(element) {
  if (!element) return;
  element.hidden = true;
  element.style.display = "none";
}

function show(element, display) {
  if (!element) return;
  element.hidden = false;
  element.style.display = display;
}

export function renderTenantAccessGate({ access, shell, lockedScreen, lockedMessage, shellDisplay = "block" }) {
  if (!access?.allowed) {
    hide(shell);
    if (lockedMessage) lockedMessage.textContent = access?.message || "Acesso não autorizado.";
    const exit = lockedScreen?.querySelector("[data-tenant-denied-exit]");
    if (exit) exit.setAttribute("href", deniedAccessRoute(access?.code));
    show(lockedScreen, "flex");
    return false;
  }

  hide(lockedScreen);
  show(shell, shellDisplay);
  return true;
}
