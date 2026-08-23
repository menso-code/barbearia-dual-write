// ============================================================================
// CONTEXTO DA BARBEARIA (TENANT)
// ============================================================================
// Esta é a única fonte do tenant no frontend. Enquanto a migração para
// múltiplas barbearias acontece, toda a aplicação continua apontando de forma
// determinística para a Barbearia Antunes. Não usamos query string,
// localStorage ou valor editável pelo navegador para escolher o tenant: a
// autorização definitiva continuará sendo conferida pelo Firestore.

// ID interno, estável e independente de nome/URL. Ele será o ID da primeira
// tenant quando a escrita real da Fase 3C for aprovada.
export const BARBEARIA_PADRAO_ID = "tnt_80b2fda7ad644a1dbeff050aa8e0d595";
export const BARBEARIA_PADRAO_SLUG = "antunes";

/**
 * Retorna o identificador da barbearia em uso na interface atual.
 *
 * A futura resolução por domínio/slug só será ativada junto com as regras e
 * com a migração dos dados. Até lá, manter o padrão fixo impede que uma
 * alteração no DevTools faça a aplicação consultar dados de outra empresa.
 */
export function getBarbeariaAtual() {
  return BARBEARIA_PADRAO_ID;
}

/** Slug público para URL e marca; nunca deve ser usado como chave de banco. */
export function getSlugBarbeariaAtual() {
  return BARBEARIA_PADRAO_SLUG;
}

/**
 * Compatibilidade temporária para documentos antigos, criados antes do campo
 * `barbearia_id`. Eles pertencem somente ao tenant padrão durante a migração.
 * Um tenant novo nunca deve enxergá-los por esse fallback.
 */
export function documentoPertenceABarbeariaAtual(dados = {}, barbeariaId = getBarbeariaAtual()) {
  const idDoDocumento = String(dados?.barbearia_id || "").trim();
  return idDoDocumento
    ? idDoDocumento === barbeariaId
    : barbeariaId === BARBEARIA_PADRAO_ID;
}

/** Acrescenta o tenant apenas aos novos documentos da migração gradual. */
export function comBarbeariaAtual(dados = {}) {
  return { ...dados, barbearia_id: getBarbeariaAtual() };
}
