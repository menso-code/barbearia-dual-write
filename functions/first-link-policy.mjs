export function normalizarEmail(email) {
  return String(email || "").trim().toLowerCase();
}

export function emailAutorizado(email, autorizado) {
  return normalizarEmail(email) === normalizarEmail(autorizado);
}

export function unirPapeisPrimeiroVinculo(existingRoles = []) {
  const roles = Array.isArray(existingRoles) ? existingRoles.filter((role) => typeof role === "string") : [];
  return [...new Set([...roles, "CLIENTE", "BARBEIRO"])].sort();
}
