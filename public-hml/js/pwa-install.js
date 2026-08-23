const DISMISS_KEY = "pwa_install_dismissed_at";
const DISMISS_DURATION = 7 * 24 * 60 * 60 * 1000;
let deferredInstallPrompt = null;
let installCard = null;

function estaInstalado() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}
function foiDispensadoRecentemente() {
  const dismissedAt = Number(localStorage.getItem(DISMISS_KEY) || 0);
  return dismissedAt > 0 && Date.now() - dismissedAt < DISMISS_DURATION;
}
function ehSafariIOS() {
  const ua = navigator.userAgent;
  const ios = /iPad|iPhone|iPod/.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  return ios && /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS|GSA/.test(ua);
}
function removerAviso() { installCard?.remove(); installCard = null; }
function dispensarAviso() { localStorage.setItem(DISMISS_KEY, String(Date.now())); removerAviso(); }

function montarAviso(tipo) {
  if (installCard || estaInstalado() || foiDispensadoRecentemente()) return;
  installCard = document.createElement("aside");
  installCard.className = "pwa-install-card";
  installCard.setAttribute("role", "region");
  installCard.setAttribute("aria-label", "Instalar aplicativo Barbearia Antunes");
  const acao = tipo === "ios" ? "COMO INSTALAR" : "INSTALAR AGORA";
  installCard.innerHTML = `<div class="pwa-install-brand"><img src="img/logo.png" alt="" width="42" height="42"><span>Barbearia Antunes</span></div><div class="pwa-install-content"><strong>Instale nosso aplicativo</strong><p>Tenha acesso rápido aos seus horários, fidelidade e agendamentos direto da Tela de Início.</p></div><div class="pwa-install-actions"><button class="btn btn-primary btn-sm" type="button" data-pwa-action="install">${acao}</button><button class="btn btn-ghost btn-sm" type="button" data-pwa-action="dismiss">Agora não</button></div>`;
  installCard.querySelector('[data-pwa-action="dismiss"]').addEventListener("click", dispensarAviso);
  installCard.querySelector('[data-pwa-action="install"]').addEventListener("click", () => tipo === "ios" ? mostrarInstrucoesIOS() : solicitarInstalacaoAndroid());
  document.body.appendChild(installCard);
}
function mostrarInstrucoesIOS() {
  if (!installCard) return;
  installCard.classList.add("pwa-install-guide");
  installCard.querySelector(".pwa-install-content").innerHTML = `<strong>Adicionar à Tela de Início</strong><ol><li>Toque em <span class="pwa-share-icon" aria-label="Compartilhar">⇧</span> <b>Compartilhar</b> no Safari.</li><li>Selecione <b>Adicionar à Tela de Início</b>.</li><li>Confirme em <b>Adicionar</b>.</li></ol>`;
  installCard.querySelector("[data-pwa-action=install]").hidden = true;
}
async function solicitarInstalacaoAndroid() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  try { await deferredInstallPrompt.userChoice; } finally { deferredInstallPrompt = null; removerAviso(); }
}
window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault(); deferredInstallPrompt = event;
  if (!estaInstalado() && !foiDispensadoRecentemente()) montarAviso("android");
});
window.addEventListener("appinstalled", () => { localStorage.removeItem(DISMISS_KEY); deferredInstallPrompt = null; removerAviso(); });
if ("serviceWorker" in navigator && (window.isSecureContext || location.hostname === "localhost")) {
  window.addEventListener("load", () => navigator.serviceWorker.register("/sw.js").catch((error) => console.warn("Não foi possível registrar o suporte offline.", error)));
}
document.addEventListener("DOMContentLoaded", () => {
  if (ehSafariIOS() && !estaInstalado() && !foiDispensadoRecentemente()) montarAviso("ios");
});
