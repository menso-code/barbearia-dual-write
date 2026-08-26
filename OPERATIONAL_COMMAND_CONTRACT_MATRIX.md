# Operational Command Contract Matrix

Fonte normativa: `functions/dual-write.js`. O envelope callable é `{ command, requestId, data }`; a autenticação vem de `request.auth.uid`. Em HML, `resolveOperationalUid()` aplica `homologacao_mapeamentos/{authUid}` antes dos comandos operacionais.

| Comando | Dados principais | Papel/identidade | Legado/V2 e atomicidade | Idempotência/erros principais |
|---|---|---|---|---|
| cliente.garantir-perfil | `extras` opcional | autenticado; próprio cliente | cliente, membro e `usuarios` em transação | requestId; argumentos inválidos |
| cliente.atualizar-perfil | campos de perfil permitidos | autenticado; próprio cliente | cliente + V2; `usuarios.nome` opcional, transação | requestId; perfil ausente/sem alteração |
| assinatura.solicitar | `planId` | autenticado; próprio cliente | solicitação + V2, transação | pendente existente = already-exists |
| agenda.disponibilidade.obter | `data`, `slug`; sem `tenantId` ou path | CLIENTE ativo no tenant resolvido server-side pelo slug | leitura derivada V2 de funcionamento, fechamento e abertura; resposta mínima sem metadados administrativos; zero writes | requestId apenas estrutural; sem log/idempotency write; data, tenant e membership inválidos são rejeitados |
| bloqueio.criar | barbeiro, data, início/fim, motivo | ADMIN ou barbeiro dono | bloqueio + ocupações Legado/V2, transação | requestId; horário ocupado/fora expediente |
| bloqueio.remover | `blockId` | ADMIN ou barbeiro dono | bloqueio + ocupações correspondentes, transação | requestId; inexistente/sem permissão |
| agenda.criar | barbeiro, serviço, data, horário; cliente/origem opcionais | ADMIN, barbeiro dono ou cliente permitido | agendamento + ocupações Legado/V2; créditos de assinatura quando aplicável, transação | replay por requestId; horário ocupado/indisponível |
| agenda.reagendar | `appointmentId`, serviço/data/horário | permissão do agendamento | novo agendamento, cancelamento do antigo e ocupações Legado/V2, mesma transação | replay por requestId; alvo ocupado/estado inválido |
| agenda.cliente_chegou | `appointmentId` | ADMIN ou barbeiro dono | atualização de agendamento Legado/V2 | estado deve ser `agendado` |
| agenda.em_atendimento | `appointmentId` | ADMIN ou barbeiro dono | atualização de agendamento Legado/V2 | estado deve ser `cliente_chegou` |
| agenda.concluir | `appointmentId` | ADMIN ou barbeiro dono | agendamento Legado/V2; crédito/histórico quando assinatura | estado ativo; crédito inválido |
| agenda.cancelar | `appointmentId` | ADMIN, barbeiro dono ou cliente do agendamento | agendamento Legado/V2; ocupações removidas; crédito reservado liberado | estado ativo; crédito inválido |
| agenda.nao_compareceu | `appointmentId` | ADMIN ou barbeiro dono | agendamento Legado/V2; ocupações removidas; crédito consumido quando assinatura | estado ativo; crédito inválido |
| admin.funcionamento.salvar | intervalo, períodos, dias fechados | ADMIN do tenant | funcionamento Legado/V2, transação | campos extras/intervalo inválidos |
| admin.estudio.identidade.salvar | identidade visual permitida (nome, logo, cores e dados institucionais; favicon é global GoEstudio) | ADMIN ativo no membership do tenant resolvido | documento V2 `barbearias/{tenantId}/configuracoes/identidade`, sem mirror legado, transação | requestId; tenantId/campos extras, favicon tenant-scoped, cores, URLs e limites inválidos |
| admin.abertura.salvar/remover | data, horários, motivo | ADMIN do tenant | fechamento global Legado/V2, transação | horários/IDs inválidos |
| admin.fechamento.salvar/remover | datas, período, motivo, IDs | ADMIN do tenant | fechamentos globais Legado/V2, transação | período/IDs inválidos |
| admin.barbeiro.salvar | cadastro e `email_acesso` | ADMIN do tenant | barbeiro, vínculo/membro e índice de e-mail, transação | `tx.create` do índice; conflito de unicidade |
| admin.barbeiro.ativar/remover | `id` e, ao ativar, `ativo` | ADMIN do tenant | barbeiro, membro/vínculo e índice na remoção, transação | owner guard no índice |
| admin.servico.salvar/remover | cadastro ou `id` | ADMIN do tenant | serviço Legado/V2, transação | validação de duração/preço |
| admin.plano.salvar/inicial/ativar | cadastro, serviços ou `id` | ADMIN do tenant | plano Legado/V2, transação | serviços inexistentes/estado inválido |
| admin.assinatura.aprovar/recusar/renovar/cancelar/expirar | `id`, motivo opcional | ADMIN do tenant | solicitação, plano e créditos Legado/V2, transação | estado e créditos inválidos |

## Authorization and tenancy

- HML: Auth UID → `homologacao_mapeamentos` → UID operacional; produção usa o Auth UID diretamente.
- Administração exige `admins/{uid}` no tenant resolvido.
- Os comandos mutáveis legados ainda usam um `TENANT_ID` fixo. A leitura `agenda.disponibilidade.obter` resolve o tenant no servidor pelo slug canônico e nunca aceita `tenantId` como autorização.
- `email_acesso_index` é namespaced por tenant; e-mail igual em tenants distintos não conflita arquiteturalmente.
- A auditoria estática não encontrou lookup global por e-mail concedendo papel.

## Agenda state machine

`agendado → cliente_chegou → em_atendimento → concluido`.

De `agendado`, `cancelar` e `nao_compareceu` são permitidos. De `cliente_chegou` e `em_atendimento`, a validação comum exige estado ativo; transições de chegada/atendimento têm estados-alvo explícitos. Estados terminais não podem ser processados novamente.

## Coverage status

HML/prod proof exists for `agenda.criar`, cancellation and `admin.barbeiro.salvar` uniqueness. The directed HML fixture flow for `admin.barbeiro.ativar` is closed as `CLOSED_HML_ONLY`, including create, activation, same-request replay, restore, cleanup and zero-residue proof. The consolidated coverage matrix has `MISSING_COVERAGE = 0` and `P2_GAPS = NENHUM`; remaining deferred commands stay governed by their existing non-reversibility policy.
