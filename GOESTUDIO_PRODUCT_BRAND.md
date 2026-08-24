# GoEstudio — Documento da Marca e Projeto

Última atualização: 24 de agosto de 2026  
Status: Em desenvolvimento / pré-lançamento

## 1. Visão geral

GoEstudio é uma plataforma de gestão voltada inicialmente para negócios de beleza, com foco especial em barbearias.

A proposta é reunir em um único ambiente as principais rotinas do estabelecimento, reduzindo a dependência de agenda manual, Direct, WhatsApp, caderno e processos espalhados.

### Posicionamento atual

> **Gestão inteligente para negócios de beleza.**

Mensagem complementar usada na comunicação:

> **Agenda • Clientes • Assinaturas • Gestão**  
> **Seu negócio organizado em um só lugar.**

A marca está sendo construída para não ficar limitada exclusivamente a barbearias. A ideia é permitir expansão futura para salões, estética e outros negócios de serviços.

## 2. Nome da marca

Nome escolhido: **GoEstudio**.

Na comunicação, o nome pode aparecer como GoEstudio ou GOESTUDIO. A identidade visual utiliza um símbolo GO como elemento principal da marca.

### Pesquisa de marca

Foram realizadas pesquisas na base do INPI, incluindo GOSTUDIO, GoStudio, StudioGO e GoEstudio. A pesquisa específica por GoEstudio na Classe de Nice 42 não apresentou resultado na consulta realizada.

> Importante: ausência de resultado na busca não garante automaticamente a possibilidade de registro. A decisão definitiva depende do exame técnico do INPI.

## 3. Domínio

O domínio oficial adquirido para o projeto é **goestudio.com.br**.

- Data de criação: 19/08/2026
- Expiração exibida no Registro.br: 19/08/2028
- Status: Publicado

Esse domínio deverá se tornar o endereço principal da plataforma e da presença institucional do GoEstudio.

## 4. Instagram

Perfil: **@goestudio.app**

Bio utilizada:

> 📱 Gestão inteligente para negócios de beleza.  
> 📅 Agenda • Clientes • Assinaturas • Gestão  
> ✨ Seu negócio organizado em um só lugar.  
> 🚀 Em breve.

Também foi configurado um canal de contato pelo WhatsApp.

## 5. Identidade visual

A marca deve transmitir tecnologia, confiança, organização, simplicidade, profissionalismo, produto SaaS moderno e gestão.

Elementos atuais:

- fundo predominantemente preto/escuro;
- branco para contraste;
- azul como cor de destaque;
- símbolo GO;
- tipografia limpa e moderna;
- interfaces escuras;
- composição minimalista.

Diretrizes descartadas:

- verde como cor principal da marca GoEstudio;
- roxo;
- gradientes genéricos associados a produtos de IA;
- excesso de efeitos futuristas;
- aparência de template;
- elementos que façam a identidade parecer gerada automaticamente.

## 6. Produto

O GoEstudio nasceu a partir do desenvolvimento de um sistema real de agendamento e gestão para barbearia. O primeiro ambiente usado como laboratório do produto foi desenvolvido para a Barbearia Antunes.

Esse projeto permitiu validar fluxos de cliente, barbeiro e administrador antes da transformação da solução em um produto mais amplo.

## 7. Estrutura atual do sistema

### Cliente

Pode criar conta, fazer login, visualizar profissionais, selecionar barbeiro e serviço, escolher data e horário, realizar e acompanhar agendamentos, acessar assinaturas, gerenciar foto de perfil, consultar informações do estabelecimento, WhatsApp e localização.

### Profissional / Barbeiro

Possui painel próprio com agenda individual, atendimentos do dia, concluídos/restantes, próximo cliente, timeline, alteração de status, acesso aos próprios agendamentos, criação de agendamentos e envio de lembretes.

### Administrador

Possui visão ampla da operação, incluindo gerenciamento e filtros de agendamentos, pesquisa de clientes, paginação, ordenação, criação manual de agendamento, profissionais, vínculo seguro de contas, assinaturas, aprovações, clientes e controle operacional.

## 8. Sistema de agendamento

Fluxo principal:

**Cliente → Profissional → Serviço → Data → Horário → Confirmação**

Regras implementadas/projetadas incluem bloqueio de horários indisponíveis, prevenção de duplicidade, limite por cliente, dias fechados, fechamento por datas específicas, horário do estabelecimento e janela de agendamentos futuros.

A arquitetura do GoEstudio deverá permitir que essas regras sejam configuráveis para cada negócio.

## 9. Assinaturas

Fluxo desenvolvido:

**Cliente solicita plano → estabelecimento recebe solicitação → pagamento no estabelecimento → administrador aprova → créditos são liberados**

Recursos trabalhados incluem planos, assinaturas ativas, múltiplas assinaturas, créditos mensais, controle de uso, expiração, histórico, identificação do cliente, serviços vinculados, aprovação administrativa e termos.

## 10. Segurança e infraestrutura

Infraestrutura atual baseada em Firebase, considerando Authentication, Cloud Firestore, Hosting, Cloud Messaging, App Check e Cloud Functions.

Controle de acesso em três níveis: Admin, Profissional e Cliente. O objetivo é que a segurança não dependa apenas da interface, mantendo restrições também no backend e nas regras de dados.

## 11. Notificações

O projeto considera notificações via PWA + Firebase Cloud Messaging para novos agendamentos, alterações, lembretes, avisos ao cliente e avisos administrativos.

## 12. Experiência e interface

Direção de UI:

- interface premium;
- desktop e mobile;
- responsividade;
- PWA;
- cards limpos;
- navegação simples;
- hierarquia clara;
- poucos elementos por tela;
- foco nas ações principais.

A interface piloto utilizou preto, branco e verde escuro por fazer parte da identidade da Barbearia Antunes. Essa identidade não representa necessariamente as cores da marca GoEstudio.

## 13. Marketing já iniciado

A divulgação começou antes do lançamento oficial por Instagram, publicações institucionais, carrosséis, stories, anúncios, apresentação visual do sistema, captação de interessados, WhatsApp e pré-cadastro.

Chamada principal:

> **Faça seu pré-cadastro e tenha acesso a benefícios de lançamento.**

## 14. Conteúdo produzido

Já foram desenvolvidas peças sobre a nova forma de gerir negócios de beleza, tecnologia para simplificar a gestão, dashboards, agendamentos, clientes, assinaturas, relatórios e pré-lançamento, seguindo principalmente fundo escuro, branco e azul.

## 15. Anúncios

Em um dos primeiros testes registrados:

- Alcance: 608 pessoas
- Impressões: 670
- Valor gasto: R$ 29,28
- Cliques no link: 3
- Conversas iniciadas: 0

O teste indicou que alcance isolado não é suficiente e motivou abordagem mais direta para aquisição de estabelecimentos interessados no beta.

## 16. Estratégia comercial inicial

A prioridade é encontrar barbearias reais para testar o produto, especialmente estabelecimentos com fluxo de clientes e presença no Instagram que ainda dependam de WhatsApp, Direct, agenda física ou processos manuais.

A abordagem deve evitar venda agressiva e começar pelo diagnóstico de como os horários são organizados atualmente.

## 17. Estratégia Beta

Objetivo inicial: **5 a 10 estabelecimentos reais utilizando o GoEstudio**.

Os parceiros deverão fornecer feedback, identificação de bugs, sugestões, validação de funcionalidades, dados de uso, depoimentos, estudos de caso e prova social.

Oferta sugerida: acesso gratuito durante os testes em troca de feedback.

## 18. Funil inicial

```text
Instagram / prospecção
        ↓
Contato com a barbearia
        ↓
Diagnóstico do processo atual
        ↓
Demonstração curta
        ↓
Pré-cadastro
        ↓
Acesso ao Beta
        ↓
Uso real
        ↓
Feedback
        ↓
Ajustes no produto
        ↓
Plano comercial
```

## 19. Diferenciais em construção

O GoEstudio não pretende ser apenas uma agenda online. A visão reúne:

**Agendamento + Clientes + Profissionais + Assinaturas + Gestão + Relatórios + Comunicação**

O objetivo é que o estabelecimento tenha um único ambiente para operar o negócio.

## 20. Próximas etapas recomendadas

1. Consolidar a identidade visual oficial.
2. Definir um mini manual de marca.
3. Colocar goestudio.com.br como domínio principal.
4. Criar landing page oficial de pré-cadastro.
5. Finalizar estrutura multiestabelecimento.
6. Separar configurações específicas da Barbearia Antunes do núcleo do GoEstudio.
7. Finalizar segurança e regras do Firebase.
8. Testar fluxos completos de cliente, profissional e administrador.
9. Criar ambiente Beta.
10. Selecionar 5–10 estabelecimentos parceiros.
11. Coletar feedback estruturado.
12. Corrigir problemas encontrados no uso real.
13. Definir planos e precificação.
14. Criar termos de uso e política de privacidade.
15. Preparar lançamento comercial.

## 21. Visão da marca

O GoEstudio está deixando de ser apenas um projeto de sistema para uma barbearia e começando a assumir a estrutura de um produto próprio.

A direção é construir uma plataforma que seja **simples para o cliente, prática para o profissional e completa para o gestor**.

# GoEstudio

> **Seu negócio organizado em um só lugar.**
