import { auth } from "./firebase-config.js";
import { executarComandoOperacional } from "./operational-commands.js";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signOut,
  onAuthStateChanged,
  updateProfile,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";

// ----------------------------------------------------------------------------
// Helpers de UI
// ----------------------------------------------------------------------------
function showMsg(el, text, type = "err") {
  el.textContent = text;
  el.className = `msg show ${type}`;
}
function hideMsg(el) {
  el.className = "msg";
}

function traduzErro(code) {
  const mapa = {
    "auth/email-already-in-use": "Este e-mail já está cadastrado.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "A senha deve ter pelo menos 6 caracteres.",
    "auth/wrong-password": "Senha incorreta.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/user-not-found": "Nenhuma conta encontrada com este e-mail.",
    "auth/too-many-requests": "Muitas tentativas. Tente novamente em instantes.",
    "auth/unauthorized-domain": "Este domínio não está autorizado no Firebase Authentication.",
  };
  return mapa[code] || "Ocorreu um erro. Tente novamente.";
}

function normalizarWhatsApp(numero) {
  const digitos = numero.replace(/\D/g, "");
  return /^55\d{10,11}$/.test(digitos) ? digitos : null;
}

// Garante que exista um documento em /clientes/{uid} para o usuário autenticado.
// Não sobrescreve dados já existentes (merge: true).
async function garantirDocCliente(user, dadosExtras = {}) {
  await executarComandoOperacional("cliente.garantir-perfil", { extras: dadosExtras });
}

// ----------------------------------------------------------------------------
// Elementos da tela de autenticação (index.html)
// ----------------------------------------------------------------------------
const authSwitcher = document.getElementById("auth-switcher");
const modeButtons = document.querySelectorAll("[data-auth-mode]");
const formLogin = document.getElementById("form-login");
const formCadastro = document.getElementById("form-cadastro");
const msgAuth = document.getElementById("auth-msg");

modeButtons.forEach((button) => button.addEventListener("click", () => alternarTab(button.dataset.authMode)));

function alternarTab(qual) {
  hideMsg(msgAuth);
  if (!authSwitcher) return;
  const cadastro = qual === "cadastro";
  authSwitcher.classList.toggle("is-cadastro", cadastro);
  formLogin?.setAttribute("aria-hidden", String(cadastro));
  formCadastro?.setAttribute("aria-hidden", String(!cadastro));
  formLogin?.querySelectorAll("input, button, a").forEach((element) => { element.tabIndex = cadastro ? -1 : 0; });
  formCadastro?.querySelectorAll("input, button, a").forEach((element) => { element.tabIndex = cadastro ? 0 : -1; });
  document.querySelector(".auth-mode-copy--login")?.setAttribute("aria-hidden", String(cadastro));
  document.querySelector(".auth-mode-copy--cadastro")?.setAttribute("aria-hidden", String(!cadastro));
}

// Mantém o formulário fora de cena também fora da navegação por teclado até
// que o usuário escolha mudar de modo.
if (authSwitcher) alternarTab("login");

// ---- Cadastro com e-mail/senha ----
formCadastro?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg(msgAuth);
  const nome = document.getElementById("cad-nome").value.trim();
  const telefone = document.getElementById("cad-telefone").value.trim();
  const email = document.getElementById("cad-email").value.trim();
  const senha = document.getElementById("cad-senha").value;
  const btn = formCadastro.querySelector("button[type=submit]");

  if (senha.length < 6) {
    showMsg(msgAuth, "A senha deve ter pelo menos 6 caracteres.");
    return;
  }

  const whatsapp = normalizarWhatsApp(telefone);
  if (!whatsapp) {
    showMsg(msgAuth, "Informe seu WhatsApp com DDI, por exemplo: +55 11 99999-9999.");
    return;
  }

  btn.disabled = true;
  try {
    // O Firebase autentica o usuário assim que a conta é criada. Este marcador
    // impede o redirecionamento automático até o perfil (incluindo telefone)
    // terminar de ser gravado no Firestore.
    sessionStorage.setItem("cadastroEmAndamento", "1");
    const cred = await createUserWithEmailAndPassword(auth, email, senha);
    await updateProfile(cred.user, { displayName: nome });
    await garantirDocCliente(cred.user, { nome, telefone: whatsapp, email });
    sessionStorage.removeItem("cadastroEmAndamento");
    window.location.replace("app.html");
  } catch (err) {
    sessionStorage.removeItem("cadastroEmAndamento");
    showMsg(msgAuth, traduzErro(err.code));
    btn.disabled = false;
  }
});

// ---- Login com e-mail/senha ----
formLogin?.addEventListener("submit", async (e) => {
  e.preventDefault();
  hideMsg(msgAuth);
  const email = document.getElementById("log-email").value.trim();
  const senha = document.getElementById("log-senha").value;
  const btn = formLogin.querySelector("button[type=submit]");

  btn.disabled = true;
  try {
    await signInWithEmailAndPassword(auth, email, senha);
  } catch (err) {
    showMsg(msgAuth, traduzErro(err.code));
    btn.disabled = false;
  }
});

// ----------------------------------------------------------------------------
// Sessão / logout (usado em app.html e admin.html)
// ----------------------------------------------------------------------------
document.querySelectorAll("[data-logout]").forEach((btn) => {
  btn.addEventListener("click", () => signOut(auth));
});

export { onAuthStateChanged, auth, garantirDocCliente };
