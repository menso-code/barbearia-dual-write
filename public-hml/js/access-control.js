import { functions } from "./firebase-config.js";
import { initializeTenantContext } from "./tenant-context.js";
import { ACCESS_CHECK_TIMEOUT_MS, resolveTenantMembershipAccess, withAccessTimeout } from "./tenant-membership-gate-core.mjs";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";

const inspectTenantMembership = httpsCallable(functions, "inspectTenantMembership");
const SURFACES = Object.freeze(["CLIENTE", "BARBEIRO", "ADMIN"]);

async function inspect({ hostname, surface }) {
  const result = await inspectTenantMembership({ context: { hostname }, surface });
  return result?.data;
}

// A callable é a única leitura de membership no navegador. Ela decide a
// identidade HML e o tenant no backend; o cliente só recebe o estado mínimo.
export async function getCurrentUserAccess(user, requiredRole) {
  const primary = await resolveTenantMembershipAccess({
    user,
    resolveTenantContext: initializeTenantContext,
    inspectMembership: inspect,
    requiredRole,
  });
  if (primary.inspectionState !== "ACTIVE") return primary;

  const hostname = primary.tenantContext.hostname;
  const results = await Promise.all(SURFACES.map(async (surface) => {
    try {
      const result = await withAccessTimeout(
        () => inspect({ hostname, surface }),
        ACCESS_CHECK_TIMEOUT_MS,
        "MEMBERSHIP_CAPABILITY",
      );
      return [surface, result?.schema === 1 && result.state === "ACTIVE"];
    } catch {
      return [surface, false];
    }
  }));
  const capability = Object.fromEntries(results);
  return Object.freeze({
    ...primary,
    isClient: capability.CLIENTE === true,
    isBarber: capability.BARBEIRO === true,
    isAdmin: capability.ADMIN === true,
  });
}
