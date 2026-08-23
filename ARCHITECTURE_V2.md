# Arquitetura V2 — Multi-barbearia

**Estado:** definida para revisão; nenhuma coleção atual foi migrada, nenhuma
regra foi publicada e nenhum fluxo de produção foi redirecionado.

## 1. Objetivo e princípios

Transformar a aplicação em uma plataforma para várias barbearias sem reconstruir
o produto e sem misturar dados, permissões, agenda ou financeiro entre elas.

Princípios obrigatórios:

- A Barbearia Antunes continua como primeira tenant, com ID interno imutável
  `tnt_80b2fda7ad644a1dbeff050aa8e0d595` e slug público `antunes`.
- O Firebase Authentication continua global: uma conta pode participar de mais
  de uma barbearia.
- Dados operacionais pertencem a uma única barbearia e vivem somente abaixo do
  caminho dela.
- A interface nunca concede acesso. Firestore Rules conferem o vínculo da conta
  com a barbearia em todo acesso.
- A migração é incremental, reversível e verificável. Dados legados não são
  apagados durante a transição.

## 2. Modelo do Firestore

### 2.1 Dados globais de identidade

```text
usuarios/{uid}
```

Documento global de identidade, sem agenda, créditos, serviços, tenant ou
papéis de uma empresa específica.

```js
{
  nome: "Emerson Santos",
  email: "cliente@exemplo.com",
  avatar_data: "...",              // opcional
  criado_em: Timestamp
}
```

O perfil global não contém permissões. A autorização é exclusivamente
confirmada pelo documento `barbearias/{barbeariaId}/membros/{uid}`. As Rules
sempre verificam pertencimento (`"ADMIN" in papeis`), nunca a posição de um
papel no array.

### 2.2 Tenant e membros

```text
barbearias/{barbeariaId}
barbearias/{barbeariaId}/membros/{uid}
```

```js
// barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595
{
  tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595",
  nome: "Barbearia Antunes",
  slug: "antunes",
  logo: "...",                     // URL ou data URL institucional
  status: "ACTIVE",
  plano: "padrao",
  dominio: "barber-a01e7.web.app",
  timezone: "America/Sao_Paulo",
  created_at: Timestamp,
  updated_at: Timestamp,
  schema: 2
}

// barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/membros/{uid}
{
  uid: "uid-da-conta",
  papeis: ["CLIENTE", "BARBEIRO"], // contém CLIENTE, BARBEIRO e/ou ADMIN
  barbeiro_id: "id-local-do-barbeiro", // apenas quando aplicável
  ativo: true,
  criado_em: Timestamp,
  atualizado_em: Timestamp
}
```

Papéis atuais:

- **ADMIN:** membro administrativo somente da própria barbearia.
- **BARBEIRO:** membro vinculado a um barbeiro local; vê e opera somente a sua
  agenda naquele tenant.
- **CLIENTE:** membro que possui perfil e dados independentes em cada tenant.

## 3. Estrutura completa do Firestore por barbearia

```text
barbearias/{barbeariaId}/
├── configuracoes/{configId}
│   └── funcionamento
├── fechamentos/{YYYY-MM-DD}
├── membros/{uid}
├── clientes/{uid}
├── barbeiros/{barbeiroId}
├── servicos/{servicoId}
├── agendamentos/{agendamentoId}
├── ocupacoes/{ocupacaoId}
├── bloqueios/{bloqueioId}
├── planos_assinatura/{planoId}
├── assinaturas/{assinaturaId}
├── historico_assinaturas/{historicoId}
└── financeiro/{periodoId}
```

Estruturas SaaS reservadas, vazias até que suas funcionalidades sejam
implementadas e protegidas por Rules específicas:

```text
barbearias/{barbeariaId}/integracoes/{integracaoId}
barbearias/{barbeariaId}/webhooks/{webhookId}
barbearias/{barbeariaId}/api_keys/{apiKeyId}
barbearias/{barbeariaId}/billing/{registroId}
barbearias/{barbeariaId}/audit_logs/{eventoId}
```

### Versionamento global do sistema

Na primeira escrita aprovada da Fase 3C, será criado o documento global:

```text
system/version
```

```js
{
  schema: 2,
  tenancy: true,
  mode: "legacy"
}
```

Ele é a fonte única para o estado da arquitetura, não um mecanismo de
autorização. Até o cutover, `mode` permanece `legacy`; a leitura atual do site
não muda. A escrita desse documento será feita somente pela rotina de migração
autorizada, após homologação — nunca por cliente ou barbeiro.

Também será criada, somente na Fase 3C, uma coleção operacional global e
imutável para auditoria:

```text
migration_logs/{migrationId}
```

```js
{
  migration: "tenant-v2",
  tenant_id: "tnt_80b2fda7ad644a1dbeff050aa8e0d595",
  tenant_slug: "antunes",
  started_at: Timestamp,
  finished_at: Timestamp,
  documents_read: 1524,
  documents_written: 1524,
  warnings: [],
  errors: [],
  status: "SUCCESS"
}
```

Esses logs não armazenam credenciais ou dados pessoais desnecessários. O
frontend poderá ler apenas o estado de versão necessário após as Rules da V2
serem aprovadas; a gravação permanece na rotina de migração.

### 3.1 Entidades e relacionamentos

| Entidade | ID | Dados principais | Relações |
| --- | --- | --- | --- |
| `clientes/{uid}` | UID global | nome, telefone, preferências, avatar local | membro CLIENTE; agendamentos e assinaturas próprios |
| `barbeiros/{id}` | local ao tenant | nome, foto, ativo, `uid_usuario`, horários | membro BARBEIRO opcional; serviços e agenda locais |
| `servicos/{id}` | local ao tenant | nome, preço, duração, ativo | planos e agendamentos locais |
| `agendamentos/{id}` | `barbeiroId_data_horario` dentro do tenant | cliente, barbeiro, serviço, status, origem | cria ocupações; pode apontar para assinatura |
| `ocupacoes/{id}` | `barbeiroId_data_horario` dentro do tenant | barbeiro, data, horário, agendamento/bloqueio | transacional com agenda/bloqueio |
| `bloqueios/{id}` | local ao tenant | barbeiro, período, motivo | gera ocupações locais |
| `planos_assinatura/{id}` | local ao tenant | preço, usos, `servicos_ids`, ativo | base para novas assinaturas |
| `assinaturas/{id}` | local ao tenant | cliente, plano, créditos, status, vigência | reserva/consome crédito por agendamento |
| `historico_assinaturas/{id}` | local ao tenant | assinatura, cliente, agendamento, crédito | imutável, criado na conclusão/falta |
| `financeiro/{periodoId}` | local ao tenant | cache/fechamento opcional | derivado de agendamentos concluídos, nunca fonte de verdade |

O valor financeiro existente continuará sendo calculado dos agendamentos até
que um fechamento local seja realmente necessário. Nenhum dado financeiro será
inventado na migração.

### 3.2 IDs de agenda e ocupação

Os IDs canônicos podem continuar como `barbeiroId_data_horario`, porque agora
ficam dentro do caminho da barbearia. Assim, dois tenants podem ter o mesmo ID
local sem colisão:

```text
barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/agendamentos/abc_2026-08-20_09:00
barbearias/tnt_outra-barbearia/agendamentos/abc_2026-08-20_09:00
```

### 3.3 Identificação externa e APIs futuras

O slug serve somente para marca e roteamento público, por exemplo
`barbearia.com/antunes`. A resolução desse endereço consulta metadata pública e
retorna o `tenant_id` interno; todas as consultas, transações, logs e futuros
tokens de integração usam exclusivamente o ID interno.

Uma futura API pública deverá exigir `X-Tenant-ID` ou `tenant_id` explícito. O
valor será uma referência de contexto, nunca prova de acesso: o serviço ainda
validará a conta/chave de API, o tenant ativo e as permissões antes de qualquer
leitura ou escrita. Domínio e slug isoladamente jamais autorizam uma operação.

### 3.4 Padrão de audit logs

Eventos administrativos e operacionais relevantes usarão o mesmo formato em
`barbearias/{tenantId}/audit_logs/{eventoId}`:

```js
{
  actor_uid: "uid-da-conta",       // quem
  tenant_id: "tnt_...",            // onde
  action: "APPOINTMENT_CANCELLED", // ação padronizada
  collection: "agendamentos",
  document_id: "id-local",
  result: "SUCCESS",               // SUCCESS | DENIED | FAILED
  occurred_at: Timestamp,           // quando
  ip: "...",                       // opcional, somente se fornecido por backend confiável
  user_agent: "..."                // opcional, minimizado quando aplicável
}
```

Logs não armazenam senhas, tokens, números completos de cartão ou o conteúdo
integral de documentos. O acesso e a retenção seguirão as Rules e a política de
privacidade aplicável antes de essa funcionalidade ser ativada.

### 3.5 Billing reservado

`barbearias/{tenantId}/billing/{registroId}` ficará reservado para a futura
gestão de cobrança da plataforma, sem habilitar pagamentos agora:

```js
{
  plano: "professional",
  status: "ACTIVE",
  trial_until: Timestamp,
  next_invoice: Timestamp,
  limits: { active_barbers: 5, monthly_appointments: 1000 },
  active_users: 0,
  active_barbers: 0
}
```

Ele permitirá cobrar por plano, barbeiros, agendamentos ou recursos premium
sem alterar a estrutura operacional de agenda.

## 4. Regras de segurança V2

As Rules usarão funções equivalentes a estas, sem confiar em `role`,
`barbearia_id` ou qualquer outro valor enviado pelo browser:

```text
logado()
membroAtivo(barbeariaId)
temPapel(barbeariaId, papel)
ehAdminDa(barbeariaId)
ehBarbeiroDa(barbeariaId, barbeiroId)
ehClienteDo(barbeariaId, uid)
```

Fonte de verdade:

```text
papeis locais -> barbearias/{barbeariaId}/membros/{uid}.papeis
```

Matriz de acesso principal:

| Recurso | Cliente | Barbeiro | Admin local |
| --- | --- | --- | --- |
| Perfil local próprio | ler/editar campos permitidos | ler próprio se também cliente | ler/editar dentro do tenant |
| Catálogo e funcionamento | ler | ler | total |
| Agendamento | criar/ler/cancelar somente próprio | ler/operar somente próprio barbeiro | total no tenant |
| Ocupação | apenas leitura pontual necessária para vaga livre | própria agenda | total |
| Bloqueio | sem escrita | apenas próprio barbeiro | total |
| Plano e assinatura | ler plano ativo; criar solicitação própria | sem gestão | total no tenant |
| Histórico de assinatura | próprio quando houver tela de cliente autorizada | próprio atendimento, sem editar | total no tenant |
| Membros e papéis | sem promoção/alteração | sem promoção/alteração | gerencia papéis locais permitidos |

Regras críticas:

1. O caminho do tenant já limita a consulta à empresa correta; não haverá
   consultas globais de agendamentos, clientes ou serviços.
2. Um cliente só poderá criar agendamento se `cliente_id == request.auth.uid`,
   o serviço/barbeiro existirem no mesmo tenant e as ocupações forem criadas na
   mesma transação.
3. Crédito, reserva e histórico de assinatura serão validados com `getAfter`
   dentro do mesmo caminho de tenant.
4. Um barbeiro não poderá escolher outro `barbeiro_id` por HTML, SDK ou REST.
5. ADMIN é local: ser admin da Antunes não permite ler a agenda da
   `barbearia-centro`.
6. Nenhum cliente ou barbeiro pode gravar `papel` ou `membros` para se
   promover.

> Nesta V2 não existe SUPER_ADMIN em código nem nas Rules. O provisionamento
> de uma nova tenant será definido em etapa posterior, sem credenciais
> administrativas no frontend.

## 5. Fluxos

### Login e seleção de barbearia

1. Firebase Authentication identifica a conta.
2. A aplicação resolve o tenant pela configuração pública da marca (futuro
   domínio/slug), nunca por um valor livre no navegador.
3. Ela lê `membros/{uid}` daquele tenant e verifica papéis por pertinência ao
   array, sem depender da ordem.
4. A interface mostra Cliente, Painel do Barbeiro e/ou Painel Admin conforme o
   membro ativo, mas as Rules fazem a validação definitiva.
5. A mesma conta pode repetir o fluxo em outro tenant sem compartilhar agenda,
   perfil local, créditos ou histórico.

### Cliente

Cadastro cria/atualiza `usuarios/{uid}` e o perfil
`barbearias/{id}/clientes/{uid}`. A agenda lê apenas catálogo, profissionais,
fechamentos e ocupações daquele caminho. Agendamento, assinatura e fidelidade
ficam vinculados ao mesmo tenant.

### Barbeiro

O membro BARBEIRO contém o `barbeiro_id` local. `barber.html` usa esse vínculo
para abrir apenas `barbearias/{id}/barbeiros/{barbeiroId}` e os documentos de
agenda/bloqueio correspondentes.

### Admin

O membro ADMIN acessa cadastros, agenda, assinaturas e financeiro somente em
`barbearias/{id}`. O admin atual da Antunes será migrado como ADMIN de
`antunes`.

## 6. Estratégia de migração da Barbearia Antunes

### Pré-requisitos

1. Fazer export/backup do Firestore e guardar a contagem por coleção.
2. Registrar IDs e contagens dos documentos globais atuais.
3. Executar primeiro o utilitário de **dry-run** somente-leitura. Ele monta a
   árvore em memória, compara relações e gera relatório local, sem chamar
   qualquer operação de escrita do Firestore.
4. Criar documento de controle da migração com versão, início, fim, contagens,
   checksum e falhas por coleção.

### Ordem segura

1. Após o dry-run aprovado, criar `barbearias/antunes` e os membros do tenant,
   sem alterar leituras do site publicado.
2. Copiar catálogo, configurações, fechamentos, clientes e barbeiros para a
   árvore `antunes`, preservando IDs quando possível.
3. Copiar agendamentos, ocupações e bloqueios no mesmo lote lógico e verificar
   que cada ocupação aponta para um agendamento/bloqueio local válido.
4. Copiar planos, assinaturas e histórico, mantendo a referência dos IDs
   locais e os saldos de crédito.
5. Comparar contagens, IDs e totais financeiros entre legado e tenant.
6. Publicar uma versão com **dual-write**, ainda lendo o legado. Toda gravação
   nova deve ir aos dois modelos durante a janela de validação.
7. Executar sincronização incremental, comparar novamente e trocar as leituras
   para `barbearias/antunes` por área: catálogo, perfil, agenda, assinaturas,
   financeiro e Admin.
8. Só depois de todos os testes, publicar Rules que fecham as coleções globais
   para a aplicação. O legado permanece como backup somente-leitura até o fim
   do período de rollback definido.

## 7. Rollback

- A migração não exclui coleções globais.
- Enquanto houver dual-write, uma flag de origem por área permite voltar a ler
  o legado sem perda de dados.
- Se a validação de uma área falhar, a leitura volta ao legado, o tenant novo é
  marcado como `migracao_pendente` e a causa é corrigida antes de tentar de
  novo.
- Nenhuma Rule que bloqueie o legado será publicada antes de uma rodada completa
  de testes e comparação de dados.
- O rollback não apaga a cópia tenant; ela serve para diagnóstico e nova
  execução idempotente.

## 8. Índices necessários

Como as coleções tenant são subcoleções com nomes repetidos, os índices serão
do tipo **collection group**, mas as consultas sempre partirão do caminho de
uma barbearia.

| Coleção | Campos | Uso |
| --- | --- | --- |
| `agendamentos` | `barbeiro_id`, `data`, `horario` | timeline/disponibilidade do barbeiro |
| `agendamentos` | `cliente_id`, `data desc` | meus agendamentos e perfil |
| `agendamentos` | `status`, `data`, `barbeiro_id` | filtros admin/financeiro quando necessário |
| `bloqueios` | `barbeiro_id`, `data`, `inicio` | agenda e bloqueios |
| `assinaturas` | `cliente_id`, `status`, `vencimento_em` | assinaturas do cliente |
| `historico_assinaturas` | `assinatura_id`, `utilizado_em desc` | histórico de créditos |
| `servicos` | `ativo`, `nome` | catálogo local |
| `barbeiros` | `ativo`, `nome` | escolha de profissional |

Os índices finais serão gerados somente depois de cada consulta real ser
migrada; não serão publicados índices especulativos.

## 9. Plano de testes antes de qualquer corte

### Dados

- Contagem e IDs de todos os documentos por coleção.
- Agenda/ocupação/bloqueio consistentes para cada horário migrado.
- Saldo e histórico de cada assinatura consistentes.
- Totais de faturamento, cancelamentos e faltas iguais ao legado.

### Permissões

- Cliente de Antunes não lê ou escreve outro cliente/tenant.
- Barbeiro só enxerga a própria agenda no tenant de vínculo.
- ADMIN Antunes não acessa nenhuma coleção da segunda barbearia.
- Tentativas por DevTools, REST e HTML alterado retornam `permission-denied`.

### Fluxos e interface

- Login, cadastro, perfil, agenda normal e por assinatura.
- Cliente chegou, iniciar, concluir, cancelar e não compareceu.
- Assinaturas, créditos, histórico e financeiro.
- Admin e Barber panels.
- Desktop, Android e Safari iPhone em zoom 100%, sem alterações de UI ou
  overflow horizontal.

## 10. Próxima decisão técnica

O próximo passo é executar `scripts/multi-tenant-dry-run.mjs`. Ele lê os dados
atuais, monta a tenant `antunes` somente em memória e gera um relatório local
de equivalência. Nenhuma consulta da aplicação nem `firestore.rules` será
alterada antes da comparação de dados ser aprovada.

## 11. Fases aprovadas para a migração

### Fase 3A — Dry-run de produção, somente leitura

O dry-run lê todas as coleções legadas, monta a projeção `antunes` em memória
e interrompe a aprovação se houver qualquer divergência. Ele confere:

- total de clientes, barbeiros, serviços, ocupações, assinaturas, históricos e
  configurações/fechamentos;
- total de agendamentos e a distribuição por status;
- créditos totais, utilizados, restantes e reservados;
- financeiro realizado, previsto, concluídos, cancelamentos e faltas;
- relações cliente, barbeiro, serviço, plano, assinatura, histórico,
  agendamento, bloqueio e ocupação;
- documentos órfãos, IDs duplicados e agendamentos ativos sem ocupação;
- contagem de cada coleção legada contra a projeção tenant.

O relatório só marca `aprovado_para_migracao: true` se **não existir nenhum
erro ou aviso**, todas as contagens coincidirem e financeiro/créditos forem
equivalentes. Ele não cria `barbearias/antunes` nesta fase.

### Fase 3B — Shadow Migration em homologação

Uma cópia de teste será criada em um projeto Firebase separado, nunca no
projeto publicado. A migração completa será executada apenas nesse ambiente e
validará Cliente, Barbeiro, Admin, agenda, disponibilidade, bloqueios,
assinaturas, créditos, histórico e Financeiro.

Critério de saída: todos os testes funcionais, de permissão e de equivalência
passam; qualquer inconsistência volta para a correção da rotina de migração.

### Fase 3C — Shadow Migration em produção

Somente após a homologação, a cópia real para `barbearias/antunes` será feita
de forma idempotente. O site ainda continuará lendo exclusivamente a estrutura
legada. Não haverá corte de tráfego nessa fase.

A rotina cria/atualiza `system/version` em `legacy` e grava um único
`migration_logs/{migrationId}` com as contagens, alertas, falhas e resultado.
Se qualquer comparação falhar, o status será `FAILED` e não haverá avanço para
dual-read.

### Fase 3D — Dual-read controlado

Depois da cópia validada, uma feature flag central será introduzida:

```text
system/version
{ schema: 2, tenancy: true, mode: "legacy" | "dual-read" | "multi-tenant" }
```

- `legacy`: apenas a estrutura atual é usada.
- `dual-read`: uma área por vez lê a origem principal legada e compara a
  resposta com a estrutura tenant, sem mudar o resultado exibido ao usuário.
- `multi-tenant`: a área validada passa a usar a estrutura tenant.

Na fase de comparação, divergências serão registradas em relatório controlado
ou em `barbearias/{id}/audit_logs`, sem expor dados pessoais no console do
cliente. A flag não será gravável por cliente ou barbeiro; a regra definitiva
será publicada somente junto das consultas V2.

### Fase 3E — Cutover gradual

Com dual-read estável, consultas serão trocadas por domínio funcional:

1. clientes e perfil;
2. barbeiros;
3. serviços;
4. planos;
5. assinaturas;
6. agendamentos;
7. ocupações e bloqueios;
8. financeiro.

Após cada domínio, cliente, barbeiro e admin serão testados antes de avançar.
As coleções legadas só poderão ser removidas depois de período de retenção,
backup recuperável e confirmação explícita; elas não serão apagadas no
cutover.

## 12. Idempotência e bloqueios

Toda rotina de migração futura usará IDs preservados no caminho tenant e uma
chave de versão por documento. Rodar a mesma rotina uma, duas ou dez vezes
deve produzir a mesma projeção, sem criar duplicatas nem substituir dados
tenant que já tenham sido validados.

Qualquer uma destas condições bloqueia automaticamente a próxima fase:

- erro de integridade ou equivalência no dry-run;
- falha de fluxo ou permissão em homologação;
- divergência em dual-read;
- tentativa de publicar Rules antes de todas as consultas correspondentes
  estarem adaptadas.
