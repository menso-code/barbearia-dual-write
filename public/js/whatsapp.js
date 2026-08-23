export function normalizarNumeroWhatsApp(numero) {
  let digitos = String(numero || "").replace(/\D/g, "");
  if (digitos.startsWith("00")) digitos = digitos.slice(2);
  if (/^55\d{10,11}$/.test(digitos)) return digitos;
  if (/^\d{10,11}$/.test(digitos)) return `55${digitos}`;
  return "";
}

export function formatarNumeroWhatsApp(numero) {
  const whatsapp = normalizarNumeroWhatsApp(numero);
  if (!whatsapp) return "—";
  const local = whatsapp.slice(2);
  const ddd = local.slice(0, 2);
  const telefone = local.slice(2);
  return telefone.length === 9
    ? `(${ddd}) ${telefone.slice(0, 5)}-${telefone.slice(5)}`
    : `(${ddd}) ${telefone.slice(0, 4)}-${telefone.slice(4)}`;
}

export function buildReminderMessage(agendamento) {
  return `Olá, ${agendamento.cliente_nome || "cliente"}! Tudo bem? ✂️\n\nPassando para lembrar do seu horário na Barbearia Antunes.\n\n🗓️ ${String(agendamento.data || "").split("-").reverse().join("/")}\n⌚ ${agendamento.horario || ""}\n💈 Barbeiro: ${agendamento.barbeiro_nome || "seu barbeiro"}\n✂️ Serviço: ${agendamento.servico_nome || "não informado"}\n\nAté já!`;
}

export function abrirWhatsAppLembrete(agendamento) {
  const numero = normalizarNumeroWhatsApp(agendamento.cliente_whatsapp);
  if (!numero) return false;
  window.open(`https://wa.me/${numero}?text=${encodeURIComponent(buildReminderMessage(agendamento))}`, "_blank", "noopener");
  return true;
}
