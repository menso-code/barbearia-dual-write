import { auth } from "./firebase-config.js";
import { signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

const MESSAGES = Object.freeze({
  MEMBERSHIP_MISSING: "Você ainda não possui cadastro nessa barbearia.",
  MEMBERSHIP_INACTIVE: "Seu acesso nesta barbearia está inativo.",
  ROLE_INSUFFICIENT: "Você não está autorizado para esta área.",
  TENANT_NOT_READY: "Este estabelecimento não está disponível.",
  MEMBERSHIP_UNAVAILABLE: "Não foi possível validar seu acesso neste estabelecimento.",
});

const reason = new URLSearchParams(window.location.search).get("reason");
document.getElementById("access-denied-message").textContent = MESSAGES[reason] || MESSAGES.MEMBERSHIP_UNAVAILABLE;

document.getElementById("access-denied-logout")?.addEventListener("click", async (event) => {
  event.currentTarget.disabled = true;
  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch {
    event.currentTarget.disabled = false;
  }
});
