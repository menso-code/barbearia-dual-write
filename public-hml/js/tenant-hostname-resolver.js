import { functions } from "./firebase-config.js";
import { httpsCallable } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-functions.js";
import {
  createTrustedTenantHostnameResolver,
  executeCanonicalTenantRedirect,
} from "./tenant-hostname-resolver-core.mjs";

const resolveTenantHostnameCallable = httpsCallable(functions, "resolveTenantHostname");

export const resolveTenantHostname = createTrustedTenantHostnameResolver({
  invoke: async ({ hostname }) => {
    const result = await resolveTenantHostnameCallable({ hostname });
    return result.data;
  },
});

export function redirectToCanonicalTenantHostname({ redirectToSlug, location = globalThis.location }) {
  return executeCanonicalTenantRedirect({ redirectToSlug, location });
}
