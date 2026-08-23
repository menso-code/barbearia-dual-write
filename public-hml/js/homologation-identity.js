import { db, FIREBASE_PROJECT_ID } from "./firebase-config.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import { executarComandoOperacional } from "./operational-commands.js";

// Em produção, o UID operacional é o próprio UID autenticado. Na
// homologação, as contas de teste apontam explicitamente para os dados
// migrados, sem copiar credenciais ou usuários reais.
const PROJECT_HML = "teste-483f6";
const cache = new Map();

export async function obterUidOperacional(user) {
  if (!user?.uid) return "";
  if (FIREBASE_PROJECT_ID !== PROJECT_HML) return user.uid;
  if (cache.has(user.uid)) return cache.get(user.uid);

  const mapping = await getDoc(doc(db, "homologacao_mapeamentos", user.uid));
  const data = mapping.exists() ? mapping.data() : null;
  const uid = data?.ativo === true ? String(data.uid_producao_referencia || "") : "";
  if (!uid) throw new Error("MAPEAMENTO_HOMOLOGACAO_AUSENTE");
  cache.set(user.uid, uid);
  return uid;
}

export async function obterUidOperacionalComPrimeiroVinculo(user) {
  try {
    return await obterUidOperacional(user);
  } catch (erro) {
    if (erro?.message !== "MAPEAMENTO_HOMOLOGACAO_AUSENTE") throw erro;
    await executarComandoOperacional("barbeiro.vincular-primeiro-acesso");
    await user.getIdToken(true);
    cache.delete(user.uid);
    return obterUidOperacional(user);
  }
}

// Clientes novos usam o bootstrap restrito de cliente. O first-link de
// barbeiro permanece separado e continua sendo usado somente pelo painel do
// barbeiro.
export async function obterUidOperacionalComBootstrapCliente(user) {
  try {
    return await obterUidOperacional(user);
  } catch (erro) {
    if (erro?.message !== "MAPEAMENTO_HOMOLOGACAO_AUSENTE") throw erro;
    await executarComandoOperacional("cliente.garantir-perfil", {
      extras: {
        nome: user.displayName || "",
        email: user.email || "",
        telefone: String(user.phoneNumber || "").replace(/\D/g, ""),
      },
    });
    await user.getIdToken(true);
    cache.delete(user.uid);
    return obterUidOperacional(user);
  }
}
