# CURRENT PRODUCTION STATE

> **Estado canônico pós-go-live — atualizado em 23/08/2026**

- GO_LIVE = **CONCLUÍDO**
- POST_GO_LIVE_ENGINEERING_STATUS = **STABLE**
- Projeto de produção: `barber-a01e7`
- `executeOperationalCommand`: ACTIVE, Gen 2, `southamerica-east1`, Node.js 22.
- Revisão: `executeoperationalcommand-00003-cel`.
- `auditDualRead`: ACTIVE / PRESERVADA.
- Hosting live: versão `c0fa7920e0d74383`.
- Baseline Hosting pré-cutover: `pre-cutover` / `0bf6114d9e83148e`; confirmar expiração antes de tratá-lo como rollback.
- Rules ativo: release `cloud.firestore`, ruleset `49df51e7-9d0e-404b-a866-87a94c1a3b37`.

## Auditoria local pós-baseline — 23/08/2026

- Baseline Git canônico: `v1.0.0-hml-validated` em `91728b96535b5a83e6eb84a13c7223286af18211`.
- `DATA_MODEL_MULTI_TENANT = SIM` e `AUTHORIZATION_MULTI_TENANT = SIM`; `RUNTIME_TENANT_RESOLUTION = FIXED_TENANT` é uma limitação arquitetural conhecida.
- Fingerprint SHA-256 confirmado para `public/js/agenda.js`: `5986FB990D06D80E900F4154FC94755D5ED34D606D6A40B2A92358AFF6756BEF`.
- O drift encontrado nas transições de agenda do pacote HML foi corrigido localmente para usar `data.appointmentId`; nenhuma Function foi alterada.
- Rollback Function confirmado para `executeoperationalcommand-00002-pos`; rollback Hosting apontado para `pre-cutover / 0bf6114d9e83148e`; a versão anterior de Rules continua não identificada.
- Artefatos locais de credenciais/cache foram movidos para fora da árvore do projeto, preservando a cobertura do `.gitignore`.

## First controlled production flow

`agenda.criar`, Dual Write Legado/V2 e cancelamento pelo frontend foram comprovados. O estado final foi `cancelado` em Legado e V2, com ambas as ocupações ausentes, `ACTIVE_RESIDUE = NÃO`, equivalência final Legado/V2, `PARTIAL_WRITE = NÃO`, `CLEANUP_ZERO_RESIDUE = PASS` e `FINAL_PRODUCTION_FLOW_RESULT = PASS`.

## Idempotência

COMPROVADA: primeira chamada non-replay, segunda chamada replay, mesmo `appointmentId`, uma entidade lógica, uma ocupação lógica e equivalência Legado/V2.

## Segurança e operação

Runtime service account dedicada com role mínima Firestore; nenhuma chave criada; nenhuma conta administrativa reutilizada; autenticação, autorização e isolamento preservados. Logs recentes com severity `>= ERROR`: zero resultados. Rollback não necessário. P0: nenhum. P1: nenhum.

## P2 — backlog pós-go-live

- Cobertura automatizada desigual dos cinco comandos diferidos por política.
- Organização/arquivamento dos artefatos HML.
- Revisão futura das mensagens de erro em logs.
- Nome histórico `homologation-identity.js`.
- Manutenção da documentação de contratos e rollback.
- `.firebaserc` mantém produção como projeto padrão; deploy exige projeto explícito.
- `RUNTIME_TENANT_RESOLUTION = FIXED_TENANT` permanece limitação arquitetural conhecida.

> **HISTÓRICO/SUPERADO:** todo o conteúdo abaixo registra a preparação
> anterior ao go-live. Qualquer ocorrência de `GO-LIVE BLOQUEADO`, Function
> ausente, idempotência não comprovada ou cutover pendente refere-se somente
> ao estado histórico datado e não ao estado atual.

# GO-LIVE READINESS — BARBEARIA ANTUNES (HISTÓRICO/SUPERADO)

Data da revisão: 20/08/2026
Escopo: HML `teste-483f6`; produção `barber-a01e7` não alterada.

## Resultado executivo

**HISTÓRICO/SUPERADO — ❌ GO-LIVE BLOQUEADO**

Bloqueio técnico restante nesta revisão:

1. Produzir evidência formal de idempotência de `agenda.criar` com o mesmo `requestId`, comprovando segunda execução sem duplicação nem escrita parcial. O plano está em `AGENDA_CRIAR_IDEMPOTENCY_TEST_PLAN_HML.md` e não foi executado.

A inconsistência documental do reset foi resolvida por atualização do relatório intermediário. O estado posterior comprovado registra o reset concluído e validado. Os três placeholders V2 foram verificados como não operacionais: `ativo:false`, sem `servicos_ids` e sem preço comercial válido; o frontend filtra planos ativos e a Function rejeita plano indisponível. Eles permanecem documentados como `NON_OPERATIONAL_LEGACY_PLACEHOLDER` e não bloqueiam o Go-Live.

## Matriz de prontidão

| Item | Estado | Classificação / evidência |
|---|---|---|
| Tintura | PENDENTE | `POST_GO_LIVE_PENDING_SERVICE`; duração/preço não devem ser inventados. |
| WhatsApp, Instagram e endereço | PENDENTE | `POST_GO_LIVE`, desde que os valores estáticos atualmente exibidos estejam corretos. Não criar coleção nova. |
| Identidade visual | READY | Logo e configuração visual existentes no frontend HML. |
| Serviços reais | READY | 38 serviços em Legado/V2, 38 equivalentes. |
| Planos reais | READY COM RESSALVA | 4 planos comerciais equivalentes; 3 placeholders V2 extras ainda precisam ser classificados/limpos antes do cutover. |
| Funcionamento | READY | Seg–Qui 08:30–20:00; Sex–Sáb 08:30–21:00; domingo fechado; exceções e limite de duração homologados em HML. |
| Admin real | READY | Reset final e vínculo Admin preservado estão comprovados no relatório aplicado e na validação posterior. |
| Barbeiros reais | READY | Samuel, Lucas e Rafael ativos e equivalentes; Auth individual não é requisito para cadastro/agendamento. |
| Auth de barbeiros | POST_GO_LIVE | Obrigatório apenas para quem acessar o Painel do Barbeiro; não bloquear operação por ausência de Auth. |
| Disponibilidade individual | BLOCKED | Deve ser definida para cada barbeiro que atenderá no lançamento. |
| Serviços compatíveis por barbeiro | BLOCKED | Deve ser confirmado para evitar catálogo reservável incompatível. |
| Placeholders V2 | READY COM CLASSIFICAÇÃO | 3 extras conhecidos, inativos, sem `servicos_ids` e sem preço comercial; classificados como `NON_OPERATIONAL_LEGACY_PLACEHOLDER`. |
| Idempotência `agenda.criar` | BLOCKED | Implementação existe, mas a reexecução observada com o mesmo `requestId` ainda não está documentada. |
| Service Worker | READY COM MONITORAMENTO | Não há bloqueio funcional documentado; manter verificação de atualização/cache no smoke test. |
| Reconciliação HML Legado × V2 | READY COM RESSALVA | 46 Legado / 49 V2 / 46 equivalentes / 0 ausentes / 0 divergentes / 0 órfãos; extras são os 3 placeholders conhecidos. |
| Escritas diretas no frontend | READY | Auditoria estática indica fluxo via `executeOperationalCommand`. |
| Functions autenticadas | READY | Function valida autenticação, tenant, papel e `requestId`. |
| Isolamento de tenant e papéis | READY EM HML | Rules e Function restringem tenant; BARBEIRO usa `barbeiro_id`; ADMIN é limitado ao tenant. |
| SUPER_ADMIN | READY | Não implementado e não deve ser ativado. |
| Rules | READY PARA PREPARAÇÃO | Revisão HML confirma bloqueio de escrita direta; preflight de produção continua sendo etapa do cutover, fora desta análise. |
| Functions | READY PARA PREPARAÇÃO | Lista e runtime Node 22 definidos; publicação futura ainda depende dos bloqueios acima. |
| Hosting | READY PARA PREPARAÇÃO | HML usa `public-hml`; produção usa `public`; cutover futuro deve ser separado. |
| `system/version` / `tenancy.mode` | BLOCKED PARA CUTOVER | A mudança de modo é operação de cutover, não deve ocorrer agora; confirmar estado do destino no preflight. |
| Tenant Antunes | READY EM HML | `tnt_80b2fda7ad644a1dbeff050aa8e0d595`, slug `antunes`. |

## Itens que podem ficar para depois

- Cadastro de Auth para Lucas, Rafael ou qualquer barbeiro que não precise do painel.
- Tintura, até existirem duração e preço aprovados.
- Persistência dinâmica de WhatsApp, Instagram e endereço, se o conteúdo exibido estiver correto.
- SUPER_ADMIN, onboarding SaaS, billing, integrações e webhooks.
- Melhorias de Service Worker sem impacto funcional confirmado.

## Reconciliação HML

Fonte: `reports/dual-write/hml-dual-write-reconciliation-2026-08-20T16-32-33-530Z.json`.

- Escritas durante a auditoria: 0.
- Barbeiros: 3/3 equivalentes.
- Serviços: 38/38 equivalentes.
- Configuração: 1/1 equivalente.
- Agenda, ocupações, bloqueios, solicitações, históricos e financeiro: vazios nos dois modelos.
- Ausentes V2: 0.
- Divergências: 0.
- Órfãos de ocupação: 0.
- Extras V2: 3 placeholders de planos, todos conhecidos e classificados como pendência.

## Preparação futura, sem executar

Functions a publicar: o conjunto definido em `functions/index.js` e `functions/dual-write.js`, com runtime Node.js 22.
Rules: `firestore.dual-write.hml.rules` é somente referência de HML; a versão de produção deverá ser revisada e aprovada separadamente.
Hosting: publicar o conteúdo de `public` no site de produção somente após o preflight.
Modo: manter o destino no modo seguro atual até a janela de cutover; ativar a arquitetura multi-tenant somente como etapa explícita e reversível.

## Cutover proposto

1. Snapshot imutável e auditoria final.
2. Resolver os bloqueios acima.
3. Publicar Functions, Rules e Hosting na ordem aprovada.
4. Validar ainda no modo seguro.
5. Executar smoke test mínimo.
6. Alterar o modo de tenancy de forma administrativa e auditável.
7. Monitorar logs e métricas.
8. Em erro, retornar imediatamente ao modo anterior e interromper a fase.

Nenhuma etapa foi executada nesta revisão.
