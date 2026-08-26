import { db } from "./firebase-config.js";
import {
  initializeTenantContext,
  tenantContextIsReady,
} from "./tenant-context.js";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

const CLOSED_ACCESS = Object.freeze({
  isAuthenticated: true,
  isClient: false,
  isBarber: false,
  isAdmin: false,
  barberId: null,
});

// Fonte única de permissões para a interface. Nenhuma permissão é gravada em
// localStorage ou sessionStorage: toda consulta é referente à conta atual.
export async function getCurrentUserAccess(user) {
  if (!user?.uid) {
    return { isAuthenticated: false, isClient: false, isBarber: false, isAdmin: false, barberId: null };
  }

  const tenantContext = await initializeTenantContext();
  if (!tenantContextIsReady(tenantContext)) {
    return { ...CLOSED_ACCESS, tenantStatus: tenantContext.status };
  }

  const memberResult = await Promise.allSettled([
    getDoc(doc(db, "barbearias", tenantContext.tenantId, "membros", user.uid)),
  ]);
  const memberSnapshot = memberResult[0].status === "fulfilled" ? memberResult[0].value : null;
  const member = memberSnapshot?.exists() ? memberSnapshot.data() : null;
  const roles = member?.ativo === true && Array.isArray(member.papeis) ? member.papeis : [];

  return {
    isAuthenticated: true,
    isClient: roles.includes("CLIENTE"),
    isAdmin: roles.includes("ADMIN"),
    isBarber: roles.includes("BARBEIRO"),
    barberId: roles.includes("BARBEIRO") ? member?.barbeiro_id || null : null,
    tenantStatus: tenantContext.status,
  };
}
