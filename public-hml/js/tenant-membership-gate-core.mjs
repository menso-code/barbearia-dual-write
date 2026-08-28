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
  resolveOperationalUid,
  readMembership,
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

  let uidOperacional = "";
  try {
    uidOperacional = await withAccessTimeout(
      () => resolveOperationalUid(user),
      timeoutMs,
      "HML_MAPPING",
    );
  } catch (error) {
    if (error?.message === "MAPEAMENTO_HOMOLOGACAO_AUSENTE") {
      return {
        ...unavailableAccess(tenantContext),
        tenantStatus: tenantContext.status,
        membershipStatus: "MISSING",
        uidOperacional: "",
      };
    }
    return unavailableAccess(tenantContext);
  }

  let member;
  try {
    member = await withAccessTimeout(
      () => readMembership({ tenantId: tenantContext.tenantId, uidOperacional }),
      timeoutMs,
      "MEMBERSHIP",
    );
  } catch {
    return unavailableAccess(tenantContext);
  }

  const roles = member?.ativo === true && Array.isArray(member.papeis)
    ? [...new Set(member.papeis.filter((role) => typeof role === "string"))]
    : [];
  const membershipStatus = !member ? "MISSING" : member.ativo === true ? "ACTIVE" : "INACTIVE";

  return {
    isAuthenticated: true,
    isClient: roles.includes("CLIENTE"),
    isBarber: roles.includes("BARBEIRO"),
    isAdmin: roles.includes("ADMIN"),
    barberId: roles.includes("BARBEIRO") ? member?.barbeiro_id || null : null,
    tenantStatus: tenantContext.status,
    tenantContext,
    membershipStatus,
    roles,
    uidOperacional,
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

  if (requiredRole && !access.roles?.includes(requiredRole)) {
    return Object.freeze({
      allowed: false,
      code: "ROLE_INSUFFICIENT",
      message: "Usuário não autorizado para esta área.",
    });
  }

  return Object.freeze({ allowed: true, code: "READY", message: "" });
}
