import { auth, db } from "./firebase-config.js";
import { obterUidOperacionalComBootstrapCliente } from "./homologation-identity.js?v=2026082015";
import { onAuthStateChanged, signOut } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection,
  query,
  where,
  orderBy,
  getDocs,
  doc,
  getDoc,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { createTenantScopedAgenda, dataDentroDaJanelaDoCliente, limitesDataAgendamentoCliente } from "./agenda.js";
import { getCurrentUserAccess } from "./access-control.js";
import { executarComandoOperacional } from "./operational-commands.js";
import {
  initializeTenantContext,
  tenantContextIsReady,
  TENANT_CONTEXT_STATES,
} from "./tenant-context.js";

const tenantContext = await initializeTenantContext();
const tenantFailureMessages = Object.freeze({
  [TENANT_CONTEXT_STATES.NOT_FOUND]: "Estabelecimento não encontrado.",
  [TENANT_CONTEXT_STATES.UNAVAILABLE]: "Estabelecimento indisponível.",
  [TENANT_CONTEXT_STATES.ERROR]: "Não foi possível carregar o estabelecimento.",
});

function renderTenantFailure(status, message = "") {
  document.querySelector(".topbar")?.setAttribute("hidden", "");
  const container = document.querySelector(".container");
  if (!container) return;
  const state = document.createElement("section");
  state.className = "empty-state";
  state.setAttribute("role", "status");
  const title = document.createElement("h2");
  title.textContent = message || tenantFailureMessages[status] || "Não foi possível carregar o estabelecimento.";
  const description = document.createElement("p");
  description.textContent = "Confira o endereço acessado e tente novamente.";
  state.append(title, description);
  container.replaceChildren(state);
}

let appTenantConsumersStarted = false;
if (!tenantContextIsReady(tenantContext)) {
  renderTenantFailure(tenantContext.status);
} else if (!appTenantConsumersStarted) {
appTenantConsumersStarted = true;
const {
  cancelarAgendamento: cancelarReserva,
  criarAgendamento,
  horariosDisponiveis,
  obterFechamentoGlobal,
} = createTenantScopedAgenda(tenantContext);
const tenantCollection = (name) => collection(db, "barbearias", tenantContext.tenantId, name);
const tenantDocument = (name, id) => doc(db, "barbearias", tenantContext.tenantId, name, id);

let usuarioAtual = null;
let uidOperacionalAtual = "";
let barbeiroSelecionado = null;
let barbeirosDisponiveis = [];
let versaoPermissoes = 0;
let planoParaSolicitar = null;
let servicosDisponiveis = [];
// Mantém somente a assinatura escolhida para o agendamento em curso. A tela
// pode renderizar várias assinaturas ao mesmo tempo sem misturar seus créditos.
let assinaturaSelecionadaParaAgendamento = null;
let agendamentoPorAssinatura = false;
let barbeiroAutomaticoPorHorario = new Map();
let appBootstrapGeneration = 0;

function resetTenantScopedState() {
  usuarioAtual = null;
  uidOperacionalAtual = "";
  barbeiroSelecionado = null;
  barbeirosDisponiveis = [];
  planoParaSolicitar = null;
  servicosDisponiveis = [];
  assinaturaSelecionadaParaAgendamento = null;
  agendamentoPorAssinatura = false;
  barbeiroAutomaticoPorHorario = new Map();
  limparMenuPrivilegiado();
}

function currentBootstrap(user, generation) {
  return generation === appBootstrapGeneration && auth.currentUser?.uid === user.uid;
}

function assertCurrentGeneration(generation = appBootstrapGeneration) {
  if (generation !== appBootstrapGeneration) throw new Error("STALE_TENANT_BOOTSTRAP");
}

document.querySelectorAll("[data-logout]").forEach((logoutButton) => logoutButton.addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (err) {
    alert("Não foi possível sair. Tente novamente.");
    console.error(err);
  }
}));

// ----------------------------------------------------------------------------
// Guarda de sessão
// ----------------------------------------------------------------------------
onAuthStateChanged(auth, async (user) => {
  const generation = ++appBootstrapGeneration;
  if (!user) {
    resetTenantScopedState();
    window.location.href = "index.html";
    return;
  }
  const minhaVersaoPermissoes = ++versaoPermissoes;
  resetTenantScopedState();
  usuarioAtual = user;
  try {
    uidOperacionalAtual = await obterUidOperacionalComBootstrapCliente(user);
    if (!currentBootstrap(user, generation)) return;
    // O TenantContext seleciona somente o estabelecimento exibido. A
    // autorização definitiva continua no backend e nas Rules.
    const clienteRef = tenantDocument("clientes", uidOperacionalAtual);
    let clienteSnap = await getDoc(clienteRef);
    if (!currentBootstrap(user, generation)) return;
    if (!clienteSnap.exists()) {
      await executarComandoOperacional("cliente.garantir-perfil", { extras: {
        nome: user.displayName || "",
        email: user.email || "",
        telefone: String(user.phoneNumber || "").replace(/\D/g, ""),
      } });
      clienteSnap = await getDoc(clienteRef);
      if (!currentBootstrap(user, generation)) return;
    }
    const chip = document.getElementById("user-chip");
    const userRole = document.getElementById("user-role");
    const perfil = clienteSnap.exists() ? clienteSnap.data() : {};
    const nomeExibido = perfil.nome || user.displayName || user.email || "";
    chip.textContent = nomeExibido;
    if (userRole) userRole.textContent = "Cliente";
    const avatar = document.getElementById("header-avatar");
    if (avatar) {
      const avatarUrl = perfil.avatar_data;
      if (avatarUrl) {
        avatar.style.backgroundImage = `url(${avatarUrl})`;
        avatar.textContent = "";
      } else {
        avatar.style.backgroundImage = "";
        avatar.textContent = nomeExibido.split(/\s+/).filter(Boolean).slice(0, 2).map((n) => n[0]).join("").toUpperCase() || "BA";
      }
    }

    await carregarBarbeiros(generation);
    if (!currentBootstrap(user, generation)) return;
    await carregarServicos(generation);
    if (!currentBootstrap(user, generation)) return;
    await carregarAssinaturasCliente(generation);
    if (!currentBootstrap(user, generation)) return;
    await carregarMeusAgendamentos(generation);
    if (!currentBootstrap(user, generation)) return;
    await atualizarMenuPorPermissao(user, minhaVersaoPermissoes);
    if (!currentBootstrap(user, generation)) return;
    abrirReagendamentoDaConta();
  } catch (error) {
    if (!currentBootstrap(user, generation)) return;
    resetTenantScopedState();
    console.error("Falha no bootstrap tenant-scoped do App.", error);
    renderTenantFailure(TENANT_CONTEXT_STATES.ERROR);
  }
});

function limparMenuPrivilegiado() {
  document.getElementById("privileged-menu-items")?.replaceChildren();
}

function criarLinkPrivilegiado(href, texto) {
  const link = document.createElement("a");
  link.href = href;
  link.role = "menuitem";
  link.textContent = texto;
  return link;
}

async function atualizarMenuPorPermissao(user, versao) {
  const areaPrivilegiada = document.getElementById("privileged-menu-items");
  if (!areaPrivilegiada) return;

  // Padrão seguro: antes da confirmação não existe link privilegiado no DOM.
  areaPrivilegiada.replaceChildren();
  const acesso = await getCurrentUserAccess(user);
  if (versao !== versaoPermissoes || auth.currentUser?.uid !== user.uid) return;

  const userRole = document.getElementById("user-role");
  if (userRole) userRole.textContent = acesso.isAdmin ? "Administrador" : acesso.isBarber ? "Barbeiro" : "Cliente";

  const itens = [];
  if (acesso.isBarber) itens.push(criarLinkPrivilegiado("barber.html", "Painel do barbeiro"));
  if (acesso.isAdmin) itens.push(criarLinkPrivilegiado("admin.html", "Painel administrativo"));
  areaPrivilegiada.replaceChildren(...itens);
}

const accountTrigger = document.getElementById("account-trigger");
const accountDropdown = document.getElementById("account-dropdown");

// O menu é movido para o body para não herdar a camada do header com
// backdrop-filter. Isso evita cortes e falhas de empilhamento no Safari iOS.
if (accountDropdown) {
  document.body.appendChild(accountDropdown);
  accountDropdown.classList.add("account-dropdown-portal");
}

function posicionarMenuConta() {
  if (!accountTrigger || !accountDropdown) return;

  const margem = 12;
  const retangulo = accountTrigger.getBoundingClientRect();
  const viewport = window.visualViewport;
  const larguraViewport = viewport?.width || document.documentElement.clientWidth;
  const alturaViewport = viewport?.height || window.innerHeight;
  const larguraMenu = Math.min(280, Math.max(0, larguraViewport - margem * 2));
  const alturaMenu = accountDropdown.getBoundingClientRect().height;
  const esquerda = Math.min(
    Math.max(margem, retangulo.right - larguraMenu),
    Math.max(margem, larguraViewport - larguraMenu - margem)
  );
  const topoPreferido = retangulo.bottom + 10;
  const topo = Math.min(topoPreferido, Math.max(margem, alturaViewport - alturaMenu - margem));

  accountDropdown.style.width = `${larguraMenu}px`;
  accountDropdown.style.left = `${Math.round(esquerda)}px`;
  accountDropdown.style.top = `${Math.round(topo)}px`;
}

function fecharMenuConta() {
  accountDropdown?.classList.remove("show");
  accountDropdown?.setAttribute("aria-hidden", "true");
  accountTrigger?.setAttribute("aria-expanded", "false");
}

accountTrigger?.addEventListener("click", () => {
  const aberto = !accountDropdown?.classList.contains("show");
  if (!aberto) {
    fecharMenuConta();
    return;
  }
  accountDropdown.classList.add("show");
  accountDropdown.setAttribute("aria-hidden", "false");
  accountTrigger.setAttribute("aria-expanded", "true");
  posicionarMenuConta();
});
document.addEventListener("click", (event) => {
  if (!event.target.closest(".account-menu-wrap") && !accountDropdown?.contains(event.target)) {
    fecharMenuConta();
  }
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    fecharMenuConta();
    accountTrigger?.focus();
  }
});
accountDropdown?.querySelectorAll("a").forEach((item) =>
  item.addEventListener("click", () => {
    fecharMenuConta();
  })
);
window.addEventListener("resize", posicionarMenuConta);
window.addEventListener("scroll", posicionarMenuConta, { passive: true });
window.visualViewport?.addEventListener("resize", posicionarMenuConta);
window.visualViewport?.addEventListener("scroll", posicionarMenuConta);

// ----------------------------------------------------------------------------
// Navegação entre seções
// ----------------------------------------------------------------------------
function mostrarView(nome) {
  document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${nome}`).classList.add("active");
  document.querySelectorAll("[data-view]").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === nome)
  );
  if (nome === "assinaturas") carregarAssinaturasCliente();
}
document.querySelectorAll("[data-view]").forEach((b) =>
  b.addEventListener("click", () => mostrarView(b.dataset.view))
);
document.querySelectorAll("[data-view-btn]").forEach((b) =>
  b.addEventListener("click", () => mostrarView(b.dataset.viewBtn))
);

// ----------------------------------------------------------------------------
// Carregar barbeiros ativos
// ----------------------------------------------------------------------------
async function carregarBarbeiros(generation = appBootstrapGeneration) {
  const grid = document.getElementById("barbeiros-grid");
  const q = query(tenantCollection("barbeiros"), where("ativo", "==", true));
  const snap = await getDocs(q);
  assertCurrentGeneration(generation);
  barbeirosDisponiveis = snap.docs.map((docSnap) => ({ id: docSnap.id, ...docSnap.data() }));

  if (snap.empty) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <h3>Nenhum barbeiro disponível no momento</h3>
      <p>Volte em breve — estamos organizando a equipe.</p>
    </div>`;
    return;
  }

  grid.innerHTML = "";
  snap.forEach((docSnap) => {
    const b = docSnap.data();
    const el = document.createElement("div");
    el.className = "barbeiro-card";
    el.innerHTML = `
      <img class="barbeiro-foto" src="${b.foto || 'https://placehold.co/400x300/151517/3f8f5f?text=Barbeiro'}" alt="${b.nome}" />
      <div class="barbeiro-body">
        <h3>${b.nome}</h3>
        <span class="barbeiro-esp">${b.especialidade || ""}</span>
        <p class="barbeiro-desc">${b.descricao || ""}</p>
        <button class="btn btn-primary btn-block" data-id="${docSnap.id}">Agendar com este barbeiro</button>
      </div>`;
    el.querySelector("button").addEventListener("click", () =>
      abrirAgendamento(docSnap.id, b)
    );
    grid.appendChild(el);
  });
}

// ----------------------------------------------------------------------------
// Assinaturas — somente vitrine de planos ativos (sem adesão nesta etapa)
// ----------------------------------------------------------------------------
function escaparHtml(valor) {
  return String(valor ?? "").replace(/[&<>"']/g, (caractere) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[caractere]));
}

function formatarPrecoAssinatura(centavos) {
  if (!Number.isInteger(centavos) || centavos <= 0) return "Preço sob consulta";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(centavos / 100);
}

function formatarDataAssinatura(valor) {
  const data = valor?.toDate?.();
  if (!data) return "Data não disponível";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit", month: "2-digit", year: "numeric",
  }).format(data);
}

function creditosDaAssinatura(assinatura) {
  return Object.values(assinatura?.creditos_mensais || {});
}

function creditosEsgotadosDaAssinatura(assinatura) {
  const creditos = creditosDaAssinatura(assinatura);
  return creditos.length > 0
    && creditos.every((credito) => Number(credito.restantes) <= 0);
}

function assinaturaExpiradaParaExibicao(assinatura) {
  return assinatura?.status === "EXPIRADA"
    || creditosEsgotadosDaAssinatura(assinatura)
    || !assinaturaEstaValida(assinatura);
}

function renderizarCardMinhaAssinatura(assinatura) {
  const creditos = creditosDaAssinatura(assinatura);
  const creditosEsgotados = creditosEsgotadosDaAssinatura(assinatura);
  const pendente = assinatura.status === "PENDENTE";
  const expirada = !pendente && assinaturaExpiradaParaExibicao(assinatura);
  const motivoCreditos = assinatura.motivo_expiracao === "CREDITOS_ESGOTADOS" || creditosEsgotados;

  return `
    <article class="minha-assinatura-card${expirada ? " is-expirada" : ""}${pendente ? " is-pendente" : ""}">
      <div class="minha-assinatura-head">
        <div><span class="eyebrow">${pendente ? "Solicitação em análise" : expirada ? "Assinatura expirada" : "Minha assinatura"}</span><h3>${expirada ? "Plano encerrado" : escaparHtml(assinatura.plano_nome || "Plano")}</h3>${expirada ? `<p class="minha-assinatura-plano">Plano ${escaparHtml(assinatura.plano_nome || "")}</p>` : ""}</div>
        <span class="minha-assinatura-status${expirada ? " is-expirada" : ""}${pendente ? " is-pendente" : ""}">${expirada ? "EXPIRADA" : escaparHtml(assinatura.status || "ATIVA")}</span>
      </div>
      <div class="minha-assinatura-datas">
        ${pendente
          ? `<span>Solicitada em <strong>${formatarDataAssinatura(assinatura.solicitado_em)}</strong></span>`
          : `<span>Ativada em <strong>${formatarDataAssinatura(assinatura.ativado_em)}</strong></span><span>Válido até <strong>${formatarDataAssinatura(assinatura.vencimento_em)}</strong></span>`}
      </div>
      ${pendente ? '<p class="minha-assinatura-aviso">A assinatura será ativada após a confirmação do pagamento presencial pela barbearia.</p>' : `<div class="minha-assinatura-creditos">
        ${creditos.length ? creditos.map((credito) => `
          <div><span>${escaparHtml(credito.nome || "Crédito")}</span><strong>${expirada && motivoCreditos ? `${Number(credito.utilizados) || 0} de ${Number(credito.total) || 0} créditos utilizados` : `${Number(credito.restantes) || 0}/${Number(credito.total) || 0} disponíveis`}</strong><small>${Number(credito.utilizados) || 0} utilizados</small></div>
        `).join("") : "<p>Os créditos desta assinatura serão disponibilizados em breve.</p>"}
      </div>
      ${expirada ? `<p class="minha-assinatura-aviso">Os créditos deste período foram utilizados ou a validade do plano chegou ao fim.${motivoCreditos ? " Créditos utilizados: " + creditos.reduce((total, credito) => total + (Number(credito.utilizados) || 0), 0) + " de " + creditos.reduce((total, credito) => total + (Number(credito.total) || 0), 0) + "." : " Plano encerrado em " + formatarDataAssinatura(assinatura.vencimento_em) + "."}</p>` : `<button class="btn btn-primary" type="button" data-usar-assinatura="${escaparHtml(assinatura.id)}">Usar minha assinatura</button>`}`}
    </article>`;
}

function renderizarMinhasAssinaturas(assinaturasAtivas, assinaturasPendentes, assinaturasExpiradas) {
  const area = document.getElementById("minha-assinatura");
  const grid = document.getElementById("assinaturas-cliente-grid");
  const introducao = document.getElementById("assinaturas-introducao");
  if (!area || !grid || !introducao) return;

  const assinaturas = [...assinaturasAtivas, ...assinaturasPendentes, ...assinaturasExpiradas];
  if (!assinaturas.length) {
    area.hidden = true;
    area.innerHTML = "";
    grid.hidden = false;
    introducao.textContent = "Escolha o plano que mais combina com a sua rotina. O atendimento será realizado pelo barbeiro disponível no dia e horário escolhidos.";
    return;
  }

  area.hidden = false;
  grid.hidden = false;
  introducao.textContent = "Acompanhe os créditos e a validade de cada assinatura. Os planos disponíveis continuam abaixo.";
  area.innerHTML = `
    <div class="minhas-assinaturas-head"><span class="eyebrow">Minhas assinaturas</span></div>
    ${assinaturasAtivas.length || assinaturasPendentes.length ? `<div class="minhas-assinaturas-grid">${[...assinaturasAtivas, ...assinaturasPendentes].map(renderizarCardMinhaAssinatura).join("")}</div>` : ""}
    ${assinaturasExpiradas.length ? `<section class="minhas-assinaturas-historico" aria-label="Assinaturas encerradas"><span class="eyebrow">Histórico de assinaturas</span><div class="minhas-assinaturas-grid">${assinaturasExpiradas.map(renderizarCardMinhaAssinatura).join("")}</div></section>` : ""}`;

  const porId = new Map(assinaturasAtivas.map((assinatura) => [assinatura.id, assinatura]));
  area.querySelectorAll("[data-usar-assinatura]").forEach((botao) => {
    botao.addEventListener("click", () => {
      const assinatura = porId.get(botao.dataset.usarAssinatura);
      if (assinatura) abrirAgendamentoPorAssinatura(assinatura);
    });
  });
}

function assinaturaEstaValida(assinatura) {
  if (assinatura?.status !== "ATIVA") return false;
  const vencimento = assinatura.vencimento_em?.toDate?.();
  if (!vencimento) return false;
  return vencimento > new Date();
}

async function carregarAssinaturasCliente(generation = appBootstrapGeneration) {
  const grid = document.getElementById("assinaturas-cliente-grid");
  const planosDisponiveis = document.getElementById("planos-disponiveis");
  if (!grid || !usuarioAtual) return;
  assinaturaSelecionadaParaAgendamento = null;
  renderizarMinhasAssinaturas([], [], []);
  if (planosDisponiveis) planosDisponiveis.hidden = true;
  grid.innerHTML = '<p style="color:var(--cinza)">Carregando planos…</p>';
  try {
    const [planosAtivos, assinaturasSnap] = await Promise.all([
      getDocs(query(tenantCollection("planos_assinatura"), where("ativo", "==", true))),
      getDocs(query(tenantCollection("assinaturas"), where("cliente_id", "==", uidOperacionalAtual))),
    ]);
    assertCurrentGeneration(generation);
    const assinaturas = assinaturasSnap.docs
      .map((item) => ({ id: item.id, ...item.data() }));
    const ativasOrdenadas = assinaturas
      .filter((assinatura) => assinaturaEstaValida(assinatura) && !creditosEsgotadosDaAssinatura(assinatura))
      .sort((a, b) => (b.ativado_em?.toMillis?.() || 0) - (a.ativado_em?.toMillis?.() || 0));
    const pendentesOrdenadas = assinaturas
      .filter((assinatura) => assinatura.status === "PENDENTE")
      .sort((a, b) => (b.solicitado_em?.toMillis?.() || 0) - (a.solicitado_em?.toMillis?.() || 0));
    const expiradasOrdenadas = assinaturas
      .filter((assinatura) => !ativasOrdenadas.some((ativa) => ativa.id === assinatura.id)
        && !pendentesOrdenadas.some((pendente) => pendente.id === assinatura.id)
        && assinaturaExpiradaParaExibicao(assinatura))
      .sort((a, b) => (b.expirada_em?.toMillis?.() || b.vencimento_em?.toMillis?.() || 0) - (a.expirada_em?.toMillis?.() || a.vencimento_em?.toMillis?.() || 0));
    renderizarMinhasAssinaturas(ativasOrdenadas, pendentesOrdenadas, expiradasOrdenadas);
    const planos = planosAtivos.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .filter((plano) =>
        Array.isArray(plano.servicos_ids)
          && plano.servicos_ids.length > 0
          && Number(plano.usos_mensais) % plano.servicos_ids.length === 0,
      )
      .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || ""), "pt-BR"));
    if (!planos.length) {
      if (planosDisponiveis) planosDisponiveis.hidden = true;
      grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>Nenhuma assinatura disponível</h3><p>Em breve teremos planos para você.</p></div>';
      return;
    }
    if (planosDisponiveis) planosDisponiveis.hidden = false;
    grid.innerHTML = "";
    planos.forEach((plano) => {
      const card = document.createElement("article");
      card.className = "assinatura-cliente-card";
      const servicos = Array.isArray(plano.servicos_incluidos) ? plano.servicos_incluidos : [];
      card.innerHTML = `
        <span class="eyebrow">Plano mensal</span>
        <h3>${escaparHtml(plano.nome)}</h3>
        <p class="assinatura-cliente-descricao">${escaparHtml(plano.descricao || "Plano personalizado")}</p>
        <strong class="assinatura-cliente-preco">${formatarPrecoAssinatura(plano.preco_centavos)}<small>/ mês</small></strong>
        <div class="assinatura-cliente-meta"><span>${Number(plano.usos_mensais) || 0} uso(s) por mês</span><span>Validade: mensal</span></div>
        <div class="assinatura-cliente-servicos">${servicos.map((servico) => `<span>${escaparHtml(servico)}</span>`).join("") || "<span>Serviços a definir</span>"}</div>
        <p class="assinatura-cliente-regra">Atendimento realizado pelo barbeiro disponível no dia.</p>
        <button class="btn btn-primary btn-block" type="button">Solicitar assinatura</button>`;
      card.querySelector("button").addEventListener("click", () => abrirConfirmacaoAssinatura(plano));
      grid.appendChild(card);
    });
  } catch (erro) {
    if (erro?.message === "STALE_TENANT_BOOTSTRAP") return;
    console.error("Falha ao carregar planos ativos.", erro);
    if (planosDisponiveis) planosDisponiveis.hidden = false;
    grid.innerHTML = '<div class="empty-state" style="grid-column:1/-1"><h3>Não foi possível carregar as assinaturas</h3><p>Tente novamente em instantes.</p></div>';
  }
}

function fecharConfirmacaoAssinatura() {
  planoParaSolicitar = null;
  const modal = document.getElementById("modal-solicitar-assinatura");
  modal?.classList.remove("show");
  modal?.setAttribute("aria-hidden", "true");
}

function abrirConfirmacaoAssinatura(plano) {
  planoParaSolicitar = plano;
  document.getElementById("solicitacao-assinatura-plano").textContent = `${plano.nome} — ${formatarPrecoAssinatura(plano.preco_centavos)} por mês`;
  document.getElementById("solicitacao-assinatura-termos").checked = false;
  document.getElementById("solicitacao-assinatura-msg").className = "msg";
  const modal = document.getElementById("modal-solicitar-assinatura");
  modal.classList.add("show");
  modal.setAttribute("aria-hidden", "false");
  document.getElementById("btn-confirmar-solicitacao-assinatura").focus();
}

document.getElementById("btn-cancelar-solicitacao-assinatura")?.addEventListener("click", fecharConfirmacaoAssinatura);

document.getElementById("btn-confirmar-solicitacao-assinatura")?.addEventListener("click", async (evento) => {
  if (!planoParaSolicitar || !usuarioAtual) return;
  const botao = evento.currentTarget;
  const mensagem = document.getElementById("solicitacao-assinatura-msg");
  if (!document.getElementById("solicitacao-assinatura-termos").checked) {
    mensagem.textContent = "Você precisa aceitar os Termos de Uso da Assinatura.";
    mensagem.className = "msg show err";
    return;
  }
  botao.disabled = true;
  botao.textContent = "Enviando…";
  mensagem.className = "msg";
  try {
    // Releitura obrigatória: nunca confia no preço/nome do card renderizado.
    const planoSnap = await getDoc(tenantDocument("planos_assinatura", planoParaSolicitar.id));
    if (!planoSnap.exists() || planoSnap.data().ativo !== true) {
      throw new Error("PLANO_INDISPONIVEL");
    }
    const plano = { id: planoSnap.id, ...planoSnap.data() };
    if (!Number.isInteger(plano.preco_centavos)
      || plano.preco_centavos <= 0
      || !Array.isArray(plano.servicos_ids)
      || !plano.servicos_ids.length
      || Number(plano.usos_mensais) % plano.servicos_ids.length !== 0) {
      throw new Error("PRECO_INDISPONIVEL");
    }

    // Uma solicitação pendente por cliente/plano evita duplo clique ou repetição.
    const anteriores = await getDocs(query(tenantCollection("assinaturas"), where("cliente_id", "==", uidOperacionalAtual)));
    if (anteriores.docs.some((item) => item.data().plano_id === plano.id && item.data().status === "PENDENTE")) {
      throw new Error("SOLICITACAO_EXISTENTE");
    }

    const clienteSnap = await getDoc(tenantDocument("clientes", uidOperacionalAtual));
    const clienteNome = clienteSnap.exists()
      ? String(clienteSnap.data().nome || "")
      : String(usuarioAtual.displayName || usuarioAtual.email || "");
    if (!clienteNome) throw new Error("CLIENTE_INDISPONIVEL");

    await executarComandoOperacional("assinatura.solicitar", { planId: plano.id });

    fecharConfirmacaoAssinatura();
    document.getElementById("assinaturas-cliente-feedback").textContent = "Solicitação enviada. Aguarde a confirmação do pagamento presencial na barbearia.";
  } catch (erro) {
    const textos = {
      PLANO_INDISPONIVEL: "Este plano não está mais disponível.",
      PRECO_INDISPONIVEL: "Este plano ainda não possui preço disponível.",
      SOLICITACAO_EXISTENTE: "Você já possui uma solicitação pendente para este plano.",
      CLIENTE_INDISPONIVEL: "Não foi possível identificar seu cadastro. Atualize a página e tente novamente.",
    };
    console.error("Falha ao solicitar assinatura.", erro);
    mensagem.textContent = textos[erro.message] || "Não foi possível enviar a solicitação. Tente novamente.";
    mensagem.className = "msg show err";
  } finally {
    botao.disabled = false;
    botao.textContent = "Confirmar solicitação";
  }
});

function abrirReagendamentoDaConta() {
  const params = new URLSearchParams(location.search);
  const barbeiroId = params.get("barbeiro");
  const servicoId = params.get("servico");
  if (!barbeiroId) return;
  const barbeiro = barbeirosDisponiveis.find((item) => item.id === barbeiroId);
  if (!barbeiro) return;
  abrirAgendamento(barbeiro.id, barbeiro);
  if (servicoId) document.getElementById("ag-servico").value = servicoId;
  history.replaceState({}, "", "app.html");
}

// ----------------------------------------------------------------------------
// Carregar serviços disponíveis
// ----------------------------------------------------------------------------
async function carregarServicos(generation = appBootstrapGeneration) {
  const select = document.getElementById("ag-servico");
  const snap = await getDocs(tenantCollection("servicos"));
  assertCurrentGeneration(generation);
  servicosDisponiveis = snap.docs.map((item) => ({ id: item.id, ...item.data() }));
  preencherServicosAgendamento(servicosDisponiveis);
  if (snap.empty) {
    select.innerHTML = `<option value="">Nenhum serviço cadastrado</option>`;
    return;
  }
}

function preencherServicosAgendamento(servicos, { assinatura = false } = {}) {
  const select = document.getElementById("ag-servico");
  select.innerHTML = "";
  if (!servicos.length) {
    select.innerHTML = `<option value="">Nenhum serviço disponível</option>`;
    return;
  }
  servicos.forEach((s) => {
    const opt = document.createElement("option");
    opt.value = s.id;
    opt.textContent = assinatura
      ? `${s.nome} — Incluso no plano`
      : `${s.nome} — ${s.duracao} min — ${s.preco}`;
    opt.dataset.nome = s.nome;
    opt.dataset.duracao = s.duracao;
    select.appendChild(opt);
  });
}

// ----------------------------------------------------------------------------
// Abrir tela de agendamento para um barbeiro
// ----------------------------------------------------------------------------
function abrirAgendamento(id, barbeiro) {
  agendamentoPorAssinatura = false;
  barbeiroAutomaticoPorHorario = new Map();
  preencherServicosAgendamento(servicosDisponiveis);
  barbeiroSelecionado = { id, ...barbeiro };
  document.querySelector(".booking-card")?.classList.remove("modo-assinatura");
  document.getElementById("ag-assinatura-note").hidden = true;
  document.querySelector("[data-view-btn]").dataset.viewBtn = "barbeiros";
  document.getElementById("ag-foto").src =
    barbeiro.foto || "https://placehold.co/120x120/151517/3f8f5f?text=%20";
  document.getElementById("ag-nome").textContent = barbeiro.nome;
  document.getElementById("ag-esp").textContent = barbeiro.especialidade || "";

  const campoData = document.getElementById("ag-data");
  const { min, max } = limitesDataAgendamentoCliente();
  campoData.min = min;
  campoData.max = max;
  campoData.value = "";
  document.getElementById("ag-horario").value = "";
  atualizarHorariosDisponiveis();
  hideMsg(document.getElementById("agendar-msg"));

  mostrarView("agendar");
}

function normalizarServico(valor) {
  return String(valor || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

function chaveServico(valor) {
  return normalizarServico(valor).replace(/s\b/g, "").trim();
}

function servicoIncluidoNaAssinatura(servico, assinatura = assinaturaSelecionadaParaAgendamento) {
  const servicosIds = Array.isArray(assinatura?.servicos_ids)
    ? assinatura.servicos_ids
    : [];
  return Boolean(
    servico?.id
      && servicosIds.includes(servico.id)
      && assinatura?.creditos_mensais?.[servico.id],
  );
}

function tipoCreditoDaAssinatura(servico, assinatura = assinaturaSelecionadaParaAgendamento) {
  return servicoIncluidoNaAssinatura(servico, assinatura) ? servico.id : "";
}

function barbeiroRealizaServico(barbeiro, servico) {
  if (Array.isArray(barbeiro.servicos_ids) && barbeiro.servicos_ids.length) return barbeiro.servicos_ids.includes(servico.id);
  if (Array.isArray(barbeiro.servicos) && barbeiro.servicos.length) {
    return barbeiro.servicos.some((item) => chaveServico(servico.nome).includes(chaveServico(item)));
  }
  // O cadastro atual não restringe serviços por profissional: nesse caso,
  // preserva a regra existente, em que todo barbeiro ativo atende o catálogo.
  return true;
}

function dataPermitidaParaAssinatura(data) {
  const dia = new Date(`${data}T12:00:00`).getDay();
  return dia >= 1 && dia <= 4;
}

function prepararCampoDataAgendamento() {
  const campoData = document.getElementById("ag-data");
  const { min, max } = limitesDataAgendamentoCliente();
  campoData.min = min;
  campoData.max = max;
  campoData.value = "";
  document.getElementById("ag-horario").value = "";
}

function abrirAgendamentoPorAssinatura(assinatura) {
  if (!assinaturaEstaValida(assinatura)) {
    document.getElementById("assinaturas-cliente-feedback").textContent = "Sua assinatura não está válida para novos agendamentos.";
    return;
  }
  const servicosIncluidos = servicosDisponiveis.filter((servico) => servicoIncluidoNaAssinatura(servico, assinatura));
  if (!servicosIncluidos.length) {
    document.getElementById("assinaturas-cliente-feedback").textContent = "Esta assinatura precisa ter os serviços incluídos definidos pela barbearia.";
    return;
  }
  assinaturaSelecionadaParaAgendamento = assinatura;
  agendamentoPorAssinatura = true;
  barbeiroSelecionado = null;
  barbeiroAutomaticoPorHorario = new Map();
  preencherServicosAgendamento(servicosIncluidos, { assinatura: true });
  document.querySelector(".booking-card")?.classList.add("modo-assinatura");
  document.getElementById("ag-nome").textContent = "Barbeiro disponível";
  document.getElementById("ag-esp").textContent = "Definido conforme a disponibilidade do horário";
  document.getElementById("ag-assinatura-note").hidden = false;
  document.querySelector("[data-view-btn]").dataset.viewBtn = "assinaturas";
  prepararCampoDataAgendamento();
  atualizarHorariosDisponiveis();
  hideMsg(document.getElementById("agendar-msg"));
  mostrarView("agendar");
}

function showMsg(el, text, type = "err") {
  el.textContent = text;
  el.className = `msg show ${type}`;
}
function hideMsg(el) {
  el.className = "msg";
}

function statusClass(status) {
  if (status === "concluido") return "status-concluido";
  if (status === "cancelado") return "status-cancelado";
  if (status === "nao_compareceu") return "status-falta";
  if (status === "cliente_chegou") return "status-chegou";
  if (status === "em_atendimento") return "status-atendimento";
  return "status-agendado";
}

function statusLabel(status) {
  return ({
    agendado: "Agendado",
    concluido: "✓ Concluído",
    cancelado: "Cancelado",
    nao_compareceu: "Não compareceu",
    cliente_chegou: "Cliente chegou",
    em_atendimento: "Em atendimento",
  })[status] || "Agendado";
}

async function atualizarHorariosDisponiveis() {
  const data = document.getElementById("ag-data").value;
  const select = document.getElementById("ag-horario");
  const servico = document.getElementById("ag-servico").selectedOptions[0];
  select.innerHTML = `<option value="">${data ? "Carregando horários…" : "Escolha uma data"}</option>`;
  if (!data || !servico?.value) return;
  try {
    if (agendamentoPorAssinatura) {
      if (!dataPermitidaParaAssinatura(data)) {
        select.innerHTML = `<option value="">Assinaturas: segunda a quinta-feira</option>`;
        showMsg(document.getElementById("agendar-msg"), "Agendamentos por assinatura estão disponíveis somente de segunda a quinta-feira.");
        return;
      }
      const servicoAtual = servicosDisponiveis.find((item) => item.id === servico.value);
      if (!servicoAtual || !servicoIncluidoNaAssinatura(servicoAtual)) {
        select.innerHTML = `<option value="">Escolha um serviço incluído</option>`;
        return;
      }
      const disponibilidadeGlobal = await obterFechamentoGlobal(db, data);
      if (disponibilidadeGlobal.fechado) {
        select.innerHTML = `<option value="">Barbearia fechada neste dia</option>`;
        return;
      }
      const candidatos = barbeirosDisponiveis.filter((barbeiro) => barbeiroRealizaServico(barbeiro, servicoAtual));
      const horariosPorBarbeiro = await Promise.all(candidatos.map(async (barbeiro) => ({
        barbeiro,
        horarios: await horariosDisponiveis(db, { barbeiro, barbeiroId: barbeiro.id, data, duracao: Number(servico.dataset.duracao || 30), disponibilidadeGlobal }),
      })));
      barbeiroAutomaticoPorHorario = new Map();
      horariosPorBarbeiro.forEach(({ barbeiro, horarios }) => horarios.forEach((horario) => {
        if (!barbeiroAutomaticoPorHorario.has(horario)) barbeiroAutomaticoPorHorario.set(horario, barbeiro);
      }));
      const horarios = [...barbeiroAutomaticoPorHorario.keys()].sort();
      select.innerHTML = `<option value="">${horarios.length ? "Selecione" : "Nenhum horário disponível"}</option>`;
      horarios.forEach((horario) => select.add(new Option(horario, horario)));
      hideMsg(document.getElementById("agendar-msg"));
      return;
    }
    if (!barbeiroSelecionado) return;
    const fechamento = await obterFechamentoGlobal(db, data);
    if (fechamento.fechado) {
      select.innerHTML = `<option value="">Barbearia fechada neste dia</option>`;
      showMsg(document.getElementById("agendar-msg"), `Barbearia fechada neste dia.${fechamento.motivo ? ` ${fechamento.motivo}.` : ""}`);
      return;
    }
    hideMsg(document.getElementById("agendar-msg"));
    const horarios = await horariosDisponiveis(db, {
      barbeiro: barbeiroSelecionado,
      barbeiroId: barbeiroSelecionado.id,
      data,
      duracao: Number(servico.dataset.duracao || 30),
      disponibilidadeGlobal: fechamento,
    });
    select.innerHTML = `<option value="">${horarios.length ? "Selecione" : "Nenhum horário disponível"}</option>`;
    horarios.forEach((horario) => {
      const option = document.createElement("option");
      option.value = horario;
      option.textContent = horario;
      select.appendChild(option);
    });
  } catch (err) {
    select.innerHTML = `<option value="">Não foi possível consultar os horários</option>`;
    console.error(err);
  }
}

document.getElementById("ag-data").addEventListener("change", atualizarHorariosDisponiveis);
document.getElementById("ag-servico").addEventListener("change", atualizarHorariosDisponiveis);

// ----------------------------------------------------------------------------
// Confirmar agendamento
// (bloqueio de conflito: 1 documento por combinação barbeiro+data+horario)
// ----------------------------------------------------------------------------
document.getElementById("form-agendar").addEventListener("submit", async (e) => {
  e.preventDefault();
  const msgEl = document.getElementById("agendar-msg");
  hideMsg(msgEl);

  const servicoSelect = document.getElementById("ag-servico");
  const servicoId = servicoSelect.value;
  const servicoNome = servicoSelect.selectedOptions[0]?.dataset.nome || "";
  const duracao = Number(servicoSelect.selectedOptions[0]?.dataset.duracao || 30);
  const data = document.getElementById("ag-data").value;
  const horario = document.getElementById("ag-horario").value;

  if ((!barbeiroSelecionado && !agendamentoPorAssinatura) || !servicoId || !data || !horario) {
    showMsg(msgEl, "Preencha todos os campos.");
    return;
  }

  if (!dataDentroDaJanelaDoCliente(data)) {
    showMsg(msgEl, "Os agendamentos podem ser realizados com até 10 dias de antecedência.");
    return;
  }

  const servicoAtual = servicosDisponiveis.find((item) => item.id === servicoId);
  if (agendamentoPorAssinatura && (!assinaturaEstaValida(assinaturaSelecionadaParaAgendamento) || !servicoIncluidoNaAssinatura(servicoAtual))) {
    showMsg(msgEl, "Este serviço não está disponível na sua assinatura ativa.");
    return;
  }
  if (agendamentoPorAssinatura) {
    const tipoCredito = tipoCreditoDaAssinatura(servicoAtual);
    const credito = assinaturaSelecionadaParaAgendamento?.creditos_mensais?.[tipoCredito];
    if (!credito || !Number.isInteger(Number(credito.reservados))) {
      showMsg(msgEl, "Os créditos da sua assinatura estão sendo preparados. Tente novamente em instantes.");
      return;
    }
    if (Number(credito.restantes) - Number(credito.reservados) < 1) {
      showMsg(msgEl, "Não há crédito disponível para este serviço na sua assinatura.");
      return;
    }
  }
  if (agendamentoPorAssinatura && !dataPermitidaParaAssinatura(data)) {
    showMsg(msgEl, "Agendamentos por assinatura estão disponíveis somente de segunda a quinta-feira.");
    return;
  }

  // Impede reservas em horários que já começaram quando a data selecionada é hoje.
  // A comparação usa data/hora local para não sofrer deslocamento de fuso horário.
  const agora = new Date();
  const hoje = [
    agora.getFullYear(),
    String(agora.getMonth() + 1).padStart(2, "0"),
    String(agora.getDate()).padStart(2, "0"),
  ].join("-");
  if (data === hoje && horario <= `${String(agora.getHours()).padStart(2, "0")}:${String(agora.getMinutes()).padStart(2, "0")}`) {
    showMsg(msgEl, "Escolha um horário futuro para hoje.");
    return;
  }

  const btn = e.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Confirmando…";

  try {
    let barbeiroDoAgendamento = barbeiroSelecionado;
    const creditoAssinaturaTipo = agendamentoPorAssinatura ? tipoCreditoDaAssinatura(servicoAtual) : "";
    if (agendamentoPorAssinatura) {
      const disponibilidadeGlobal = await obterFechamentoGlobal(db, data);
      if (disponibilidadeGlobal.fechado) throw new Error("HORARIO_INDISPONIVEL");
      const candidatos = barbeirosDisponiveis.filter((barbeiro) => barbeiroRealizaServico(barbeiro, servicoAtual));
      for (const barbeiro of candidatos) {
        const horarios = await horariosDisponiveis(db, { barbeiro, barbeiroId: barbeiro.id, data, duracao, disponibilidadeGlobal });
        if (horarios.includes(horario)) {
          barbeiroDoAgendamento = barbeiro;
          break;
        }
      }
      if (!barbeiroDoAgendamento) throw new Error("HORARIO_INDISPONIVEL");
    }
    // pega o nome do cliente (para exibição no painel admin)
    const clienteSnap = await getDoc(tenantDocument("clientes", uidOperacionalAtual));
    const clienteNome = clienteSnap.exists()
      ? clienteSnap.data().nome
      : usuarioAtual.displayName || usuarioAtual.email || "Cliente";
    // O WhatsApp é informado no cadastro. Para contas antigas sem número,
    // o agendamento continua normalmente, apenas sem lembrete pelo painel.
    const clienteWhatsapp = String(clienteSnap.data()?.telefone || usuarioAtual.phoneNumber || "").replace(/\D/g, "");

    await criarAgendamento(db, {
      cliente_id: uidOperacionalAtual,
      cliente_nome: clienteNome,
      cliente_whatsapp: clienteWhatsapp,
      cliente_tipo: "autenticado",
      barbeiro_id: barbeiroDoAgendamento.id,
      barbeiro_nome: barbeiroDoAgendamento.nome,
      barbeiro: barbeiroDoAgendamento,
      servico_id: servicoId,
      servico_nome: servicoNome,
      duracao,
      data,
      horario,
      limiteAntecedenciaCliente: true,
      origem: agendamentoPorAssinatura ? "assinatura" : "cliente",
      ...(agendamentoPorAssinatura ? {
        assinatura_id: assinaturaSelecionadaParaAgendamento.id,
        assinatura_plano_id: assinaturaSelecionadaParaAgendamento.plano_id,
        assinatura_credito_tipo: creditoAssinaturaTipo,
        credito_assinatura_consumido: false,
        credito_assinatura_reservado: true,
      } : {}),
    });

    showMsg(msgEl, "Agendamento confirmado com sucesso!", "ok");
    await carregarMeusAgendamentos();
    setTimeout(() => mostrarView("meus"), 900);
  } catch (err) {
    if (err.message === "DATA_FORA_DA_JANELA") {
      showMsg(msgEl, "Os agendamentos podem ser realizados com até 10 dias de antecedência.");
    } else if (err.message === "BARBEARIA_FECHADA") {
      showMsg(msgEl, "Barbearia fechada nesta data. Escolha outro dia.");
    } else if (err.message === "HORARIO_OCUPADO" || err.message === "HORARIO_INDISPONIVEL") {
      showMsg(msgEl, "Este horário acabou de ficar indisponível. Escolha outro horário.");
    } else if (err.message === "CREDITO_INDISPONIVEL") {
      showMsg(msgEl, "Não há crédito disponível para este serviço na sua assinatura.");
    } else if (err.message === "CREDITOS_ASSINATURA_NAO_PREPARADOS") {
      showMsg(msgEl, "Os créditos da sua assinatura estão sendo preparados. Tente novamente em instantes.");
    } else if (err.code === "permission-denied") {
      showMsg(msgEl, "O Firestore bloqueou este agendamento. Publique as regras atualizadas do Firestore e tente novamente.");
    } else {
      const detalhe = err.code || err.message || "erro desconhecido";
      showMsg(msgEl, `Não foi possível confirmar o agendamento (${detalhe}).`);
      console.error(err);
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirmar agendamento";
  }
});

// ----------------------------------------------------------------------------
// Meus agendamentos
// ----------------------------------------------------------------------------
async function carregarMeusAgendamentos(generation = appBootstrapGeneration) {
  const lista = document.getElementById("meus-lista");
  lista.innerHTML = `<p style="color:var(--cinza)">Carregando…</p>`;

  const q = query(
    tenantCollection("agendamentos"),
    where("cliente_id", "==", uidOperacionalAtual),
    orderBy("data", "desc")
  );
  const snap = await getDocs(q);
  assertCurrentGeneration(generation);

  if (snap.empty) {
    lista.innerHTML = `<div class="empty-state">
      <h3>Você ainda não tem agendamentos</h3>
      <p>Escolha um barbeiro para marcar seu primeiro horário.</p>
    </div>`;
    return;
  }

  lista.innerHTML = "";
  snap.forEach((docSnap) => {
    const a = { id: docSnap.id, ...docSnap.data() };
    const item = document.createElement("div");
    item.className = "agendamento-item";
    const cancelavel = a.status === "agendado";
    item.innerHTML = `
      <div class="agendamento-info">
        <span class="quando">${a.horario || "—"}</span>
        <span class="data-agendamento">${formatarDataCompleta(a.data)}</span>
        <span class="detalhe">${a.servico_nome || "Serviço"}</span>
        <span class="com-barbeiro">com ${a.barbeiro_nome || "barbeiro"}</span>
      </div>
      <div class="agendamento-actions">
        <span class="status-pill ${statusClass(a.status)}">${statusLabel(a.status)}</span>
        ${cancelavel ? `<button class="btn btn-danger btn-sm" data-cancelar="${docSnap.id}">Cancelar</button>` : ""}
      </div>
    `;
    lista.appendChild(item);
  });

  lista.querySelectorAll("[data-cancelar]").forEach((btn) => {
    btn.addEventListener("click", () => cancelarAgendamento(btn.dataset.cancelar, btn));
  });
}

async function cancelarAgendamento(id, btn) {
  if (!confirm("Deseja realmente cancelar este agendamento?")) return;
  btn.disabled = true;
  btn.textContent = "Cancelando…";
  try {
    const snap = await getDoc(tenantDocument("agendamentos", id));
    await cancelarReserva(db, { id, ...snap.data() });
    await carregarMeusAgendamentos();
  } catch (err) {
    alert("Não foi possível cancelar. Tente novamente.");
    btn.disabled = false;
    btn.textContent = "Cancelar";
  }
}

function formatarData(iso) {
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

function formatarDataCompleta(iso) {
  if (!iso) return "Data não informada";
  const texto = new Intl.DateTimeFormat("pt-BR", {
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(`${iso}T12:00:00`));
  return texto.charAt(0).toUpperCase() + texto.slice(1);
}
}
