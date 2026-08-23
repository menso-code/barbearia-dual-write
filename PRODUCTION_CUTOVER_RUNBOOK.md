# Runbook de Cutover V2 — Produção

## Escopo congelado

- Projeto Firebase: `barber-a01e7`.
- Tenant: `tnt_80b2fda7ad644a1dbeff050aa8e0d595` (`antunes`).
- Arquitetura: V2 homologada, sem alterações estruturais.
- Cinco documentos `legacy_unresolved` permanecem no legado e não entram na operação V2.
- Nenhuma fase autoriza deploy de frontend ou Rules sem o gate específico correspondente.

## Gates obrigatórios

### Gate 1 — Preparação (sem escrita)

1. Dry-run legado deve estar `APROVADO`.
2. Preflight deve encontrar `189` documentos V2 ausentes, `0` divergentes.
3. Snapshot local deve existir e seu SHA-256 ser registrado.
4. Credencial de escrita temporária ainda não deve existir ou estar ativa.
5. Produção continua servindo exclusivamente o legado.

### Gate 2 — Migração dos dados V2

Requer autorização operacional nova e uma conta de serviço temporária, dedicada e de menor privilégio.

Comandos previstos, não executar sem autorização:

```powershell
$env:CUTOVER_SOURCE_CREDENTIALS="C:\caminho\reader.json"
$env:CUTOVER_TARGET_CREDENTIALS="C:\caminho\writer-temporario.json"
node .\scripts\production-cutover.mjs --apply --confirm PRODUCTION_CUTOVER_V2_APPROVED
node .\scripts\production-cutover.mjs --validate
```

Garantias:

- criação somente se o documento não existir;
- lote único e atômico enquanto o plano permanecer abaixo de 300 documentos;
- abortar diante de qualquer divergência;
- `system/version.mode` gravado como `legacy`;
- relatório e snapshot local imutável com SHA-256;
- `migration_logs/tenant-v2-antunes-production` criado junto com a migração;
- repetição idempotente: zero novas escritas.

Após a validação, revogar a chave e desabilitar/excluir a conta temporária.

### Rollback imediato da migração

Permitido somente antes de qualquer leitura/escrita operacional na V2 e quando todos os documentos ainda forem exatamente iguais ao snapshot aplicado.

```powershell
node .\scripts\production-cutover.mjs --rollback --confirm PRODUCTION_CUTOVER_ROLLBACK_APPROVED
```

O rollback:

- falha fechado se detectar alteração, ausência ou divergência;
- remove atomicamente apenas os documentos criados pelo plano V2;
- preserva o log de migração com status `ROLLED_BACK`;
- nunca toca coleções legadas nem os cinco documentos históricos arquivados;
- gera snapshot e validação pós-rollback.

Depois que a V2 receber dados operacionais, este rollback automático deixa de ser aplicável. Nesse cenário, retornar a feature flag para `legacy`, preservar ambas as estruturas e executar plano de reconciliação baseado nos logs.

### Gate 3 — Produção em legacy

- Validar novamente equivalência, financeiro, assinaturas, ocupações e papéis.
- Executar a suíte funcional contra o comportamento legado.
- Nenhuma mudança perceptível ao usuário.
- Se houver falha, manter `legacy` e corrigir antes de avançar.

### Gate 4 — Dual-read

Pré-condições:

- migração V2 validada;
- Rules V2 compiladas e testadas em emulador/homologação;
- implementação de leitura comparativa testada;
- rollback por feature flag validado.

Em `dual-read`, o legado continua sendo a resposta ao usuário. A V2 é comparada em segundo plano e divergências são registradas sem interromper o fluxo.

Abortar e voltar para `legacy` se houver qualquer divergência crítica, regressão, erro de permissão ou impacto de performance.

### Gate 5 — Multi-tenant

Somente após:

- zero divergências durante a janela definida;
- testes funcionais completos;
- financeiro e assinaturas equivalentes;
- Rules e índices validados;
- autorização operacional específica.

### Gate 6 — Legado

Não remover no dia do cutover. Elaborar plano separado somente após alguns dias de operação V2 estável, com retenção, backup e rollback aprovados.

## Matriz mínima de validação

- Cliente: login, cadastro, agendamento, cancelamento, assinatura e histórico.
- Barbeiro: agenda, conclusão, falta e reagendamento.
- Admin: barbeiros, serviços, clientes, financeiro, assinaturas e disponibilidade.
- Sistema: Rules, múltiplos papéis, ocupações, créditos, relatórios, índices e performance.

## Critérios de parada imediata

- qualquer divergência legado × V2;
- total ou referência diferente do relatório homologado;
- documento V2 já existente com conteúdo divergente;
- falha de snapshot, hash, log ou validação pós-execução;
- permissão acima do mínimo na credencial temporária;
- impacto percebido por usuários;
- impossibilidade de provar rollback.
