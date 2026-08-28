import { db } from "./firebase-config.js";
import { obterUidOperacional } from "./homologation-identity.js";
import { initializeTenantContext } from "./tenant-context.js";
import { resolveTenantMembershipAccess } from "./tenant-membership-gate-core.mjs";
import { doc, getDoc } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";

// Fonte única de permissões para a interface. Nenhuma permissão é gravada em
// localStorage ou sessionStorage: toda consulta é referente à conta atual.
export async function getCurrentUserAccess(user) {
  return resolveTenantMembershipAccess({
    user,
    resolveTenantContext: initializeTenantContext,
    resolveOperationalUid: obterUidOperacional,
    readMembership: async ({ tenantId, uidOperacional }) => {
      const snapshot = await getDoc(doc(db, "barbearias", tenantId, "membros", uidOperacional));
      return snapshot.exists() ? snapshot.data() : null;
    },
  });
}
