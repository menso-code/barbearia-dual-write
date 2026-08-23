import { db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
import { collection, doc, getDoc, getDocs, query, where } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Fonte única de permissões para a interface. Nenhuma permissão é gravada em
// localStorage ou sessionStorage: toda consulta é referente à conta atual.
export async function getCurrentUserAccess(user) {
  if (!user?.uid) {
    return { isAuthenticated: false, isClient: false, isBarber: false, isAdmin: false, barberId: null };
  }

  const uidOperacional = await obterUidOperacional(user);
  const [adminResult, barberResult] = await Promise.allSettled([
    getDoc(doc(db, "admins", uidOperacional)),
    getDocs(query(collection(db, "barbeiros"), where("uid_usuario", "==", uidOperacional))),
  ]);
  const barbeiros = barberResult.status === "fulfilled" ? barberResult.value : null;

  return {
    isAuthenticated: true,
    isClient: true,
    isAdmin: adminResult.status === "fulfilled" && adminResult.value.exists(),
    isBarber: Boolean(barbeiros && !barbeiros.empty),
    barberId: barbeiros?.docs[0]?.id || null,
  };
}
