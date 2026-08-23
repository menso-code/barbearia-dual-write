import { auth, db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
import { executarComandoOperacional } from "./operational-commands.js";
import { onAuthStateChanged, signOut, updateProfile, updatePassword, EmailAuthProvider, reauthenticateWithCredential } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import { doc, getDoc, collection, query, where, orderBy, getDocs } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

let user; let operationalUid = ""; let profile = {}; let appointments = [];
const $ = (id) => document.getElementById(id);
const initials = (name) => String(name || "BA").split(/\s+/).filter(Boolean).slice(0,2).map((v)=>v[0]).join("").toUpperCase();
const fmtDate = (date) => date ? date.split("-").reverse().join("/") : "—";
const message = (id, text, type="ok") => { const el=$(id); el.textContent=text; el.className=`msg show ${type}`; };
const AVATAR_MAX_BYTES = 5 * 1024 * 1024;
// O Firestore limita um documento a 1 MiB. Como Base64 aumenta o tamanho
// do arquivo, mantemos o blob próximo de 500 KB antes de convertê-lo.
const AVATAR_TARGET_BYTES = 500 * 1024;
const AVATAR_MAX_SIDE = 1600;
const AVATAR_TYPES = ["image/jpeg", "image/png", "image/webp"];
const avatarAtual = () => profile.avatar_data || "";
function setAvatar(data, name) { [$("profile-avatar")].forEach((el)=>{ if(data){el.style.backgroundImage=`url(${data})`;el.textContent="";}else{el.style.backgroundImage="";el.textContent=initials(name);} }); }
function arquivoDeImagemAceito(file) { return AVATAR_TYPES.includes(String(file.type || "").toLowerCase()) || /\.(jpe?g|png|webp)$/i.test(file.name || ""); }
function blobDoCanvas(canvas, tipo, qualidade) { return new Promise((resolve) => canvas.toBlob(resolve, tipo, qualidade)); }
function blobParaDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const leitor = new FileReader();
    leitor.onload = () => resolve(leitor.result);
    leitor.onerror = () => reject(leitor.error || new Error("LEITURA_FALHOU"));
    leitor.readAsDataURL(blob);
  });
}
async function carregarImagem(file) {
  if ("createImageBitmap" in window) {
    try { const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" }); return { imagem: bitmap, fechar: () => bitmap.close?.() }; } catch (_) { /* Safari antigo usa o fallback abaixo. */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const imagem = await new Promise((resolve, reject) => { const el = new Image(); el.onload = () => resolve(el); el.onerror = reject; el.src = url; });
    return { imagem, fechar: () => URL.revokeObjectURL(url) };
  } catch (erro) { URL.revokeObjectURL(url); throw erro; }
}
async function otimizarAvatar(file) {
  const { imagem, fechar } = await carregarImagem(file);
  try {
    const larguraOriginal = imagem.width || imagem.naturalWidth;
    const alturaOriginal = imagem.height || imagem.naturalHeight;
    let escala = Math.min(1, AVATAR_MAX_SIDE / Math.max(larguraOriginal, alturaOriginal));
    let melhorBlob = null;
    for (let tentativaTamanho = 0; tentativaTamanho < 4; tentativaTamanho += 1) {
      const largura = Math.max(1, Math.round(larguraOriginal * escala));
      const altura = Math.max(1, Math.round(alturaOriginal * escala));
      const canvas = document.createElement("canvas");
      canvas.width = largura; canvas.height = altura;
      const contexto = canvas.getContext("2d", { alpha: false });
      contexto.drawImage(imagem, 0, 0, largura, altura);
      for (const qualidade of [.84, .80, .76, .72, .68, .64]) {
        let blob = await blobDoCanvas(canvas, "image/webp", qualidade);
        if (!blob || blob.type !== "image/webp") blob = await blobDoCanvas(canvas, "image/jpeg", qualidade);
        if (!blob) throw new Error("COMPRESSAO_FALHOU");
        melhorBlob = blob;
        if (blob.size <= AVATAR_TARGET_BYTES) return blob;
      }
      escala *= .82;
    }
    return melhorBlob;
  } finally { fechar(); }
}
function bookingCard(a, history=false) { if(!a) return `<div class="empty-state"><h3>Seu próximo corte começa aqui.</h3><p>Escolha um barbeiro e encontre seu próximo horário.</p><a class="btn btn-primary" href="app.html">Agendar horário</a></div>`; const link=history?`app.html?barbeiro=${encodeURIComponent(a.barbeiro_id||"")}&servico=${encodeURIComponent(a.servico_id||"")}`:"app.html"; const status=a.status||"agendado"; const label=status==="concluido"?"✓ Concluído":status; return `<article class="personal-booking"><div><span class="status-pill status-${status === "cancelado" ? "cancelado" : status === "concluido" ? "concluido" : "agendado"}">${label}</span><h3>${a.servico_nome || "Serviço"}</h3><p>${fmtDate(a.data)} às ${a.horario} · com ${a.barbeiro_nome || "barbeiro"}</p></div><div class="booking-actions"><a class="btn btn-ghost btn-sm" href="${link}">${history ? "Agendar novamente" : "Ver detalhes"}</a></div></article>`; }
async function loadOptions() { const [barbers, services] = await Promise.all([getDocs(query(collection(db,"barbeiros"),where("ativo","==",true))),getDocs(collection(db,"servicos"))]); barbers.forEach((d)=>$("favorite-barber").insertAdjacentHTML("beforeend",`<option value="${d.id}">${d.data().nome}</option>`)); services.forEach((d)=>$("favorite-service").insertAdjacentHTML("beforeend",`<option value="${d.id}">${d.data().nome}</option>`)); }
async function loadAccount() {
  const ref = doc(db, "clientes", operationalUid);
  const snap = await getDoc(ref);
  profile = snap.exists() ? snap.data() : {};
  if (!snap.exists()) await executarComandoOperacional("cliente.garantir-perfil", { extras: { nome: user.displayName || "", email: user.email || "", telefone: "" } });

  const appointmentsQuery = query(collection(db, "agendamentos"), where("cliente_id", "==", operationalUid), orderBy("data", "desc"));
  appointments = (await getDocs(appointmentsQuery)).docs.map((d) => ({ id: d.id, ...d.data() }));
  $("profile-name").value = profile.nome || user.displayName || "";
  $("profile-phone").value = profile.telefone || "";
  $("profile-email").value = user.email || profile.email || "";
  $("profile-birth").value = profile.data_nascimento || "";
  $("favorite-barber").value = profile.barbeiro_favorito_id || "";
  $("favorite-service").value = profile.servico_favorito_id || "";
  $("preferred-period").value = profile.periodo_preferido || "";
  $("preference-notes").value = profile.observacoes || "";
  setAvatar(avatarAtual(), profile.nome || user.displayName);

  const future = appointments.find((a) => a.status === "agendado" && `${a.data}T${a.horario}` >= new Date().toISOString().slice(0, 16));
  const last = appointments.find((a) => a.status === "concluido");
  $("next-booking").innerHTML = bookingCard(future);
  $("last-booking").innerHTML = last ? bookingCard(last, true) : `<div class="empty-state">Nenhum atendimento concluído ainda.</div>`;
  $("account-appointments-list").innerHTML = appointments.length ? appointments.map((a) => bookingCard(a, a.status !== "agendado")).join("") : bookingCard(null);

  // A fidelidade é sempre derivada do banco: cada atendimento concluído vale um ponto.
  const completed = appointments.filter((a) => a.status === "concluido").length;
  const cycle = completed % 10;
  const progress = completed > 0 && cycle === 0 ? 10 : cycle;
  const benefits = Math.floor(completed / 10);
  $("loyalty-count").textContent = `${completed} atendimento${completed === 1 ? "" : "s"} concluído${completed === 1 ? "" : "s"}`;
  $("loyalty-progress").style.width = `${progress * 10}%`;
  $("loyalty-ratio").textContent = `${progress} / 10 no ciclo atual`;
  $("loyalty-copy").textContent = benefits
    ? `${benefits} benefício${benefits === 1 ? "" : "s"} disponível${benefits === 1 ? "" : "is"}. ${cycle ? `${10 - cycle} atendimentos para o próximo.` : "Você completou este ciclo."}`
    : `Faltam ${10 - cycle} atendimentos para seu próximo benefício.`;

  $("loyalty-reward").innerHTML = benefits ? `<article class="loyalty-reward"><span class="status-pill status-concluido">Benefício disponível</span><h3>Benefício desbloqueado</h3><p>Você completou ${benefits * 10} atendimentos. Seu benefício de fidelidade está disponível.</p></article>` : "";
}
$("profile-form").addEventListener("submit",async(e)=>{e.preventDefault(); const nome=$("profile-name").value.trim(); const telefone=$("profile-phone").value.replace(/\D/g,""); if(telefone&&!/^55\d{10,11}$/.test(telefone)) return message("profile-msg","Informe o WhatsApp com DDI: +55 11 99999-9999.","err"); try{await executarComandoOperacional("cliente.atualizar-perfil",{data:{nome,telefone,data_nascimento:$("profile-birth").value,avatar_data:profile.avatar_data||""}}); await updateProfile(user,{displayName:nome}); profile.nome=nome; message("profile-msg","Perfil atualizado."); setAvatar(avatarAtual(),nome);}catch(err){message("profile-msg","Não foi possível salvar o perfil.","err");}});
$("avatar-input").addEventListener("change",async(e)=>{const input=e.currentTarget;const file=input.files[0];if(!file)return;if(file.size>AVATAR_MAX_BYTES){message("profile-msg","A imagem deve ter no máximo 5 MB.","err");input.value="";return;}if(!arquivoDeImagemAceito(file)){message("profile-msg","Use JPG, PNG ou WebP, até 5 MB.","err");input.value="";return;}input.disabled=true;try{message("profile-msg","Otimizando foto...");const fotoOtimizada=await otimizarAvatar(file);if(!fotoOtimizada)throw new Error("COMPRESSAO_FALHOU");message("profile-msg","Enviando foto...");const avatarData=await blobParaDataUrl(fotoOtimizada);await executarComandoOperacional("cliente.atualizar-perfil",{data:{avatar_data:avatarData}});profile.avatar_data=avatarData;setAvatar(avatarData,$("profile-name").value);message("profile-msg","Foto atualizada.");}catch(err){console.error("Falha ao atualizar foto de perfil.",err);message("profile-msg","Não foi possível atualizar a foto. Sua foto atual foi mantida.","err");}finally{input.disabled=false;input.value="";}});
$("remove-avatar").addEventListener("click",async()=>{try{await executarComandoOperacional("cliente.atualizar-perfil",{data:{avatar_data:""}});profile.avatar_data="";$("avatar-input").value="";setAvatar("",$("profile-name").value);message("profile-msg","Foto removida.");}catch(err){message("profile-msg","Não foi possível remover a foto.","err");}});
$("preferences-form").addEventListener("submit",async(e)=>{e.preventDefault();try{await executarComandoOperacional("cliente.atualizar-perfil",{data:{barbeiro_favorito_id:$("favorite-barber").value,servico_favorito_id:$("favorite-service").value,periodo_preferido:$("preferred-period").value,observacoes:$("preference-notes").value.trim()}});message("preferences-msg","Preferências salvas.");}catch{message("preferences-msg","Não foi possível salvar as preferências.","err");}});
$("password-form").addEventListener("submit",async(e)=>{e.preventDefault();if($("new-password").value!==$("confirm-password").value)return message("password-msg","As novas senhas não coincidem.","err");try{await reauthenticateWithCredential(user,EmailAuthProvider.credential(user.email,$("current-password").value));await updatePassword(user,$("new-password").value);e.target.reset();message("password-msg","Senha alterada com sucesso.");}catch(err){message("password-msg",err.code==="auth/wrong-password"||err.code==="auth/invalid-credential"?"Senha atual incorreta.":"Não foi possível alterar a senha.","err");}});
$("delete-request").addEventListener("click",()=>alert("Pedido de exclusão registrado. Entre em contato com a Barbearia Antunes para concluir a remoção segura dos dados vinculados a agendamentos."));
document.querySelectorAll("[data-account-view]").forEach((btn)=>btn.addEventListener("click",()=>{document.querySelectorAll(".account-view").forEach((v)=>v.classList.remove("active"));document.querySelectorAll("[data-account-view]").forEach((b)=>b.classList.remove("active"));$("account-"+btn.dataset.accountView).classList.add("active");btn.classList.add("active");}));
document.querySelectorAll("[data-logout]").forEach((b)=>b.addEventListener("click",async()=>{await signOut(auth);location.replace("index.html");}));
onAuthStateChanged(auth,async(current)=>{if(!current)return location.replace("index.html");user=current;try{operationalUid=await obterUidOperacional(current);await loadOptions();await loadAccount(); const hash=location.hash.slice(1);if(hash){const target={"visao-geral":"overview","meu-perfil":"profile",agendamentos:"appointments",preferencias:"preferences",seguranca:"security",fidelidade:"loyalty"}[hash];document.querySelector(`[data-account-view="${target}"]`)?.click();}}catch(err){console.error(err);}});
