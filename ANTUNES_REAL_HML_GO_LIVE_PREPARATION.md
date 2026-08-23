# Preparação real da Barbearia Antunes para Go-Live — HML

Data: 20/08/2026
Projeto: `teste-483f6`
Tenant: `tnt_80b2fda7ad644a1dbeff050aa8e0d595`
Status: `PENDENTE_DE_DEFINICAO`

## Escopo e segurança

- Nenhum dado real foi criado nesta etapa.
- Produção (`barber-a01e7`) não foi acessada nem alterada.
- Não foi recriada massa de homologação.
- Não foi ativado SUPER_ADMIN, onboarding SaaS ou novo tenant.
- O Admin preservado é `mmenso43@gmail.com` (Auth UID `eEhjqVfcDeM0yCwiVVlb8JD8xZC3`) e o perfil operacional correspondente é `gVAwqbquC3V3fMjAjoJzJUndFlJ3`.

## Estado técnico atual da HML

O smoke test pós-reset validou, somente por leitura, o acesso Admin, as abas principais, a ausência de erros de console e a ausência de criação silenciosa de planos após a correção do frontend HML. As coleções operacionais permanecem vazias; nenhum catálogo real foi cadastrado.

| Área | Estado atual |
|---|---|
| Tenant Antunes e estrutura V2 | Preservados |
| Admin real | Preservado e validado |
| Barbeiros | 0 — aguardando dados reais |
| Serviços | 0 — aguardando dados reais |
| Agendamentos | 0 |
| Ocupações/bloqueios operacionais | 0 |
| Planos/assinaturas/créditos | 0 |
| Financeiro/histórico operacional | 0 |

## Configurações institucionais

Ainda não há definição humana suficiente para cadastrar ou confirmar como configuração comercial:

- `nome`: confirmar nome oficial de exibição;
- `logo`: fornecer arquivo/URL aprovado;
- `cores`: confirmar paleta oficial;
- `whatsapp`: `PENDENTE_DEFINICAO`;
- `instagram`: `PENDENTE_DEFINICAO`;
- `endereco`: `PENDENTE_DEFINICAO`;
- `timezone`: confirmar explicitamente antes do Go-Live;
- horários, intervalos, domingos/feriados e regras de fechamento: `PENDENTE_DEFINICAO`.

Os dados fornecidos pelo proprietário para WhatsApp, Instagram e endereço foram registrados como referência de preparação, mas não foram gravados porque o fluxo atual não expõe um comando institucional aprovado para esses campos. Logo, permanecem `PENDENTE_DE_CONFIGURACAO` até existir caminho de escrita compatível.

Valores históricos encontrados na documentação não foram tratados como autorização para cadastro real.

## Barbeiros reais

Foram cadastrados, sem conta Auth e sem credenciais inventadas, pelo comando `admin.barbeiro.salvar`:

- Samuel Torres — ativo;
- Lucas Antunes — ativo;
- Rafael Lucas — ativo.

Ainda faltam, para eventual acesso ao painel: conta Auth, e-mail/UID e disponibilidade individual. Esses campos não foram inventados.

## Serviços reais

Foram cadastrados 35 serviços reais pelo comando `admin.servico.salvar`, preservando nomes, durações e preços fornecidos, inclusive as modalidades textuais `A partir de ...` e `Consultar`.

Não foram cadastrados:

- Depilação Nasal — 20 min;
- Depilação Orelha — 10 min;
- Sobrancelha — 10 min;
- Tintura — duração e preço incompletos.

Motivo: a Function exige duração inteira de pelo menos 30 minutos, em múltiplos de 30; não foi feito arredondamento ou conversão silenciosa.

Para cada serviço, ainda são necessários: nome, duração, preço, status e regras aplicáveis.

## Funcionamento

Os horários comerciais foram definidos, mas não foram gravados porque `admin.funcionamento.salvar` aceita somente `dias_fechados_semana`. A grade padrão também diverge dos horários reais de 20:00/21:00.

O modelo atual não preserva no mesmo fluxo uma grade-base dominical 08:30–21:00 com domingo fechado por padrão e abertura excepcional. Não foi gravada configuração parcial.

## Planos de assinatura

Foram criados explicitamente pelo fluxo `admin.plano.salvar`, sem criação automática:

- Essencial — R$ 144,99 — 4 usos — cortes Seg à Qui e Sex à Dom;
- Platinum — R$ 119,99 — 4 usos — Barba + Sobrancelha;
- Premium — R$ 269,99 — 4 usos — Corte + Barba + Sobrancelha Seg à Qui e Sex à Dom;
- Prime — R$ 234,99 — 4 usos — Corte + Barba Seg à Qui e Sex à Dom.

Todos aparecem ativos no painel Admin.

## Smoke tests

- Admin: acesso e carregamento das abas principais — aprovado somente em leitura.
- Barbeiro: não executado; não há barbeiro real configurado.
- Cliente: não executado; nenhum cliente fictício foi criado.
- Side effect de navegação em Assinaturas: removido no frontend HML e verificado com a lista de planos vazia.

Após esta rodada, a lista Admin exibiu os 3 barbeiros, os 38 serviços e os 4 planos ativos. A reconciliação independente Legado × V2 ainda não foi concluída porque o ambiente local não conseguiu obter o token efêmero de leitura.

Após os cadastros, a lista Admin exibiu os 3 barbeiros e os 35 serviços. A reconciliação independente Legado × V2 não foi concluída nesta rodada porque o ambiente local não conseguiu obter o token efêmero de leitura; nenhum fallback de escrita foi usado.

## Pendências para liberar a configuração real

1. Configurar institucionalmente WhatsApp, Instagram, endereço e demais campos por comando aprovado.
2. Definir Auth e disponibilidade dos três barbeiros, se eles precisarão acessar o painel.
3. Definir duração real de Tintura.
4. Implementar/autorizar o modelo correto de funcionamento antes de gravar horários reais.
5. Executar reconciliação somente leitura Legado × V2 com credencial efêmera.

## Diagnóstico das pendências — 20/08/2026

### Durações de 10/20 minutos

A Function `functions/dual-write.js` rejeita serviços em `admin.servico.salvar` quando `duracao < 30` ou quando `duracao % 30 !== 0`, retornando `Serviço inválido.`. A mesma premissa aparece em `appointmentBlocks()` e `validBarberSlots()`, que geram ocupações em passos de 30 minutos.

O frontend também fixa `INTERVALO_MINUTOS = 30`, gera candidatos em passos de 30 e calcula blocos/ocupações nessa grade. Portanto, aceitar 10/20 apenas removendo a validação criaria risco de agendamento e ocupação incorretos, além de inconsistência em reagendamento, bloqueios, remoções e métricas.

Menor mudança arquitetural segura, ainda não aplicada: parametrizar uma unidade de grade mínima de 10 minutos de ponta a ponta — Function, `validBarberSlots`, `appointmentBlocks`, IDs de ocupação, disponibilidade, frontend de Cliente/Admin/Barbeiro, bloqueios e testes — e validar compatibilidade Legado × V2 antes de liberar serviços sub-30. Não é uma alteração pontual segura.

### Configuração institucional

O Graphify e a inspeção estática localizaram apenas o tenant fixo em `public-hml/js/tenant.js`, a logo estática em `public-hml/img/logo-512.png` e o funcionamento em `configuracoes/funcionamento`. Não foi localizado comando aprovado para gravar WhatsApp, Instagram ou endereço institucionais. Não foi criada nova coleção nem realizada escrita institucional.

### Barbeiros e Auth

Os três perfis aparecem no catálogo sem Auth porque `admin.barbeiro.salvar` aceita `uid_usuario` vazio. Auth é necessário para o painel de Barbeiro: `barber.js` resolve o usuário autenticado e procura `barbeiros.uid_usuario`; disponibilidade individual é lida de `horarios_trabalho`, com fallback para a grade padrão. Ainda faltam e-mail/UID/Auth, disponibilidade e serviços compatíveis de cada profissional para liberar acesso individual.

### Reconciliação

A tentativa de reconciliação independente não foi concluída: o token efêmero local não pôde ser emitido porque o contexto do gcloud não conseguiu acessar o arquivo de credenciais. Nenhuma escrita foi feita e nenhum resultado Legado × V2 foi inventado. A reconciliação de 3 barbeiros e 35 serviços continua pendente.

Até essas definições, a saída correta é manter a HML limpa e não emitir `✅ ANTUNES REAL CONFIGURADA EM HML`.

## Atualização comercial aplicada — 20/08/2026

- Depilação Nasal, Depilação Orelha e Sobrancelha foram cadastrados com duração operacional de 30 minutos.
- Essencial, Platinum, Premium e Prime foram cadastrados ativos, com preços, usos e serviços reais vinculados.
- Tintura permanece pendente por falta de duração real.
- Funcionamento, dados institucionais e Auth/disponibilidade dos barbeiros permanecem pendentes.
- A reconciliação independente Legado × V2 continua sendo gate obrigatório.

## Diagnóstico — funcionamento real Antunes (20/08/2026)

### 1. Causa exata da limitação

O documento legado `configuracoes/funcionamento` hoje aceita apenas `dias_fechados_semana`. O handler `admin.funcionamento.salvar` não recebe períodos por dia. Quando não há períodos no barbeiro, Cliente e Function usam uma grade padrão fixa: 08:30–12:00 e 13:00–19:30 de segunda a quinta; 13:00–20:30 de sexta/sábado; domingo fechado.

Isso não representa os fechamentos 20:00/21:00 solicitados e não permite manter um horário-base de domingo para abertura excepcional.

### 2. Schema atual

```text
configuracoes/funcionamento
  dias_fechados_semana: { "0".."6": boolean }

barbeiros/{id}
  horarios_trabalho/{dia}: [{ inicio, fim }] | false

fechamentos_globais/{YYYY-MM-DD}
  data, inicio, fim, motivo, ativo, fechamento_id
```

O fechamento excepcional já existe para datas/períodos, mas não é uma regra de abertura dominical sobreposta a um horário-base.

### 3. Menor evolução segura proposta

Ampliar apenas `configuracoes/funcionamento` para:

```js
{
  intervalo_minutos: 30,
  periodos_semana: {
    "0": [{ inicio: "08:30", fim: "21:00" }],
    "1": [{ inicio: "08:30", fim: "20:00" }],
    "2": [{ inicio: "08:30", fim: "20:00" }],
    "3": [{ inicio: "08:30", fim: "20:00" }],
    "4": [{ inicio: "08:30", fim: "20:00" }],
    "5": [{ inicio: "08:30", fim: "21:00" }],
    "6": [{ inicio: "08:30", fim: "21:00" }]
  },
  dias_fechados_semana: { "0": true }
}
```

`dias_fechados_semana[0] = true` mantém domingo fechado; uma futura abertura excepcional deve ser um documento de exceção explícito, por exemplo `fechamentos_globais/{data}` com `tipo: "abertura"`, `inicio: "08:30"`, `fim: "21:00"`, e não uma alteração permanente do domingo. O resolvedor deve aplicar: fechamento de dia/período → abertura excepcional aprovada → disponibilidade do barbeiro.

### 4. Arquivos/handlers afetados

- `functions/dual-write.js`: whitelist/validação de `admin.funcionamento.salvar`, resolvedores `defaultPeriods`, `barberPeriods`, `validBarberSlots`, `agenda.criar`, `agenda.reagendar` e `bloqueio.criar`.
- `public-hml/js/agenda.js`: `periodosPadrao`, `periodosDoBarbeiro`, `horariosCandidatos`, `horariosDisponiveis`, `obterFechamentoGlobal` e início de grade.
- `public-hml/js/app.js`: seleção de horários do Cliente.
- `public-hml/js/barber.js`: timeline, horários para agendar/bloquear e métricas.
- `public-hml/js/admin.js`: formulário de funcionamento, fechamentos e dashboard financeiro/capacidade.
- `firestore.dual-write.hml.rules`/índices: somente revisão de leitura necessária; nenhuma alteração está autorizada nesta rodada.

### 5. Impacto e compatibilidade

Cliente, Barbeiro e Admin passariam a consumir o mesmo resolvedor de períodos. `agenda.criar`, `agenda.reagendar` e `bloqueio.criar` continuariam usando a mesma transação e as ocupações continuariam em slots de 30 minutos. O Dual Write não precisa mudar a identidade dos documentos: basta espelhar a configuração enriquecida em `configuracoes/funcionamento` Legado e `barbearias/{tenant}/configuracoes/funcionamento` V2.

Durante a transição, o resolvedor deve aceitar o schema antigo: se `periodos_semana` não existir, usar o comportamento atual. A escrita nova deve ser feita somente depois de validação equivalente nos dois modelos.

### 6. Testes obrigatórios antes de implementação

- segunda a quinta: slots iniciam em 08:30 e terminam antes de 20:00;
- sexta/sábado: slots iniciam em 08:30 e terminam antes de 21:00;
- domingo padrão: nenhum slot;
- domingo excepcional: somente a data explicitamente aberta gera slots 08:30–20:30;
- feriado/fechamento excepcional: remove os slots previstos;
- disponibilidade individual restringe o período global, nunca o amplia;
- `agenda.criar`, `agenda.reagendar` e `bloqueio.criar` rejeitam horários fora da interseção global + barbeiro;
- Legado × V2 equivalentes e sem ocupações órfãs;
- compatibilidade com documentos antigos sem `periodos_semana`.

Risco: médio, concentrado no resolvedor de períodos e no novo comando de configuração. Não implementar antes de aprovação.

### Implementação HML — funcionamento real (20/08/2026)

- Implementado em `teste-483f6` o schema enriquecido com intervalo de 30 minutos, períodos semanais, dias fechados e abertura/fechamento por data.
- Mantido fallback para o schema legado e resolução comum para Cliente, Barbeiro e Admin.
- Aplicado o limite `início + duração <= fechamento` na disponibilidade e nos handlers de agenda/bloqueio.
- Corrigido e publicado somente em HML um erro de inicialização de variável em `validatePeriodsMap`.
- Funcionamento salvo: segunda–quinta 08:30–20:00; sexta/sábado 08:30–21:00; domingo fechado.
- Smoke tests concluídos: domingo fechado; abertura excepcional em 23/08/2026 com slots 08:30–20:30; limites de 30/60/90/120 minutos; sexta com último início 20:30.
- A exceção de abertura usada no teste foi removida; nenhuma massa operacional foi criada.
- Pendente: teste isolado de fechamento excepcional por data e reconciliação independente Legado × V2.

### Reconciliação final HML — 20/08/2026

Reconciliação somente leitura executada com token efêmero por impersonação da conta `dual-read-auditor-692@teste-483f6.iam.gserviceaccount.com`. Resultado: 46 documentos Legado, 49 V2, 46 equivalentes, 0 ausentes e 0 divergências operacionais. Os extras V2 `planos_assinatura/essencial`, `premium` e `prime` foram classificados como `NON_OPERATIONAL_LEGACY_PLACEHOLDER` por estarem inativos, sem preço definido, sem preço e sem serviços vinculados. Não foram removidos.

### Gate fechado — 20/08/2026

Funcionamento real validado em HML: horários semanais, domingo fechado, abertura excepcional, fechamento excepcional, grade de 30 minutos e limite integral de duração antes do fechamento. Aberturas/fechamentos de teste foram removidos e nenhuma massa operacional de teste permanece. Os quatro planos comerciais reais estão equivalentes Legado × V2.

✅ FUNCIONAMENTO REAL ANTUNES HOMOLOGADO EM HML

### Barbeiros reais — estado atual

Os três registros estão presentes e equivalentes em Legado × V2, ativos e sem identidade Auth:

- Samuel Torres — `YMJrJJ58I6N9bMl4jsgy`
- Lucas Antunes — `vesIE3gCvo47nWhX8zGL`
- Rafael Lucas — `bt3uLVpTjXzecYEGKGkf`

`email_acesso` e `uid_usuario` permanecem vazios. O painel Admin apenas grava um e-mail autorizado; o código atual não cria convite/Auth nem provisiona vínculo automático no primeiro login. O painel Barbeiro exige Auth, resolução de identidade e `uid_usuario` correspondente. Disponibilidade individual e serviços compatíveis ainda estão pendentes de definição humana. Nenhuma conta Auth foi criada.
