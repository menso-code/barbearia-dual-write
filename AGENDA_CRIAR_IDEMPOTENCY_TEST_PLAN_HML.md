# Plano de evidência — idempotência de `agenda.criar` em HML

Status: **NÃO EXECUTADO**
Projeto permitido: `teste-483f6`
Produção: fora do escopo.

## Objetivo

Com uma única massa controlada e identificável, enviar duas chamadas para `agenda.criar` com payload idêntico e o mesmo `requestId`, comprovando que a segunda chamada não cria efeitos adicionais.

## Pré-condições somente leitura

- Confirmar que o slot escolhido está livre em `agendamentos` e `ocupacoes` nos dois modelos.
- Usar um barbeiro e serviço já existentes em HML.
- Usar cliente HML já existente ou sessão Admin/barbeiro autorizada, sem criar identidade Auth.
- Escolher data futura e slot dentro do funcionamento validado.
- Registrar antes/depois somente IDs, contagens e hashes sem PII.

## Execução controlada futura

1. Gerar um `requestId` fixo, único e identificável, por exemplo `hml-idem-<timestamp>-agenda01`.
2. Enviar a primeira chamada autenticada para `executeOperationalCommand`, comando `agenda.criar`, com payload válido.
3. Guardar resposta, `appointmentId`, quantidade de slots e leitura dos documentos:
   - Legado `agendamentos/{appointmentId}`;
   - V2 `barbearias/{tenantId}/agendamentos/{appointmentId}`;
   - ocupações correspondentes em Legado e V2;
   - `barbearias/{tenantId}/audit_logs/operation-{requestId}`.
4. Reenviar exatamente a mesma chamada, inclusive `requestId` e payload.
5. Esperar resposta `duplicate: true` com o mesmo resultado da primeira chamada.
6. Relerear os mesmos caminhos e comprovar que:
   - existe um único agendamento lógico;
   - existe uma ocupação por slot, sem documentos adicionais;
   - Legado e V2 continuam equivalentes;
   - não houve novo efeito de assinatura/crédito, se o caso não for de assinatura;
   - o log de operação continua único e contém o resultado original.
7. Reexecutar a reconciliação HML somente leitura e registrar `missing_v2: 0`, `divergent: 0`, sem órfãos.
8. Remover a massa pelo procedimento autorizado de limpeza HML, usando allowlist exata, snapshot e validação de que os documentos não mudaram desde o teste. A remoção não faz parte deste plano de execução sem autorização separada.

## Critério de aprovação

Primeira chamada: `duplicate:false`, um agendamento, N ocupações, um log.
Segunda chamada: `duplicate:true`, mesmo `appointmentId`/resultado, nenhum documento adicional, nenhuma divergência Legado × V2.

## Evidência atualmente disponível

- `transactionalCommand` lê o log por `requestId` antes do callback de escrita.
- Se o log existir com a mesma operação, retorna `duplicate:true` e o resultado persistido.
- O log é criado na mesma transação que os documentos operacionais.
- A auditoria HML já registra a pendência da prova observada: a implementação existe, mas a reexecução real ainda não foi documentada.
