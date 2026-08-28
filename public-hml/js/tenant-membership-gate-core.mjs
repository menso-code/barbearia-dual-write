export const TENANT_PAGE_ROLES = Object.freeze({
  CLIENT: "CLIENTE",
  BARBER: "BARBEIRO",
  ADMIN: "ADMIN",
});

export function evaluateTenantPageAccess(access, requiredRole) {
  if (!access?.isAuthenticated) {
    return Object.freeze({ allowed: false, code: "UNAUTHENTICATED", message: "Faça login para continuar." });
  }

  if (access.tenantStatus !== "READY") {
    return Object.freeze({ allowed: false, code: "TENANT_NOT_READY", message: "Este estabelecimento não está disponível." });
  }

  if (access.membershipStatus === "MISSING") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_MISSING",
      message: "Usuário não cadastrado neste estabelecimento.",
    });
  }

  if (access.membershipStatus === "INACTIVE") {
    return Object.freeze({
      allowed: false,
      code: "MEMBERSHIP_INACTIVE",
      message: "Seu acesso neste estabelecimento está inativo.",
    });
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
