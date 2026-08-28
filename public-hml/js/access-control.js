import { db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
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
    return { ...CLOSED_ACCESS, tenantStatus: tenantContext.status, tenantContext, membershipStatus: "UNAVAILABLE", roles: [] };
  }

  let uidOperacional = "";
  try {
    uidOperacional = await obterUidOperacional(user);
  } catch {
    return {
      ...CLOSED_ACCESS,
      tenantStatus: tenantContext.status,
      tenantContext,
      membershipStatus: "MISSING",
      roles: [],
    };
  }
  const memberResult = await Promise.allSettled([
    getDoc(doc(db, "barbearias", tenantContext.tenantId, "membros", uidOperacional)),
  ]);
  const memberSnapshot = memberResult[0].status === "fulfilled" ? memberResult[0].value : null;
  if (!memberSnapshot) {
    return {
      ...CLOSED_ACCESS,
      tenantStatus: tenantContext.status,
      tenantContext,
      membershipStatus: "UNAVAILABLE",
      roles: [],
    };
  }
  const member = memberSnapshot?.exists() ? memberSnapshot.data() : null;
  const roles = member?.ativo === true && Array.isArray(member.papeis)
    ? [...new Set(member.papeis.filter((role) => typeof role === "string"))]
    : [];
  const membershipStatus = !member ? "MISSING" : member.ativo === true ? "ACTIVE" : "INACTIVE";

  return {
    isAuthenticated: true,
    isClient: roles.includes("CLIENTE"),
    isAdmin: roles.includes("ADMIN"),
    isBarber: roles.includes("BARBEIRO"),
    barberId: roles.includes("BARBEIRO") ? member?.barbeiro_id || null : null,
    tenantStatus: tenantContext.status,
    tenantContext,
    membershipStatus,
    roles,
    uidOperacional,
  };
}
