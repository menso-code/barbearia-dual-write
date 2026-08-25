const TERMINAL_APPOINTMENT_STATUS = new Set([
  "cancelado",
  "cancelada",
  "concluido",
  "nao_compareceu",
]);

const ACTIVE_APPOINTMENT_STATUS = new Set([
  "agendado",
  "confirmado",
  "cliente_chegou",
  "em_atendimento",
]);

const CURRENT_SUBSCRIPTION_STATUS = new Set(["ATIVA", "PENDENTE"]);

function text(value) {
  return String(value ?? "").trim();
}

export function normalizeSearch(value) {
  return text(value)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase("pt-BR")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizePhone(value) {
  return text(value).replace(/\D/g, "");
}

function phoneFromClient(client = {}) {
  return [
    client.telefone,
    client.whatsapp,
    client.phone,
    client.telefone_cliente,
    client.celular,
  ].map(normalizePhone).find(Boolean) || "";
}

function epoch(value) {
  if (value && typeof value.toMillis === "function") return value.toMillis();
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

export function appointmentEpoch(appointment = {}) {
  const date = text(appointment.data);
  const time = text(appointment.horario) || "00:00";
  return epoch(date ? `${date}T${time}` : appointment.criado_em);
}

function sortNewestFirst(items) {
  return [...items].sort((a, b) => appointmentEpoch(b) - appointmentEpoch(a));
}

function subscriptionEpoch(subscription = {}) {
  return epoch(
    subscription.atualizado_em
      || subscription.ativado_em
      || subscription.solicitado_em
      || subscription.criado_em,
  );
}

export function summarizeSubscription(subscriptions = [], now = new Date()) {
  const entries = subscriptions
    .filter(Boolean)
    .map((subscription) => ({
      ...subscription,
      status: text(subscription.status).toUpperCase(),
    }))
    .sort((a, b) => subscriptionEpoch(b) - subscriptionEpoch(a));

  const current = entries.find((entry) => {
    if (!CURRENT_SUBSCRIPTION_STATUS.has(entry.status)) return false;
    if (entry.status !== "ATIVA") return true;
    const expiration = epoch(entry.vencimento_em);
    return !expiration || expiration > now.getTime();
  });
  const selected = current || entries[0] || null;

  return {
    hasRecord: entries.length > 0,
    hasCurrentOrPending: Boolean(current),
    status: selected?.status || "SEM ASSINATURA",
    planName: text(selected?.plano_nome || selected?.plano_id),
    updatedAt: selected ? subscriptionEpoch(selected) : 0,
  };
}

function appointmentIsFuture(appointment, now) {
  return ACTIVE_APPOINTMENT_STATUS.has(text(appointment.status).toLowerCase())
    && appointmentEpoch(appointment) >= now.getTime();
}

export function buildCustomerRecords({
  clients = [],
  appointments = [],
  subscriptions = [],
  now = new Date(),
} = {}) {
  const byId = new Map();

  clients.forEach((item) => {
    const id = text(item.id || item.uid);
    if (!id) return;
    const data = item.data || item;
    byId.set(id, {
      id,
      name: text(data.nome || data.displayName || data.email) || "Cliente sem nome",
      phone: phoneFromClient(data),
      email: text(data.email),
      appointments: [],
      subscriptions: [],
    });
  });

  appointments.forEach((appointment) => {
    const id = text(appointment.cliente_id);
    if (!id) return;
    const current = byId.get(id) || {
      id,
      name: text(appointment.cliente_nome) || "Cliente sem nome",
      phone: normalizePhone(appointment.cliente_whatsapp),
      email: text(appointment.cliente_email),
      appointments: [],
      subscriptions: [],
    };
    if (!current.name || current.name === "Cliente sem nome") {
      current.name = text(appointment.cliente_nome) || current.name;
    }
    if (!current.phone) current.phone = normalizePhone(appointment.cliente_whatsapp);
    current.appointments.push({ ...appointment, id: text(appointment.id) });
    byId.set(id, current);
  });

  subscriptions.forEach((subscription) => {
    const id = text(subscription.cliente_id);
    if (!id) return;
    const current = byId.get(id) || {
      id,
      name: text(subscription.cliente_nome) || "Cliente sem nome",
      phone: normalizePhone(subscription.cliente_telefone || subscription.cliente_whatsapp),
      email: text(subscription.cliente_email),
      appointments: [],
      subscriptions: [],
    };
    current.subscriptions.push(subscription);
    byId.set(id, current);
  });

  return [...byId.values()]
    .map((customer) => {
      const appointmentsForCustomer = sortNewestFirst(customer.appointments);
      const future = appointmentsForCustomer
        .filter((appointment) => appointmentIsFuture(appointment, now))
        .sort((a, b) => appointmentEpoch(a) - appointmentEpoch(b));
      const subscription = summarizeSubscription(customer.subscriptions, now);
      return {
        ...customer,
        appointments: appointmentsForCustomer,
        totalAppointments: appointmentsForCustomer.length,
        lastAppointment: appointmentsForCustomer.find(
          (appointment) => appointmentEpoch(appointment) < now.getTime()
            && text(appointment.status).toLowerCase() === "concluido",
        ) || null,
        nextAppointment: future[0] || null,
        subscription,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

export function filterCustomerRecords(records = [], { search = "", filter = "all" } = {}) {
  const normalized = normalizeSearch(search);
  const digits = normalizePhone(search);
  return records.filter((customer) => {
    if (filter === "future" && !customer.nextAppointment) return false;
    if (filter === "subscription" && !customer.subscription.hasCurrentOrPending) return false;
    if (!normalized && !digits) return true;
    const searchableName = normalizeSearch(customer.name);
    const searchablePhone = normalizePhone(customer.phone);
    return searchableName.includes(normalized)
      || (digits.length > 0 && searchablePhone.includes(digits));
  });
}

export function statusLabel(status) {
  const labels = {
    agendado: "Agendado",
    confirmado: "Confirmado",
    cliente_chegou: "Cliente chegou",
    em_atendimento: "Em atendimento",
    concluido: "Concluído",
    cancelado: "Cancelado",
    nao_compareceu: "Não compareceu",
    legacy_unresolved: "Status não definido",
  };
  return labels[text(status).toLowerCase()] || text(status) || "Sem status";
}

export function isTerminalAppointment(appointment) {
  return TERMINAL_APPOINTMENT_STATUS.has(text(appointment?.status).toLowerCase());
}
