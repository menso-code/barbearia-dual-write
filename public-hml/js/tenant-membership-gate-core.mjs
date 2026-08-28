export const TENANT_PAGE_ROLES = Object.freeze({
  CLIENT: "CLIENTE",
  BARBER: "BARBEIRO",
  ADMIN: "ADMIN",
});

export const ACCESS_CHECK_TIMEOUT_MS = 5000;

export class AccessCheckTimeoutError extends Error {
  constructor(stage) {
    super(`ACCESS_CHECK_TIMEOUT:${stage}`);
    this.name = "AccessCheckTimeoutError";
    this.code = "ACCESS_CHECK_TIMEOUT";
    this.stage = stage;
  }
}

export function withAccessTimeout(operation, timeoutMs = ACCESS_CHECK_TIMEOUT_MS, stage = "ACCESS_CHECK") {
  const timeout = Number(timeoutMs);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new TypeError("timeoutMs must be a positive finite number");
  }

  const pending = typeof operation === "function"
    ? Promise.resolve().then(operation)
    : Promise.resolve(operation);

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer;
    const settle = (settler, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      settler(value);
    };

    timer = setTimeout(
      () => settle(reject, new AccessCheckTimeoutError(stage)),
      timeout,
    );

    pending.then(
      (value) => settle(resolve, value),
      (error) => settle(reject, error),
    );
  });
}

const unauthenticatedAccess = Object.freeze({
  isAuthenticated: false,
  isClient: false,
  isBarber: false,
  isAdmin: false,
  barberId: null,
});

function unavailableAccess(tenantContext = null) {
  return {
    isAuthenticated: true,
    isClient: false,
    isBarber: false,
    isAdmin: false,
    barberId: null,
    tenantStatus: tenantContext?.status || "UNAVAILABLE",
    tenantContext,
    membershipStatus: "UNAVAILABLE",
    roles: [],
  };
}

function isReadyTenantContext(tenantContext) {
  return tenantContext?.status === "READY"
    && typeof tenantContext.tenantId === "string"
    && tenantContext.tenantId.trim().length > 0;
}

export async function resolveTenantMembershipAccess({
  user,
  resolveTenantContext,
  inspectMembership,
  resolveOperationalUid,
  readMembership,
  requiredRole = "CLIENTE",
  timeoutMs = ACCESS_CHECK_TIMEOUT_MS,
} = {}) {
  if (!user?.uid) return { ...unauthenticatedAccess };

  let tenantContext;
  try {
    tenantContext = await withAccessTimeout(resolveTenantContext, timeoutMs, "TENANT_CONTEXT");
  } catch {
    return unavailableAccess();
  }

  if (!isReadyTenantContext(tenantContext)) {
    return unavailableAccess(tenantContext);
  }

  if (!TENANT_PAGE_ROLES || !Object.values(TENANT_PAGE_ROLES).includes(requiredRole)) {
    return unavailableAccess(tenantContext);
  }

  // Compatibilidade de teste: a aplicação HML sempre fornece a callable.
  // Este adaptador não é usado por access-control.js e mantém testes puros
  // do núcleo independentes de SDKs do Firebase.
  if (typeof inspectMembership !== "function") {
    let uidOperacional;
    try {
      uidOperacional = await withAccessTimeout(() => resolveOperationalUid(user), timeoutMs, "HML_MAPPING");
    } catch (error) {
      if (error?.message === "MAPEAMENTO_HOMOLOGACAO_AUSENTE") {
        return { ...unavailableAccess(tenantContext), tenantStatus: tenantContext.status, membershipStatus: "MISSING", uidOperacional: "" };
      }
      return unavailableAccess(tenantContext);
    }
    try {
      const member = await withAccessTimeout(
        () => readMembership({ tenantId: tenantContext.tenantId, uidOperacional }), timeoutMs, "MEMBERSHIP",
      );
      const roles = member?.ativo === true && Array.isArray(member.papeis)
        ? [...new Set(member.papeis.filter((role) => typeof role === "string"))] : [];
      return {
        isAuthenticated: true,
        isClient: roles.includes("CLIENTE"), isBarber: roles.includes("BARBEIRO"), isAdmin: roles.includes("ADMIN"),
        barberId: roles.includes("BARBEIRO") ? member?.barbeiro_id || null : null,
        tenantStatus: tenantContext.status, tenantContext,
        membershipStatus: !member ? "MISSING" : member.ativo === true ? "ACTIVE" : "INACTIVE",
        inspectionState: member?.ativo === true && roles.includes(requiredRole) ? "ACTIVE" : member?.ativo === true ? "ROLE_INSUFFICIENT" : "",
        roles, uidOperacional,
      };
    } catch {
      return unavailableAccess(tenantContext);
    }
  }

  let inspection;
  try {
    inspection = await withAccessTimeout(
      () => inspectMembership({ hostname: tenantContext.hostname, surface: requiredRole }),
      timeoutMs,
      "MEMBERSHIP_INSPECTION",
    );
  } catch {
    return unavailableAccess(tenantContext);
  }

  const validInspection = inspection
    && typeof inspection === "object"
    && !Array.isArray(inspection)
    && Object.keys(inspection).length === 2
    && Object.hasOwn(inspection, "schema")
    && Object.hasOwn(inspection, "state")
    && inspection.schema === 1;
  const state = validInspection ? inspection.state : "";
  if (!["ACTIVE", "NOT_MEMBER", "INACTIVE", "ROLE_INSUFFICIENT"].includes(state)) {
    return unavailableAccess(tenantContext);
  }
  const membershipStatus = state === "NOT_MEMBER" ? "MISSING" : state === "INACTIVE" ? "INACTIVE" : "ACTIVE";

  return {
    isAuthenticated: true,
    isClient: state === "ACTIVE" && requiredRole === "CLIENTE",
    isBarber: state === "ACTIVE" && requiredRole === "BARBEIRO",
    isAdmin: state === "ACTIVE" && requiredRole === "ADMIN",
    barberId: null,
    tenantStatus: tenantContext.status,
    tenantContext,
    membershipStatus,
    inspectionState: state,
    roles: [],
  };
}

const DENIED_ACCESS_REASONS = new Set([
  "MEMBERSHIP_MISSING",
  "MEMBERSHIP_INACTIVE",
  "ROLE_INSUFFICIENT",
  "TENANT_NOT_READY",
  "MEMBERSHIP_UNAVAILABLE",
]);

export function deniedAccessRoute(code) {
  const reason = DENIED_ACCESS_REASONS.has(code) ? code : "MEMBERSHIP_UNAVAILABLE";
  return `access-denied.html?reason=${encodeURIComponent(reason)}`;
}

export function evaluateTenantPageAccess(access, requiredRole) {
  if (!access?.isAuthenticated) {
    return Object.freeze({ allowed: false, code: "UNAUTHENTICATED", message: "Faça login para continuar." });
  }

  if (access.membershipStatus === "MISSING") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_MISSING",
      message: "Você ainda não possui cadastro nessa barbearia.",
    });
  }

  if (access.membershipStatus === "INACTIVE") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_INACTIVE",
      message: "Seu acesso neste estabelecimento está inativo.",
    });
  }

  if (access.membershipStatus === "UNAVAILABLE") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_UNAVAILABLE",
      message: "Não foi possível validar seu acesso neste estabelecimento.",
    });
  }

  if (access.tenantStatus !== "READY") {
    return Object.freeze({ allowed: false, code: "TENANT_NOT_READY", message: "Este estabelecimento não está disponível." });
  }

  if (access.membershipStatus !== "ACTIVE") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_UNAVAILABLE",
      message: "Não foi possível validar seu acesso neste estabelecimento.",
    });
  }

  if (access.inspectionState === "ROLE_INSUFFICIENT" || (Array.isArray(access.roles) && access.roles.length > 0 && !access.roles.includes(requiredRole))) {
    return Object.freeze({
      allowed: false,
      code: "ROLE_INSUFFICIENT",
      message: "Usuário não autorizado para esta área.",
    });
  }

  return Object.freeze({ allowed: true, code: "READY", message: "" });
}
