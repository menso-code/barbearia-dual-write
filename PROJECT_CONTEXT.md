# CURRENT PRODUCTION STATE

> **Estado canônico pós-go-live — atualizado em 21/08/2026**
>
> GO_LIVE = **CONCLUÍDO**
> POST_GO_LIVE_ENGINEERING_STATUS = **STABLE**
> Produção: `barber-a01e7`

- `executeOperationalCommand`: ACTIVE, Gen 2, `southamerica-east1`, Node.js 22.
- Revisão comprovada: `executeoperationalcommand-00001-dec`.
- `auditDualRead`: ACTIVE e preservada.
- Hosting live: `5a35f5f7a503523b`.
- Baseline Hosting pré-cutover: canal `pre-cutover`, versão `0bf6114d9e83148e`; o canal possui expiração e deve ser verificado antes de qualquer uso como rollback.
- Rules ativo: `49df51e7-9d0e-404b-a866-87a94c1a3b37`.

## First controlled production flow — comprovado

- `agenda.criar` executou com Dual Write Legado/V2.
- Foi criada uma única entidade lógica e uma única ocupação lógica.
- O cancelamento pelo frontend foi comprovado após a correção do contrato `data.appointmentId`.
- Estado final Legado: `cancelado`.
- Estado final V2: `cancelado`.
- Ocupação Legado: ausente.
- Ocupação V2: ausente.
- `ACTIVE_RESIDUE = NÃO`.
- `LEGACY_V2_FINAL_STATE_EQUIVALENT = SIM`.
- `PARTIAL_WRITE = NÃO`.
- `CLEANUP_ZERO_RESIDUE = PASS`.
- `FINAL_PRODUCTION_FLOW_RESULT = PASS`.

## Idempotência — comprovada

- Primeira chamada: non-replay.
- Segunda chamada: replay idempotente.
- Mesmo `appointmentId`.
- Uma entidade lógica e uma ocupação lógica.
- Equivalência operacional Legado/V2.

## Segurança e operação

- Runtime service account dedicada ao Dual Write, com role mínima de operações Firestore.
- Nenhuma chave de service account foi criada.
- Nenhuma conta administrativa foi reutilizada como identidade de runtime.
- Autenticação, autorização, isolamento de tenant e escopo por `barbeiro_id` permanecem preservados.
- Consulta recente de logs com severity `>= ERROR`: zero resultados.
- Rollback não foi necessário.
- P0: nenhum. P1: nenhum.

## P2 — backlog pós-go-live

- Cobertura automatizada desigual dos comandos restantes.
- Organização/arquivamento dos artefatos HML.
- Revisão futura das mensagens de erro em logs.
- Nome histórico `homologation-identity.js`.
- Manutenção da documentação de contratos e rollback.

> As seções posteriores preservam o histórico de preparação, homologação e
> cutover. Afirmações anteriores a este estado canônico são
> HISTÓRICAS/SUPERADAS e não representam o estado atual.

ESTADO ATUAL DO PROJETO — BARBEARIA ANTUNES

O projeto é um sistema web completo de agendamento para a Barbearia Antunes, desenvolvido com HTML, CSS, JavaScript, Firebase Authentication, Firestore e Firebase Hosting.

O sistema já está funcional e publicado.

ESTRUTURA ATUAL

1. ÁREA DO CLIENTE
- Login e criação de conta.
- Escolha de barbeiro.
- Escolha de serviço.
- Escolha de data.
- Exibição somente dos horários disponíveis.
- Confirmação do agendamento.
- Página "Meus agendamentos".
- Separação entre próximos agendamentos e histórico.
- Cancelamento permitido somente respeitando antecedência mínima de 2 horas.
- Status de agendamento, concluído, cancelado e não compareceu.
- Menu da conta pelo avatar/3 pontos.
- Links de Instagram e suporte via WhatsApp.
- Aba Assinaturas: vitrine somente de planos ativos, com preço, usos mensais, serviços incluídos, validade mensal e regra de barbeiro disponível. O cliente confirma a solicitação e é criado um documento em `solicitacoes_assinatura` com status `PENDENTE`; não há ativação automática nem pagamento online. Quando há assinatura `ATIVA` e ainda válida, a vitrine é substituída por “Minha assinatura”, com plano, ativação, vencimento, status e créditos mensais somente para leitura. O botão “Usar minha assinatura” abre o fluxo Serviço → Data → Horário sem escolha de barbeiro: apenas segunda a quinta, dentro da janela normal de 10 dias, e um barbeiro ativo compatível/disponível é selecionado automaticamente no momento da confirmação. O agendamento registra origem, plano e tipo de crédito; o consumo ocorre somente na conclusão.
- Layout responsivo para desktop e mobile.

2. PAINEL DO BARBEIRO — barber.html
- Acesso exclusivo para contas vinculadas a um barbeiro.
- Vínculo do profissional através da conta Firebase.
- Cada barbeiro acessa somente seus próprios dados.
- Resumo do dia:
  - atendimentos;
  - concluídos;
  - restantes;
  - próximo cliente.
- Timeline diária.
- Visualização dos horários livres e ocupados.
- Possibilidade de criar agendamento em horário livre.
- Cliente chegou.
- Concluir atendimento.
- Reagendar.
- Não compareceu.
- Cancelar.
- Enviar lembrete pelo WhatsApp do próprio aparelho para o telefone cadastrado do cliente.
- Atualizar agenda.

3. PAINEL ADMINISTRATIVO — admin.html
- Acesso exclusivo para administrador.
- Cadastro e edição de barbeiros.
- Ativar/desativar barbeiros.
- Vincular conta de acesso do barbeiro.
- Cadastro e edição de serviços.
- Visualização de todos os agendamentos.
- Criar novo agendamento manualmente.
- Fluxo:
  Cliente → Barbeiro → Serviço → Data → Horário disponível → Confirmar.
- Filtros:
  Todos / Hoje / Amanhã / Semana / Mês.
- Filtro por barbeiro.
- Filtro por status.
- Filtro por serviço.
- Busca por cliente.
- Ordenação por data.
- Paginação.
- Atualização manual da agenda.
- Concluir atendimento.
- Cliente chegou.
- Não compareceu.
- Cancelar.
- Reagendar.
- Lembrete via WhatsApp.
- Dashboard Financeiro (aba Financeiro), com filtros por data inicial/final, barbeiro e status; faturamento realizado e previsto, atendimentos concluídos, ticket médio, cancelamentos e faltas. Exibe comparação confiável com o período anterior, gráfico local diário separado entre realizado e previsto, desempenho por barbeiro (concluídos, receita e ticket médio), ranking de serviços (quantidade e receita) e ocupação futura quando a capacidade pode ser calculada com horários, bloqueios e fechamentos existentes.
- Aba Assinaturas: Admin cadastra, edita e ativa/desativa planos mensais em `planos_assinatura`. Os modelos Essencial, Prime e Premium são criados como inativos e com preço pendente até que o Admin os configure. Há uma seção de solicitações pendentes em que o Admin aprova após confirmar o pagamento presencial (status `ATIVA`, datas de ativação/vencimento mensal e UID do Admin) ou recusa (status `RECUSADA` e UID/data). A gestão mostra Pendentes, Ativos, Expirados e Cancelados, com cliente, plano, datas e saldo de créditos. Na aprovação, a solicitação recebe `creditos_mensais` com total, utilizados (inicialmente 0) e restantes. Agendamentos por assinatura registram o plano e o tipo de crédito; a conclusão atualiza, de forma atômica, o atendimento e o crédito correspondente (restantes -1, utilizados +1) e cria um registro imutável em `historico_assinaturas` com data, serviço, barbeiro e um crédito consumido. Cancelamento não altera créditos; um não comparecimento em atendimento de assinatura consome exatamente um crédito, também de forma atômica e com histórico. Clientes autenticados podem ler somente os planos ativos e criar apenas a própria solicitação pendente, com aceite obrigatório dos Termos de Uso. Ainda não há pagamento online.

4. DISPONIBILIDADE
- Sistema controla horários disponíveis por profissional.
- Horário padrão: segunda a quinta, 08:30–12:00 e 13:00–19:30; sexta e sábado, 08:30–12:00 e 13:00–20:30. Domingo permanece fechado por padrão.
- Não permitir dois agendamentos conflitantes.
- Possibilidade de bloquear dias/horários.
- Controle para dias em que a barbearia estiver fechada, como domingos, feriados ou datas específicas.

5. SEGURANÇA
- Firebase Authentication.
- Firestore Security Rules.
- Cliente não deve conseguir acessar painel administrativo ou painel do barbeiro.
- Barbeiro acessa somente os próprios agendamentos e disponibilidade.
- Admin possui acesso administrativo.
- A segurança deve existir também nas regras do Firestore, não apenas escondendo elementos no frontend.

6. VISUAL
- Identidade atual da Barbearia Antunes.
- Tema preto, branco e verde.
- Paleta global atual centralizada no `public/css/style.css`:
  - fundo `#070A09`;
  - cards `#101512`;
  - Emerald Ink `#064E3B`;
  - destaque e ações `#35B779`;
  - títulos Ivory `#F3F0E8`;
  - texto `#E7E9E7` e secundário `#9A9F9C`;
  - bordas `#26302B`.
- Interface premium/minimalista.
- Cards modernos.
- Responsivo para desktop e mobile.
- Evitar overflow horizontal.
- Não usar fontes decorativas nos horários/números.
- Manter boa legibilidade.
- Logo da Barbearia Antunes.
- Favicon utilizando a logo da barbearia.
- Foto de perfil aceita JPG, JPEG, PNG e WebP de até 5 MB. A imagem é otimizada no navegador (proporção preservada, lado máximo de 1600 px e preferência por WebP) e armazenada compactada no próprio perfil do Firestore, sem depender do Firebase Storage ou de plano pago.
- No Admin, o cadastro e a edição de barbeiros usam o mesmo fluxo de foto por galeria: prévia, substituição ou remoção, validação de 5 MB e otimização no navegador antes de salvar o campo `foto` do barbeiro no Firestore.
- No mobile, as regras compactas do cabeçalho da Área do Cliente estão isoladas com a classe `app-shell`; assim, o menu de três pontos do cliente não oculta ou interfere nas ações dos cabeçalhos Admin e Barbeiro.
- Em dispositivos touch, botões, abas, links de suporte, perfil e o menu de ações usam alvos de toque mínimos de 44 px; o foco visível também cobre `textarea` e o menu `summary`.
- Refinamento desktop aplicado em Cliente, Conta, Barbeiro e Admin: larguras de conteúdo adequadas por área, navegação administrativa em grade, escala tipográfica e rótulos mais legíveis, cards e timeline operacionais mais consistentes, filtros/tabelas administrativos melhor organizados, Financeiro mais denso e legível, e modais com ações separadas dos campos. Nenhuma lógica de Firebase, agendamento, permissões ou cálculos foi alterada.
- A navegação superior do Admin no mobile usa rolagem horizontal por toque, sem quebra de rótulos e com o item ativo trazido à área visível ao trocar de seção.
- Os campos de data do Dashboard Financeiro respeitam a largura da célula no mobile; em 390 px e menores, a grade de filtros permanece em uma coluna.
- No header móvel da Área do Cliente, avatar e menu de três pontos possuem áreas próprias de 40 px e 24 px, separadas por 10 px, sem sobreposição.
- Na tabela de Serviços do Admin em desktop, a coluna Ações reserva espaço para Editar e Remover em uma linha; o layout mobile não foi alterado.
- O cliente pode criar novos agendamentos somente entre hoje e hoje + 10 dias corridos. A janela é calculada no seletor e validada novamente antes e dentro da transação de criação; Admin e Barbeiro não recebem essa limitação. As regras Firestore não foram alteradas, pois o campo `data` atual é texto ISO e não pode ser comparado com segurança ao relógio do servidor sem migração estrutural ou backend confiável.
- No modal desktop de Novo/Editar barbeiro, o bloco de foto usa prévia circular de 92 px, botões lado a lado e texto de ajuda imediatamente abaixo; o layout mobile foi preservado.
- O cache do PWA foi versionado para `barbearia-antunes-shell-v8`, permitindo que navegadores instalados atualizem os arquivos visuais publicados em vez de manter a versão anterior do shell.
- A tela de login/cadastro possui um painel de alternância animado: cada formulário fica em uma área recortada e exclusiva (o inativo usa opacidade zero, sem interação e invisível); a área de formulários participa do fluxo da grade e o card cresce conforme o cadastro, evitando corte dos canais de suporte. Em desktop, o formulário e o painel visual deslizam entre Entrar e Criar conta sem sair do card. Em mobile, a composição se torna vertical e compacta, também mostrando somente um formulário por vez. A animação respeita `prefers-reduced-motion` e a lógica existente de login, cadastro, validação, Instagram e suporte foi preservada.
- No bloco institucional da tela de login/cadastro, a logo e o slogan ficam centralizados dentro de toda a área esquerda. A logo preserva a proporção (`object-fit: contain`), com 130–150 px no desktop e 90–100 px no mobile; o card e os formulários não foram alterados.
- A Área do Cliente possui uma seção fixa “Onde estamos” acima do rodapé e fora das abas dinâmicas. Ela permanece visível em todas as três abas, usa o link oficial do Google Maps da barbearia em nova aba e não utiliza iframe ou serviços externos adicionais.
- A navegação principal da Área do Cliente (Escolher barbeiro, Assinaturas e Meus agendamentos) usa um controle segmentado Liquid Glass: superfície escura translúcida, borda emerald sutil e indicador único que desliza entre os itens ativos. Em mobile, os três itens continuam dentro da largura disponível sem rolagem horizontal; nenhuma lógica de navegação foi modificada.
- O controle Liquid Glass da Área do Cliente mantém 44 px de alvo de toque por item, mas seu indicador ativo é um chip centralizado de aproximadamente 38 px: elevação de 1 px, raio de 11 px e blur/sombras muito discretos. O indicador continua deslizando entre as três opções e a composição móvel permanece sem overflow.
- Em Admin → Assinaturas, a gestão de assinantes possui busca local combinada ao filtro de status. A busca compara nome (sem diferenciar maiúsculas, acentos ou espaços extras), e-mail e telefone/WhatsApp (ignorando máscara e DDI), usa o cache da lista e dos perfis de clientes e não faz consultas por caractere digitado. Há estado vazio e botão para limpar a busca.
- Os planos de assinatura vinculam serviços reais por `servicos_ids` (IDs dos documentos de `servicos`), selecionados pelo Admin no cadastro/edição. Em uma nova aprovação, a assinatura recebe o mesmo conjunto de IDs e um crédito separado por serviço: `usos_mensais ÷ quantidade de serviços incluídos`. No fluxo de assinatura, o cliente vê somente esses serviços com o rótulo “Incluso no plano”; o fluxo normal continua exibindo todo o catálogo e não cria vínculo ou consumo de assinatura. Agendamentos por assinatura passaram a reservar o crédito correspondente na mesma transação que cria o agendamento. O crédito é efetivamente consumido somente em `CONCLUÍDO` ou `NÃO COMPARECEU`; no cancelamento, a reserva é liberada. A disponibilidade para novas reservas é calculada por `restantes - reservados`, impedindo que créditos já comprometidos por horários futuros sejam reutilizados. Assinaturas ativas anteriores receberam uma migração administrativa silenciosa ao abrir a gestão de Assinaturas, adicionando os contadores de reservas a partir dos horários futuros já existentes. Planos e assinaturas antigos sem `servicos_ids` não são adivinhados: o Admin deve selecionar os serviços corretos antes de novas aprovações.
- Na Área do Cliente, se todos os créditos de uma assinatura ativa tiverem `restantes = 0`, o card troca para o estado visual “Seus créditos acabaram”, mantém plano, datas, status e utilização, e remove o botão de usar a assinatura. Nenhum saldo, vencimento ou regra de negócio é alterado.
- A aba Assinaturas do cliente carrega todos os documentos próprios de `solicitacoes_assinatura`, sem selecionar apenas o primeiro. Assinaturas válidas são renderizadas em cards independentes sob “Minhas assinaturas”, cada uma com créditos, validade e seu próprio botão de uso; o clique seleciona o documento correto para o fluxo de agendamento. As expiradas ficam em histórico separado e a vitrine de planos ativos continua visível abaixo.
- No mobile, a aba Assinaturas separa visualmente “Minhas assinaturas” de “Planos disponíveis”, com divisor sutil e espaçamento próprio. Solicitações `PENDENTE` também aparecem no bloco pessoal, sem botão de uso, data de solicitação e aviso de que aguardam confirmação presencial. A área de planos só aparece quando existir plano ativo disponível; no desktop, o cabeçalho extra permanece oculto para preservar o layout.
- Assinaturas passam para `EXPIRADA` de forma persistente quando o último crédito é consumido ou quando a gestão administrativa sincroniza vencimentos. O consumo do último crédito muda o status na mesma transação do atendimento e mantém o histórico; na Área do Cliente, um vencimento é bloqueado e apresentado imediatamente como expirado, sem conceder ao cliente permissão para alterar status. Assinaturas expiradas não permitem novos usos, aparecem em `EXPIRADOS` no Admin e usam card/badge dourado discreto no cliente, com a mensagem “Plano encerrado”.
- A criação de qualquer agendamento valida, na mesma transação, todos os blocos de ocupação e também o documento canônico do horário. Isso bloqueia reservas simultâneas e documentos legados sem bloco de ocupação; quando o horário fica ocupado no processo, o cliente recebe a mensagem para escolher outro. As regras do Firestore vinculam a criação/cancelamento do agendamento de assinatura à respectiva reserva/liberação de crédito, impedindo alterações isoladas pelo frontend.
- Agendamentos por assinatura registram também `assinatura_id`, com o ID real do documento selecionado pelo cliente. A transação usa esse mesmo documento para reservar, consumir ou liberar o crédito; as Rules conferem que ele pertence ao cliente autenticado, corresponde ao plano e ao serviço do agendamento e recebe a movimentação na mesma operação. Reservas antigas sem esse campo continuam usando o identificador composto legado para conclusão/cancelamento.
- A leitura pontual de um slot inexistente em `ocupacoes` é permitida para qualquer conta autenticada, pois ela é necessária para calcular disponibilidade. Registros de ocupação existentes continuam sem dados pessoais; os documentos legados que ainda contenham `cliente_id` permanecem visíveis somente ao próprio cliente, ao barbeiro responsável ou ao Admin. Assim, uma conta cliente não transforma uma vaga em “ocupada” por receber `permission-denied`.
- A transação de criação também consulta o documento canônico em `agendamentos/{barbeiroId_data_horario}` antes de gravar. As Rules permitem essa leitura somente quando o documento ainda não existe, para que clientes confirmem vagas livres sem obter acesso a agendamentos de terceiros; documentos existentes continuam restritos ao cliente titular, ao barbeiro responsável e ao Admin.
- O modal de solicitação de assinatura apresenta os 12 Termos de Uso em lista numerada, com títulos e descrições. A área dos termos possui rolagem interna por toque ou mouse, preservando o checkbox de aceite e os botões do modal sempre acessíveis.
- Em Admin → Assinaturas, o Histórico de utilização mostra data/hora, nome do cliente em destaque e os detalhes do serviço, barbeiro e crédito. Para registros antigos sem nome salvo, o painel busca o cadastro pelo `cliente_id` usando o cache já existente; se não houver dados suficientes, exibe “Cliente não identificado”.
- No modal Admin → Novo agendamento, o cliente cadastrado é associado sempre pelo ID do documento de `clientes`. Ao selecionar, o painel relê esse mesmo documento e preenche nome e WhatsApp com prioridade `telefone` → `whatsapp` → `phone` → `telefone_cliente` → `celular`; ausência de número mostra “Telefone não cadastrado”, sem reutilizar dados de outro cliente.
- O CSS compartilhado (`public/css/style.css`) foi reorganizado e formatado: regras-base de fundo, cabeçalho, botões, layout, navegação e formulários foram consolidadas em suas seções de origem, removendo uma camada redundante de sobrescritas. As regras específicas de Cliente, Barbeiro, Admin, autenticação e Safari permanecem isoladas para preservar o visual e o comportamento existentes.

IMPORTANTE

Não reconstruir o projeto do zero.
Não alterar funcionalidades que já estão funcionando.
Não trocar nome, identidade visual ou estrutura sem necessidade.
Não adicionar APIs externas ou pagamentos neste momento.
Preservar Firebase Authentication, Firestore e Hosting existentes.
Antes de alterar qualquer arquivo, analisar a implementação atual.
Fazer alterações pequenas e seguras.
Após cada alteração, validar JavaScript, regras do Firestore quando aplicável e responsividade.
Não publicar/deployar alterações quebradas.

A partir deste estado, continue evoluindo o sistema como um produto profissional de gestão e agendamento de barbearia.

## GO-LIVE PREPARATION — revisão 20/08/2026

Foi gerado `GO_LIVE_READINESS_ANTUNES.md` após revisão somente leitura da HML. A inconsistência do reset/Auth foi identificada como relatório intermediário supersededido: o relatório posterior registra o reset concluído e validado, com Admin preservado. Os três placeholders V2 (`essencial`, `premium`, `prime`) foram verificados como não operacionais (`ativo:false`, sem `servicos_ids` e sem preço comercial) e classificados como `NON_OPERATIONAL_LEGACY_PLACEHOLDER`; não bloqueiam o Go-Live. Resta como pendência técnica de evidência o teste controlado de idempotência de `agenda.criar`, cujo plano está em `AGENDA_CRIAR_IDEMPOTENCY_TEST_PLAN_HML.md` e não foi executado.

## EVOLUÇÃO MULTI-BARBEARIA — FUNDAÇÃO

- A migração para múltiplas barbearias foi iniciada sem alterar dados ou fluxos
  publicados. `public/js/tenant.js` é a fonte única do tenant no frontend e
  mantém o ID interno `tnt_80b2fda7ad644a1dbeff050aa8e0d595` como
  identificador fixo da Barbearia Antunes; `antunes` é somente o slug público.
- O módulo comum `firebase-config.js` reexporta `getBarbeariaAtual()` e
  `BARBEARIA_ATUAL_ID`, preparando os módulos existentes para a troca gradual
  de consultas sem fontes paralelas de tenant.
- A documentação `TENANCY_MIGRATION.md` registra a arquitetura alvo e o motivo
  de não adicionar apenas `barbearia_id` às coleções atuais: o perfil global
  `clientes/{uid}` e os IDs canônicos de agenda exigem uma migração namespaced
  para impedir colisões e vazamento entre empresas.
- Nenhuma consulta, gravação, permissão, regra ou coleção em produção foi
  redirecionada nesta fundação. A Barbearia Antunes continua operando com a
  estrutura atual até a migração de dados e Rules ser validada.
- `ARCHITECTURE_V2.md` define a arquitetura multi-barbearia revisável: somente
  `usuarios/{uid}` permanece global; os dados operacionais ficam em
  `barbearias/{barbeariaId}/...` e `membros/{uid}` é a fonte de verdade local
  dos papéis. O documento também estabelece as fases de migração, rollback,
  índices e testes. Nesta etapa não houve mudança de dados, consultas, Rules
  ou deploy.
- A V2 mantém, nesta etapa, somente ADMIN, BARBEIRO e CLIENTE. SUPER_ADMIN é
  apenas uma possibilidade futura e não aparece no código, nas Rules ou no
  modelo de permissão atual. O próximo instrumento é
  `scripts/multi-tenant-dry-run.mjs`: uma leitura autenticada e sem escrita
  que monta a projeção da Antunes em memória, confere referências, contagens e
  financeiro e grava apenas um relatório local em `reports/`.
- `usuarios/{uid}` foi definido somente como identidade global; os papéis e
  vínculos pertencem exclusivamente a `barbearias/{id}/membros/{uid}`. O
  documento institucional `barbearias/{id}` conterá nome, slug, logo, ativa,
  plano, domínio, timezone e criado_em quando a migração real for aprovada.
  A tenant da Antunes ainda não foi criada no Firestore: o dry-run só pode
  escrever relatórios locais. Uma conta dedicada com papel `Leitor do Cloud
  Datastore` foi criada e sua chave permanece fora do projeto.
- A migração multi-tenant seguirá as fases 3A (dry-run somente leitura), 3B
  (shadow migration em projeto Firebase de homologação), 3C (cópia idempotente
  em produção ainda lendo legado), 3D (dual-read com `tenancy.mode`) e 3E
  (cutover gradual por domínio). As Rules atuais permanecem intactas até que a
  migração, consultas e testes estejam integralmente aprovados.
- O primeiro write aprovado da Fase 3C criará `system/version` com
  `schema: 2`, `tenancy: true` e `mode: legacy`, além de um registro imutável
  em `migration_logs`. Até então ambos existem apenas como projeção no
  relatório local. Foram reservadas, sem criação ou acesso ativo, as coleções
  tenant de integrações, webhooks, chaves de API, billing e audit_logs.
- O relatório do Marco 3A termina com `resumo_final`: APROVADO/REPROVADO,
  duração, leituras por coleção, divergências, IDs duplicados, órfãos,
  referências inválidas, diferenças de totais, integridade dos créditos,
  integridade financeira e recomendação automática. Qualquer falha crítica
  retorna REPROVADO e código de saída diferente de zero. O self-test local
  cobre tanto um cenário íntegro/APROVADO quanto uma referência inválida que
  obrigatoriamente bloqueia a migração como REPROVADO, sem acessar o Firestore.
- O primeiro dry-run real foi executado em 17/08/2026, somente por leitura, e
  terminou `REPROVADO`: 145 documentos lidos e 26 condições de integridade
  detectadas (8 agendamentos sem barbeiro atual, 1 sem serviço, 16 ativos sem
  ocupação e 1 assinatura ativa sem serviços vinculados). Não houve diferença
  de totais, IDs duplicados ou divergência financeira; o Marco 3B permanece
  bloqueado e nenhum dado, Rule, consulta, frontend ou deploy foi alterado.
- A etapa intermediária de saneamento começou apenas com a ferramenta de
  leitura `scripts/integrity-repair-preview.mjs`. Ela reproduz as quatro
  categorias reprovadas, cruza nomes somente quando há correspondência única,
  simula IDs/blocos de ocupação e herança de `servicos_ids` do plano, mas não
  executa nenhuma correção no Firestore. A prévia real de 17/08/2026 confirmou
  26 condições: 19 possuem proposta determinística de alta confiança e 7
  exigem decisão manual. O relatório está em `reports/` e recomenda análise
  manual; `integrity-repair.mjs` ainda não foi criado, nenhuma escrita foi
  realizada e a Shadow Migration continua bloqueada.
- A revisão humana da prévia foi registrada em
  `reports/integrity-repair-review-2026-08-17.md`. As 19 propostas de alta
  confiança foram separadas em 3 referências determinísticas de barbeiro, 15
  reconstruções de ocupação e 1 cópia de `servicos_ids` do plano. Duas das
  ocupações dependem primeiro do remapeamento do barbeiro. As 7 condições
  manuais correspondem a 5 documentos únicos: quatro agendamentos ligados ao
  barbeiro legado `l4ua45UlpyS6TfewN2E1` e o documento `teste`. O reparador
  continua bloqueado até aprovação explícita das categorias automáticas e uma
  decisão documentada para esses cinco documentos.
- As três categorias determinísticas foram aprovadas e codificadas em
  `scripts/integrity-repair.mjs` com escopo fechado: 3 remapeamentos de
  barbeiro, 15 reconstruções de ocupação e 1 herança de `servicos_ids`. O
  script executa apenas uma categoria por vez, oferece `--dry-run`, usa commit
  atômico com precondições, registra aplicação em `migration_logs` e relatório
  local, e oferece rollback validado contra o log remoto. Escrita e rollback
  exigem confirmações explícitas diferentes. Os dry-runs reais confirmaram 3
  mudanças de barbeiro e 1 de assinatura; a prévia de ocupações interrompeu
  corretamente porque duas dependem primeiro do remapeamento de barbeiros.
  Os cinco documentos manuais continuam explicitamente bloqueados; a execução
  posterior da primeira categoria está registrada nos itens abaixo.
- Antes de qualquer aplicação real, `integrity-repair.mjs` cria um snapshot
  write-once dos documentos-alvo em `reports/repair-snapshots/`, acompanhado de
  SHA-256 e tentativa de marcação local como somente leitura. O hash e o caminho
  entram no `migration_logs`. Após o commit, o log permanece
  `APPLIED_PENDING_VALIDATION` até o script reler cada documento e comparar os
  campos com o plano. A validação gera outro artefato local write-once e somente
  libera a categoria seguinte quando todos conferem; divergência persiste como
  `FALHA`.
- A primeira janela operacional foi executada em 17/08/2026 somente para a
  categoria `barbeiros`. Foi criada a conta temporária
  `integrity-repair-runner` e uma função personalizada contendo apenas
  `datastore.entities.get`, `list`, `create`, `update`, `delete` e
  `datastore.databases.get`; a sexta permissão foi o requisito mínimo observado
  para o contexto atômico do endpoint de commit. Durante as janelas aprovadas,
  a chave JSON permaneceu fora do projeto e do repositório, em
  `.firebase-credentials`, com ACL restrita ao usuário local. O encerramento
  dessa credencial após o saneamento automático está registrado abaixo.
- Durante a primeira tentativa, o Firestore bloqueou atomicamente a escrita e
  revelou que o reparador usava a URL REST como nome do documento. O script foi
  corrigido para enviar o nome canônico
  `projects/.../databases/(default)/documents/...`; o diagnóstico de falhas do
  commit e um self-test desse formato também foram adicionados. Nenhuma escrita
  parcial ocorreu nas tentativas rejeitadas.
- O reparo de barbeiros concluiu `SUCCESS`: 3 remapeamentos aplicados, snapshot
  pré-execução com SHA-256 conferido, 3/3 documentos validados após o commit e
  `migration_logs/integrity-repair-barbeiros-2026-08-18T02-15-20-024Z-1cf721ee`
  registrado. O relatório local é
  `reports/integrity-repair-apply-barbeiros-2026-08-18T02-15-20-024Z.json`.
- O dry-run completo posterior, usando novamente a credencial somente-leitura,
  leu 145 documentos e reduziu as condições de integridade de 26 para 23. Os
  3 remapeamentos automáticos deixaram de aparecer; restam os 5 vínculos
  manuais de barbeiro, 1 serviço ausente no documento `teste`, 16 ocupações e
  1 assinatura ativa sem `servicos_ids`. O status continua `REPROVADO`, a
  Shadow Migration permanece bloqueada e a categoria `ocupacoes` não foi
  executada. Não houve deploy nem alteração de frontend, consultas ou Rules.
- A segunda janela operacional foi executada em 17/08/2026 exclusivamente para
  `ocupacoes`. A prévia confirmou exatamente 15 criações autorizadas e nenhum
  dos cinco documentos manuais. O commit atômico concluiu `SUCCESS`, com
  snapshot pré-execução cujo SHA-256
  `e96fae99ad923e9b9586517ab65d21c744da004f9cc97aa9cda3c05a03c766fe`
  foi conferido, validação posterior de 15/15 documentos e log remoto
  `migration_logs/integrity-repair-ocupacoes-2026-08-18T02-21-50-321Z-b7d2a4b1`.
  O relatório local é
  `reports/integrity-repair-apply-ocupacoes-2026-08-18T02-21-50-321Z.json`;
  o rollback permanece disponível pelo snapshot e pelo log da execução.
- A repetição da prévia de `ocupacoes` comprovou idempotência: 0 alterações e
  15 documentos já aplicados. O dry-run completo seguinte leu 160 documentos
  e reduziu as inconsistências de 23 para 8, exatamente como previsto: quatro
  agendamentos do barbeiro legado e `agendamentos/teste` sem barbeiro, o mesmo
  documento `teste` sem serviço, uma ocupação manual ausente e uma assinatura
  ativa sem `servicos_ids`. Não surgiram inconsistências novas, não há IDs
  duplicados nem diferenças de totais e o financeiro continua `OK`. O relatório
  é
  `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T02-22-44-572Z.json`.
  O status permanece `REPROVADO`; a categoria de assinatura aguarda uma janela
  separada e a Shadow Migration continua bloqueada. Não houve deploy nem
  alteração de frontend, consultas ou Firestore Rules.
- A terceira janela operacional foi executada em 17/08/2026 exclusivamente
  para `assinatura-servicos`. A prévia confirmou uma única alteração aprovada:
  a assinatura `8kNHqfge6HW6euLvNB3NXRvfw8s2_essencial` recebeu somente o campo
  `servicos_ids`, herdado do plano válido. O commit atômico concluiu `SUCCESS`,
  com snapshot pré-execução cujo SHA-256
  `758952faff310dd8e536c5142adb9da4c952e0b47dd4be744f56d3c97ece0bd9`
  foi conferido, validação posterior de 1/1 documento e log remoto
  `migration_logs/integrity-repair-assinatura-servicos-2026-08-18T02-26-34-986Z-6c9a2149`.
  O relatório local é
  `reports/integrity-repair-apply-assinatura-servicos-2026-08-18T02-26-34-986Z.json`;
  a repetição da prévia confirmou idempotência com 0 alterações e 1 documento
  já aplicado. O rollback permanece disponível.
- O dry-run completo posterior leu 160 documentos e reduziu as condições de
  integridade de 8 para 7. A integridade dos créditos de assinatura passou para
  `OK`; o financeiro continua `OK`, sem IDs duplicados ou diferenças de totais.
  Todas as inconsistências automáticas foram saneadas. As 7 condições restantes
  pertencem exclusivamente aos cinco documentos manuais já bloqueados: quatro
  agendamentos do barbeiro legado e `agendamentos/teste`; um desses agendamentos
  também não possui ocupação e `teste` também não possui serviço. O relatório é
  `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T02-26-56-861Z.json`.
  O saneamento automático está concluído e a próxima frente é `Resolução Manual`.
  Uma futura interface administrativa “Resolver inconsistências” foi registrada
  como recomendação, mas não foi implementada nesta janela. Como o validador
  atual ainda classifica as condições manuais como erros, o resultado formal
  permanece `REPROVADO` e a Shadow Migration continua bloqueada até existir uma
  política explícita de exclusão/tratamento desses registros na homologação.
  Não houve deploy nem alteração de frontend, consultas ou Firestore Rules.
- Encerradas as três categorias automáticas, a chave privada temporária
  `39b6211ae1f61fcbf848ef96a1ff3a4b05b7cff5` da conta
  `integrity-repair-runner` foi revogada no Google Cloud e a tela de chaves foi
  recarregada, confirmando que nenhuma chave permanece ativa nessa conta. O
  arquivo JSON local correspondente também foi removido. A credencial dedicada
  de auditoria somente-leitura foi preservada. Qualquer futura resolução manual
  que exija escrita deverá usar uma nova autorização e uma nova credencial
  temporária de menor privilégio; a chave revogada não pode ser reutilizada.
- O Marco 4 — Resolução Manual foi aberto sem escrita no Firestore. A ferramenta
  somente-leitura `integrity-repair-preview.mjs` passou à versão 2 e agora inclui
  contexto operacional seguro dos agendamentos e catálogos de referência, sem
  telefone ou e-mail. A execução de 17/08/2026 confirmou 7 condições manuais em
  cinco documentos e zero propostas automáticas. A ficha auditável de decisão
  está em `reports/manual-resolution-review-2026-08-17.md`; ela exige definir o
  barbeiro correto ou o arquivamento dos quatro agendamentos legados e decidir
  se `agendamentos/teste` será arquivado, excluído ou corrigido. Nenhum desses
  documentos foi modificado e a Shadow Migration continua bloqueada enquanto
  as decisões não forem aprovadas e tratadas explicitamente.
- O Marco 4 foi concluído após decisão humana explícita: não havia evidência
  suficiente para vincular os quatro agendamentos do barbeiro legado
  `l4ua45UlpyS6TfewN2E1` a qualquer profissional atual, e `agendamentos/teste`
  não representava um registro operacional válido. Os cinco documentos foram
  preservados no legado, sem exclusão, com `status: legacy_unresolved`,
  `status_anterior`, `arquivado_legado: true`, `excluir_migracao: true`, motivo
  específico, decisão e data do arquivamento. Eles continuam disponíveis para
  consulta histórica, mas não entram na projeção operacional multi-tenant.
- A categoria auditável `arquivamento-legado` foi adicionada a
  `scripts/integrity-repair.mjs` com escopo fechado nos cinco IDs aprovados,
  snapshot write-once, SHA-256, commit atômico, precondições, `migration_logs`,
  validação posterior e rollback. A execução concluiu `SUCCESS`, validou 5/5
  documentos e gerou o log remoto
  `migration_logs/integrity-repair-arquivamento-legado-2026-08-18T02-46-53-983Z-e0bb4ce5`.
  O snapshot está em
  `reports/repair-snapshots/2026-08-18/arquivamento-legado-before-2026-08-18T02-46-53-983Z-e0bb4ce5.json`,
  com SHA-256
  `0ce422491209fd00bd03e12c632291acab06f356b2b76ebbdb39f47220ffd1ed`.
  Uma nova prévia confirmou idempotência: 0 alterações e 5 documentos já
  aplicados; `integrity-repair-preview.mjs` retornou 0 inconsistências.
- `scripts/multi-tenant-dry-run.mjs` agora separa explicitamente documentos
  preservados na origem de agendamentos operacionais migráveis. O relatório
  continua contabilizando os 53 documentos legados lidos, registra nominalmente
  os 5 excluídos em `exclusoes_migracao.agendamentos_legados` e projeta somente
  48 agendamentos operacionais para a tenant. Essa exclusão só é aceita quando
  todos os campos canônicos de arquivamento estão presentes; não é uma omissão
  silenciosa nem uma exclusão física.
- O dry-run completo final foi executado em 17/08/2026 com a credencial dedicada
  somente-leitura e terminou `APROVADO`: 160 documentos lidos, 0 divergências,
  0 IDs duplicados, 0 documentos órfãos, 0 referências inválidas, 0 diferenças
  de totais, integridade de créditos `OK` e integridade financeira `OK`. O
  relatório é
  `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T02-47-11-912Z.json`
  e recomenda `AVANCAR_PARA_SHADOW_MIGRATION`. O gate do Marco 3A foi atendido;
  a próxima etapa permitida é a Shadow Migration exclusivamente em homologação,
  ainda sem alterar frontend, consultas, Rules ou produção operacional.
- A chave privada temporária
  `50e3cd488cefcc7edb65c14297db089b7d37d7e1`, criada exclusivamente para o
  arquivamento manual, foi revogada imediatamente após a validação. A tela do
  Google Cloud confirmou que `integrity-repair-runner` voltou a ter zero chaves
  ativas, e o arquivo JSON temporário local foi removido. A credencial de
  auditoria somente-leitura permanece preservada. Não houve deploy.
- A Shadow Migration foi concluída exclusivamente no projeto de homologação
  `teste-483f6`. A tenant `tnt_80b2fda7ad644a1dbeff050aa8e0d595`
  (`antunes`) recebeu 189 documentos V2 equivalentes: 17 usuários globais,
  17 membros, 17 clientes, 4 barbeiros, 39 serviços, 48 agendamentos
  operacionais, 31 ocupações, 4 planos, 5 assinaturas, 4 históricos, tenant
  raiz, `system/version` e `migration_log`. Os cinco documentos
  `legacy_unresolved` permaneceram fora da estrutura operacional.
- A validação final retornou `APROVADO`, com 0 ausências, 0 divergências,
  0 referências inválidas, integridade de assinaturas `OK`, financeiro `OK` e
  nova execução idempotente com 0 gravações. A evidência principal está em
  `reports/shadow-migration/validation-2026-08-18T03-46-28-335Z.json` e
  `reports/shadow-migration/after-2026-08-18T03-46-56-808Z.json`.
- Três contas temporárias foram criadas somente no Authentication de
  homologação e vinculadas por `homologacao_mapeamentos` a perfis migrados,
  com papéis de teste isolados `CLIENTE`, `BARBEIRO` e `ADMIN`. As regras
  exclusivas de homologação foram publicadas apenas em `teste-483f6`; as Rules
  de produção permaneceram intocadas. As credenciais estão fora do projeto e
  do repositório, com ACL local restrita.
- Os testes funcionais de dados e permissões passaram: login dos três perfis,
  isolamento de cliente, agenda do barbeiro, acesso administrativo, criação,
  bloqueio de horário duplicado, cancelamento, liberação e nova reserva do
  horário, conclusão, não comparecimento, reserva e consumo único de crédito,
  bloqueio de consumo duplicado e leitura financeira. Os 12 documentos
  temporários usados nos testes foram removidos e a equivalência 189/189 foi
  confirmada novamente. Evidência em
  `reports/shadow-migration/functional-validation-2026-08-18T03-45-50Z.json`.
- O relatório consolidado está em
  `reports/shadow-migration/HOMOLOGATION_FINAL_REPORT.md`. Resultado final:
  `HOMOLOGAÇÃO APROVADA`. Nenhuma alteração ou deploy ocorreu na produção.
- Após a homologação, a chave temporária
  `3dbd5d39ff916adcbfcbdb31add1b9d092dc20eb` da conta
  `shadow-migration-runner` foi revogada. O Console confirmou zero chaves
  ativas, o JSON local foi excluído e a conta de serviço foi desativada,
  preservando o registro para auditoria sem permitir autenticação. A conta e a
  credencial de auditoria somente leitura continuam disponíveis para futuras
  validações. As credenciais das três contas funcionais de teste permanecem
  fora do projeto e do repositório para uso exclusivo da homologação.
# Cutover V2 de produção — Fase 1 (18/08/2026)

- A arquitetura V2 permanece congelada e a produção continua operando exclusivamente no legado.
- O dry-run real foi reexecutado em modo somente leitura e retornou `APROVADO`: 160 documentos lidos, zero divergências, referências inválidas, órfãos, duplicidades ou diferenças de totais; financeiro e créditos/assinaturas `OK`.
- O preflight de produção confirmou 189 documentos V2 ausentes, zero existentes e zero divergentes. Nenhuma escrita foi realizada.
- Snapshot: `reports/production-cutover/before-2026-08-18T03-57-32-602Z.json`; SHA-256 `CE5EE39539E864D7F4E332F127370343753657EBAD29E81392D5229A13A4A8FE`.
- Criado `scripts/production-cutover.mjs`, que reutiliza a lógica homologada com travas específicas de produção, criação create-only, commit atômico (até 300 documentos), `system/version.mode = legacy`, validação e rollback restrito ao estado intacto.
- Criados `PRODUCTION_CUTOVER_RUNBOOK.md` e `reports/production-cutover/PRE_CUTOVER_CHECKLIST.md`.
- Fase 2 continua bloqueada até autorização operacional específica e criação de credencial temporária de escrita com menor privilégio. Nenhuma credencial de escrita foi criada, nenhum deploy foi feito e Rules/frontend não foram alterados.

# Cutover V2 de produção — Fase 2 (18/08/2026)

- A migração V2 create-only foi executada uma única vez na produção, com credenciais separadas: auditoria somente leitura como origem e uma conta temporária de menor privilégio como destino. Foram criados exatamente 189 documentos V2 equivalentes, incluindo a tenant `tnt_80b2fda7ad644a1dbeff050aa8e0d595` (`antunes`), membros, catálogos, agendamentos operacionais, ocupações, assinaturas, histórico, financeiro, `migration_logs` e `system/version`.
- O snapshot final pré-escrita está em `reports/production-cutover/before-2026-08-18T04-10-54-919Z.json`, SHA-256 `8dda2b0fb0aa630213860b1152310ce3cb13338f17f53d5f52a508b426155487`. A validação posterior confirmou 189/189 documentos equivalentes e 0 divergências; a repetição em dry-run comprovou idempotência com 0 criações e 189 equivalentes.
- O dry-run final do legado retornou `APROVADO`: 160 documentos lidos, 0 divergências, 0 órfãos, 0 referências inválidas, 0 duplicidades, financeiro `OK` e assinaturas/créditos `OK`. Os cinco registros `legacy_unresolved` permanecem preservados e fora da estrutura operacional.
- A produção permanece em `system/version.mode = legacy`; não houve mudança perceptível aos usuários. Firestore Rules, frontend, consultas e Firebase Hosting não foram alterados e nenhum deploy foi realizado.
- Após a validação, a chave da conta temporária `production-cutover-runner` foi revogada, seu JSON local removido, a conta foi excluída e a função personalizada `Production Cutover Writer` foi programada para exclusão. A conta e credencial de auditoria somente leitura foram preservadas e permanecem ativas. Evidência consolidada: `reports/production-cutover/PRODUCTION_CUTOVER_PHASE_2_REPORT.md`.
- O próximo gate é a Fase 3: validação funcional da produção ainda em `legacy`. Não ativar `dual-read` sem nova autorização explícita.

# Cutover V2 de produção — Fase v2.2 (baseline em `legacy`, 18/08/2026)

- A validação somente leitura da produção confirmou novamente a equivalência de 189/189 documentos V2, 0 divergências, 48 agendamentos operacionais, 5 registros históricos preservados fora da operação, financeiro `OK`, créditos/assinaturas `OK` e idempotência com 0 gravações esperadas. Evidências: `reports/production-cutover/validation-2026-08-18T04-20-17-152Z.json` e `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T04-20-27-119Z.json`.
- Uma sessão autenticada de produção com papéis de Cliente, Barbeiro e Admin carregou as três áreas, incluindo agenda do barbeiro, agendamentos administrativos, disponibilidade, Assinaturas e Financeiro, sem erros ou avisos de console. Não houve escrita, mudança de `mode`, Rules, frontend ou deploy.
- A Fase v2.2 está `EM ANDAMENTO`: o baseline técnico é positivo, mas a aprovação final aguarda uma janela de observação operacional definida e testes transacionais controlados de criação/cancelamento/conclusão/falta/crédito com conta de teste e limpeza autorizada. `dual-read` continua bloqueado. Relatório: `reports/production-cutover/LEGACY_PRODUCTION_VALIDATION_BASELINE.md`.

# Cutover V2 de produção — Fase v2.2 (testes transacionais, 18/08/2026)

- Foram validados em produção, ainda em `legacy`, os fluxos de agendamento normal, cancelamento pelo cliente, conclusão pelo Admin e não comparecimento pelo Admin. Os três registros controlados de 27/08/2026 foram persistidos com os status esperados. Nenhuma Rule, frontend, Hosting, deploy ou `tenancy.mode` foi alterado.
- O dry-run de integridade posterior continuou `APROVADO`: 164 documentos lidos, 0 inconsistências, financeiro `OK` e assinaturas/créditos `OK`. Evidência: `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T04-36-19-242Z.json`.
- A Fase v2.2 **não foi aprovada**: a conta de validação tem somente assinatura expirada, portanto o consumo real de crédito não foi testado para evitar ativação/pagamento fictício em produção. Além disso, os três agendamentos de teste e sua ocupação foram gravados apenas no legado — comportamento esperado com `mode = legacy` — e a comparação legado × V2 detectou 4 documentos V2 ausentes mais o `migration_log` técnico. Evidência: `reports/production-cutover/blocked-divergence-2026-08-18T04-36-39-260Z.json`.
- `dual-read` continua bloqueado. O relatório final da fase está em `reports/production-cutover/LEGACY_PRODUCTION_VALIDATION_FINAL.md`. Nenhuma próxima fase foi iniciada.
- O consumo de crédito também foi validado com assinatura Essencial temporária: solicitação, aprovação presencial simulada, agendamento usando assinatura e conclusão passaram o saldo de `4/4` para `3/4 disponíveis` e `1 utilizado`. A assinatura temporária aguarda limpeza controlada. A fase continua bloqueada exclusivamente pela sincronização dos novos documentos legados para V2; não foi criada uma nova credencial de escrita nem ampliadas permissões sem uma ferramenta administrativa disponível.

# Fase v2.2 — equivalência restaurada (18/08/2026)

- Foi criada exclusivamente para esta janela a conta `v2-incremental-sync-runner`, com o papel personalizado restrito já utilizado no saneamento. Uma única chave JSON temporária foi gerada fora do projeto, usada somente para a sincronização e revogada logo após a validação; as cópias locais também foram removidas. O Console confirmou zero chaves ativas e a própria conta foi excluída após o uso.
- A operação atômica `production-cutover.mjs --sync-current` foi deliberadamente limitada ao escopo previamente observado: 7 documentos V2 ausentes (agendamentos, ocupações e histórico de assinatura) e 2 divergências permitidas (a assinatura de teste e o migration log canônico). O snapshot e a validação posterior estão em `reports/production-cutover/incremental-sync-before-2026-08-18T04-55-28-396Z.json` e `reports/production-cutover/incremental-sync-after-2026-08-18T04-55-34-068Z.json`.
- A validação posterior retornou 196/196 documentos equivalentes e 0 divergências: `reports/production-cutover/validation-2026-08-18T04-56-13-359Z.json`. O dry-run legado também retornou `APROVADO`, com 167 documentos lidos, 0 referências inválidas, 0 órfãos, 0 duplicidades, financeiro `OK` e créditos/assinaturas `OK`: `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T04-55-57-100Z.json`.
- A produção permanece em `system/version.mode = legacy`. Nenhuma Firestore Rule, frontend, Hosting ou deploy foi alterado. A Fase v2.2 está aprovada e a única fase posterior autorizada é a implementação controlada de Dual Read, mantendo o legado como fonte oficial.

# Fase v2.3 — gate de segurança identificado (18/08/2026)

- A pré-verificação de Dual Read confirmou que a equivalência atual continua íntegra (`196/196`, 0 divergências), mas as Rules publicadas em produção ainda atendem exclusivamente às coleções legadas: não existe `match` para `system/version` nem para `barbearias/{tenantId}/...`.
- Não há hoje um gravador confiável publicado para `barbearias/{tenantId}/audit_logs`. Clientes não podem receber essa permissão, pois os registros seriam forjáveis e sujeitos a abuso. Portanto, não é seguro ativar `dual-read` apenas com JavaScript no navegador.
- A produção continua em `legacy`, sem deploy, sem mudança de Rules, frontend, Hosting ou comportamento de usuário. O precheck auditável está em `reports/production-cutover/DUAL_READ_PRECHECK.md`.
- O próximo gate mínimo é: preparar/testar Rules V2 de leitura restrita que preservem integralmente o legado, disponibilizar um gravador confiável de auditoria fora do navegador e só então publicar essas peças e alterar a flag administrativa para `dual-read`.
- Em nova validação somente leitura, o dry-run retornou `APROVADO` com 167 documentos legados lidos e 0 divergências, órfãos, referências inválidas ou duplicidades; financeiro e créditos/assinaturas permanecem `OK`: `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-18T05-07-09-244Z.json`. A validação cruzada confirmou 196/196 documentos V2 equivalentes, 0 ausências, 0 divergências e rerun idempotente com 0 gravações esperadas: `reports/production-cutover/validation-2026-08-18T05-07-26-393Z.json`.

# Fase v2.3 — infraestrutura de auditoria do Dual Read validada (18/08/2026)

- As regras exclusivas de homologação em `firestore.shadow.rules` foram compiladas e publicadas somente no projeto `teste-483f6`. O caminho V2 `barbearias/{tenantId}/audit_logs/{auditId}` permite consulta administrativa e bloqueia explicitamente qualquer escrita via navegador (`allow create, update, delete: if false`). A produção, suas Rules e seu Hosting não foram alterados.
- `scripts/dual-read-audit.mjs` foi validado em homologação. Ele compara legado × V2 e registra apenas eventos técnicos mínimos, sem PII, mediante conta de serviço; o teste criou e releu o evento `dual-read-dual_read_audit_self_test-2026-08-18T05-41-23-704Z`. Evidência: `reports/dual-read/dual-read-audit-2026-08-18T05-41-23-919Z.json`.
- A comparação do teste encontrou duas divergências preexistentes na cópia de homologação e as registrou sem modificar dados operacionais. Relatório: `reports/shadow-migration/blocked-divergence-2026-08-18T05-41-23-428Z.json`.
- A conta temporária `dual-read-audit-runner` recebeu somente `datastore.entities.get`, `datastore.entities.list` e `datastore.entities.create`. Sua chave temporária foi revogada, a cópia local removida, o papel personalizado programado para exclusão e a conta removida após o teste. Não foram usados papéis amplos. Relatório consolidado: `reports/dual-read/DUAL_READ_INFRASTRUCTURE_VALIDATION.md`.
- A infraestrutura está validada, mas `dual-read` continua desativado e `system/version.mode` permanece `legacy`. A ativação de Dual Read exige uma autorização específica posterior; não foi iniciada nesta etapa.

# Fase v2.4 — Cloud Functions para auditoria confiável (homologação, 18/08/2026)

- Foi criado o backend agendado Gen 2 `functions/index.js` para o auditor Dual Read. Ele não recebe dados do navegador, só executa quando `system/version.mode` é `dual-read`, compara legado e V2 e grava eventos técnicos mínimos em `barbearias/{tenantId}/audit_logs` apenas se detectar divergência. A comparação foi corrigida para ser bidirecional: ausências, diferenças de campos e documentos extras existentes somente na V2 são todos detectados. Eventos carregam apenas contagens e fingerprints SHA-256 de caminhos, sem PII.
- A Function `auditDualRead` foi publicada e validada apenas em `teste-483f6`, região `southamerica-east1`, com a identidade limitada `dual-read-auditor-692@teste-483f6.iam.gserviceaccount.com`. O papel ativo `Dual Read Auditor V2` contém exclusivamente `datastore.entities.get`, `datastore.entities.list` e `datastore.entities.create`; não houve chave JSON, papel amplo ou alteração na produção.
- O Scheduler foi executado manualmente com a flag temporária de homologação em `dual-read`. A versão inicial revelou que V2 extras não eram comparados; a correção foi publicada antes de qualquer uso produtivo. A revisão final `auditdualread-00003-quk` detectou 186 documentos V2 inesperados na cópia de homologação e registrou o audit event técnico, comprovando leitura e escrita por Cloud Function com privilégio mínimo. Evidência: `reports/dual-read/CLOUD_FUNCTIONS_HML_VALIDATION_2026-08-18.md`.
- O projeto de produção `barber-a01e7`, suas Rules, Hosting, frontend, consultas e `system/version.mode = legacy` permaneceram inalterados. Antes de qualquer publicação em produção, a homologação deve voltar a `legacy`, o runtime deve ser atualizado/testado em Node.js 22 e uma autorização específica deve liberar o próximo gate.

# Fase v2.4 — Dual Read em produção (ativação inicial, 18/08/2026)

- A Cloud Function agendada Gen 2 `auditDualRead` foi publicada em `barber-a01e7`, região `southamerica-east1`, runtime Node.js 22. Ela usa a identidade de execução limitada configurada para o auditor e não recebe dados do navegador.
- As Rules V2 de produção foram compiladas e publicadas. Elas preservam integralmente as permissões legadas, restringem as leituras V2 a membros autorizados e bloqueiam explicitamente qualquer escrita do navegador em `barbearias/{tenantId}/audit_logs`.
- A flag `system/version.mode` da produção foi alterada para `dual-read`; o legado permanece a fonte oficial e o frontend/Hosting não foram modificados.
- A primeira execução manual do Scheduler após a ativação concluiu com HTTP 200 e o log da Function registrou `Dual Read equivalente.` às 20:09 BRT. Não houve divergência técnica, erro funcional ou gravação de `audit_logs` (esses eventos só são criados quando há divergência).
- O Dual Read permanece em observação controlada. Em caso de `Divergência Dual Read detectada.` ou erro crítico, o rollback imediato é alterar somente `system/version.mode` de volta para `legacy` e interromper a fase. Não ativar `multi-tenant` até a janela de observação e os testes funcionais serem concluídos.
- A consolidação inicial observou três execuções manuais do Scheduler: duas foram ignoradas com segurança antes da alteração efetiva da flag; a primeira execução real em `dual-read` retornou HTTP 200 em 4.466 ms e registrou `Dual Read equivalente.`, com 0 divergências e 0 falhas críticas. O relatório `reports/dual-read/DUAL_READ_CONSOLIDATION_2026-08-18.md` classifica a fase como bloqueada preventivamente, pois os fluxos funcionais ainda não foram exercitados com `dual-read` ativo nem houve janela de observação suficiente. Nenhuma ativação de `multi-tenant` está autorizada.
- Durante a validação funcional inicial, uma execução posterior às 20:30:57 BRT registrou `Divergência Dual Read detectada.`. O rollback foi realizado imediatamente e confirmado: `system/version.mode` voltou para `legacy`. O site segue usando somente o legado, sem alteração de frontend, Hosting ou dados operacionais pelo auditor. A Fase v2.4.2 está bloqueada até a leitura do evento técnico em `barbearias/{tenantId}/audit_logs`, reprodução da causa em homologação e nova validação controlada. Não reativar `dual-read` nem `multi-tenant`.
- O evento técnico de divergência `dual-read-2026-08-18T23-30-57-461Z` foi revisado: legado esperado `203`, equivalentes `191`, ausentes na V2 `9`, divergentes `3` e inesperados na V2 `0`. Os itens são armazenados como fingerprints sem PII. A causa exata ainda exige reconciliação detalhada somente leitura; nenhuma correção ou nova ativação está autorizada até então.
- Fase v2.4.3 iniciada: criado `scripts/dual-read-reconciliation.mjs`, ferramenta com chamadas Firestore exclusivamente `GET`, que produz relatório local detalhado de ausências, divergências, campos alterados e classificação técnica. A sintaxe foi validada; a execução real está bloqueada de forma segura porque não há `GOOGLE_APPLICATION_CREDENTIALS` nem token de leitura configurado nesta máquina. Nenhuma chamada ao Firestore, escrita, alteração de Rules, flag, frontend, Hosting ou deploy foi realizada nesta etapa.

# Fase v2.4.3 — Reconciliação somente leitura (18/08/2026)

- O Google Cloud CLI foi instalado localmente apenas para emitir um token temporário por impersonação da conta de auditoria `dry-run-firestore-reader@barber-a01e7.iam.gserviceaccount.com`; nenhum arquivo JSON foi criado. Foi concedido à conta humana `mmenso43@gmail.com` o papel `roles/iam.serviceAccountTokenCreator` **somente nessa conta de serviço**, para viabilizar futuras auditorias de leitura com credenciais efêmeras.
- A reconciliação real foi executada com sucesso com operações Firestore exclusivamente `GET`; o token foi removido do processo ao final. Nenhuma escrita, sincronização, Rule, deploy, frontend, Hosting ou alteração de `system/version.mode` foi realizada. A produção permanece em `legacy`.
- Resultado confirmado: 203 documentos legados esperados, 191 equivalentes, 9 ausentes na V2, 3 divergentes e 0 extras na V2. Todos os 12 casos possuem `update_time` posterior ao baseline do cutover e foram classificados como `ALTERACAO_OPERACIONAL_APOS_CUTOVER` com recomendação `REQUER_SINCRONIZACAO_INCREMENTAL`; não há caso automático inconclusivo ou manual nesta lista.
- Ausências: 1 serviço (`LpPMCtctqFH7cPB4xhkr`), 3 agendamentos, 4 ocupações e a configuração `configuracoes/funcionamento`. Divergências: barbeiro `fxtjJbFFaZ0i86ZeRKL3` (`ativo` de `false` para `true`), plano `premium` (`ativo` e `atualizado_em`) e assinatura `w8VuB0a1vOMRX8tSV0ZA3UrS0BC2_essencial` (reserva de crédito e metadados da última reserva). Valores de campos pessoais foram redigidos no JSON.
- Evidências produzidas localmente: `reports/dual-read/DUAL_READ_RECONCILIATION_REPORT.md` e `reports/dual-read/dual-read-reconciliation-2026-08-19T00-11-04-157Z.json`. O Dual Read permanece bloqueado até revisão humana e autorização explícita para uma sincronização incremental idempotente baseada nesses 12 itens.

# Fase v2.4.4 — Reconciliação incremental controlada (19/08/2026)

- A sincronização foi limitada por código a nove ausências e três divergências operacionais previstas na reconciliação. Um primeiro preflight bloqueou a execução ao identificar o log canônico técnico da migração; esse metadado foi explicitamente excluído do escopo operacional, pois o auditor também exclui `migration_logs` de sua projeção. Nenhum dado foi escrito no preflight bloqueado.
- O commit posterior foi único e atômico: nove criações, três atualizações com pré-condição `updateTime` e um registro em `migration_logs`. O snapshot pré-escrita imutável está em `reports/production-cutover/reconciliation-sync-before-2026-08-19T00-32-16-407Z.json`, SHA-256 `b371b953e1cc2be468ca581242af2b082d3ab10eaf608a6843a5a554c029ae78`. Resultado pós-escrita: `reports/production-cutover/reconciliation-sync-after-2026-08-19T00-32-23-992Z.json`.
- A validação somente leitura posterior retornou **203/203 equivalentes**, 0 ausências, 0 divergências e 0 extras operacionais: `reports/dual-read/dual-read-reconciliation-2026-08-19T00-33-52-063Z.json`. O dry-run legado também retornou `APROVADO` com 176 documentos lidos, financeiro `OK` e assinaturas/créditos `OK`: `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-19T00-33-41-754Z.json`.
- A produção permanece em `system/version.mode = legacy`. Nenhuma Rule, frontend, Hosting, deploy ou arquitetura foi modificada.
- A identidade temporária `v2-reconciliation-sync-runner` recebeu somente `datastore.entities.get`, `datastore.entities.list`, `datastore.entities.create` e `datastore.entities.update`, sem chave JSON. Após a confirmação, o acesso de impersonação foi revogado, a conta foi excluída e o papel `v2ReconciliationSyncRunner` foi removido. Evidência consolidada: `reports/production-cutover/V2_RECONCILIATION_SYNC_2026-08-19.md`.

# Fase v2.4.5 — Reativação controlada do Dual Read (19/08/2026)

- O preflight somente leitura confirmou **203/203 equivalentes**, sem ausências, divergências ou extras operacionais: `reports/dual-read/dual-read-reconciliation-2026-08-19T00-41-01-129Z.json`. O dry-run legado também permaneceu `APROVADO` (176 documentos, financeiro e assinaturas/créditos `OK`): `reports/multi-tenant-dry-run-tnt_80b2fda7ad644a1dbeff050aa8e0d595-2026-08-19T00-41-02-148Z.json`.
- A flag de produção foi atualizada de forma condicional, preservando todos os demais campos de `system/version`: `mode = dual-read` às 00:50:12 UTC. A conta temporária de menor privilégio usada exclusivamente nessa alteração tinha apenas `datastore.entities.get` e `datastore.entities.update`; foi removida logo após a confirmação, sem criação de chave JSON.
- A primeira execução do auditor após a reativação concluiu com HTTP 200 em **3,682 s** e registrou `Dual Read equivalente.` às 00:51:21 UTC. Nenhum `audit_log` de divergência foi criado nesta execução. A fase permanece em observação e ainda exige testes funcionais completos antes de qualquer aprovação ou mudança para `multi-tenant`.

# Fase v2.4.5 — Rollback preventivo após teste funcional do cliente (19/08/2026)

- Após a rodada funcional informada pelo cliente (agendamento, assinatura, horários e créditos), o auditor executou às 01:01 UTC e registrou `Divergência Dual Read detectada.`. O rollback obrigatório foi concluído imediatamente: `system/version.mode` voltou para `legacy` às 01:05:19 UTC. Nenhuma Rule, frontend, Hosting ou documento operacional foi alterado pelo rollback.
- A identidade temporária de menor privilégio usada somente no rollback tinha `datastore.entities.get` e `datastore.entities.update`; foi removida logo após a confirmação, sem criação de chave JSON.
- A reconciliação exclusivamente leitura posterior identificou mudanças operacionais realizadas desde a última sincronização: **210** documentos legados esperados, **193** equivalentes, **8** ausentes, **9** divergentes e **1** ocupação inesperada na V2. Os oito ausentes e nove divergentes estão classificados como `ALTERACAO_OPERACIONAL_APOS_CUTOVER` e requerem sincronização incremental; a ocupação inesperada requer decisão manual. Evidência: `reports/dual-read/dual-read-reconciliation-2026-08-19T01-06-41-229Z.json`.
- O Dual Read permanece **bloqueado** e a produção opera novamente em `legacy`. Não reativar a flag antes de uma reconciliação específica desses 18 itens, com snapshot, classificação e validação posterior.

# Fase v2.5.2 — Dual Write em homologação (19/08/2026)

- O projeto de homologação `teste-483f6` recebeu a identidade de execução limitada `dual-write-runner@teste-483f6.iam.gserviceaccount.com`, com apenas `datastore.databases.get`, `datastore.entities.get`, `datastore.entities.list`, `datastore.entities.create`, `datastore.entities.update` e `datastore.entities.delete`. Não foi criada chave JSON nem concedido papel amplo.
- Foram publicados **somente em homologação**: a Callable Function Gen 2 `executeOperationalCommand` (Node.js 22, `southamerica-east1`), as Rules `firestore.dual-write.hml.rules` e o Hosting `https://teste-483f6.web.app`. A Function de auditoria `auditDualRead` permanece publicada no mesmo ambiente. Produção, suas Rules, Hosting e `system/version.mode` não foram alterados.
- A Function foi verificada como publicada via Firebase CLI. A chamada sem autenticação foi rejeitada com HTTP 401, confirmando que o endpoint não aceita operação anônima. O pacote HML foi validado contra a configuração exclusiva de `teste-483f6`, sem referências ao projeto de produção.
- A política de retenção do repositório de imagens de Functions em `southamerica-east1` foi configurada para remover imagens com mais de 1 dia, evitando acúmulo de custo em homologação.
- A homologação funcional do Dual Write permanece pendente: é necessário entrar no site HML com as contas de teste vinculadas e executar os fluxos operacionais; somente então rodar a validação Legado × V2 e emitir `DUAL WRITE HOMOLOGADO`.
- A falha de login da homologação foi diagnosticada e corrigida: havia uma diferença de capitalização na `apiKey` pública em `public-hml/js/firebase-config.js`. A configuração foi conferida na fonte oficial do Firebase, corrigida e publicada somente no Hosting de `teste-483f6`. Uma tentativa segura com credencial inexistente confirmou que o Authentication responde normalmente, e o login real de teste foi confirmado pelo usuário. Produção, Rules e `tenancy.mode` não foram alterados.

# Homologação — prévia de espelhamento legado (19/08/2026)

- O login HML funciona, mas a interface ainda lê as coleções raiz legadas (`barbeiros`, `servicos`, configurações etc.), enquanto a Shadow Migration preencheu a estrutura V2 em `barbearias/{tenantId}`. Por isso uma conta de cliente HML pode autenticar, porém não enxergar a equipe.
- Criado `scripts/hml-legacy-seed.mjs`, planejador **somente leitura** fixo para `teste-483f6` e para a tenant Antunes. Ele compara as projeções V2 com a raiz legada HML e escreve somente relatórios locais em `reports/hml-legacy-seed/`; `--apply` é bloqueado por código.
- Nenhum token, chave, acesso Firestore, dado operacional, Rule, Function, Hosting, modo de tenancy ou recurso de produção foi alterado nesta etapa. A execução da prévia e qualquer aplicação futura exigem autorização explícita, credencial temporária e validação separada.

# Fase v2.5.2 — Prévia real do seed legado em HML (19/08/2026)

- A prévia real foi executada apenas contra `teste-483f6`, usando token efêmero por impersonação da conta limitada `dual-read-auditor-692@teste-483f6.iam.gserviceaccount.com`; o token não foi persistido.
- O comando `scripts/hml-legacy-seed.mjs --scope todos` fez somente leituras. Resultado: 153 documentos V2 comparados com 1 documento legado; 1 `JA_EQUIVALENTE`, 152 `CRIAR_SEED`, 0 `DIVERGENTE_BLOQUEAR` e 0 `IGNORAR`.
- Escopo proposto, ainda não aplicado: `barbeiros` 4, `servicos` 39, `clientes` 17, `agendamentos` 48, `ocupacoes` 31, `planos_assinatura` 4, `solicitacoes_assinatura` 5 e `historico_assinaturas` 4. `configuracoes`, `fechamentos` e `bloqueios` não possuem itens.
- Relatórios locais: `reports/hml-legacy-seed/hml-legacy-seed-plan-2026-08-19T19-56-41-314Z.md` e `.json`.
- Não houve escrita no Firestore, alteração de Rules, Functions, Hosting, `system/version.mode` ou acesso a `barber-a01e7`. O próximo passo exige revisão humana e autorização explícita antes de criar qualquer ferramenta de aplicação do seed.

# Fase v2.5.3 — Aplicador controlado do seed legado em HML (19/08/2026)

- Criado `scripts/hml-legacy-seed-apply.mjs`, separado da prévia e limitado por código ao projeto `teste-483f6` e à tenant Antunes homologada. Qualquer tentativa de apontar para `barber-a01e7` é bloqueada.
- A aplicação futura exige simultaneamente um plano aprovado, `--apply` e `--confirm-apply`. Ela recalcula a prévia antes da escrita e bloqueia se o plano, os totais ou as 152 criações determinísticas tiverem mudado.
- O aplicador cria somente documentos legados inexistentes; não atualiza nem remove dados existentes e bloqueia se encontrar um documento com conteúdo divergente.
- Foram previstos snapshot pré-execução, hash SHA-256 do plano e do snapshot, commits condicionais, validação pós-escrita, relatório local sem dados pessoais e rollback limitado aos documentos criados pela própria execução e que permaneçam inalterados.
- Sintaxe e self-test locais do aplicador foram validados. Nesta etapa o seed não foi executado e não houve escrita no Firestore, alteração de Rules, Functions, Hosting, `system/version.mode` ou acesso a `barber-a01e7`.

# Fase v2.5.3 — Seed legado HML aplicado e validado (19/08/2026)

- A aplicação foi executada exclusivamente em `teste-483f6`, com token efêmero e identidade limitada. Não houve chave JSON, papel amplo ou acesso a `barber-a01e7`.
- Foram criados 152 documentos legados inexistentes; 1 documento já era equivalente. Nenhum documento legado existente foi atualizado ou removido. A execução terminou como `APLICADO_VALIDADO`, sem falhas.
- Snapshot, hashes SHA-256, plano e validação pós-escrita foram registrados em `reports/hml-legacy-seed/hml-legacy-seed-apply-2026-08-19T21-09-33-748Z.json`. O rollback permanece limitado aos documentos criados por essa execução e que não tenham sido alterados depois.
- A verificação independente, somente leitura, de escopo completo confirmou: **153 V2 / 153 legado / 153 equivalentes / 0 ausentes / 0 divergentes / 0 itens apenas no legado**. Evidências: `reports/hml-legacy-seed/hml-legacy-seed-plan-2026-08-19T21-18-24-957Z.md` e `.json`.
- Não houve alteração de Rules, Functions, Hosting, `system/version.mode` nem produção. O seed legado de HML está validado; qualquer deploy ou teste funcional do Dual Write depende de nova autorização.

---

# Fase v2.5.4 — Dual Write em homologação: preparação validada (19/08/2026)

- Escopo restrito ao projeto de homologação `teste-483f6`; produção `barber-a01e7` não foi alterada.
- A Function `executeOperationalCommand`, as Rules de Dual Write e o Hosting de HML já estão publicados somente em `teste-483f6`.
- A configuração Web de HML aponta exclusivamente para `teste-483f6`.
- A inspeção estática confirmou que os JavaScript públicos de HML não realizam escritas diretas nas coleções operacionais; as escritas passam pela callable Function. Rules de HML bloqueiam escrita direta do navegador e `audit_logs`.
- O baseline somente leitura imediatamente antes da bateria funcional confirmou: **153 V2 / 153 legado / 153 equivalentes / 0 ausentes / 0 divergentes / 0 exclusivos do legado**. Evidência: `reports/hml-legacy-seed/hml-legacy-seed-plan-2026-08-19T23-37-23-701Z.md`.
- Relatórios criados: `reports/dual-write/DUAL_WRITE_HOMOLOGATION_REPORT.md` e `reports/dual-write/dual-write-homologation-status-2026-08-19.json`.
- Estado da fase: **PENDENTE DE VALIDAÇÃO FUNCIONAL AUTENTICADA**. Ainda não emitir `DUAL WRITE HOMOLOGADO`: faltam as operações reais de Cliente, Barbeiro e Admin e a comparação pós-teste.

## Correção HML — confirmação de agendamento (19/08/2026)

- Identificado falso erro `failed-precondition` após a confirmação de agendamento: a Cloud Function concluía a gravação no legado e na V2, porém a recarga posterior de “Meus agendamentos” falhava em HML pela ausência do índice composto `agendamentos(cliente_id ASC, data DESC)`. O `catch` externo mascarava a confirmação, mesmo com o horário já ocupado.
- `public-hml/js/app.js` foi ajustado para preservar a mensagem de sucesso quando apenas a atualização imediata da lista falhar; esse erro fica limitado ao console.
- Publicados exclusivamente em `teste-483f6`: Hosting HML e o índice composto necessário. Não foram alterados Cloud Functions, Rules, dados, `system/version.mode` ou qualquer recurso de produção (`barber-a01e7`).
# Auditoria final Dual Write HML — 20/08/2026

- A ferramenta `scripts/hml-dual-write-reconciliation.mjs` foi criada com trava rígida para `teste-483f6`, somente `GET`/`LIST`, sem chave JSON persistente e sem APIs de escrita.
- A execução utilizou token efêmero por impersonação da conta de auditoria HML; o token foi removido ao fim do processo.
- Resultado atual: **177 Legado / 177 V2 / 175 equivalentes / 0 ausentes / 2 divergentes / 0 extras**.
- Divergências: `barbeiros/1OZRgMZpK8Eb8aCfuG07` nos campos `email_acesso` e `nome`; `barbeiros/fxtjJbFFaZ0i86ZeRKL3` no campo `ativo`.
- Nenhuma correção, sincronização, escrita operacional, alteração de Rules ou produção foi executada. Evidência: `reports/dual-write/HML_FINAL_AUDIT_2026-08-20.md`.
- As duas divergências de barbeiros foram reclassificadas como `HML_TEST_CHANGE` (massa descartável de teste), destinadas a remoção/normalização somente no futuro `PRE-GO-LIVE RESET`; nenhuma sincronização foi executada.
- Considerando equivalentes as coleções operacionais críticas, o gate é: **✅ DUAL WRITE HOMOLOGADO COM DIVERGÊNCIAS HML DE TESTE DOCUMENTADAS**. A prova explícita de reexecução de `agenda.criar` com o mesmo `requestId` permanece pendente de evidência e visível.
# PRE-GO-LIVE RESET — PREVIEW HML (20/08/2026)

- Foi executado somente preview de leitura em `teste-483f6`; nenhuma exclusão, atualização, sincronização ou alteração de produção ocorreu.
- Classificação: **52 PRESERVE**, **20 REMOVE_TEST_DATA**, **130 REVIEW_REQUIRED**. O critério foi conservador: dados ambíguos não foram marcados como removíveis.
- Candidatos inequívocos incluem 7 agendamentos, 2 barbeiros `HML_TEST_CHANGE`, 4 clientes de teste, 4 usuários temporários, 1 serviço, 1 plano e 1 solicitação marcados como teste/HML. Ocupações, históricos e demais identidades permanecem sujeitos a revisão referencial antes de qualquer aplicação.
- O mecanismo futuro deverá usar snapshot imutável, allowlist Legado+V2, aplicação idempotente, validação pós-reset e rollback somente por snapshot aprovado. O reset ainda aguarda autorização explícita.
- Evidências: `reports/dual-write/PRE_GO_LIVE_RESET_PREVIEW_2026-08-20.md` e JSON correspondente.
# PRE-GO-LIVE RESET — PREVIEW FINAL (20/08/2026)

- Nova decisão de negócio: todos os dados atuais são de teste; preservar somente o Admin real, seu perfil/membro operacional, tenant e estrutura técnica V2.
- Auth validado diretamente: `mmenso43@gmail.com` → `eEhjqVfcDeM0yCwiVVlb8JD8xZC3`.
- Perfil operacional ADMIN validado: `gVAwqbquC3V3fMjAjoJzJUndFlJ3`, com `admins/{uid}`, `usuarios/{uid}` e membro V2 ativo. O Auth `eEh...` ainda não possui `homologacao_mapeamentos` nem membro V2 correspondente; nenhum vínculo foi criado.
- Preview final: legado **2 preservar / 200 remover**; V2 **3 preservar / 174 remover**; Authentication **1 preservar / 7 remover**; mapeamentos HML **0 preservar / 6 remover**.
- Caminhos preservados: `admins/gVAwqbquC3V3fMjAjoJzJUndFlJ3`, `usuarios/gVAwqbquC3V3fMjAjoJzJUndFlJ3`, `barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/membros/gVAwqbquC3V3fMjAjoJzJUndFlJ3`, tenant V2 e `system/version`, além do Auth `eEh...`.
- Nenhuma exclusão ou alteração foi executada. Evidência: `reports/dual-write/PRE_GO_LIVE_RESET_FINAL_PREVIEW_2026-08-20.md`.

# PRE-GO-LIVE RESET — concluído e validado (20/08/2026)

- Aplicado exclusivamente em `teste-483f6` com o snapshot aprovado e SHA-256 `f8a63f706885dc314e880b41b4f2a8649ec7a778a8d12b872632343372d382e4`.
- Foram removidos 394 documentos Firestore do manifesto único: 200 Legado e 194 V2. Os seis caminhos protegidos permaneceram presentes.
- A exclusão Auth exigiu `force: true` porque as contas não estavam desativadas; foram removidas somente as 6 identidades HML/teste aprovadas. `mmenso43@gmail.com` (UID `eEhjqVfcDeM0yCwiVVlb8JD8xZC3`) permaneceu.
- Validação pós-reset: tenant, membro ADMIN, `admins`, `usuarios`, mapeamento HML do Admin e `system/version` presentes; coleções operacionais de teste zeradas; `admin.html` abriu após recarregamento. Produção, Rules, Functions e Hosting não foram alterados.

# Fase — preparação real para Go-Live em HML (20/08/2026)

- O workspace correto foi confirmado em `C:\Users\menso\OneDrive\Desktop\barbearia` e os documentos obrigatórios foram revisados.
- Nenhum cadastro comercial foi criado: não foram informados barbeiros, serviços, horários institucionais, dados de contato/endereço ou planos reais suficientes para uma escrita segura.
- A HML permanece limpa e o Admin real `mmenso43@gmail.com` (Auth `eEhjqVfcDeM0yCwiVVlb8JD8xZC3`, perfil operacional `gVAwqbquC3V3fMjAjoJzJUndFlJ3`) permanece preservado.
- O relatório `ANTUNES_REAL_HML_GO_LIVE_PREPARATION.md` registra o estado técnico, as pendências e os dados que precisam de definição humana. A fase não atingiu ainda o critério `ANTUNES REAL CONFIGURADA EM HML`.

## Atualização — cadastros reais parciais em HML

- Foram cadastrados exclusivamente em `teste-483f6`, via `admin.barbeiro.salvar`, os barbeiros reais Samuel Torres, Lucas Antunes e Rafael Lucas, ativos e sem Auth/credenciais inventadas.
- Foram cadastrados 35 serviços reais via `admin.servico.salvar`. Os preços fixos, `A partir de ...` e `Consultar` foram preservados como texto no modelo atual.
- Permanecem pendentes Depilação Nasal (20 min), Depilação Orelha (10 min), Sobrancelha (10 min) e Tintura sem duração/preço completos; a Function rejeita durações menores que 30 minutos.
- Planos e funcionamento não foram criados/alterados. Dados institucionais fornecidos ainda não foram escritos porque não há comando institucional aprovado identificado no fluxo atual.
- A reconciliação independente Legado × V2 após os cadastros permanece pendente por falta de token efêmero de leitura no ambiente local. Não houve escrita direta nem fallback.

## Diagnóstico pré-Go-Live — serviços sub-30 e configuração real

- `functions/dual-write.js` exige duração inteira de pelo menos 30 minutos e múltipla de 30 em `admin.servico.salvar` e em `appointmentBlocks`; `validBarberSlots` também gera a grade em passos de 30.
- `public-hml/js/agenda.js` fixa `INTERVALO_MINUTOS = 30`, afetando disponibilidade, ocupações e blocos. Permitir 10/20 exige mudança arquitetural coordenada; nenhuma validação foi alterada.
- O modelo institucional identificado é o tenant `barbearias/{tenantId}` e `configuracoes/funcionamento`, com logo estática no frontend. Não foi localizado comando institucional aprovado para WhatsApp, Instagram e endereço; nenhum documento novo foi criado.
- Os barbeiros reais podem aparecer sem Auth; Auth só é necessário para o painel individual, que resolve `uid_usuario` e `horarios_trabalho`. E-mail/UID, disponibilidade e serviços compatíveis continuam pendentes.
- A reconciliação independente dos 3 barbeiros e 35 serviços continua pendente porque o token efêmero local não pôde ser emitido; não houve fallback ou escrita direta.

## Atualização — planos e serviços curtos reais em HML

- Cadastrados, via `admin.servico.salvar`, Depilação Nasal, Depilação Orelha e Sobrancelha com 30 minutos operacionais.
- Cadastrados, via `admin.plano.salvar`, Essencial, Platinum, Premium e Prime, ativos, com preços/usos confirmados e serviços reais vinculados.
- O funcionamento real não foi gravado: o comando atual aceita apenas dias fechados e não suporta a grade 08:30–20:00/21:00 nem domingo fechado com abertura excepcional.
- Tintura continua pendente por falta de duração real; dados institucionais continuam sem comando de persistência aprovado.
- A reconciliação independente Legado × V2 permanece gate obrigatório.

## Diagnóstico — funcionamento real Antunes

- O schema atual de `configuracoes/funcionamento` só armazena `dias_fechados_semana`; a grade padrão permanece fixa em 08:30–19:30/20:30 e domingo fechado.
- A proposta mínima é adicionar `intervalo_minutos: 30` e `periodos_semana` por dia, mantendo domingo com período-base 08:30–21:00 e `dias_fechados_semana[0] = true`; abertura excepcional deve ser uma exceção explícita por data, não a abertura permanente do domingo.
- A alteração afetaria o resolvedor de períodos na Function, `agenda.js`, Cliente, Barbeiro, Admin, fechamentos, bloqueios e as duas projeções do Dual Write, mas preservaria IDs/ocupações de 30 minutos.
- Nenhuma alteração de código, Rules, Hosting, Function ou dados foi feita. A proposta aguarda aprovação.
## Funcionamento real HML — 2026-08-20

Implementado exclusivamente em `teste-483f6`: períodos semanais, domingo fechado por padrão, abertura/fechamento por data, grade de 30 minutos e validação de que o serviço termina até o fechamento. Produção `barber-a01e7` não foi alterada. Smoke tests de domingo, abertura excepcional e limites de duração passaram; reconciliação Legado × V2 e teste isolado de fechamento excepcional permanecem pendentes.
## Reconciliação final do funcionamento HML — 2026-08-20

Reconciliação somente leitura executada com token efêmero por impersonação da conta de auditoria HML. Resultado: 0 ausentes e 0 divergências operacionais. Os três extras V2 `planos_assinatura/essencial`, `premium` e `prime` foram classificados como `NON_OPERATIONAL_LEGACY_PLACEHOLDER` e preservados. Os quatro planos comerciais reais estão equivalentes Legado × V2.

✅ FUNCIONAMENTO REAL ANTUNES HOMOLOGADO EM HML
## Barbeiros reais Antunes — 2026-08-20

HML contém três barbeiros reais, equivalentes em Legado × V2 e sem Auth: Samuel Torres (`YMJrJJ58I6N9bMl4jsgy`), Lucas Antunes (`vesIE3gCvo47nWhX8zGL`) e Rafael Lucas (`bt3uLVpTjXzecYEGKGkf`). O fluxo atual salva `email_acesso`, mas não cria convite/Auth nem vínculo automático; `uid_usuario`, disponibilidade individual e serviços compatíveis continuam pendentes. Nenhuma conta fictícia foi criada.
