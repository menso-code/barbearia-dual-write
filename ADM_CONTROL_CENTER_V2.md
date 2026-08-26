# ADM Control Center V2

## Fonte canônica de produto e marca

Este documento deve ser interpretado em conjunto com [`GOESTUDIO_PRODUCT_BRAND.md`](./GOESTUDIO_PRODUCT_BRAND.md), que é a fonte canônica para identidade, posicionamento, direção visual e visão de produto do GoEstudio.

Em caso de decisões de interface relacionadas a marca, cores, posicionamento ou separação entre plataforma e estabelecimento, prevalece a direção documentada em `GOESTUDIO_PRODUCT_BRAND.md`.

## Objetivo

Transformar o **Painel ADM no coração operacional do GoEstudio**, deixando de ser apenas uma área de configurações para se tornar o principal ambiente de trabalho do gestor.

A Agenda Operacional deve ocupar o centro da experiência, conectando atendimento, clientes, profissionais, serviços, planos, assinaturas, financeiro e indicadores do negócio.

## Princípio de produto

**GoEstudio é a plataforma. O estabelecimento é configurável.**

A Barbearia Antunes é o primeiro ambiente/laboratório do produto, mas sua identidade específica não deve definir o núcleo visual ou funcional do GoEstudio.

O Control Center deve evoluir preparado para múltiplos estabelecimentos, mesmo que a resolução dinâmica de tenant seja uma etapa arquitetural posterior.

## Estrutura principal do ADM

- Visão Geral
- Agenda
- Clientes
- Profissionais
- Serviços
- Planos e Assinaturas
- Financeiro
- Relatórios
- Configurações

## Agenda Operacional

A Agenda deve ser o elemento dominante do painel e permitir:

- visão diária/semanal;
- profissionais em colunas;
- horários em linhas;
- agendamentos com cliente, serviço, horário e status;
- seleção de atendimento;
- operações rápidas sem sair da agenda.

Estados operacionais relevantes:

- Confirmado
- Cliente chegou
- Em atendimento
- Concluído
- Cancelado
- Não compareceu

Ações rápidas previstas:

- Cliente chegou
- Iniciar atendimento
- Concluir
- Reagendar
- Cancelar

## Indicadores do gestor

O topo do Control Center poderá apresentar indicadores compactos, sem competir visualmente com a Agenda:

- faturamento do dia;
- agendamentos do dia;
- ocupação;
- clientes atendidos;
- ticket médio;
- próximo atendimento;
- profissionais ativos;
- alertas operacionais.

## Configurações — Identidade do Estúdio

O administrador deverá poder personalizar a identidade do próprio estabelecimento sem alterar a identidade institucional do GoEstudio.

Configurações previstas:

- nome do estabelecimento;
- logo;
- nome curto;
- cor principal do estabelecimento;
- cor de destaque;
- tema quando aplicável;
- telefone;
- WhatsApp;
- endereço;
- Instagram/redes sociais;
- informações institucionais.

O favicon permanece global do GoEstudio e não é configurável por estabelecimento.
`GOESTUDIO_FAVICON = GLOBAL` · `TENANT_FAVICON_CONFIGURABLE = NÃO`.

A futura URL pública do estabelecimento seguirá o modelo `FUTURE_SUBDOMAIN`, por exemplo:
`barbeariaantunes.goestudio.com.br`. DNS, wildcard e resolução de subdomínio não fazem parte desta fase.

A interface deverá oferecer **pré-visualização em tempo real** da identidade aplicada ao painel e, futuramente, às experiências do cliente e de agendamento.

### Separação de identidade

- **GoEstudio:** plataforma/produto SaaS.
- **Estabelecimento:** marca configurável do cliente.

A identidade principal do GoEstudio segue `GOESTUDIO_PRODUCT_BRAND.md`: base escura/preta, branco e azul como destaque. Verde pode ser utilizado semanticamente para sucesso/status, mas não como cor principal da marca GoEstudio.

## Fundação existente a preservar

A evolução do ADM deve aproveitar a fundação técnica já construída, incluindo:

- comandos operacionais;
- autorização;
- idempotência;
- estrutura Legado/V2;
- testes e contratos existentes.

A intenção não é reconstruir o backend validado, mas desenvolver uma experiência administrativa superior sobre essa base.

## Próxima etapa técnica

Realizar levantamento do frontend administrativo atual, principalmente:

- `public/admin.html`
- `public/js/admin.js`
- `public/js/agenda.js`
- CSS relacionado ao painel

Classificar cada parte como:

- **REAPROVEITAR**
- **REFATORAR**
- **CONSTRUIR**
- **REMOVER/DEPRECAR**

Depois do levantamento, produzir o plano incremental de implementação do **ADM Control Center V2**, priorizando a Agenda Operacional como núcleo da experiência.

## Restrição da primeira etapa

A primeira etapa deverá ser de análise e planejamento, sem:

- alteração de runtime;
- alteração de dados;
- deploy;
- mudança em produção.

## Resultado esperado

Ao final do levantamento deverá existir uma especificação clara da nova arquitetura de interface do Painel ADM, permitindo iniciar sua implementação incremental sem comprometer a fundação operacional já validada.

---

`NEXT_STEP = ADM_CONTROL_CENTER_V2_FRONTEND_AUDIT`

`PRIMARY_GOAL = PAINEL_ADM_COMO_CORACAO_DO_NEGOCIO`

`PRODUCT_BRAND_SOURCE = GOESTUDIO_PRODUCT_BRAND.md`

`RUNTIME_CHANGE_INITIAL_PHASE = NÃO`

`PRODUCTION_CHANGE_INITIAL_PHASE = NÃO`

`DEPLOY_INITIAL_PHASE = NÃO`
