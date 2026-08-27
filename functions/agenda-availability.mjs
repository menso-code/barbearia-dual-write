import {
  TENANT_SLUG_STATUSES,
  TenantSlugError,
  normalizeTenantSlug,
  resolveTenantSlug,
} from "./tenant-slug.mjs";

export const AGENDA_AVAILABILITY_CODES = Object.freeze({
  AVAILABLE: "AVAILABLE",
  CLOSED: "CLOSED",
  OUTSIDE_BUSINESS_HOURS: "OUTSIDE_BUSINESS_HOURS",
  NO_AVAILABILITY: "NO_AVAILABILITY",
});

export class AgendaAvailabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "AgendaAvailabilityError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new AgendaAvailabilityError(code, message);
}

function snapshotData(snapshot) {
  return snapshot?.exists ? snapshot.data() : null;
}

function normalizeDate(value) {
  const date = String(value ?? "").trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) fail("INVALID_DATE", "Data inválida.");
  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const parsed = new Date(Date.UTC(year, month - 1, day, 12));
  if (
    parsed.getUTCFullYear() !== year
    || parsed.getUTCMonth() !== month - 1
    || parsed.getUTCDate() !== day
  ) {
    fail("INVALID_DATE", "Data inválida.");
  }
  return date;
}

function normalizeTime(value) {
  const time = String(value ?? "").trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    fail("INVALID_AVAILABILITY_CONFIG", "Disponibilidade indisponível.");
  }
  return time;
}

function minutes(value) {
  const [hour, minute] = normalizeTime(value).split(":").map(Number);
  return hour * 60 + minute;
}

function normalizePeriods(value) {
  if (!Array.isArray(value)) fail("INVALID_AVAILABILITY_CONFIG", "Disponibilidade indisponível.");
  return value.map((period) => {
    if (!period || typeof period !== "object" || Array.isArray(period)) {
      fail("INVALID_AVAILABILITY_CONFIG", "Disponibilidade indisponível.");
    }
    const inicio = normalizeTime(period.inicio);
    const fim = normalizeTime(period.fim);
    if (minutes(fim) <= minutes(inicio)) {
      fail("INVALID_AVAILABILITY_CONFIG", "Disponibilidade indisponível.");
    }
    return { inicio, fim };
  });
}

function weekdayFor(date) {
  return new Date(`${date}T12:00:00Z`).getUTCDay();
}

function defaultPeriods(date) {
  const weekday = weekdayFor(date);
  if (weekday === 0) return [];
  return [
    { inicio: "08:30", fim: "12:00" },
    { inicio: "13:00", fim: weekday <= 4 ? "19:30" : "20:30" },
  ];
}

function configuredPeriods(date, config) {
  const configured = config?.periodos_semana?.[weekdayFor(date)];
  return configured === undefined ? defaultPeriods(date) : normalizePeriods(configured);
}

function exceptionalOpeningPeriods(opening) {
  if (!opening || opening.ativo === false || opening.tipo !== "abertura") return null;
  return normalizePeriods([{
    inicio: opening.inicio_horario || "08:30",
    fim: opening.fim_horario || "21:00",
  }]);
}

function result(data, closed, effectiveOpenPeriods, publicMessageCode) {
  return Object.freeze({
    data,
    closed,
    effectiveOpenPeriods: effectiveOpenPeriods.map((period) => Object.freeze({ ...period })),
    publicMessageCode,
  });
}

export function deriveAgendaAvailability({ data: rawDate, config, closure, opening }) {
  const data = normalizeDate(rawDate);
  if (closure && closure.ativo !== false) {
    return result(data, true, [], AGENDA_AVAILABILITY_CODES.CLOSED);
  }

  const openingPeriods = exceptionalOpeningPeriods(opening);
  if (openingPeriods) {
    return result(data, false, openingPeriods, AGENDA_AVAILABILITY_CODES.AVAILABLE);
  }

  const weekday = weekdayFor(data);
  const weeklyClosed = config?.dias_fechados_semana?.[weekday] === true
    || (config?.dias_fechados_semana?.[weekday] === undefined && !config && weekday === 0);
  if (weeklyClosed) return result(data, true, [], AGENDA_AVAILABILITY_CODES.CLOSED);

  const periods = configuredPeriods(data, config);
  if (!periods.length) {
    return result(data, true, [], AGENDA_AVAILABILITY_CODES.NO_AVAILABILITY);
  }
  return result(data, false, periods, AGENDA_AVAILABILITY_CODES.AVAILABLE);
}

export async function getTenantAgendaAvailability({ db, tenantId: rawTenantId, data: rawDate }) {
  if (!db?.doc) fail("INVALID_ADAPTER", "Serviço indisponível.");
  const tenantId = String(rawTenantId ?? "").trim();
  if (!tenantId || tenantId.length > 200 || tenantId.includes("/")) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }
  const data = normalizeDate(rawDate);
  const [configSnapshot, closureSnapshot, openingSnapshot] = await Promise.all([
    db.doc(`barbearias/${tenantId}/configuracoes/funcionamento`).get(),
    db.doc(`barbearias/${tenantId}/fechamentos/${data}`).get(),
    db.doc(`barbearias/${tenantId}/fechamentos/abertura_${data}`).get(),
  ]);
  return deriveAgendaAvailability({
    data,
    config: snapshotData(configSnapshot),
    closure: snapshotData(closureSnapshot),
    opening: snapshotData(openingSnapshot),
  });
}

function requireClientMembership(snapshot) {
  const member = snapshotData(snapshot);
  if (
    !member
    || member.ativo !== true
    || !Array.isArray(member.papeis)
    || !member.papeis.includes("CLIENTE")
  ) {
    fail("CLIENT_MEMBERSHIP_REQUIRED", "Acesso não autorizado.");
  }
}

function mapSlugError(cause) {
  if (!(cause instanceof TenantSlugError)) throw cause;
  if ([
    "INVALID_SLUG",
    "RESERVED_SLUG",
    "SLUG_TOO_SHORT",
    "SLUG_TOO_LONG",
    "XN_PREFIX_FORBIDDEN",
  ].includes(cause.code)) {
    fail("INVALID_SLUG", "Estabelecimento inválido.");
  }
  if (cause.code === "SLUG_NOT_FOUND") fail("TENANT_NOT_FOUND", "Estabelecimento não encontrado.");
  fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
}

export async function getDerivedAgendaAvailability({ db, slug: rawSlug, uid, data: rawDate }) {
  if (!db?.doc) fail("INVALID_ADAPTER", "Serviço indisponível.");
  const data = normalizeDate(rawDate);
  const actorUid = String(uid ?? "").trim();
  if (!actorUid || actorUid.includes("/")) fail("CLIENT_MEMBERSHIP_REQUIRED", "Acesso não autorizado.");

  let slug;
  let resolution;
  try {
    slug = normalizeTenantSlug(rawSlug);
    resolution = await resolveTenantSlug({ db, slug });
  } catch (cause) {
    mapSlugError(cause);
  }
  if (resolution?.status !== TENANT_SLUG_STATUSES.ACTIVE || !resolution.tenantId) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }

  const tenantId = resolution.tenantId;
  const tenantSnapshot = await db.doc(`barbearias/${tenantId}`).get();
  const tenant = snapshotData(tenantSnapshot);
  if (!tenant || tenant.status !== TENANT_SLUG_STATUSES.ACTIVE || tenant.slug !== slug) {
    fail("TENANT_UNAVAILABLE", "Estabelecimento indisponível.");
  }

  const membershipSnapshot = await db.doc(`barbearias/${tenantId}/membros/${actorUid}`).get();
  requireClientMembership(membershipSnapshot);

  return getTenantAgendaAvailability({ db, tenantId, data });
}
