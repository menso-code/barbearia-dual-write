import { db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Fonte única de permissões para a interface. Nenhuma permissão é gravada em
// localStorage ou sessionStorage: toda consulta é referente à conta atual.
export async function getCurrentUserAccess(user) {
  if (!user?.uid) {
    return { isAuthenticated: false, roles: [], isClient: false, isBarber: false, isAdmin: false, barberId: null };
  }

  const uidOperacional = await obterUidOperacional(user);
  const [memberResult, adminResult, barberResult] = await Promise.allSettled([
    getDoc(doc(db, "barbearias", "tnt_80b2fda7ad644a1dbeff050aa8e0d595", "membros", uidOperacional)),
    getDoc(doc(db, "admins", uidOperacional)),
    getDocs(query(collection(db, "barbeiros"), where("uid_usuario", "==", uidOperacional))),
  ]);
  const barbeiros = barberResult.status === "fulfilled" ? barberResult.value : null;
  const member = memberResult.status === "fulfilled" && memberResult.value.exists() ? memberResult.value.data() : {};
  const roles = Array.isArray(member.papeis) ? member.papeis.filter((role) => typeof role === "string") : [];
  const isBarber = roles.includes("BARBEIRO") && Boolean(barbeiros && !barbeiros.empty);
  const isAdmin = roles.includes("ADMIN") && adminResult.status === "fulfilled" && adminResult.value.exists();
  const isClient = roles.includes("CLIENTE");

  return {
    isAuthenticated: true,
    roles,
    isClient,
    isAdmin,
    isBarber,
    barberId: isBarber ? barbeiros?.docs[0]?.id || null : null,
  };
}
