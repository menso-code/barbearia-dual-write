import { auth, db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
import {
  onAuthStateChanged,
  signOut,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  where,
  Timestamp,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  blocosDoAtendimento,
  cancelarAgendamento as cancelarReserva,
  concluirAgendamento,
  criarAgendamento,
  dataLocalHoje,
  horariosCandidatos,
  horariosDisponiveis,
  marcarNaoComparecimento,
  obterFechamentoGlobal,
} from "./agenda.js";
import { abrirWhatsAppLembrete } from "./whatsapp.js";
import { executarComandoOperacional } from "./operational-commands.js";

const LIMITE_BARBEIROS = 5;
const operationalModalState = {
  resolve: null,
  previousFocus: null,
};
let barbeirosCache = [];
let servicosCache = [];
let planosAssinaturaCache = [];
let solicitacaoAssinaturaParaAprovar = null;
let filtroGestaoAssinaturas = "PENDENTES";
let buscaGestaoAssinaturas = "";
let solicitacoesAssinaturaCarregadas = false;
let solicitacoesAssinaturaCache = [];
const clientesAssinaturasCache = new Map();
const clientesNovoAgendamentoCache = new Map();
let clientesAdministrativosCarregados = false;
let agendaTodosCache = [];
let agendaTodosCachePronto = false;
let selecaoClienteNovoAgendamento = 0;
const agendaEstado = {
  periodo: "todos",
  dataSelecionada: "",
  barbeiro: "",
  status: "",
  servico: "",
  busca: "",
  ordenacao: "proximos",
  pagina: 1,
  tamanho: 20,
};

window.adminAgendaV2 = {
  setDate(date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return;
    agendaEstado.dataSelecionada = date;
    agendaEstado.periodo = "custom";
    agendaEstado.pagina = 1;
    carregarAgenda();
  },
};
let buscaAgendaTimer = null;
let agendaFeedbackTimer = null;
let uidVinculoOriginal = "";
let emailAcessoOriginal = "";
let fechamentosCache = [];
let fotoBarbeiroAtual = "";
let fotoBarbeiroPendente = false;

const FOTO_BARBEIRO_MAX_BYTES = 5 * 1024 * 1024;
const FOTO_BARBEIRO_TARGET_BYTES = 500 * 1024;
const FOTO_BARBEIRO_MAX_SIDE = 1600;
const FOTO_BARBEIRO_TYPES = ["image/jpeg", "image/png", "image/webp"];

function publicarDadosClientes() {
  const detail = {
    clients: [...clientesNovoAgendamentoCache.entries()].map(([id, data]) => ({
      id,
      data,
    })),
    appointments: agendaTodosCache,
    subscriptions: solicitacoesAssinaturaCache,
    complete: clientesAdministrativosCarregados && agendaTodosCachePronto,
  };
  window.adminCustomersSourceSnapshot = detail;
  window.dispatchEvent(new CustomEvent("admin:customers-data", { detail }));
}

async function carregarClientesAdministrativos({ atualizar = false } = {}) {
  if (clientesAdministrativosCarregados && !atualizar) {
    publicarDadosClientes();
    return true;
  }
  try {
    const clientes = await getDocs(collection(db, "clientes"));
    clientesNovoAgendamentoCache.clear();
    clientes.forEach((cliente) => {
      clientesNovoAgendamentoCache.set(cliente.id, cliente.data());
    });
    clientesAdministrativosCarregados = true;
    publicarDadosClientes();
    return true;
  } catch (erro) {
    console.warn("Não foi possível carregar os clientes cadastrados.", erro);
    return false;
  }
}

document.querySelector("[data-logout]")?.addEventListener("click", async () => {
  try {
    await signOut(auth);
    window.location.replace("index.html");
  } catch (err) {
    alert("Não foi possível sair. Tente novamente.");
    console.error(err);
  }
});

// ----------------------------------------------------------------------------
// Guarda de acesso: só entra quem tem doc em /admins/{uid}
// ----------------------------------------------------------------------------
function publicarEstadoAcessoAdmin(status) {
  window.adminAccessState = status;
  window.dispatchEvent(new CustomEvent("admin:access-state", { detail: { status } }));
}

onAuthStateChanged(auth, async (user) => {
  if (!user) {
    publicarEstadoAcessoAdmin("DENIED");
    window.location.href = "index.html";
    return;
  }
  publicarEstadoAcessoAdmin("CHECKING");
  const uidOperacional = await obterUidOperacional(user);
  const adminSnap = await getDoc(doc(db, "admins", uidOperacional));
  if (!adminSnap.exists()) {
    publicarEstadoAcessoAdmin("DENIED");
    document.getElementById("locked-screen").style.display = "flex";
    return;
  }
  publicarEstadoAcessoAdmin("READY");
  document.getElementById("admin-shell").style.display = "block";
  await carregarBarbeiros();
  await carregarServicos();
  await carregarAssinaturas();
  await carregarSolicitacoesAssinatura();
  await carregarClientesAdministrativos();
  await carregarHistoricoAssinaturas();
  await carregarFuncionamento();
  await carregarAgenda();
  await carregarRelatorio();
});

// ----------------------------------------------------------------------------
// Navegação
// ----------------------------------------------------------------------------
function manterAbaAdminVisivel(botao) {
  if (!window.matchMedia("(max-width: 767px)").matches) return;
  const navegacao = botao.closest(".admin-nav");
  if (!navegacao) return;

  window.requestAnimationFrame(() => {
    const destino = Math.max(
      0,
      botao.offsetLeft - (navegacao.clientWidth - botao.offsetWidth) / 2,
    );
    navegacao.scrollTo({
      left: destino,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "auto"
        : "smooth",
    });
  });
}

document.querySelectorAll("[data-view]").forEach((b) =>
  b.addEventListener("click", () => {
    document
      .querySelectorAll(".view")
      .forEach((v) => v.classList.remove("active"));
    document.getElementById(`view-${b.dataset.view}`).classList.add("active");
    document
      .querySelectorAll("[data-view]")
      .forEach((x) => x.classList.toggle("active", x === b));
    manterAbaAdminVisivel(b);
    if (b.dataset.view === "relatorios") carregarRelatorio();
    if (b.dataset.view === "assinaturas") {
      carregarAssinaturas();
      carregarSolicitacoesAssinatura();
      carregarHistoricoAssinaturas();
    }
  }),
);

// ----------------------------------------------------------------------------
// Funcionamento global — fechado para todos os profissionais
// ----------------------------------------------------------------------------
const DIAS_SEMANA = [
  "Domingo",
  "Segunda-feira",
  "Terça-feira",
  "Quarta-feira",
  "Quinta-feira",
  "Sexta-feira",
  "Sábado",
];
const funcionamentoRef = doc(db, "configuracoes", "funcionamento");

function formatarDataFechamento(data) {
  return String(data || "")
    .split("-")
    .reverse()
    .join("/");
}

function agruparFechamentos() {
  const grupos = new Map();
  fechamentosCache.forEach((fechamento) => {
    const chave = fechamento.fechamento_id || fechamento.id;
    if (!grupos.has(chave)) grupos.set(chave, { ...fechamento, datas: [] });
    grupos.get(chave).datas.push(fechamento.data);
  });
  return [...grupos.values()].sort((a, b) =>
    a.datas[0].localeCompare(b.datas[0]),
  );
}

function renderizarFechamentos() {
  const body = document.getElementById("fechamentos-body");
  if (!body) return;
  const grupos = agruparFechamentos();
  if (!grupos.length) {
    body.innerHTML =
      '<tr><td colspan="4" style="color:var(--cinza)">Nenhum fechamento excepcional cadastrado.</td></tr>';
    return;
  }
  body.innerHTML = grupos
    .map((grupo) => {
      const inicio = grupo.datas.sort()[0];
      const fim = grupo.datas[grupo.datas.length - 1];
      const periodo =
        inicio === fim
          ? formatarDataFechamento(inicio)
          : `${formatarDataFechamento(inicio)} → ${formatarDataFechamento(fim)}`;
      return `<tr><td>${periodo}</td><td>${grupo.motivo || "Fechamento excepcional"}</td><td>${inicio === fim ? "Dia inteiro" : "Período"}</td><td><button class="btn btn-danger btn-sm" type="button" data-remover-fechamento="${grupo.fechamento_id || grupo.id}">Remover</button></td></tr>`;
    })
    .join("");
  body
    .querySelectorAll("[data-remover-fechamento]")
    .forEach((botao) =>
      botao.addEventListener("click", () =>
        removerFechamento(botao.dataset.removerFechamento),
      ),
    );
}

async function carregarFuncionamento() {
  const [configSnap, fechamentosSnap] = await Promise.all([
    getDoc(funcionamentoRef),
    getDocs(
      query(collection(db, "fechamentos_globais"), orderBy("data", "asc")),
    ),
  ]);
  const semanal = configSnap.exists()
    ? configSnap.data().dias_fechados_semana || {}
    : {};
  DIAS_SEMANA.forEach((_, dia) => {
    const campo = document.getElementById(`func-semana-${dia}`);
    if (campo)
      campo.checked =
        semanal[dia] === true || (semanal[dia] === undefined && dia === 0);
  });
  fechamentosCache = fechamentosSnap.docs
    .map((snap) => ({ id: snap.id, ...snap.data() }))
    .filter((item) => item.ativo !== false);
  renderizarFechamentos();
}

document
  .getElementById("btn-salvar-funcionamento")
  ?.addEventListener("click", async (evento) => {
    const botao = evento.currentTarget;
    const feedback = document.getElementById("funcionamento-feedback");
    const dias_fechados_semana = {};
    DIAS_SEMANA.forEach((_, dia) => {
      dias_fechados_semana[dia] = Boolean(
        document.getElementById(`func-semana-${dia}`)?.checked,
      );
    });
    botao.disabled = true;
    botao.textContent = "Salvando…";
    feedback.textContent = "";
    try {
      await executarComandoOperacional("admin.funcionamento.salvar", {
        data: { dias_fechados_semana },
      });
      feedback.textContent = "Funcionamento atualizado.";
    } catch (erro) {
      console.error("Falha ao salvar funcionamento.", erro);
      feedback.textContent = "Não foi possível salvar o funcionamento.";
    } finally {
      botao.disabled = false;
      botao.textContent = "Salvar funcionamento";
    }
  });

function abrirModalFechamento() {
  document.getElementById("form-fechamento-global").reset();
  document.getElementById("fechamento-msg").className = "msg";
  document.getElementById("fechamento-inicio").min = dataLocalHoje();
  document.getElementById("fechamento-fim-field").hidden = true;
  document.getElementById("modal-fechamento-global").classList.add("show");
}

document
  .getElementById("btn-novo-fechamento")
  ?.addEventListener("click", abrirModalFechamento);
document
  .getElementById("btn-fechar-modal-fechamento")
  ?.addEventListener("click", () =>
    document.getElementById("modal-fechamento-global").classList.remove("show"),
  );
document
  .getElementById("fechamento-tipo")
  ?.addEventListener("change", (evento) => {
    const porPeriodo = evento.target.value === "periodo";
    document.getElementById("fechamento-fim-field").hidden = !porPeriodo;
    document.getElementById("fechamento-fim").required = porPeriodo;
  });

document
  .getElementById("form-fechamento-global")
  ?.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const inicio = document.getElementById("fechamento-inicio").value;
    const fim =
      document.getElementById("fechamento-tipo").value === "periodo"
        ? document.getElementById("fechamento-fim").value
        : inicio;
    const motivo =
      document.getElementById("fechamento-motivo").value.trim() ||
      "Fechamento excepcional";
    const msg = document.getElementById("fechamento-msg");
    if (!inicio || !fim || fim < inicio) {
      msg.textContent = "Informe um período de datas válido.";
      msg.className = "msg show";
      return;
    }
    const intervalo = [];
    for (let data = inicio; data <= fim; data = isoSomarDias(data, 1)) {
      intervalo.push(data);
      if (intervalo.length > 366) {
        msg.textContent = "O período máximo para esta operação é de 366 dias.";
        msg.className = "msg show";
        return;
      }
    }
    try {
      const jaFechados = await Promise.all(
        intervalo.map((data) => getDoc(doc(db, "fechamentos_globais", data))),
      );
      if (
        jaFechados.some((snap) => snap.exists() && snap.data().ativo !== false)
      ) {
        msg.textContent =
          "Já existe um fechamento cadastrado em pelo menos uma destas datas. Remova-o antes de cadastrar outro.";
        msg.className = "msg show";
        return;
      }
      const existentes = await getDocs(
        query(
          collection(db, "agendamentos"),
          where("data", ">=", inicio),
          where("data", "<=", fim),
        ),
      );
      if (
        !existentes.empty &&
        !window.confirm(
          `Existem ${existentes.size} agendamento(s) neste período. Eles não serão apagados. Confirmar o fechamento mesmo assim?`,
        )
      )
        return;
      const botao = evento.target.querySelector("button[type=submit]");
      botao.disabled = true;
      botao.textContent = "Salvando…";
      await executarComandoOperacional("admin.fechamento.salvar", {
        data: { datas: intervalo, inicio, fim, motivo, fechamento_id: `fechamento_${Date.now()}` },
      });
      document
        .getElementById("modal-fechamento-global")
        .classList.remove("show");
      await carregarFuncionamento();
    } catch (erro) {
      console.error("Falha ao cadastrar fechamento.", erro);
      msg.textContent = "Não foi possível salvar o fechamento.";
      msg.className = "msg show";
    } finally {
      const botao = evento.target.querySelector("button[type=submit]");
      botao.disabled = false;
      botao.textContent = "Salvar fechamento";
    }
  });

async function removerFechamento(fechamentoId) {
  const documentos = fechamentosCache.filter(
    (item) => (item.fechamento_id || item.id) === fechamentoId,
  );
  if (
    !documentos.length ||
    !window.confirm(
      "Remover este fechamento? Novos agendamentos voltarão a respeitar somente a disponibilidade normal.",
    )
  )
    return;
  try {
    await executarComandoOperacional("admin.fechamento.remover", {
      data: { ids: documentos.map((item) => item.id) },
    });
    await carregarFuncionamento();
  } catch (erro) {
    console.error("Falha ao remover fechamento.", erro);
    alert("Não foi possível remover o fechamento.");
  }
}

// ----------------------------------------------------------------------------
// Listar barbeiros
// ----------------------------------------------------------------------------
let totalBarbeiros = 0;

async function carregarBarbeiros() {
  const grid = document.getElementById("admin-barbeiros-grid");
  const snap = await getDocs(
    query(collection(db, "barbeiros"), orderBy("nome")),
  );
  barbeirosCache = snap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
  totalBarbeiros = snap.size;
  window.dispatchEvent(
    new CustomEvent("admin:barbers-loaded", {
      detail: { professionals: barbeirosCache },
    }),
  );

  document.getElementById("limite-barbeiros").textContent =
    `${totalBarbeiros} de ${LIMITE_BARBEIROS} barbeiros cadastrados.`;
  document.getElementById("btn-novo-barbeiro").disabled =
    totalBarbeiros >= LIMITE_BARBEIROS;
  preencherFiltroBarbeiros();

  if (snap.empty) {
    grid.innerHTML = `<div class="empty-state" style="grid-column:1/-1">
      <h3>Nenhum barbeiro cadastrado</h3><p>Clique em "Novo barbeiro" para começar.</p></div>`;
    return;
  }

  grid.innerHTML = "";
  snap.forEach((docSnap) => {
    const b = docSnap.data();
    const el = document.createElement("div");
    el.className = "admin-barbeiro-card";
    el.innerHTML = `
      <img src="${b.foto || "https://placehold.co/300x220/151517/3f8f5f?text=Barbeiro"}" alt="${b.nome}" />
      <div>
        <strong>${b.nome}</strong><br/>
        <span style="color:var(--cinza); font-size:12.5px;">${b.especialidade || ""}</span>
      </div>
      ${b.ativo ? "" : '<span class="badge-inativo">Inativo</span>'}
      <div class="admin-actions">
        <button class="btn btn-ghost btn-sm" data-editar="${docSnap.id}">Editar</button>
        <button class="btn btn-sm" data-toggle="${docSnap.id}" data-ativo="${b.ativo}">${b.ativo ? "Desativar" : "Ativar"}</button>
        <button class="btn btn-danger btn-sm" data-remover="${docSnap.id}">Remover</button>
      </div>`;
    grid.appendChild(el);

    el.querySelector("[data-editar]").addEventListener("click", () =>
      abrirModal(docSnap.id, b),
    );
    el.querySelector("[data-toggle]").addEventListener("click", () =>
      alternarAtivo(docSnap.id, !b.ativo),
    );
    el.querySelector("[data-remover]").addEventListener("click", () =>
      removerBarbeiro(docSnap.id, b.nome),
    );
  });
}

async function alternarAtivo(id, novoStatus) {
  await executarComandoOperacional("admin.barbeiro.ativar", { data: { id, ativo: novoStatus } });
  await carregarBarbeiros();
}

async function removerBarbeiro(id, nome) {
  if (!confirm(`Remover "${nome}" definitivamente?`)) return;
  await executarComandoOperacional("admin.barbeiro.remover", { data: { id } });
  await carregarBarbeiros();
}

// ----------------------------------------------------------------------------
// Modal cadastrar / editar
// ----------------------------------------------------------------------------
const modal = document.getElementById("modal-barbeiro");
const form = document.getElementById("form-barbeiro");
const modalMsg = document.getElementById("modal-msg");

function arquivoDeFotoBarbeiroAceito(file) {
  return (
    FOTO_BARBEIRO_TYPES.includes(String(file.type || "").toLowerCase()) ||
    /\.(jpe?g|png|webp)$/i.test(file.name || "")
  );
}

function blobDoCanvasBarbeiro(canvas, tipo, qualidade) {
  return new Promise((resolve) => canvas.toBlob(resolve, tipo, qualidade));
}

function blobParaDataUrlBarbeiro(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error || new Error("LEITURA_FALHOU"));
    leitor.readAsDataURL(blob);
  });
}

async function carregarImagemBarbeiro(file) {
  if ("createImageBitmap" in window) {
    try {
      const bitmap = await createImageBitmap(file, {
        imageOrientation: "from-image",
      });
      return { imagem: bitmap, fechar: () => bitmap.close?.() };
    } catch (_) {
      /* Safari antigo usa o fallback abaixo. */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const imagem = await new Promise((resolve, reject) => {
      const elemento = new Image();
      elemento.onload = () => resolve(elemento);
      elemento.onerror = reject;
      elemento.src = url;
    });
    return { imagem, fechar: () => URL.revokeObjectURL(url) };
  } catch (erro) {
    URL.revokeObjectURL(url);
    throw erro;
  }
}

async function otimizarFotoBarbeiro(file) {
  const { imagem, fechar } = await carregarImagemBarbeiro(file);
  try {
    const larguraOriginal = imagem.width || imagem.naturalWidth;
    const alturaOriginal = imagem.height || imagem.naturalHeight;
    let escala = Math.min(
      1,
      FOTO_BARBEIRO_MAX_SIDE / Math.max(larguraOriginal, alturaOriginal),
    );
    let melhorBlob = null;
    for (
      let tentativaTamanho = 0;
      tentativaTamanho < 4;
      tentativaTamanho += 1
    ) {
      const largura = Math.max(1, Math.round(larguraOriginal * escala));
      const altura = Math.max(1, Math.round(alturaOriginal * escala));
      const canvas = document.createElement("canvas");
      canvas.width = largura;
      canvas.height = altura;
      const contexto = canvas.getContext("2d", { alpha: false });
      contexto.drawImage(imagem, 0, 0, largura, altura);
      for (const qualidade of [0.84, 0.8, 0.76, 0.72, 0.68, 0.64]) {
        let blob = await blobDoCanvasBarbeiro(canvas, "image/webp", qualidade);
        if (!blob || blob.type !== "image/webp")
          blob = await blobDoCanvasBarbeiro(canvas, "image/jpeg", qualidade);
        if (!blob) throw new Error("COMPRESSAO_FALHOU");
        melhorBlob = blob;
        if (blob.size <= FOTO_BARBEIRO_TARGET_BYTES) return blob;
      }
      escala *= 0.82;
    }
    return melhorBlob;
  } finally {
    fechar();
  }
}

function mostrarPreviewFotoBarbeiro(foto) {
  const preview = document.getElementById("b-foto-preview");
  const placeholder = document.getElementById("b-foto-placeholder");
  const remover = document.getElementById("btn-remover-foto");
  preview.hidden = !foto;
  placeholder.hidden = Boolean(foto);
  preview.removeAttribute("src");
  if (foto) preview.src = foto;
  remover.disabled = !foto;
}

async function atualizarStatusConta(uid = "") {
  const status = document.getElementById("b-conta-status");
  const detalhes = document.getElementById("b-conta-detalhes");
  const desvincular = document.getElementById("btn-desvincular-conta");
  status.className = "account-link-status";
  desvincular.hidden = !uid;
  const email =
    document.getElementById("b-email-acesso")?.value.trim().toLowerCase() || "";
  if (!uid) {
    status.textContent = email
      ? "○ Aguardando criação/login da conta"
      : "○ Nenhuma conta vinculada";
    detalhes.textContent = email
      ? `E-mail autorizado: ${email}. O vínculo será feito automaticamente no primeiro acesso ao painel.`
      : "Defina o e-mail com que este profissional criará ou acessará a conta.";
    return Boolean(email);
  }
  status.textContent = "Validando conta…";
  try {
    const perfil = await getDoc(doc(db, "clientes", uid));
    if (!perfil.exists()) {
      status.textContent = "○ Conta não localizada";
      detalhes.textContent =
        "Nenhum perfil foi encontrado para este UID. Peça ao barbeiro para criar e acessar a conta uma vez.";
      return false;
    }
    const dados = perfil.data();
    status.textContent = "● Conta vinculada";
    status.classList.add("linked");
    detalhes.textContent = `${dados.nome || "Conta do barbeiro"}${dados.email ? ` · ${dados.email}` : ""} · UID: ${uid}`;
    return true;
  } catch (err) {
    status.textContent = "○ Não foi possível validar a conta";
    detalhes.textContent = "Tente novamente.";
    return false;
  }
}

async function abrirModal(id = null, dados = {}) {
  document.getElementById("modal-titulo").textContent = id
    ? "Editar barbeiro"
    : "Novo barbeiro";
  document.getElementById("b-id").value = id || "";
  document.getElementById("b-nome").value = dados.nome || "";
  fotoBarbeiroAtual = dados.foto || "";
  fotoBarbeiroPendente = false;
  document.getElementById("b-foto-file").value = "";
  mostrarPreviewFotoBarbeiro(fotoBarbeiroAtual);
  document.getElementById("b-especialidade").value = dados.especialidade || "";
  document.getElementById("b-descricao").value = dados.descricao || "";
  document.getElementById("b-uid-usuario").value = dados.uid_usuario || "";
  document.getElementById("b-email-acesso").value = dados.email_acesso || "";
  uidVinculoOriginal = dados.uid_usuario || "";
  emailAcessoOriginal = dados.email_acesso || "";
  document.getElementById("b-ativo").value =
    dados.ativo === false ? "false" : "true";
  modalMsg.className = "msg";
  modal.classList.add("show");
  await atualizarStatusConta(dados.uid_usuario || "");
}

document.getElementById("btn-novo-barbeiro").addEventListener("click", () => {
  if (totalBarbeiros >= LIMITE_BARBEIROS) return;
  abrirModal();
});
document
  .getElementById("btn-fechar-modal")
  .addEventListener("click", () => modal.classList.remove("show"));
document
  .getElementById("b-foto-file")
  .addEventListener("change", async (event) => {
    const input = event.currentTarget;
    const file = input.files[0];
    if (!file) return;
    if (file.size > FOTO_BARBEIRO_MAX_BYTES) {
      modalMsg.textContent = "A imagem deve ter no máximo 5 MB.";
      modalMsg.className = "msg show err";
      input.value = "";
      return;
    }
    if (!arquivoDeFotoBarbeiroAceito(file)) {
      modalMsg.textContent = "Use JPG, PNG ou WebP, até 5 MB.";
      modalMsg.className = "msg show err";
      input.value = "";
      return;
    }
    input.disabled = true;
    try {
      modalMsg.textContent = "Otimizando foto...";
      modalMsg.className = "msg show ok";
      const fotoOtimizada = await otimizarFotoBarbeiro(file);
      if (!fotoOtimizada) throw new Error("COMPRESSAO_FALHOU");
      fotoBarbeiroAtual = await blobParaDataUrlBarbeiro(fotoOtimizada);
      fotoBarbeiroPendente = true;
      mostrarPreviewFotoBarbeiro(fotoBarbeiroAtual);
      modalMsg.textContent = "Foto pronta para salvar.";
      modalMsg.className = "msg show ok";
    } catch (erro) {
      console.error("Falha ao otimizar foto do barbeiro.", erro);
      modalMsg.textContent =
        "Não foi possível otimizar a foto. A foto atual foi mantida.";
      modalMsg.className = "msg show err";
    } finally {
      input.disabled = false;
      input.value = "";
    }
  });
document.getElementById("btn-remover-foto").addEventListener("click", () => {
  fotoBarbeiroAtual = "";
  fotoBarbeiroPendente = true;
  document.getElementById("b-foto-file").value = "";
  mostrarPreviewFotoBarbeiro("");
  modalMsg.textContent = "Foto removida. Salve para confirmar.";
  modalMsg.className = "msg show ok";
});
document
  .getElementById("btn-validar-vinculo")
  ?.addEventListener("click", () =>
    atualizarStatusConta(document.getElementById("b-uid-usuario").value.trim()),
  );
document
  .getElementById("btn-desvincular-conta")
  ?.addEventListener("click", async () => {
    const id = document.getElementById("b-id").value;
    const uid = document.getElementById("b-uid-usuario").value.trim();
    if (
      !id ||
      !uid ||
      !confirm(
        "Desvincular esta conta? O profissional perderá o acesso ao painel.",
      )
    )
      return;
    try {
      await executarComandoOperacional("admin.barbeiro.salvar", {
        data: {
          id,
          nome: document.getElementById("b-nome").value.trim(),
          foto: fotoBarbeiroAtual,
          especialidade: document.getElementById("b-especialidade").value.trim(),
          descricao: document.getElementById("b-descricao").value.trim(),
          uid_usuario: "",
          email_acesso: document.getElementById("b-email-acesso").value.trim().toLowerCase(),
          ativo: document.getElementById("b-ativo").value === "true",
          uid_vinculo_original: uid,
        },
      });
      document.getElementById("b-uid-usuario").value = "";
      await atualizarStatusConta("");
      modalMsg.textContent = "Conta desvinculada com sucesso.";
      modalMsg.className = "msg show ok";
      await carregarBarbeiros();
    } catch (err) {
      modalMsg.textContent = "Não foi possível desvincular a conta.";
      modalMsg.className = "msg show err";
      console.error("Falha ao desvincular conta.", err);
    }
  });

form.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("b-id").value;
  const dados = {
    nome: document.getElementById("b-nome").value.trim(),
    foto: fotoBarbeiroAtual,
    especialidade: document.getElementById("b-especialidade").value.trim(),
    descricao: document.getElementById("b-descricao").value.trim(),
    uid_usuario: document.getElementById("b-uid-usuario").value.trim(),
    email_acesso: document
      .getElementById("b-email-acesso")
      .value.trim()
      .toLowerCase(),
    ativo: document.getElementById("b-ativo").value === "true",
  };

  try {
    if (fotoBarbeiroPendente) {
      modalMsg.textContent = "Enviando foto...";
      modalMsg.className = "msg show ok";
    }
    if (dados.email_acesso && !/^\S+@\S+\.\S+$/.test(dados.email_acesso))
      throw new Error("EMAIL_INVALIDO");
    if (uidVinculoOriginal && dados.email_acesso !== emailAcessoOriginal)
      throw new Error("DESVINCULAR_PRIMEIRO");
    if (dados.email_acesso) {
      const emailEmUso = barbeirosCache.find(
        (barbeiro) =>
          barbeiro.id !== id &&
          String(barbeiro.email_acesso || "").toLowerCase() ===
            dados.email_acesso,
      );
      if (emailEmUso) throw new Error("EMAIL_JA_VINCULADO");
    }
    if (dados.uid_usuario) {
      if (!(await atualizarStatusConta(dados.uid_usuario)))
        throw new Error("UID_INVALIDO");
      const existente = barbeirosCache.find(
        (barbeiro) =>
          barbeiro.id !== id && barbeiro.uid_usuario === dados.uid_usuario,
      );
      if (existente) throw new Error("UID_JA_VINCULADO");
    }
    if (!id) {
      if (totalBarbeiros >= LIMITE_BARBEIROS) {
        modalMsg.textContent = `Limite de ${LIMITE_BARBEIROS} barbeiros atingido.`;
        modalMsg.className = "msg show err";
        return;
      }
    }
    await executarComandoOperacional("admin.barbeiro.salvar", {
      data: { id, ...dados, uid_vinculo_original: uidVinculoOriginal || "" },
    });
    modalMsg.textContent = dados.uid_usuario
      ? "Conta vinculada com sucesso."
      : dados.email_acesso
        ? "E-mail autorizado salvo. Aguardando o primeiro acesso da conta."
        : "Profissional salvo com sucesso.";
    modalMsg.className = "msg show ok";
    fotoBarbeiroPendente = false;
    await carregarBarbeiros();
    setTimeout(() => modal.classList.remove("show"), 900);
  } catch (err) {
    modalMsg.textContent =
      err.message === "DESVINCULAR_PRIMEIRO"
        ? "Desvincule a conta atual antes de alterar o e-mail autorizado."
        : err.message === "EMAIL_JA_VINCULADO"
          ? "Este e-mail já está associado a outro profissional."
          : err.message === "EMAIL_INVALIDO"
            ? "Informe um e-mail autorizado válido."
            : err.message === "UID_JA_VINCULADO"
              ? "Esta conta já está vinculada a outro barbeiro."
              : err.message === "UID_INVALIDO"
                ? "UID inválido: a conta ainda não possui perfil no sistema."
                : "Não foi possível salvar. Tente novamente.";
    modalMsg.className = "msg show err";
  }
});

// ----------------------------------------------------------------------------
// Importação em lote — catálogo real da Barbearia Antunes
// ----------------------------------------------------------------------------
const CATALOGO_ANTUNES = [
  { nome: "00. Corte Infantil (até 12 anos)", duracao: 30, preco: "R$ 40,00" },
  { nome: "01. Corte Seg à Qui", duracao: 30, preco: "R$ 40,00" },
  { nome: "01. Corte Sex à Dom", duracao: 30, preco: "R$ 45,00" },
  { nome: "02. Corte + Sobrancelha Seg à Qui", duracao: 30, preco: "R$ 50,00" },
  { nome: "02. Corte + Sobrancelha Sex à Dom", duracao: 30, preco: "R$ 55,00" },
  {
    nome: "03. Corte + Barba + Sobrancelha Seg à Qui",
    duracao: 60,
    preco: "R$ 80,00",
  },
  {
    nome: "03. Corte + Barba + Sobrancelha Sex à Dom",
    duracao: 60,
    preco: "R$ 85,00",
  },
  {
    nome: "04. Corte + Barba Express (Somente máquina) Seg à Qui",
    duracao: 30,
    preco: "R$ 60,00",
  },
  {
    nome: "04. Corte + Barba Express (Somente máquina) Sex à Dom",
    duracao: 30,
    preco: "R$ 65,00",
  },
  { nome: "05. Corte + Barba Seg à Qui", duracao: 60, preco: "R$ 70,00" },
  { nome: "05. Corte + Barba Sex à Dom", duracao: 60, preco: "R$ 75,00" },
  { nome: "06. Corte + Penteado Seg à Qui", duracao: 30, preco: "R$ 65,00" },
  { nome: "06. Corte + Penteado Sex à Dom", duracao: 30, preco: "R$ 70,00" },
  { nome: "07. Penteado", duracao: 30, preco: "R$ 30,00" },
  { nome: "07. Pezinho", duracao: 30, preco: "R$ 20,00" },
  { nome: "07. Pezinho + Barba", duracao: 30, preco: "R$ 55,00" },
  { nome: "07. Pezinho + Penteado", duracao: 30, preco: "R$ 50,00" },
  { nome: "07. Pezinho + Sobrancelha", duracao: 30, preco: "R$ 40,00" },
  { nome: "08. Barba", duracao: 30, preco: "R$ 35,00" },
  { nome: "08. Barba + Sobrancelha", duracao: 30, preco: "R$ 45,00" },
  {
    nome: "08. Barba Express (Somente máquina, sem navalha)",
    duracao: 30,
    preco: "R$ 20,00",
  },
  {
    nome: "09. Corte + Barba + Penteado Seg à Qui",
    duracao: 60,
    preco: "R$ 100,00",
  },
  {
    nome: "09. Corte + Barba + Penteado Sex à Dom",
    duracao: 90,
    preco: "R$ 105,00",
  },
  {
    nome: "10. Corte + Barba + Botox Seg à Qui",
    duracao: 120,
    preco: "R$ 140,00",
  },
  {
    nome: "10. Corte + Barba + Botox Sex à Dom",
    duracao: 120,
    preco: "R$ 150,00",
  },
  { nome: "11. Corte Raspado + Barba", duracao: 30, preco: "R$ 65,00" },
  { nome: "12. Corte + Botox Seg à Quarta", duracao: 60, preco: "R$ 110,00" },
  {
    nome: "12. Corte + Botox Quinta à Sábado",
    duracao: 60,
    preco: "R$ 115,00",
  },
  { nome: "Alisante Americano", duracao: 30, preco: "R$ 35,00" },
  { nome: "Botox", duracao: 30, preco: "A partir de R$ 70,00" },
  { nome: "Camuflagem (Pintar Fios Brancos)", duracao: 30, preco: "Consultar" },
  { nome: "Depilação Nasal", duracao: 20, preco: "R$ 20,00" },
  { nome: "Depilação Orelha", duracao: 10, preco: "R$ 15,00" },
  { nome: "Hidratação", duracao: 30, preco: "R$ 20,00" },
  { nome: "Platinado (Luzes)", duracao: 60, preco: "A partir de R$ 70,00" },
  { nome: "Platinado (Nevou)", duracao: 60, preco: "A partir de R$ 120,00" },
  { nome: "Progressiva", duracao: 60, preco: "A partir de R$ 85,00" },
  { nome: "Sobrancelha", duracao: 10, preco: "R$ 20,00" },
  { nome: "Tintura", duracao: 30, preco: "Consultar" },
];

document
  .getElementById("btn-importar-servicos")
  .addEventListener("click", async () => {
    const btn = document.getElementById("btn-importar-servicos");
    const msg = document.getElementById("importar-msg");

    if (
      !confirm(
        `Importar os ${CATALOGO_ANTUNES.length} serviços do catálogo da Barbearia Antunes? Serviços já cadastrados com o mesmo nome não serão duplicados.`,
      )
    ) {
      return;
    }

    btn.disabled = true;
    btn.textContent = "Importando…";

    // evita duplicar serviços que já existem (compara pelo nome)
    const existentesSnap = await getDocs(collection(db, "servicos"));
    const nomesExistentes = new Set();
    existentesSnap.forEach((d) => nomesExistentes.add(d.data().nome));

    let criados = 0;
    for (const servico of CATALOGO_ANTUNES) {
      if (nomesExistentes.has(servico.nome)) continue;
      await executarComandoOperacional("admin.servico.salvar", {
        data: { ...servico, ativo: servico.ativo !== false },
      });
      criados++;
    }

    msg.textContent = `${criados} serviço(s) importado(s). ${CATALOGO_ANTUNES.length - criados} já existiam e foram ignorados.`;
    btn.disabled = false;
    btn.textContent = "Importar catálogo Antunes (39)";
    await carregarServicos();
  });

// ----------------------------------------------------------------------------
// Serviços — listar, cadastrar, editar, remover
// ----------------------------------------------------------------------------
async function carregarServicos() {
  const body = document.getElementById("admin-servicos-body");
  const snap = await getDocs(
    query(collection(db, "servicos"), orderBy("nome")),
  );
  servicosCache = snap.docs.map((docSnap) => ({
    id: docSnap.id,
    ...docSnap.data(),
  }));
  preencherFiltroServicos();

  if (snap.empty) {
    body.innerHTML = `<tr><td colspan="5" style="color:var(--cinza)">Nenhum serviço cadastrado. Clique em "Novo serviço" para começar.</td></tr>`;
    return;
  }

  body.innerHTML = "";
  snap.forEach((docSnap) => {
    const s = docSnap.data();
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${s.nome}</td>
      <td style="color:var(--cinza)">${s.descricao || "—"}</td>
      <td>${s.duracao} min</td>
      <td>${s.preco}</td>
      <td>
        <div style="display:flex; gap:8px;">
          <button class="btn btn-ghost btn-sm" data-editar-servico="${docSnap.id}">Editar</button>
          <button class="btn btn-danger btn-sm" data-remover-servico="${docSnap.id}">Remover</button>
        </div>
      </td>`;
    body.appendChild(tr);

    tr.querySelector("[data-editar-servico]").addEventListener("click", () =>
      abrirModalServico(docSnap.id, s),
    );
    tr.querySelector("[data-remover-servico]").addEventListener("click", () =>
      removerServico(docSnap.id, s.nome),
    );
  });
}

async function removerServico(id, nome) {
  if (!confirm(`Remover o serviço "${nome}"?`)) return;
  await executarComandoOperacional("admin.servico.remover", { data: { id } });
  await carregarServicos();
}

const modalServico = document.getElementById("modal-servico");
const formServico = document.getElementById("form-servico");
const modalServicoMsg = document.getElementById("modal-servico-msg");

function abrirModalServico(id = null, dados = {}) {
  document.getElementById("modal-servico-titulo").textContent = id
    ? "Editar serviço"
    : "Novo serviço";
  document.getElementById("s-id").value = id || "";
  document.getElementById("s-nome").value = dados.nome || "";
  document.getElementById("s-descricao").value = dados.descricao || "";
  document.getElementById("s-duracao").value = dados.duracao ?? "";
  document.getElementById("s-preco").value = dados.preco ?? "";
  modalServicoMsg.className = "msg";
  modalServico.classList.add("show");
}

document
  .getElementById("btn-novo-servico")
  .addEventListener("click", () => abrirModalServico());
document
  .getElementById("btn-fechar-modal-servico")
  .addEventListener("click", () => modalServico.classList.remove("show"));

formServico.addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = document.getElementById("s-id").value;
  const dados = {
    nome: document.getElementById("s-nome").value.trim(),
    descricao: document.getElementById("s-descricao").value.trim(),
    duracao: Number(document.getElementById("s-duracao").value),
    preco: document.getElementById("s-preco").value.trim(),
  };

  if (!dados.nome || !dados.duracao || !dados.preco) {
    modalServicoMsg.textContent =
      "Preencha nome, duração e preço corretamente.";
    modalServicoMsg.className = "msg show err";
    return;
  }

  try {
    await executarComandoOperacional("admin.servico.salvar", {
      data: { id, ...dados, ativo: true },
    });
    modalServico.classList.remove("show");
    await carregarServicos();
  } catch (err) {
    modalServicoMsg.textContent = "Não foi possível salvar. Tente novamente.";
    modalServicoMsg.className = "msg show err";
  }
});

// ----------------------------------------------------------------------------
// Assinaturas — catálogo administrativo de planos (sem adesão de clientes)
// ----------------------------------------------------------------------------
const PLANOS_ASSINATURA_INICIAIS = [
  {
    id: "essencial",
    nome: "Essencial",
    descricao: "4 cortes por mês",
    usos_mensais: 4,
    servicos_incluidos: ["Corte"],
  },
  {
    id: "prime",
    nome: "Prime",
    descricao: "4 cortes + 4 sobrancelhas por mês",
    usos_mensais: 8,
    servicos_incluidos: ["Corte", "Sobrancelha"],
  },
  {
    id: "premium",
    nome: "Premium",
    descricao: "4 cortes + 4 barbas + 4 sobrancelhas por mês",
    usos_mensais: 12,
    servicos_incluidos: ["Corte", "Barba", "Sobrancelha"],
  },
];

function servicosDoPlano(plano = {}) {
  const ids = Array.isArray(plano.servicos_ids) ? plano.servicos_ids : [];
  return ids
    .map((id) => servicosCache.find((servico) => servico.id === id))
    .filter(Boolean);
}

function preencherSelecaoServicosDoPlano(plano = null) {
  const select = document.getElementById("a-servicos");
  if (!select) return;
  const idsSelecionados = new Set(
    Array.isArray(plano?.servicos_ids) ? plano.servicos_ids : [],
  );
  select.innerHTML = "";
  servicosCache.forEach((servico) => {
    const option = new Option(servico.nome, servico.id, false, idsSelecionados.has(servico.id));
    select.add(option);
  });
}

function nomesDosServicosDoPlano(plano = {}) {
  const selecionados = servicosDoPlano(plano);
  if (selecionados.length) return selecionados.map((servico) => servico.nome);
  return Array.isArray(plano.servicos_incluidos) ? plano.servicos_incluidos : [];
}

function formatarPrecoPlano(centavos) {
  if (!Number.isInteger(centavos) || centavos <= 0) return "Preço a definir";
  return new Intl.NumberFormat("pt-BR", {
    style: "currency",
    currency: "BRL",
  }).format(centavos / 100);
}

function textoDoPrecoPlano(centavos) {
  if (!Number.isInteger(centavos) || centavos <= 0) return "";
  return (centavos / 100).toFixed(2).replace(".", ",");
}

function precoParaCentavos(valor) {
  const texto = String(valor || "").trim();
  const normalizado = texto.includes(",")
    ? texto.replace(/[^\d,]/g, "").replace(",", ".")
    : texto.replace(/[^\d.]/g, "");
  const preco = Number(normalizado);
  return Number.isFinite(preco) && preco > 0 ? Math.round(preco * 100) : 0;
}

async function garantirPlanosAssinaturaIniciais() {
  await Promise.all(
    PLANOS_ASSINATURA_INICIAIS.map(async ({ id, ...plano }) => {
      const referencia = doc(db, "planos_assinatura", id);
      const existente = await getDoc(referencia);
      if (!existente.exists()) {
        await executarComandoOperacional("admin.plano.inicial", {
          data: { id, ...plano },
        });
      }
    }),
  );
}

async function carregarAssinaturas() {
  const grid = document.getElementById("admin-assinaturas-grid");
  if (!grid || !auth.currentUser) return;
  try {
    await garantirPlanosAssinaturaIniciais();
    const snap = await getDocs(
      query(collection(db, "planos_assinatura"), orderBy("nome")),
    );
    planosAssinaturaCache = snap.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    if (snap.empty) {
      grid.innerHTML =
        '<div class="empty-state" style="grid-column:1/-1"><h3>Nenhum plano cadastrado</h3><p>Clique em “Novo plano” para começar.</p></div>';
      return;
    }
    grid.innerHTML = "";
    planosAssinaturaCache.forEach((plano) => {
      const card = document.createElement("article");
      card.className = "assinatura-card";
      const servicos = nomesDosServicosDoPlano(plano);
      card.innerHTML = `
        <div class="assinatura-card-head">
          <div><span class="eyebrow">Plano mensal</span><h3>${escaparHtml(plano.nome)}</h3></div>
          <span class="assinatura-status${plano.ativo ? "" : " inativo"}">${plano.ativo ? "Ativo" : "Inativo"}</span>
        </div>
        <p>${escaparHtml(plano.descricao || "Sem descrição")}</p>
        <strong class="assinatura-preco">${formatarPrecoPlano(plano.preco_centavos)}</strong>
        <span class="assinatura-usos">${Number(plano.usos_mensais) || 0} uso(s) por mês</span>
        <div class="assinatura-servicos">${servicos.map((servico) => `<span>${escaparHtml(servico)}</span>`).join("") || "<span>Serviços a definir</span>"}</div>
        <div class="assinatura-card-actions">
          <button class="btn btn-ghost btn-sm" type="button" data-editar-assinatura="${plano.id}">Editar</button>
          <button class="btn ${plano.ativo ? "btn-danger" : "btn-primary"} btn-sm" type="button" data-toggle-assinatura="${plano.id}">${plano.ativo ? "Desativar" : "Ativar"}</button>
        </div>`;
      card
        .querySelector("[data-editar-assinatura]")
        .addEventListener("click", () => abrirModalAssinatura(plano));
      card
        .querySelector("[data-toggle-assinatura]")
        .addEventListener("click", () => alternarPlanoAssinatura(plano));
      grid.appendChild(card);
    });
  } catch (erro) {
    console.error("Falha ao carregar planos de assinatura.", erro);
    grid.innerHTML =
      '<div class="empty-state" style="grid-column:1/-1"><h3>Não foi possível carregar os planos</h3><p>Tente atualizar a página.</p></div>';
  }
}

function abrirModalAssinatura(plano = null) {
  document.getElementById("modal-assinatura-titulo").textContent = plano
    ? "Editar plano"
    : "Novo plano";
  document.getElementById("a-id").value = plano?.id || "";
  document.getElementById("a-nome").value = plano?.nome || "";
  document.getElementById("a-descricao").value = plano?.descricao || "";
  document.getElementById("a-preco").value = textoDoPrecoPlano(
    plano?.preco_centavos,
  );
  document.getElementById("a-usos").value = plano?.usos_mensais || "";
  preencherSelecaoServicosDoPlano(plano);
  document.getElementById("a-ativo").value = plano?.ativo ? "true" : "false";
  document.getElementById("modal-assinatura-msg").className = "msg";
  document.getElementById("modal-assinatura").classList.add("show");
}

async function alternarPlanoAssinatura(plano) {
  const feedback = document.getElementById("assinaturas-feedback");
  if (
    !plano.ativo &&
    (!Number.isInteger(plano.preco_centavos)
      || plano.preco_centavos <= 0
      || !Array.isArray(plano.servicos_ids)
      || !plano.servicos_ids.length
      || Number(plano.usos_mensais) % plano.servicos_ids.length !== 0)
  ) {
    feedback.textContent = "Defina preço e serviços incluídos com uma quantidade de usos válida antes de ativar este plano.";
    return;
  }
  try {
    await executarComandoOperacional("admin.plano.ativar", {
      data: { id: plano.id, ativo: !plano.ativo },
    });
    feedback.textContent = `Plano ${plano.ativo ? "desativado" : "ativado"} com sucesso.`;
    await carregarAssinaturas();
  } catch (erro) {
    console.error("Falha ao alterar status do plano.", erro);
    feedback.textContent = "Não foi possível atualizar o plano.";
  }
}

document
  .getElementById("btn-nova-assinatura")
  ?.addEventListener("click", () => abrirModalAssinatura());
document
  .getElementById("btn-fechar-modal-assinatura")
  ?.addEventListener("click", () =>
    document.getElementById("modal-assinatura").classList.remove("show"),
  );

document
  .getElementById("form-assinatura")
  ?.addEventListener("submit", async (evento) => {
    evento.preventDefault();
    const id = document.getElementById("a-id").value;
    const mensagem = document.getElementById("modal-assinatura-msg");
    const botao = evento.currentTarget.querySelector('button[type="submit"]');
    const servicosIds = [...document.getElementById("a-servicos").selectedOptions]
      .map((option) => option.value)
      .filter((servicoId) => servicosCache.some((servico) => servico.id === servicoId));
    const servicos = servicosIds
      .map((servicoId) => servicosCache.find((servico) => servico.id === servicoId)?.nome)
      .filter(Boolean);
    const dados = {
      nome: document.getElementById("a-nome").value.trim(),
      descricao: document.getElementById("a-descricao").value.trim(),
      preco_centavos: precoParaCentavos(
        document.getElementById("a-preco").value,
      ),
      preco_definido: true,
      usos_mensais: Number(document.getElementById("a-usos").value),
      servicos_ids: [...new Set(servicosIds)],
      servicos_incluidos: [...new Set(servicos)],
      ativo: document.getElementById("a-ativo").value === "true",
    };
    if (
      !dados.nome ||
      !dados.descricao ||
      !dados.preco_centavos ||
      !Number.isInteger(dados.usos_mensais) ||
      dados.usos_mensais < 1 ||
      !dados.servicos_ids.length
    ) {
      mensagem.textContent =
        "Preencha nome, descrição, preço, usos mensais e os serviços incluídos.";
      mensagem.className = "msg show err";
      return;
    }
    if (dados.usos_mensais % dados.servicos_ids.length !== 0) {
      mensagem.textContent = "A quantidade de usos por mês deve ser divisível pela quantidade de serviços incluídos.";
      mensagem.className = "msg show err";
      return;
    }
    botao.disabled = true;
    botao.textContent = "Salvando…";
    try {
      await executarComandoOperacional("admin.plano.salvar", { data: { id, ...dados } });
      document.getElementById("modal-assinatura").classList.remove("show");
      document.getElementById("assinaturas-feedback").textContent =
        "Plano salvo com sucesso.";
      await carregarAssinaturas();
    } catch (erro) {
      console.error("Falha ao salvar plano.", erro);
      mensagem.textContent =
        "Não foi possível salvar o plano. Tente novamente.";
      mensagem.className = "msg show err";
    } finally {
      botao.disabled = false;
      botao.textContent = "Salvar plano";
    }
  });

// ----------------------------------------------------------------------------
// Solicitações de assinatura — aprovação presencial pelo administrador
// ----------------------------------------------------------------------------
function formatarDataHoraAssinatura(valor) {
  const data = valor?.toDate?.();
  if (!data) return "Aguardando registro";
  return new Intl.DateTimeFormat("pt-BR", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(data);
}

function vencimentoMensal(dataBase = new Date()) {
  const ano = dataBase.getFullYear();
  const mesSeguinte = dataBase.getMonth() + 1;
  const ultimoDia = new Date(ano, mesSeguinte + 1, 0).getDate();
  return new Date(
    ano,
    mesSeguinte,
    Math.min(dataBase.getDate(), ultimoDia),
    dataBase.getHours(),
    dataBase.getMinutes(),
    dataBase.getSeconds(),
  );
}

function criarCreditosMensais(plano) {
  const servicosIds = [...new Set(Array.isArray(plano?.servicos_ids) ? plano.servicos_ids : [])];
  const usosMensais = Number(plano?.usos_mensais);
  if (!servicosIds.length || !Number.isInteger(usosMensais) || usosMensais < 1 || usosMensais % servicosIds.length !== 0) {
    return null;
  }
  const usosPorServico = usosMensais / servicosIds.length;
  const nomesSalvos = Array.isArray(plano.servicos_incluidos) ? plano.servicos_incluidos : [];
  return Object.fromEntries(
    servicosIds.map((servicoId, indice) => {
      const servico = servicosCache.find((item) => item.id === servicoId);
      return [servicoId, {
        servico_id: servicoId,
        nome: servico?.nome || nomesSalvos[indice] || "Serviço incluído",
        total: usosPorServico,
        utilizados: 0,
        restantes: usosPorServico,
        reservados: 0,
      }];
    }),
  );
}

function normalizarBuscaAssinatura(valor) {
  return String(valor || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

function numerosBuscaAssinatura(valor) {
  const digitos = String(valor || "").replace(/\D/g, "");
  return /^55\d{10,11}$/.test(digitos)
    ? [digitos, digitos.slice(2)]
    : [digitos];
}

async function enriquecerSolicitacoesComCliente(solicitacoes) {
  const idsPendentes = [
    ...new Set(solicitacoes.map((item) => item.cliente_id).filter(Boolean)),
  ].filter((clienteId) => !clientesAssinaturasCache.has(clienteId));

  await Promise.all(
    idsPendentes.map(async (clienteId) => {
      try {
        const clienteSnap = await getDoc(doc(db, "clientes", clienteId));
        clientesAssinaturasCache.set(
          clienteId,
          clienteSnap.exists() ? clienteSnap.data() : {},
        );
      } catch (erro) {
        console.warn(
          "Não foi possível carregar o cadastro de um assinante.",
          erro,
        );
        clientesAssinaturasCache.set(clienteId, {});
      }
    }),
  );

  return solicitacoes.map((solicitacao) => {
    const cliente = clientesAssinaturasCache.get(solicitacao.cliente_id) || {};
    return {
      ...solicitacao,
      cliente_nome_busca:
        cliente.nome || cliente.displayName || solicitacao.cliente_nome || "",
      cliente_email_busca: solicitacao.cliente_email || cliente.email || "",
      cliente_telefone_busca:
        solicitacao.cliente_telefone ||
        solicitacao.cliente_whatsapp ||
        cliente.telefone ||
        cliente.whatsapp ||
        cliente.celular ||
        "",
    };
  });
}

function solicitacaoCorrespondeBusca(solicitacao, busca) {
  const texto = normalizarBuscaAssinatura(busca);
  if (!texto) return true;

  const nome = normalizarBuscaAssinatura(solicitacao.cliente_nome_busca);
  const email = normalizarBuscaAssinatura(solicitacao.cliente_email_busca);
  if (nome.includes(texto) || email.includes(texto)) return true;

  const termoTelefone = String(busca || "").replace(/\D/g, "");
  if (!termoTelefone) return false;
  return numerosBuscaAssinatura(solicitacao.cliente_telefone_busca).some(
    (numero) => numero.includes(termoTelefone),
  );
}

function solicitacaoCorrespondeStatus(solicitacao) {
  const vencimento = solicitacao.vencimento_em?.toDate?.();
  if (filtroGestaoAssinaturas === "PENDENTES")
    return solicitacao.status === "PENDENTE";
  if (filtroGestaoAssinaturas === "ATIVOS")
    return solicitacao.status === "ATIVA" && vencimento && vencimento > new Date();
  if (filtroGestaoAssinaturas === "EXPIRADOS")
    return solicitacao.status === "EXPIRADA" || (solicitacao.status === "ATIVA" && vencimento && vencimento <= new Date());
  return ["RECUSADA", "CANCELADA", "CANCELADO"].includes(solicitacao.status);
}

function assinaturaComCreditosEsgotados(assinatura) {
  const creditos = Object.values(assinatura?.creditos_mensais || {});
  return creditos.length > 0 && creditos.every((credito) => Number(credito.restantes) <= 0);
}

async function sincronizarAssinaturasExpiradas(solicitacoes) {
  const agora = new Date();
  const expiraveis = solicitacoes.filter((assinatura) => {
    const vencimento = assinatura.vencimento_em?.toDate?.();
    return assinatura.status === "ATIVA"
      && (assinaturaComCreditosEsgotados(assinatura) || (vencimento && vencimento <= agora));
  });
  if (!expiraveis.length) return solicitacoes;

  return solicitacoes.map((assinatura) => {
    const vencimento = assinatura.vencimento_em?.toDate?.();
    const porCreditos = assinaturaComCreditosEsgotados(assinatura);
    if (assinatura.status === "ATIVA" && (porCreditos || (vencimento && vencimento <= agora))) {
      return { ...assinatura, status: "EXPIRADA", motivo_expiracao: porCreditos ? "CREDITOS_ESGOTADOS" : "VENCIMENTO" };
    }
    return assinatura;
  });
}

function creditoTemReservaPreparada(credito) {
  return Number.isInteger(Number(credito?.reservados)) && Number(credito.reservados) >= 0;
}

// Migração silenciosa e única para assinaturas aprovadas antes da reserva de
// créditos. Somente o Admin executa esta rotina; os agendamentos futuros já
// existentes passam a ocupar o crédito correspondente antes de novos horários.
async function prepararReservasLegadas(solicitacoes) {
  const assinaturasPendentes = solicitacoes.filter((assinatura) =>
    assinatura.status === "ATIVA"
    && Object.values(assinatura.creditos_mensais || {}).some((credito) => !creditoTemReservaPreparada(credito)),
  );
  if (!assinaturasPendentes.length) return solicitacoes;

  const agendamentosSnap = await getDocs(collection(db, "agendamentos"));
  const reservasPorAssinatura = new Map();
  agendamentosSnap.docs.forEach((item) => {
    const agendamento = item.data();
    if (
      agendamento.origem !== "assinatura"
      || agendamento.credito_assinatura_consumido === true
      || agendamento.credito_assinatura_reservado === true
      || !["agendado", "cliente_chegou", "em_atendimento"].includes(agendamento.status)
    ) return;
    const chave = `${agendamento.cliente_id}_${agendamento.assinatura_plano_id}`;
    const porTipo = reservasPorAssinatura.get(chave) || {};
    porTipo[agendamento.assinatura_credito_tipo] = (porTipo[agendamento.assinatura_credito_tipo] || 0) + 1;
    reservasPorAssinatura.set(chave, porTipo);
  });

  return solicitacoes.map((assinatura) => {
    const reservas = reservasPorAssinatura.get(assinatura.id) || {};
    const creditos = Object.fromEntries(Object.entries(assinatura.creditos_mensais || {}).map(([tipo, credito]) => [
      tipo,
      creditoTemReservaPreparada(credito)
        ? credito
        : { ...credito, reservados: Math.max(0, Number(reservas[tipo] || 0)) },
    ]));
    return { ...assinatura, creditos_mensais: creditos };
  });
}

function atualizarControleBuscaAssinaturas() {
  const limpar = document.getElementById("assinaturas-limpar-busca");
  if (limpar) limpar.hidden = !buscaGestaoAssinaturas.trim();
}

function renderizarSolicitacoesAssinatura() {
  const grid = document.getElementById("solicitacoes-assinatura-grid");
  if (!grid) return;

  atualizarControleBuscaAssinaturas();
  const solicitacoes = solicitacoesAssinaturaCache
    .filter(solicitacaoCorrespondeStatus)
    .filter((solicitacao) =>
      solicitacaoCorrespondeBusca(solicitacao, buscaGestaoAssinaturas),
    );

  if (!solicitacoes.length) {
    const buscaAtiva = buscaGestaoAssinaturas.trim();
    grid.innerHTML = buscaAtiva
      ? '<div class="empty-state" style="grid-column:1/-1"><h3>Nenhum assinante encontrado.</h3><p>Tente buscar por outro nome, telefone ou e-mail.</p></div>'
      : '<div class="empty-state" style="grid-column:1/-1"><h3>Nenhum assinante neste status</h3><p>Os registros de assinatura aparecerão aqui.</p></div>';
    return;
  }

  grid.innerHTML = "";
  solicitacoes.forEach((solicitacao) => {
    const card = document.createElement("article");
    card.className = "solicitacao-assinatura-card";
    card.innerHTML = `
      <span class="solicitacao-assinatura-status">${escaparHtml(filtroGestaoAssinaturas === "EXPIRADOS" ? "EXPIRADA" : solicitacao.status)}</span>
      <h4>${escaparHtml(solicitacao.cliente_nome || solicitacao.cliente_nome_busca || "Cliente")}</h4>
      <p>${escaparHtml(solicitacao.plano_nome || "Plano")}</p>
      <div class="solicitacao-assinatura-meta">
        <div><span>Preço</span><strong>${formatarPrecoPlano(solicitacao.plano_preco_centavos)}</strong></div>
        <div><span>${solicitacao.ativado_em ? "Início" : "Solicitada em"}</span><strong>${formatarDataHoraAssinatura(solicitacao.ativado_em || solicitacao.solicitado_em)}</strong></div>
        ${solicitacao.vencimento_em ? `<div><span>Vencimento</span><strong>${formatarDataHoraAssinatura(solicitacao.vencimento_em)}</strong></div>` : ""}
        ${Object.values(solicitacao.creditos_mensais || {})
          .map(
            (credito) =>
              `<div><span>${escaparHtml(credito.nome || "Crédito")}</span><strong>${Number(credito.restantes) || 0}/${Number(credito.total) || 0} restantes · ${Number(credito.utilizados) || 0} uso(s)</strong></div>`,
          )
          .join("")}
      </div>
      ${
        solicitacao.status === "PENDENTE"
          ? `<div class="solicitacao-assinatura-actions">
        <button class="btn btn-primary btn-sm" type="button" data-aprovar-assinatura="${solicitacao.id}">Aprovar</button>
        <button class="btn btn-danger btn-sm" type="button" data-recusar-assinatura="${solicitacao.id}">Recusar</button>
      </div>`
          : ""
      }`;
    card
      .querySelector("[data-aprovar-assinatura]")
      ?.addEventListener("click", () => abrirAprovacaoAssinatura(solicitacao));
    card
      .querySelector("[data-recusar-assinatura]")
      ?.addEventListener("click", () =>
        recusarSolicitacaoAssinatura(solicitacao),
      );
    grid.appendChild(card);
  });
}

async function carregarSolicitacoesAssinatura({ atualizar = false } = {}) {
  const grid = document.getElementById("solicitacoes-assinatura-grid");
  if (!grid) return;
  if (solicitacoesAssinaturaCarregadas && !atualizar) {
    renderizarSolicitacoesAssinatura();
    return;
  }

  grid.innerHTML = '<p class="limit-note">Carregando solicitações…</p>';
  try {
    const snap = await getDocs(collection(db, "solicitacoes_assinatura"));
    let todas = snap.docs
      .map((item) => ({ id: item.id, ...item.data() }))
      .sort(
        (a, b) =>
          (b.solicitado_em?.toMillis?.() || 0) -
          (a.solicitado_em?.toMillis?.() || 0),
      );
    todas = await sincronizarAssinaturasExpiradas(todas);
    todas = await prepararReservasLegadas(todas);
    solicitacoesAssinaturaCache = await enriquecerSolicitacoesComCliente(todas);
    solicitacoesAssinaturaCarregadas = true;
    publicarDadosClientes();
    renderizarSolicitacoesAssinatura();
  } catch (erro) {
    console.error("Falha ao carregar solicitações de assinatura.", erro);
    grid.innerHTML =
      '<div class="empty-state" style="grid-column:1/-1"><h3>Não foi possível carregar as solicitações</h3><p>Tente novamente em instantes.</p></div>';
  }
}

async function carregarHistoricoAssinaturas() {
  const lista = document.getElementById("historico-assinaturas-lista");
  if (!lista) return;
  try {
    const snap = await getDocs(
      query(
        collection(db, "historico_assinaturas"),
        orderBy("utilizado_em", "desc"),
      ),
    );
    const usos = await Promise.all(
      snap.docs.map(async (item) => {
        const uso = item.data();
        const nomeSalvo = String(uso.cliente_nome || "").trim();
        const clienteId = String(uso.cliente_id || "").trim();

        if (nomeSalvo || !clienteId) {
          return {
            ...uso,
            cliente_nome_historico: nomeSalvo || "Cliente não identificado",
          };
        }

        if (!clientesAssinaturasCache.has(clienteId)) {
          try {
            const clienteSnap = await getDoc(doc(db, "clientes", clienteId));
            clientesAssinaturasCache.set(
              clienteId,
              clienteSnap.exists() ? clienteSnap.data() : {},
            );
          } catch (erro) {
            console.warn(
              "Não foi possível carregar o cliente de um uso de assinatura.",
              erro,
            );
            clientesAssinaturasCache.set(clienteId, {});
          }
        }

        const cliente = clientesAssinaturasCache.get(clienteId) || {};
        return {
          ...uso,
          cliente_nome_historico:
            String(cliente.nome || cliente.displayName || "").trim() ||
            "Cliente não identificado",
        };
      }),
    );
    lista.innerHTML = snap.empty
      ? '<p class="limit-note">Nenhum crédito utilizado ainda.</p>'
      : usos
          .map((uso) => {
            return `<article class="historico-assinatura-item"><time class="historico-assinatura-data">${escaparHtml(formatarDataHoraAssinatura(uso.utilizado_em))}</time><strong class="historico-assinatura-cliente">${escaparHtml(uso.cliente_nome_historico)}</strong><span class="historico-assinatura-detalhes">${escaparHtml(uso.servico_nome || "Serviço")} · ${escaparHtml(uso.barbeiro_nome || "Barbeiro")} · ${Number(uso.creditos_consumidos) || 1} crédito</span></article>`;
          })
          .join("");
  } catch (erro) {
    console.error("Falha ao carregar histórico de assinaturas.", erro);
    lista.innerHTML =
      '<p class="limit-note">Não foi possível carregar o histórico.</p>';
  }
}

document.querySelectorAll("[data-filtro-assinatura]").forEach((botao) =>
  botao.addEventListener("click", () => {
    filtroGestaoAssinaturas = botao.dataset.filtroAssinatura;
    document
      .querySelectorAll("[data-filtro-assinatura]")
      .forEach((item) => item.classList.toggle("active", item === botao));
    renderizarSolicitacoesAssinatura();
  }),
);

document
  .getElementById("assinaturas-busca")
  ?.addEventListener("input", (evento) => {
    buscaGestaoAssinaturas = evento.target.value;
    renderizarSolicitacoesAssinatura();
  });

document
  .getElementById("assinaturas-limpar-busca")
  ?.addEventListener("click", () => {
    const campo = document.getElementById("assinaturas-busca");
    if (!campo) return;
    campo.value = "";
    buscaGestaoAssinaturas = "";
    renderizarSolicitacoesAssinatura();
    campo.focus();
  });

function fecharAprovacaoAssinatura() {
  solicitacaoAssinaturaParaAprovar = null;
  document.getElementById("modal-aprovar-assinatura")?.classList.remove("show");
}

function abrirAprovacaoAssinatura(solicitacao) {
  solicitacaoAssinaturaParaAprovar = solicitacao;
  document.getElementById("aprovar-assinatura-resumo").textContent =
    `${solicitacao.cliente_nome || "Cliente"} — ${solicitacao.plano_nome || "Plano"} (${formatarPrecoPlano(solicitacao.plano_preco_centavos)})`;
  document.getElementById("aprovar-assinatura-msg").className = "msg";
  document.getElementById("modal-aprovar-assinatura").classList.add("show");
}

document
  .getElementById("btn-cancelar-aprovacao-assinatura")
  ?.addEventListener("click", fecharAprovacaoAssinatura);

document
  .getElementById("btn-confirmar-aprovacao-assinatura")
  ?.addEventListener("click", async (evento) => {
    const solicitacao = solicitacaoAssinaturaParaAprovar;
    if (!solicitacao || !auth.currentUser) return;
    const botao = evento.currentTarget;
    const mensagem = document.getElementById("aprovar-assinatura-msg");
    botao.disabled = true;
    botao.textContent = "Aprovando…";
    try {
      await executarComandoOperacional("admin.assinatura.aprovar", {
        data: { id: solicitacao.id },
      });
      fecharAprovacaoAssinatura();
      document.getElementById("solicitacoes-assinatura-feedback").textContent =
        "Assinatura ativada com créditos mensais criados.";
      await carregarSolicitacoesAssinatura({ atualizar: true });
    } catch (erro) {
      console.error("Falha ao aprovar solicitação de assinatura.", erro);
      mensagem.textContent =
        erro.message === "SOLICITACAO_INDISPONIVEL"
          ? "Esta solicitação já foi processada."
          : erro.message === "PLANO_SEM_CREDITOS"
            ? "Este plano não possui uma regra de créditos configurada."
            : "Não foi possível aprovar a solicitação.";
      mensagem.className = "msg show err";
    } finally {
      botao.disabled = false;
      botao.textContent = "Confirmar aprovação";
    }
  });

async function recusarSolicitacaoAssinatura(solicitacao) {
  if (
    !window.confirm(
      `Recusar a solicitação de ${solicitacao.cliente_nome || "cliente"}?`,
    )
  )
    return;
  const feedback = document.getElementById("solicitacoes-assinatura-feedback");
  try {
    await executarComandoOperacional("admin.assinatura.recusar", {
      data: { id: solicitacao.id },
    });
    feedback.textContent = "Solicitação recusada.";
    await carregarSolicitacoesAssinatura({ atualizar: true });
  } catch (erro) {
    console.error("Falha ao recusar solicitação de assinatura.", erro);
    feedback.textContent =
      erro.message === "SOLICITACAO_INDISPONIVEL"
        ? "Esta solicitação já foi processada."
        : "Não foi possível recusar a solicitação.";
  }
}

// ----------------------------------------------------------------------------
// Todos os agendamentos
// ----------------------------------------------------------------------------
function normalizarWhatsApp(numero) {
  const digitos = String(numero || "").replace(/\D/g, "");
  return /^55\d{10,11}$/.test(digitos) ? digitos : "";
}

function formatarWhatsApp(numero) {
  const whatsapp = normalizarWhatsApp(numero);
  if (!whatsapp) return "—";

  const local = whatsapp.slice(2);
  const ddd = local.slice(0, 2);
  const numeroLocal = local.slice(2);
  return numeroLocal.length === 9
    ? `(${ddd}) ${numeroLocal.slice(0, 5)}-${numeroLocal.slice(5)}`
    : `(${ddd}) ${numeroLocal.slice(0, 4)}-${numeroLocal.slice(4)}`;
}

function escaparHtml(valor) {
  return String(valor ?? "").replace(
    /[&<>"']/g,
    (caractere) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[caractere],
  );
}

function classeStatus(status) {
  if (status === "concluido") return "status-concluido";
  if (status === "cancelado") return "status-cancelado";
  if (status === "cliente_chegou") return "status-chegou";
  if (status === "em_atendimento") return "status-atendimento";
  if (status === "nao_compareceu") return "status-falta";
  return "status-agendado";
}

function rotuloStatus(status) {
  const rotulos = {
    agendado: "Agendado",
    cliente_chegou: "Cliente chegou",
    em_atendimento: "Em atendimento",
    concluido: "✓ Concluído",
    cancelado: "Cancelado",
    nao_compareceu: "Não compareceu",
  };
  return rotulos[status] || "Agendado";
}

function anunciarAtualizacaoAgenda(mensagem, variante = "success") {
  const feedback = document.getElementById("agenda-atualizada-feedback");
  if (!feedback) return;
  feedback.textContent = mensagem;
  feedback.className = `agenda-refresh-feedback${variante === "error" ? " is-error" : ""}`;
  clearTimeout(agendaFeedbackTimer);
  agendaFeedbackTimer = setTimeout(() => {
    if (feedback.textContent === mensagem) {
      feedback.textContent = "";
      feedback.className = "agenda-refresh-feedback";
    }
  }, 2500);
}

function acoesOperacionaisAgenda(agendamento) {
  if (
    !["agendado", "cliente_chegou", "em_atendimento"].includes(
      agendamento.status,
    )
  )
    return [];
  const actions = [];
  if (agendamento.status === "agendado") actions.push(["Cliente chegou", "data-chegada-agendamento"]);
  if (agendamento.status === "cliente_chegou") actions.push(["Iniciar atendimento", "data-iniciar-agendamento"]);
  if (agendamento.cliente_whatsapp) actions.push(["Enviar lembrete", "data-whatsapp"]);
  actions.push(["Concluir", "data-concluir-agendamento"]);
  actions.push(["Não compareceu", "data-falta-agendamento"]);
  actions.push(["Cancelar", "data-cancelar-agendamento"]);
  return actions.map(([label, attribute]) => ({ label, attribute, id: agendamento.id }));
}

window.adminAgendaActionDefinitions = acoesOperacionaisAgenda;

function acoesAgenda(agendamento) {
  const actions = acoesOperacionaisAgenda(agendamento);
  if (!actions.length) return "";
  const primary = actions.find((action) => ["data-iniciar-agendamento", "data-concluir-agendamento"].includes(action.attribute));
  const secondary = actions.filter((action) => action !== primary);
  const renderButton = (action, className = "btn btn-ghost btn-sm") =>
    `<button class="${className}" ${action.attribute}="${escaparHtml(action.attribute === "data-whatsapp" ? agendamento.cliente_whatsapp : agendamento.id)}">${escaparHtml(action.label === "Iniciar atendimento" ? "Iniciar" : action.label === "Enviar lembrete" ? "Lembrete" : action.label)}</button>`;
  return `<div class="agenda-actions">
    ${primary ? renderButton(primary, "btn btn-primary btn-sm") : ""}
    <details class="agenda-actions-menu"><summary aria-label="Mais ações">⋮</summary><div>
      ${secondary.map((action) => renderButton(action, action.attribute === "data-falta-agendamento" || action.attribute === "data-cancelar-agendamento" ? "btn btn-danger btn-sm" : "btn btn-ghost btn-sm")).join("")}
    </div></details>
  </div>`;
}

function conectarAcoesAgenda(elemento, agendamento) {
  elemento
    .querySelector("[data-whatsapp]")
    ?.addEventListener("click", () => abrirWhatsApp(agendamento));
  elemento
    .querySelector("[data-concluir-agendamento]")
    ?.addEventListener("click", (evento) =>
      concluirComConfirmacao(agendamento, evento.currentTarget),
    );
  elemento
    .querySelector("[data-chegada-agendamento]")
    ?.addEventListener("click", (evento) =>
      atualizarStatusOperacional(
        agendamento,
        "cliente_chegou",
        evento.currentTarget,
      ),
    );
  elemento
    .querySelector("[data-iniciar-agendamento]")
    ?.addEventListener("click", (evento) =>
      atualizarStatusOperacional(
        agendamento,
        "em_atendimento",
        evento.currentTarget,
      ),
    );
  elemento
    .querySelector("[data-falta-agendamento]")
    ?.addEventListener("click", (evento) =>
      marcarNaoCompareceu(agendamento, evento.currentTarget),
    );
  elemento
    .querySelector("[data-cancelar-agendamento]")
    ?.addEventListener("click", () =>
      cancelarAgendamentoAdmin(
        agendamento,
        elemento.querySelector("[data-cancelar-agendamento]"),
      ),
    );
}

function preencherFiltroBarbeiros() {
  const select = document.getElementById("agenda-filtro-barbeiro");
  if (!select) return;
  const atual = select.value;
  select.innerHTML = `<option value="">Todos os barbeiros</option>`;
  barbeirosCache.forEach((barbeiro) =>
    select.add(new Option(barbeiro.nome, barbeiro.id)),
  );
  select.value = atual;
}

function preencherFiltroServicos() {
  const select = document.getElementById("agenda-filtro-servico");
  if (!select) return;
  const atual = select.value;
  select.innerHTML = `<option value="">Todos os serviços</option>`;
  servicosCache.forEach((servico) =>
    select.add(new Option(servico.nome, servico.id)),
  );
  select.value = atual;
}

function isoSomarDias(base, dias) {
  const data = new Date(`${base}T12:00:00`);
  data.setDate(data.getDate() + dias);
  return `${data.getFullYear()}-${String(data.getMonth() + 1).padStart(2, "0")}-${String(data.getDate()).padStart(2, "0")}`;
}

function periodoAgenda() {
  if (agendaEstado.dataSelecionada) {
    return { inicio: agendaEstado.dataSelecionada, fim: agendaEstado.dataSelecionada };
  }
  const hoje = dataLocalHoje();
  if (agendaEstado.periodo === "hoje") return { inicio: hoje, fim: hoje };
  if (agendaEstado.periodo === "amanha") {
    const amanha = isoSomarDias(hoje, 1);
    return { inicio: amanha, fim: amanha };
  }
  if (agendaEstado.periodo === "semana") {
    const dia = new Date(`${hoje}T12:00:00`).getDay();
    return {
      inicio: isoSomarDias(hoje, dia === 0 ? -6 : 1 - dia),
      fim: isoSomarDias(hoje, dia === 0 ? 0 : 7 - dia),
    };
  }
  if (agendaEstado.periodo === "mes")
    return { inicio: `${hoje.slice(0, 7)}-01`, fim: `${hoje.slice(0, 7)}-31` };
  return null;
}

function aplicarEstadoAgenda() {
  document
    .querySelectorAll("[data-periodo]")
    .forEach((botao) =>
      botao.classList.toggle(
        "active",
        botao.dataset.periodo === agendaEstado.periodo,
      ),
    );
  document.getElementById("agenda-filtro-barbeiro").value =
    agendaEstado.barbeiro;
  document.getElementById("agenda-filtro-status").value = agendaEstado.status;
  document.getElementById("agenda-filtro-servico").value = agendaEstado.servico;
  document.getElementById("agenda-busca").value = agendaEstado.busca;
  document.getElementById("agenda-ordenacao").value = agendaEstado.ordenacao;
  document.getElementById("agenda-tamanho-pagina").value = String(
    agendaEstado.tamanho,
  );
  document.getElementById("agenda-limpar-filtros").hidden = !(
    agendaEstado.periodo !== "todos" ||
    agendaEstado.barbeiro ||
    agendaEstado.status ||
    agendaEstado.servico ||
    agendaEstado.busca ||
    agendaEstado.ordenacao !== "proximos"
  );
}

async function carregarAgenda() {
  const body = document.getElementById("admin-agenda-body");
  const cards = document.getElementById("admin-agenda-cards");
  aplicarEstadoAgenda();
  body.innerHTML = `<tr><td colspan="7" style="color:var(--cinza)">Carregando agendamentos…</td></tr>`;
  cards.innerHTML = "";
  const periodo = periodoAgenda();
  const restricoes = [collection(db, "agendamentos")];
  if (periodo)
    restricoes.push(
      where("data", ">=", periodo.inicio),
      where("data", "<=", periodo.fim),
    );
  restricoes.push(orderBy("data", "desc"));
  const snap = await getDocs(query(...restricoes));

  if (snap.empty) {
    if (!periodo) {
      agendaTodosCache = [];
      agendaTodosCachePronto = true;
      publicarDadosClientes();
    }
    body.innerHTML = `<tr><td colspan="7" style="color:var(--cinza)">Nenhum agendamento ainda.</td></tr>`;
    cards.innerHTML = `<div class="empty-state"><h3>Nenhum agendamento ainda</h3></div>`;
    document.getElementById("agenda-contador").textContent =
      "0 agendamentos encontrados";
    document.getElementById("agenda-pagina").textContent = "Página 1 de 1";
    document.getElementById("agenda-anterior").disabled = true;
    document.getElementById("agenda-proxima").disabled = true;
    window.dispatchEvent(
      new CustomEvent("admin:agenda-rendered", {
        detail: {
          appointments: [],
          allAppointments: [],
          actionsByAppointment: {},
          date: agendaEstado.dataSelecionada || (agendaEstado.periodo === "hoje" ? dataLocalHoje() : ""),
        },
      }),
    );
    return;
  }

  body.innerHTML = "";
  cards.innerHTML = "";
  const agendamentos = await Promise.all(
    snap.docs.map(async (docSnap) => {
      const a = docSnap.data();
      let nomeCliente = a.cliente_nome || "";
      // Agendamentos antigos podem não ter o número copiado no documento.
      // Busca o WhatsApp salvo no cadastro para que o painel continue exibindo-o.
      let whatsapp = normalizarWhatsApp(a.cliente_whatsapp);
      if (a.cliente_id) {
        try {
          const clienteSnap = await getDoc(doc(db, "clientes", a.cliente_id));
          if (clienteSnap.exists()) {
            const cliente = clienteSnap.data();
            nomeCliente = cliente.nome || cliente.displayName || nomeCliente;
            whatsapp =
              normalizarWhatsApp(
                cliente.telefone || cliente.whatsapp || cliente.celular,
              ) || whatsapp;
          }
        } catch (err) {
          console.warn("Não foi possível obter o cadastro do cliente.", err);
        }
      }

      // A tela só usa os dados atuais para exibição. A correção histórica de
      // nomes/telefones é feita por rotina administrativa no servidor, nunca
      // por uma leitura do navegador.
      return {
        id: docSnap.id,
        ...a,
        cliente_nome: nomeCliente,
        cliente_whatsapp: whatsapp,
      };
    }),
  );

  if (!periodo) {
    agendaTodosCache = agendamentos;
    agendaTodosCachePronto = true;
    publicarDadosClientes();
  }

  const busca = agendaEstado.busca.trim().toLocaleLowerCase("pt-BR");
  const filtrados = agendamentos.filter((a) => {
    if (agendaEstado.barbeiro && a.barbeiro_id !== agendaEstado.barbeiro)
      return false;
    if (agendaEstado.status && a.status !== agendaEstado.status) return false;
    if (agendaEstado.servico && a.servico_id !== agendaEstado.servico)
      return false;
    if (!busca) return true;
    return [a.cliente_nome, a.cliente_whatsapp, a.cliente_email].some((valor) =>
      String(valor || "")
        .toLocaleLowerCase("pt-BR")
        .includes(busca),
    );
  });
  const agora = `${dataLocalHoje()}T${new Date().toTimeString().slice(0, 5)}`;
  filtrados.sort((a, b) => {
    const chaveA = `${a.data || ""}T${a.horario || "00:00"}`;
    const chaveB = `${b.data || ""}T${b.horario || "00:00"}`;
    if (agendaEstado.ordenacao === "antigos")
      return chaveA.localeCompare(chaveB);
    if (agendaEstado.ordenacao === "recentes")
      return chaveB.localeCompare(chaveA);
    if (agendaEstado.ordenacao === "horario")
      return (
        (a.horario || "").localeCompare(b.horario || "") ||
        chaveA.localeCompare(chaveB)
      );
    const futuroA = chaveA >= agora,
      futuroB = chaveB >= agora;
    if (futuroA !== futuroB) return futuroA ? -1 : 1;
    return futuroA
      ? chaveA.localeCompare(chaveB)
      : chaveB.localeCompare(chaveA);
  });
  const totalPaginas = Math.max(
    1,
    Math.ceil(filtrados.length / agendaEstado.tamanho),
  );
  agendaEstado.pagina = Math.min(agendaEstado.pagina, totalPaginas);
  const inicioPagina = (agendaEstado.pagina - 1) * agendaEstado.tamanho;
  const pagina = filtrados.slice(
    inicioPagina,
    inicioPagina + agendaEstado.tamanho,
  );
  window.dispatchEvent(
    new CustomEvent("admin:agenda-rendered", {
      detail: {
        appointments: filtrados,
        allAppointments: agendamentos,
        actionsByAppointment: Object.fromEntries(
          agendamentos.map((appointment) => [appointment.id, acoesOperacionaisAgenda(appointment)]),
        ),
        date: agendaEstado.dataSelecionada || (agendaEstado.periodo === "hoje" ? dataLocalHoje() : ""),
      },
    }),
  );
  document.getElementById("agenda-contador").textContent =
    `${filtrados.length} agendamento${filtrados.length === 1 ? "" : "s"} encontrado${filtrados.length === 1 ? "" : "s"}`;
  document.getElementById("agenda-pagina").textContent =
    `Página ${agendaEstado.pagina} de ${totalPaginas}`;
  document.getElementById("agenda-anterior").disabled =
    agendaEstado.pagina === 1;
  document.getElementById("agenda-proxima").disabled =
    agendaEstado.pagina === totalPaginas;
  if (!pagina.length) {
    body.innerHTML = `<tr><td colspan="7"><div class="empty-state"><h3>Nenhum agendamento encontrado</h3><p>Tente alterar os filtros ou crie um novo agendamento.</p></div></td></tr>`;
    cards.innerHTML = `<div class="empty-state"><h3>Nenhum agendamento encontrado</h3><p>Tente alterar os filtros ou crie um novo agendamento.</p></div>`;
    return;
  }
  body.innerHTML = "";
  cards.innerHTML = "";
  pagina.forEach((a) => {
    const tr = document.createElement("tr");
    tr.dataset.agendaId = a.id;
    tr.innerHTML = `
      <td><div class="agenda-date">${escaparHtml(formatarData(a.data))}<span>${escaparHtml(a.horario)}</span></div></td>
      <td class="agenda-client" title="${escaparHtml(a.cliente_nome)}">${escaparHtml(a.cliente_nome || "—")}</td>
      <td>${formatarWhatsApp(a.cliente_whatsapp)}</td>
      <td>${escaparHtml(a.barbeiro_nome || "—")}</td>
      <td class="agenda-service" title="${escaparHtml(a.servico_nome)}">${escaparHtml(a.servico_nome || "—")}</td>
      <td><span class="status-pill ${classeStatus(a.status)}">${rotuloStatus(a.status)}</span></td>
      <td>${acoesAgenda(a)}</td>
    `;
    body.appendChild(tr);
    conectarAcoesAgenda(tr, a);

    const card = document.createElement("article");
    card.className = "agenda-card";
    card.dataset.agendaId = a.id;
    card.innerHTML = `<div class="agenda-card-top"><div class="agenda-card-time">${escaparHtml(a.horario)}<span>${escaparHtml(formatarData(a.data))}</span></div><span class="status-pill ${classeStatus(a.status)}">${rotuloStatus(a.status)}</span></div>
      <div><h3>${escaparHtml(a.cliente_nome || "—")}</h3><span class="agenda-card-phone">${formatarWhatsApp(a.cliente_whatsapp)}</span></div>
      <div class="agenda-card-details"><div><strong>Barbeiro</strong><span>${escaparHtml(a.barbeiro_nome || "—")}</span></div><div><strong>Serviço</strong><span>${escaparHtml(a.servico_nome || "—")}</span></div></div>${acoesAgenda(a)}`;
    cards.appendChild(card);
    conectarAcoesAgenda(card, a);
  });
}

  document.querySelectorAll("[data-periodo]").forEach((botao) =>
    botao.addEventListener("click", () => {
      agendaEstado.periodo = botao.dataset.periodo;
      agendaEstado.dataSelecionada = "";
      agendaEstado.pagina = 1;
    carregarAgenda();
  }),
);
document
  .getElementById("btn-atualizar-agenda")
  ?.addEventListener("click", async (evento) => {
    const botao = evento.currentTarget;
    const feedback = document.getElementById("agenda-atualizada-feedback");
    botao.disabled = true;
    botao.textContent = "↻ Atualizando…";
    feedback.textContent = "";
    try {
      // Reutiliza a mesma consulta, preservando todos os filtros e paginação.
      await carregarAgenda();
      feedback.textContent = "Agenda atualizada.";
      setTimeout(() => {
        if (feedback.textContent === "Agenda atualizada.")
          feedback.textContent = "";
      }, 2500);
    } catch (err) {
      console.error("Falha ao atualizar agenda.", err);
      feedback.textContent = "Não foi possível atualizar a agenda.";
    } finally {
      botao.disabled = false;
      botao.textContent = "↻ Atualizar";
    }
  });
[
  ["agenda-filtro-barbeiro", "barbeiro"],
  ["agenda-filtro-status", "status"],
  ["agenda-filtro-servico", "servico"],
  ["agenda-ordenacao", "ordenacao"],
  ["agenda-tamanho-pagina", "tamanho"],
].forEach(([id, propriedade]) =>
  document.getElementById(id)?.addEventListener("change", (evento) => {
    agendaEstado[propriedade] =
      propriedade === "tamanho"
        ? Number(evento.target.value)
        : evento.target.value;
    agendaEstado.pagina = 1;
    carregarAgenda();
  }),
);
document.getElementById("agenda-busca")?.addEventListener("input", (evento) => {
  clearTimeout(buscaAgendaTimer);
  buscaAgendaTimer = setTimeout(() => {
    agendaEstado.busca = evento.target.value;
    agendaEstado.pagina = 1;
    carregarAgenda();
  }, 350);
});
document
  .getElementById("agenda-limpar-filtros")
  ?.addEventListener("click", () => {
    Object.assign(agendaEstado, {
      periodo: "todos",
      dataSelecionada: "",
      barbeiro: "",
      status: "",
      servico: "",
      busca: "",
      ordenacao: "proximos",
      pagina: 1,
    });
    carregarAgenda();
  });
document.getElementById("agenda-anterior")?.addEventListener("click", () => {
  if (agendaEstado.pagina > 1) {
    agendaEstado.pagina--;
    carregarAgenda();
  }
});
document.getElementById("agenda-proxima")?.addEventListener("click", () => {
  agendaEstado.pagina++;
  carregarAgenda();
});

function detalhesAgendamentoOperacional(agendamento) {
  return `
    <div><dt>Cliente</dt><dd>${escaparHtml(agendamento.cliente_nome || "—")}</dd></div>
    <div><dt>Barbeiro</dt><dd>${escaparHtml(agendamento.barbeiro_nome || "—")}</dd></div>
    <div><dt>Serviço</dt><dd>${escaparHtml(agendamento.servico_nome || "—")}</dd></div>
    <div><dt>Data e horário</dt><dd>${escaparHtml(formatarData(agendamento.data))} às ${escaparHtml(agendamento.horario || "—")}</dd></div>`;
}

function fecharModalOperacional(confirmado = false) {
  const backdrop = document.getElementById("modal-operacional-confirmacao");
  const modal = backdrop?.querySelector("[role=dialog]");
  if (!backdrop) return;
  backdrop.classList.remove("show");
  modal?.classList.remove("modal-operational--warning", "modal-operational--destructive");
  const resolver = operationalModalState.resolve;
  const previousFocus = operationalModalState.previousFocus;
  operationalModalState.resolve = null;
  operationalModalState.previousFocus = null;
  resolver?.(confirmado);
  if (previousFocus && typeof previousFocus.focus === "function") {
    window.requestAnimationFrame(() => previousFocus.focus());
  }
}

function abrirModalOperacional({ type, title, description, appointment, confirmLabel, variant = "primary" }) {
  const backdrop = document.getElementById("modal-operacional-confirmacao");
  const modal = backdrop?.querySelector("[role=dialog]");
  const eyebrow = document.getElementById("operational-modal-eyebrow");
  const titleElement = document.getElementById("operational-modal-title");
  const descriptionElement = document.getElementById("operational-modal-description");
  const details = document.getElementById("operational-modal-details");
  const confirmButton = document.getElementById("btn-operational-confirm");
  if (!backdrop || !modal || !eyebrow || !titleElement || !descriptionElement || !details || !confirmButton) return Promise.resolve(false);

  operationalModalState.previousFocus = document.activeElement;
  eyebrow.textContent = type;
  titleElement.textContent = title;
  descriptionElement.textContent = description;
  details.innerHTML = detalhesAgendamentoOperacional(appointment);
  confirmButton.textContent = confirmLabel;
  confirmButton.disabled = false;
  modal.classList.remove("modal-operational--warning", "modal-operational--destructive");
  if (variant === "warning" || variant === "destructive") modal.classList.add(`modal-operational--${variant}`);
  backdrop.classList.add("show");
  window.requestAnimationFrame(() => confirmButton.focus());
  return new Promise((resolve) => { operationalModalState.resolve = resolve; });
}

document.getElementById("btn-operational-cancel")?.addEventListener("click", () => fecharModalOperacional(false));
document.getElementById("btn-operational-confirm")?.addEventListener("click", () => {
  const button = document.getElementById("btn-operational-confirm");
  if (!button || button.disabled) return;
  button.disabled = true;
  button.textContent = "Processando…";
  fecharModalOperacional(true);
});
document.getElementById("modal-operacional-confirmacao")?.addEventListener("click", (event) => {
  if (event.target === event.currentTarget) fecharModalOperacional(false);
});
document.addEventListener("keydown", (event) => {
  const backdrop = document.getElementById("modal-operacional-confirmacao");
  if (event.key === "Escape" && backdrop?.classList.contains("show")) {
    event.preventDefault();
    fecharModalOperacional(false);
  }
});

async function concluirComConfirmacao(agendamento, sourceButton) {
  const confirmado = await abrirModalOperacional({
    type: "Confirmar presença",
    title: "Concluir atendimento?",
    description: "Confirme que o cliente compareceu e o atendimento foi realizado.",
    appointment: agendamento,
    confirmLabel: "Confirmar conclusão",
  });
  if (!confirmado) return;
  const textoOriginal = sourceButton?.textContent || "";
  if (sourceButton) { sourceButton.disabled = true; sourceButton.textContent = "Concluindo…"; }
  try {
    await concluirAgendamento(db, agendamento, { validarDuplicidade: true });
    await carregarAgenda();
    await carregarRelatorio();
    anunciarAtualizacaoAgenda("Atendimento concluído.");
  } catch (err) {
    const texto = err.message === "CREDITO_INDISPONIVEL"
      ? "Não há crédito disponível nesta assinatura para concluir este atendimento."
      : err.message === "ASSINATURA_SEM_VINCULO"
        ? "Este agendamento de assinatura não possui vínculo de crédito válido."
        : "Não foi possível concluir o atendimento. Tente novamente.";
    anunciarAtualizacaoAgenda(texto, "error");
    console.error(err);
  } finally {
    if (sourceButton) { sourceButton.disabled = false; sourceButton.textContent = textoOriginal; }
  }
}

function abrirWhatsApp(agendamento) {
  abrirWhatsAppLembrete(agendamento);
}

async function cancelarAgendamentoAdmin(agendamento, btn) {
  const confirmado = await abrirModalOperacional({
    type: "Ação destrutiva",
    title: "Cancelar agendamento",
    description: "Confirme o cancelamento do agendamento selecionado.",
    appointment: agendamento,
    confirmLabel: "Cancelar agendamento",
    variant: "destructive",
  });
  if (!confirmado) return;
  btn.disabled = true;
  try {
    await cancelarReserva(db, agendamento);
    abrirWhatsAppCancelamento(agendamento);
    await carregarAgenda();
    await carregarRelatorio();
    anunciarAtualizacaoAgenda("Agendamento cancelado.");
  } catch (err) {
    anunciarAtualizacaoAgenda("Não foi possível cancelar o agendamento. Tente novamente.", "error");
    btn.disabled = false;
  }
}

async function atualizarStatusOperacional(agendamento, status, btn) {
  const mensagens = {
    cliente_chegou: {
      type: "Confirmar chegada",
      title: "Cliente chegou?",
      description: "Confirme que o cliente chegou ao estabelecimento.",
      confirmLabel: "Confirmar chegada",
    },
    em_atendimento: {
      type: "Atendimento",
      title: "Iniciar atendimento?",
      description: "Confirme o início do atendimento deste cliente.",
      confirmLabel: "Iniciar atendimento",
    },
  };
  const confirmado = await abrirModalOperacional({ ...mensagens[status], appointment: agendamento });
  if (!confirmado) return;
  const textoOriginal = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Atualizando…";
  }
  try {
    await executarComandoOperacional(`agenda.${status}`, {
      data: { appointmentId: agendamento.id },
    });
    await carregarAgenda();
    anunciarAtualizacaoAgenda("Status atualizado.");
  } catch (err) {
    anunciarAtualizacaoAgenda(
      err.code === "permission-denied"
        ? "Você não possui permissão para alterar este atendimento."
        : "Não foi possível atualizar o atendimento.",
      "error",
    );
    console.error("Falha ao atualizar status operacional.", err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }
}

async function marcarNaoCompareceu(agendamento, btn) {
  const avisoAssinatura =
    agendamento.origem === "assinatura"
      ? " Como é um atendimento por assinatura, 1 crédito será consumido."
      : "";
  const confirmado = await abrirModalOperacional({
    type: "Atenção",
    title: "Cliente não compareceu?",
    description: `Confirme que o cliente não compareceu ao horário agendado.${avisoAssinatura}`,
    appointment: agendamento,
    confirmLabel: "Confirmar ausência",
    variant: "warning",
  });
  if (!confirmado) return;
  const textoOriginal = btn?.textContent || "";
  if (btn) {
    btn.disabled = true;
    btn.textContent = "Atualizando…";
  }
  try {
    await marcarNaoComparecimento(db, agendamento, {
      validarDuplicidade: true,
    });
    await carregarAgenda();
    await carregarRelatorio();
    anunciarAtualizacaoAgenda("Agendamento atualizado.");
  } catch (err) {
    anunciarAtualizacaoAgenda(
      err.message === "CREDITO_INDISPONIVEL"
        ? "Não há crédito disponível nesta assinatura."
        : err.code === "permission-denied"
          ? "Você não possui permissão para alterar este atendimento."
          : "Não foi possível marcar a falta.",
      "error",
    );
    console.error("Falha ao marcar não compareceu.", err);
  } finally {
    if (btn) {
      btn.disabled = false;
      btn.textContent = textoOriginal;
    }
  }
}

window.addEventListener("admin:pending-action", (event) => {
  const appointment = event.detail?.appointment;
  const action = event.detail?.action?.attribute;
  const button = event.detail?.button;
  if (!appointment || !action) return;
  if (action === "data-whatsapp") return abrirWhatsApp(appointment);
  if (action === "data-chegada-agendamento") return atualizarStatusOperacional(appointment, "cliente_chegou", button);
  if (action === "data-iniciar-agendamento") return atualizarStatusOperacional(appointment, "em_atendimento", button);
  if (action === "data-concluir-agendamento") return concluirComConfirmacao(appointment, button);
  if (action === "data-falta-agendamento") return marcarNaoCompareceu(appointment, button);
  if (action === "data-cancelar-agendamento") return cancelarAgendamentoAdmin(appointment, button);
});

function abrirWhatsAppCancelamento(agendamento) {
  const numero = String(agendamento.cliente_whatsapp || "").replace(/\D/g, "");
  if (!numero) return;

  const mensagem = `Olá, ${agendamento.cliente_nome || "cliente"}. Seu horário na Barbearia Antunes em ${formatarData(agendamento.data)} às ${agendamento.horario}, com ${agendamento.barbeiro_nome || "o barbeiro"}, foi cancelado. Para remarcar, fale conosco ou faça um novo agendamento pelo site.`;
  window.open(
    `https://wa.me/${numero}?text=${encodeURIComponent(mensagem)}`,
    "_blank",
    "noopener",
  );
}

function formatarData(iso) {
  if (!iso) return "—";
  const [ano, mes, dia] = iso.split("-");
  return `${dia}/${mes}/${ano}`;
}

// ----------------------------------------------------------------------------
// Dashboard financeiro — usa exclusivamente os dados já persistidos no Firestore.
// ----------------------------------------------------------------------------

// Valores "sob consulta" ou "a partir de" não representam receita definida.
function parsePreco(str) {
  if (!str) return null;
  if (/consult|a\s+partir/i.test(String(str))) return null;
  const m = String(str).match(/(\d+(?:[.,]\d{1,2})?)/);
  if (!m) return null;
  return parseFloat(m[1].replace(",", "."));
}

function formatarMoeda(n) {
  return n.toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function limitesMesAtual() {
  const hoje = dataLocalHoje();
  const inicio = `${hoje.slice(0, 7)}-01`;
  const fim = isoSomarDias(`${hoje.slice(0, 7)}-01`, 32).slice(0, 7) + "-01";
  return { inicio, fim: isoSomarDias(fim, -1) };
}

const inputRelatorioInicio = document.getElementById("relatorio-data-inicio");
const inputRelatorioFim = document.getElementById("relatorio-data-fim");
const inputRelatorioBarbeiro = document.getElementById("relatorio-barbeiro");
const inputRelatorioStatus = document.getElementById("relatorio-status");
let dadosGraficoFinanceiro = [];
let desenhoFinanceiroAgendado = null;

if (inputRelatorioInicio && inputRelatorioFim) {
  const periodo = limitesMesAtual();
  inputRelatorioInicio.value = periodo.inicio;
  inputRelatorioFim.value = periodo.fim;
}

document
  .getElementById("btn-atualizar-relatorio")
  ?.addEventListener("click", carregarRelatorio);
window.addEventListener("resize", () => {
  window.clearTimeout(desenhoFinanceiroAgendado);
  desenhoFinanceiroAgendado = window.setTimeout(
    () => desenharGraficoFinanceiro(dadosGraficoFinanceiro),
    120,
  );
});

function preencherFiltroRelatorioBarbeiros(barbeiros) {
  if (!inputRelatorioBarbeiro) return;
  const selecionado = inputRelatorioBarbeiro.value;
  inputRelatorioBarbeiro.innerHTML =
    '<option value="">Todos os barbeiros</option>';
  barbeiros
    .sort((a, b) => String(a.nome || "").localeCompare(String(b.nome || "")))
    .forEach((barbeiro) => {
      inputRelatorioBarbeiro.add(
        new Option(barbeiro.nome || "Sem nome", barbeiro.id),
      );
    });
  inputRelatorioBarbeiro.value = selecionado;
}

function valorDoAgendamento(agendamento, precoPorServico) {
  return (
    parsePreco(agendamento.servico_preco) ??
    precoPorServico[agendamento.servico_id] ??
    null
  );
}

function agendamentoFuturoValido(agendamento, agora = new Date()) {
  if (
    !["agendado", "cliente_chegou", "em_atendimento"].includes(
      agendamento.status,
    )
  )
    return false;
  const dataHora = new Date(
    `${agendamento.data || ""}T${agendamento.horario || "00:00"}`,
  );
  return !Number.isNaN(dataHora.getTime()) && dataHora > agora;
}

function datasDoIntervalo(inicio, fim) {
  const resultado = [];
  for (let data = inicio; data <= fim; data = isoSomarDias(data, 1))
    resultado.push(data);
  return resultado;
}

function periodoAnteriorDoDashboard(inicio, fim) {
  const duracao = datasDoIntervalo(inicio, fim).length;
  return {
    inicio: isoSomarDias(inicio, -duracao),
    fim: isoSomarDias(inicio, -1),
  };
}

function resumoFinanceiro(agendamentos, precoPorServico) {
  const concluidos = agendamentos.filter((item) => item.status === "concluido");
  const futuros = agendamentos.filter((item) => agendamentoFuturoValido(item));
  const concluidosComPreco = concluidos.filter(
    (item) => valorDoAgendamento(item, precoPorServico) !== null,
  );
  const realizado = concluidos.reduce(
    (total, item) => total + (valorDoAgendamento(item, precoPorServico) || 0),
    0,
  );
  const previsto = futuros.reduce(
    (total, item) => total + (valorDoAgendamento(item, precoPorServico) || 0),
    0,
  );
  return {
    concluidos,
    futuros,
    concluidosComPreco,
    realizado,
    previsto,
    ticketMedio: concluidosComPreco.length
      ? realizado / concluidosComPreco.length
      : 0,
    cancelados: agendamentos.filter((item) => item.status === "cancelado")
      .length,
    faltas: agendamentos.filter((item) => item.status === "nao_compareceu")
      .length,
  };
}

function comparacaoFinanceira(atual, anterior, disponivel = true) {
  if (!disponivel)
    return '<span class="finance-comparison neutral">Não comparável</span>';
  if (anterior === 0 && atual === 0)
    return '<span class="finance-comparison neutral">Sem variação vs. anterior</span>';
  if (anterior === 0)
    return '<span class="finance-comparison positive">Novo no período</span>';
  const percentual = ((atual - anterior) / anterior) * 100;
  if (percentual === 0)
    return '<span class="finance-comparison neutral">0% vs. período anterior</span>';
  const sinal = percentual > 0 ? "+" : "−";
  const classe = percentual > 0 ? "positive" : "negative";
  return `<span class="finance-comparison ${classe}">${sinal}${Math.abs(percentual).toLocaleString("pt-BR", { maximumFractionDigits: 1 })}% vs. período anterior</span>`;
}

function cardFinanceiro(rotulo, valor, detalhe, comparacao) {
  return `<article class="finance-metric"><span class="rotulo">${rotulo}</span><strong class="valor">${valor}</strong><span class="detalhe">${detalhe}</span>${comparacao}</article>`;
}

function diaFechadoNoDashboard(data, semanal, fechamentos) {
  if (fechamentos.has(data)) return true;
  const dia = new Date(`${data}T12:00:00`).getDay();
  return semanal[dia] === true || (semanal[dia] === undefined && dia === 0);
}

function calcularOcupacaoFutura({
  inicio,
  fim,
  barbeiros,
  agendamentos,
  bloqueios,
  semanal,
  fechamentos,
}) {
  const hoje = dataLocalHoje();
  if (
    fim < hoje ||
    !barbeiros.length ||
    barbeiros.some((barbeiro) => barbeiro.ativo === false)
  )
    return null;
  const datasFechadas = new Set(
    fechamentos.filter((item) => item.ativo !== false).map((item) => item.data),
  );
  const agora = new Date();
  const minutosAgora = agora.getHours() * 60 + agora.getMinutes();
  const capacidade = new Set();
  const bloqueados = new Set();
  const ocupados = new Set();
  const ids = new Set(barbeiros.map((barbeiro) => barbeiro.id));

  datasDoIntervalo(inicio < hoje ? hoje : inicio, fim).forEach((data) => {
    if (diaFechadoNoDashboard(data, semanal, datasFechadas)) return;
    barbeiros.forEach((barbeiro) =>
      horariosCandidatos(barbeiro, data, 30).forEach((horario) => {
        const [hora, minuto] = horario.split(":").map(Number);
        if (data === hoje && hora * 60 + minuto <= minutosAgora) return;
        capacidade.add(`${barbeiro.id}|${data}|${horario}`);
      }),
    );
  });

  bloqueios
    .filter((bloqueio) => ids.has(bloqueio.barbeiro_id))
    .forEach((bloqueio) => {
      blocosDoAtendimento(bloqueio.inicio, bloqueio.duracao || 30).forEach(
        (horario) =>
          bloqueados.add(`${bloqueio.barbeiro_id}|${bloqueio.data}|${horario}`),
      );
    });
  agendamentos
    .filter(
      (agendamento) =>
        ids.has(agendamento.barbeiro_id) &&
        agendamentoFuturoValido(agendamento, agora),
    )
    .forEach((agendamento) => {
      blocosDoAtendimento(
        agendamento.horario,
        agendamento.duracao || 30,
      ).forEach((horario) =>
        ocupados.add(
          `${agendamento.barbeiro_id}|${agendamento.data}|${horario}`,
        ),
      );
    });

  bloqueados.forEach((slot) => capacidade.delete(slot));
  const utilizados = [...ocupados].filter((slot) =>
    capacidade.has(slot),
  ).length;
  return capacidade.size
    ? {
        percentual: Math.round((utilizados / capacidade.size) * 100),
        utilizados,
        capacidade: capacidade.size,
      }
    : null;
}

function desenharGraficoFinanceiro(serie = []) {
  const canvas = document.getElementById("finance-revenue-chart");
  const vazio = document.getElementById("finance-chart-empty");
  const nota = document.getElementById("finance-chart-note");
  if (!canvas || !vazio || !nota) return;
  const temDados = serie.some(
    (item) => item.realizado > 0 || item.previsto > 0,
  );
  vazio.hidden = temDados;
  canvas.hidden = !temDados;
  if (temDados) {
    const realizado = serie.reduce((total, item) => total + item.realizado, 0);
    const previsto = serie.reduce((total, item) => total + item.previsto, 0);
    nota.textContent = `${formatarMoeda(realizado)} realizado · ${formatarMoeda(previsto)} previsto`;
  } else {
    nota.textContent = "";
  }
  if (!temDados) return;

  const largura = Math.max(canvas.clientWidth, 240);
  const altura = Math.max(canvas.clientHeight, 210);
  const escala = window.devicePixelRatio || 1;
  canvas.width = Math.round(largura * escala);
  canvas.height = Math.round(altura * escala);
  const contexto = canvas.getContext("2d");
  contexto.setTransform(escala, 0, 0, escala, 0, 0);
  contexto.clearRect(0, 0, largura, altura);
  const margem = { superior: 15, direita: 8, inferior: 30, esquerda: 8 };
  const areaAltura = altura - margem.superior - margem.inferior;
  const maximo = Math.max(
    ...serie.flatMap((item) => [item.realizado, item.previsto]),
    1,
  );
  const passo = (largura - margem.esquerda - margem.direita) / serie.length;
  const larguraGrupo = Math.max(7, Math.min(42, passo - 3));
  const larguraBarra = Math.max(2, (larguraGrupo - 3) / 2);

  contexto.strokeStyle = "rgba(231,233,231,.12)";
  contexto.lineWidth = 1;
  for (let linha = 0; linha < 3; linha += 1) {
    const y = margem.superior + (areaAltura / 2) * linha;
    contexto.beginPath();
    contexto.moveTo(margem.esquerda, y);
    contexto.lineTo(largura - margem.direita, y);
    contexto.stroke();
  }
  serie.forEach((item, indice) => {
    const x = margem.esquerda + indice * passo + (passo - larguraGrupo) / 2;
    const desenharBarra = (valor, deslocamento, cor) => {
      if (!valor) return;
      const alturaBarra = (valor / maximo) * areaAltura;
      const y = margem.superior + areaAltura - alturaBarra;
      contexto.fillStyle = cor;
      contexto.fillRect(
        x + deslocamento,
        y,
        larguraBarra,
        Math.max(2, alturaBarra),
      );
    };
    const gradiente = contexto.createLinearGradient(
      0,
      margem.superior,
      0,
      margem.superior + areaAltura,
    );
    gradiente.addColorStop(0, "#35B779");
    gradiente.addColorStop(1, "#064E3B");
    desenharBarra(item.realizado, 0, gradiente);
    desenharBarra(item.previsto, larguraBarra + 3, "rgba(231,233,231,.46)");
  });
  contexto.fillStyle = "#9A9F9C";
  contexto.font = "10px DM Sans, Inter, sans-serif";
  contexto.textAlign = "center";
  const passoRotulo = Math.max(1, Math.ceil(serie.length / 6));
  serie.forEach((item, indice) => {
    if (indice % passoRotulo !== 0 && indice !== serie.length - 1) return;
    contexto.fillText(
      item.data.slice(8, 10) + "/" + item.data.slice(5, 7),
      margem.esquerda + indice * passo + passo / 2,
      altura - 9,
    );
  });
}

async function carregarRelatorio() {
  const inicio = inputRelatorioInicio?.value;
  const fim = inputRelatorioFim?.value;
  const feedback = document.getElementById("relatorio-feedback");
  const resumoEl = document.getElementById("relatorio-resumo");
  const desempenhoEl = document.getElementById("relatorio-body");
  const rankingEl = document.getElementById("finance-service-ranking");
  const operacionalEl = document.getElementById("finance-operational");
  if (!inicio || !fim || inicio > fim) {
    feedback.textContent = "Informe um período de datas válido.";
    return;
  }
  resumoEl.innerHTML =
    '<div class="finance-metric"><span class="rotulo">Carregando dados…</span></div>';
  desempenhoEl.innerHTML = rankingEl.innerHTML = operacionalEl.innerHTML = "";
  feedback.textContent = "Atualizando dados financeiros…";
  const periodoAnterior = periodoAnteriorDoDashboard(inicio, fim);

  try {
    const [
      agendamentosSnap,
      agendamentosAnterioresSnap,
      servicosSnap,
      barbeirosSnap,
      configSnap,
      fechamentosSnap,
      bloqueiosSnap,
    ] = await Promise.all([
      getDocs(
        query(
          collection(db, "agendamentos"),
          where("data", ">=", inicio),
          where("data", "<=", fim),
        ),
      ),
      getDocs(
        query(
          collection(db, "agendamentos"),
          where("data", ">=", periodoAnterior.inicio),
          where("data", "<=", periodoAnterior.fim),
        ),
      ),
      getDocs(collection(db, "servicos")),
      getDocs(collection(db, "barbeiros")),
      getDoc(funcionamentoRef),
      getDocs(
        query(
          collection(db, "fechamentos_globais"),
          where("data", ">=", inicio),
          where("data", "<=", fim),
        ),
      ),
      getDocs(
        query(
          collection(db, "bloqueios"),
          where("data", ">=", inicio),
          where("data", "<=", fim),
        ),
      ),
    ]);
    const servicos = Object.fromEntries(
      servicosSnap.docs.map((item) => [item.id, parsePreco(item.data().preco)]),
    );
    const barbeiros = barbeirosSnap.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    preencherFiltroRelatorioBarbeiros(barbeiros);
    const barbeiroId = inputRelatorioBarbeiro?.value || "";
    const statusFiltro = inputRelatorioStatus?.value || "";
    const aplicarFiltros = (itens) =>
      itens.filter(
        (item) =>
          (!barbeiroId || item.barbeiro_id === barbeiroId) &&
          (!statusFiltro || item.status === statusFiltro),
      );
    const agendamentos = aplicarFiltros(
      agendamentosSnap.docs.map((item) => ({ id: item.id, ...item.data() })),
    );
    const agendamentosAnteriores = aplicarFiltros(
      agendamentosAnterioresSnap.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      })),
    );
    const atual = resumoFinanceiro(agendamentos, servicos);
    const anterior = resumoFinanceiro(agendamentosAnteriores, servicos);
    const previsaoAnteriorComparavel =
      periodoAnterior.inicio >= dataLocalHoje();
    const porDia = new Map(
      datasDoIntervalo(inicio, fim).map((data) => [
        data,
        { realizado: 0, previsto: 0 },
      ]),
    );
    atual.concluidos.forEach((item) => {
      const dado = porDia.get(item.data);
      if (dado) dado.realizado += valorDoAgendamento(item, servicos) || 0;
    });
    atual.futuros.forEach((item) => {
      const dado = porDia.get(item.data);
      if (dado) dado.previsto += valorDoAgendamento(item, servicos) || 0;
    });
    dadosGraficoFinanceiro = [...porDia].map(([data, valores]) => ({
      data,
      ...valores,
    }));

    resumoEl.innerHTML = `
      ${cardFinanceiro("Faturamento realizado", formatarMoeda(atual.realizado), `${atual.concluidos.length} atendimento(s) concluído(s)`, comparacaoFinanceira(atual.realizado, anterior.realizado))}
      ${cardFinanceiro("Faturamento previsto", formatarMoeda(atual.previsto), `${atual.futuros.length} horário(s) futuro(s) válido(s)`, comparacaoFinanceira(atual.previsto, anterior.previsto, previsaoAnteriorComparavel))}
      ${cardFinanceiro("Atendimentos concluídos", atual.concluidos.length, "No período e filtros selecionados", comparacaoFinanceira(atual.concluidos.length, anterior.concluidos.length))}
      ${cardFinanceiro("Ticket médio", formatarMoeda(atual.ticketMedio), `${atual.concluidosComPreco.length} atendimento(s) com preço fixo`, comparacaoFinanceira(atual.ticketMedio, anterior.ticketMedio))}
      ${cardFinanceiro("Cancelamentos", atual.cancelados, "No período e filtros selecionados", comparacaoFinanceira(atual.cancelados, anterior.cancelados))}
      ${cardFinanceiro("Não comparecimentos", atual.faltas, "No período e filtros selecionados", comparacaoFinanceira(atual.faltas, anterior.faltas))}`;

    const desempenho = new Map();
    barbeiros
      .filter((barbeiro) => !barbeiroId || barbeiro.id === barbeiroId)
      .forEach((barbeiro) =>
        desempenho.set(barbeiro.id, {
          nome: barbeiro.nome || "Sem nome",
          concluidos: 0,
          comPreco: 0,
          receita: 0,
          futuros: 0,
        }),
      );
    agendamentos.forEach((item) => {
      if (!desempenho.has(item.barbeiro_id))
        desempenho.set(item.barbeiro_id, {
          nome: item.barbeiro_nome || "Sem nome",
          concluidos: 0,
          comPreco: 0,
          receita: 0,
          futuros: 0,
        });
      const dado = desempenho.get(item.barbeiro_id);
      if (item.status === "concluido") {
        dado.concluidos += 1;
        dado.receita += valorDoAgendamento(item, servicos) || 0;
        if (valorDoAgendamento(item, servicos) !== null) dado.comPreco += 1;
      }
      if (agendamentoFuturoValido(item)) dado.futuros += 1;
    });
    const desempenhoOrdenado = [...desempenho.values()].sort(
      (a, b) =>
        b.receita - a.receita ||
        b.concluidos - a.concluidos ||
        a.nome.localeCompare(b.nome),
    );
    desempenhoEl.innerHTML = desempenhoOrdenado.length
      ? desempenhoOrdenado
          .map(
            (item) =>
              `<div class="finance-performance-item"><strong title="${escaparHtml(item.nome)}">${escaparHtml(item.nome)}</strong><span class="finance-money">${formatarMoeda(item.receita)}</span><small>${item.concluidos} concluído(s) · Ticket médio ${formatarMoeda(item.comPreco ? item.receita / item.comPreco : 0)}</small></div>`,
          )
          .join("")
      : '<p class="limit-note">Nenhum barbeiro encontrado.</p>';

    const servicosRanking = new Map();
    atual.concluidos.forEach((item) => {
      const chave = item.servico_id || item.servico_nome || "sem-servico";
      const dado = servicosRanking.get(chave) || {
        nome: item.servico_nome || "Serviço",
        quantidade: 0,
        receita: 0,
      };
      dado.quantidade += 1;
      dado.receita += valorDoAgendamento(item, servicos) || 0;
      servicosRanking.set(chave, dado);
    });
    const ranking = [...servicosRanking.values()]
      .sort((a, b) => b.quantidade - a.quantidade || b.receita - a.receita)
      .slice(0, 6);
    rankingEl.innerHTML = ranking.length
      ? ranking
          .map(
            (item) =>
              `<li><strong title="${escaparHtml(item.nome)}">${escaparHtml(item.nome)}</strong><span>${item.quantidade}x · ${formatarMoeda(item.receita)}</span></li>`,
          )
          .join("")
      : "<li><strong>Nenhum serviço concluído</strong><span>—</span></li>";

    const semanal = configSnap.exists()
      ? configSnap.data().dias_fechados_semana || {}
      : {};
    const fechamentosDoPeriodo = fechamentosSnap.docs.map((item) => ({
      id: item.id,
      ...item.data(),
    }));
    const barbeirosParaOcupacao = barbeiroId
      ? barbeiros.filter((item) => item.id === barbeiroId)
      : barbeiros.filter((item) => item.ativo !== false);
    const ocupacao = calcularOcupacaoFutura({
      inicio,
      fim,
      barbeiros: barbeirosParaOcupacao,
      agendamentos,
      bloqueios: bloqueiosSnap.docs.map((item) => ({
        id: item.id,
        ...item.data(),
      })),
      semanal,
      fechamentos: fechamentosDoPeriodo,
    });
    operacionalEl.innerHTML = `
      <div class="finance-operational-item"><span>Cancelamentos</span><strong>${atual.cancelados}</strong><small>No período filtrado</small></div>
      <div class="finance-operational-item"><span>Não compareceu</span><strong>${atual.faltas}</strong><small>No período filtrado</small></div>
      <div class="finance-operational-item"><span>Ocupação futura</span><strong>${ocupacao ? `${ocupacao.percentual}%` : "—"}</strong><small>${ocupacao ? `${ocupacao.utilizados} de ${ocupacao.capacidade} slots futuros` : "Sem capacidade futura calculável"}</small></div>`;
    feedback.textContent = `Dashboard atualizado: ${formatarData(inicio)} a ${formatarData(fim)}.`;
    desenharGraficoFinanceiro(dadosGraficoFinanceiro);
  } catch (erro) {
    console.error("Falha ao carregar dashboard financeiro.", erro);
    feedback.textContent = "Não foi possível carregar os dados financeiros.";
    resumoEl.innerHTML =
      '<div class="finance-metric"><span class="rotulo">Dados indisponíveis</span></div>';
  }
}

// ----------------------------------------------------------------------------
// Novo agendamento interno — usa a mesma transação e disponibilidade do cliente
// ----------------------------------------------------------------------------
const modalNovoAgendamento = document.getElementById("modal-novo-agendamento");
const formNovoAgendamento = document.getElementById("form-novo-agendamento");
const msgNovoAgendamento = document.getElementById("novo-agendamento-msg");
let pendingNewAppointmentPrefill = null;

function contatoDoClienteNovoAgendamento(dados = {}) {
  const telefone = [
    dados.telefone,
    dados.whatsapp,
    dados.phone,
    dados.telefone_cliente,
    dados.celular,
  ].find((valor) => normalizarWhatsApp(valor));

  return {
    nome: String(dados.nome || dados.displayName || dados.email || "").trim(),
    whatsapp: normalizarWhatsApp(telefone),
  };
}

function rotuloClienteNovoAgendamento(dados) {
  const contato = contatoDoClienteNovoAgendamento(dados);
  const nome = contato.nome || "Cliente sem nome";
  return `${nome}${contato.whatsapp ? ` · ${formatarWhatsApp(contato.whatsapp)}` : " · Telefone não cadastrado"}`;
}

function mensagemNovoAgendamento(texto, tipo = "err") {
  msgNovoAgendamento.textContent = texto;
  msgNovoAgendamento.className = `msg show ${tipo}`;
}

async function abrirNovoAgendamento(prefill = {}) {
  formNovoAgendamento.reset();
  pendingNewAppointmentPrefill = prefill.barbeiroId || prefill.data || prefill.horario
    ? { ...prefill }
    : null;
  msgNovoAgendamento.className = "msg";
  document.getElementById("novo-data").min = dataLocalHoje();
  const selectBarbeiro = document.getElementById("novo-barbeiro");
  const selectServico = document.getElementById("novo-servico");
  selectBarbeiro.innerHTML = `<option value="">Selecione</option>`;
  barbeirosCache
    .filter((b) => b.ativo)
    .forEach((b) => selectBarbeiro.add(new Option(b.nome, b.id)));
  selectServico.innerHTML = `<option value="">Selecione</option>`;
  servicosCache.forEach((s) =>
    selectServico.add(
      new Option(`${s.nome} — ${s.duracao} min — ${s.preco}`, s.id),
    ),
  );

  const selectCliente = document.getElementById("novo-cliente");
  selectCliente.innerHTML = `<option value="">Cliente presencial / novo</option>`;
  const carregouClientes = await carregarClientesAdministrativos();
  if (carregouClientes) {
    clientesNovoAgendamentoCache.forEach((dados, clienteId) => {
      selectCliente.add(new Option(rotuloClienteNovoAgendamento(dados), clienteId));
    });
  } else {
    mensagemNovoAgendamento(
      "Não foi possível carregar os clientes cadastrados.",
    );
  }
  if (prefill.barbeiroId && [...selectBarbeiro.options].some((option) => option.value === prefill.barbeiroId)) {
    selectBarbeiro.value = prefill.barbeiroId;
  }
  if (prefill.data) {
    document.getElementById("novo-data").value = prefill.data;
  }
  modalNovoAgendamento.classList.add("show");
}

window.adminOpenNewAppointment = abrirNovoAgendamento;

document
  .getElementById("btn-novo-agendamento")
  ?.addEventListener("click", abrirNovoAgendamento);
document
  .getElementById("btn-fechar-novo-agendamento")
  ?.addEventListener("click", () =>
    modalNovoAgendamento.classList.remove("show"),
  );

document.getElementById("novo-cliente")?.addEventListener("change", async (event) => {
  const clienteId = event.target.value;
  const campoNome = document.getElementById("novo-cliente-nome");
  const campoTelefone = document.getElementById("novo-cliente-telefone");
  const selecaoAtual = ++selecaoClienteNovoAgendamento;

  if (!clienteId) {
    campoNome.value = "";
    campoTelefone.value = "";
    return;
  }

  let dados = clientesNovoAgendamentoCache.get(clienteId) || {};
  try {
    const clienteSnap = await getDoc(doc(db, "clientes", clienteId));
    if (clienteSnap.exists()) {
      dados = clienteSnap.data();
      clientesNovoAgendamentoCache.set(clienteId, dados);
    }
  } catch (erro) {
    console.warn("Não foi possível atualizar o contato do cliente selecionado.", erro);
  }

  // Ignora o retorno de uma seleção anterior caso o Admin mude de cliente rápido.
  if (selecaoAtual !== selecaoClienteNovoAgendamento) return;

  const contato = contatoDoClienteNovoAgendamento(dados);
  campoNome.value = contato.nome;
  campoTelefone.value = contato.whatsapp
    ? formatarWhatsApp(contato.whatsapp)
    : "Telefone não cadastrado";
});

async function atualizarHorariosNovoAgendamento() {
  const selectHorario = document.getElementById("novo-horario");
  const barbeiro = barbeirosCache.find(
    (b) => b.id === document.getElementById("novo-barbeiro").value,
  );
  const servico = servicosCache.find(
    (s) => s.id === document.getElementById("novo-servico").value,
  );
  const data = document.getElementById("novo-data").value;
  selectHorario.innerHTML = `<option value="">Carregando horários…</option>`;
  if (!barbeiro || !servico || !data) {
    selectHorario.innerHTML = `<option value="">Escolha data, barbeiro e serviço</option>`;
    return;
  }
  try {
    const fechamento = await obterFechamentoGlobal(db, data);
    if (fechamento.fechado) {
      selectHorario.innerHTML = `<option value="">Barbearia fechada neste dia</option>`;
      mensagemNovoAgendamento(
        `Barbearia fechada nesta data.${fechamento.motivo ? ` ${fechamento.motivo}.` : ""}`,
      );
      return;
    }
    msgNovoAgendamento.className = "msg";
    const horarios = await horariosDisponiveis(db, {
      barbeiro,
      barbeiroId: barbeiro.id,
      data,
      duracao: servico.duracao,
    });
    selectHorario.innerHTML = `<option value="">${horarios.length ? "Selecione" : "Nenhum horário disponível"}</option>`;
    horarios.forEach((horario) =>
      selectHorario.add(new Option(horario, horario)),
    );
    const prefill = pendingNewAppointmentPrefill;
    if (prefill
      && prefill.barbeiroId === barbeiro.id
      && prefill.data === data
      && [...selectHorario.options].some((option) => option.value === prefill.horario)) {
      selectHorario.value = prefill.horario;
      pendingNewAppointmentPrefill = null;
    }
  } catch (err) {
    selectHorario.innerHTML = `<option value="">Não foi possível consultar os horários</option>`;
    console.error(err);
  }
}

["novo-barbeiro", "novo-servico", "novo-data"].forEach((id) =>
  document
    .getElementById(id)
    ?.addEventListener("change", atualizarHorariosNovoAgendamento),
);

formNovoAgendamento?.addEventListener("submit", async (event) => {
  event.preventDefault();
  const cliente = document.getElementById("novo-cliente");
  const barbeiro = barbeirosCache.find(
    (b) => b.id === document.getElementById("novo-barbeiro").value,
  );
  const servico = servicosCache.find(
    (s) => s.id === document.getElementById("novo-servico").value,
  );
  const data = document.getElementById("novo-data").value;
  const horario = document.getElementById("novo-horario").value;
  const nome = document.getElementById("novo-cliente-nome").value.trim();
  const whatsapp = normalizarWhatsApp(
    document.getElementById("novo-cliente-telefone").value,
  );
  if (!nome || !barbeiro || !servico || !data || !horario)
    return mensagemNovoAgendamento("Preencha todos os campos obrigatórios.");
  const btn = event.target.querySelector("button[type=submit]");
  btn.disabled = true;
  btn.textContent = "Criando…";
  try {
    await criarAgendamento(db, {
      cliente_id: cliente.value || "",
      cliente_nome: nome,
      cliente_whatsapp: whatsapp,
      cliente_tipo: cliente.value ? "autenticado" : "presencial",
      barbeiro_id: barbeiro.id,
      barbeiro_nome: barbeiro.nome,
      barbeiro,
      servico_id: servico.id,
      servico_nome: servico.nome,
      duracao: servico.duracao,
      servico_preco: servico.preco || "",
      data,
      horario,
      criado_por: auth.currentUser.uid,
      criado_por_tipo: "admin",
      origem: "interno",
    });
    mensagemNovoAgendamento("Agendamento criado com sucesso.", "ok");
    await carregarAgenda();
    setTimeout(() => modalNovoAgendamento.classList.remove("show"), 700);
  } catch (err) {
    console.error("Falha ao criar agendamento interno.", {
      code: err.code,
      message: err.message,
      stack: err.stack,
      clienteId: cliente.value || null,
      barbeiroId: barbeiro?.id,
      servicoId: servico?.id,
      data,
      horario,
    });
    if (err.message === "BARBEARIA_FECHADA") {
      mensagemNovoAgendamento(
        "A barbearia está fechada nesta data. Escolha outro dia.",
      );
    } else if (err.message === "HORARIO_OCUPADO") {
      mensagemNovoAgendamento("Este horário não está mais disponível.");
    } else if (err.code === "permission-denied") {
      mensagemNovoAgendamento(
        "Você não possui permissão para criar este agendamento.",
      );
    } else if (
      err.code === "invalid-argument" ||
      err.code === "failed-precondition"
    ) {
      mensagemNovoAgendamento("Selecione um horário válido e tente novamente.");
    } else {
      mensagemNovoAgendamento(
        "Não foi possível salvar o agendamento. Tente novamente.",
      );
    }
  } finally {
    btn.disabled = false;
    btn.textContent = "Confirmar agendamento";
  }
});
