# Migração gradual para múltiplas barbearias

## Estado inicial seguro (histórico)

A Barbearia Antunes permanece como tenant padrão com o ID interno imutável
`tnt_80b2fda7ad644a1dbeff050aa8e0d595` e slug público `antunes`.
O módulo `public/js/tenant.js` concentra essa identificação no frontend.
Nesta fase ele não aceita seleção por URL, armazenamento local ou parâmetros do
navegador: isso evita que uma alteração de interface seja confundida com uma
permissão de acesso.

## Estado normativo atual

A migração operacional foi concluída para os 32 comandos. O tenant é resolvido
no servidor pelo `OperationalContext`; a ausência de hostname/slug falha
fechado, e a compatibilidade com Antunes ocorre somente por localizadores
Firebase explicitamente documentados. Novos tenants operam em `V2_ONLY`, sem
leitura ou escrita legada, enquanto Antunes preserva Dual Write conforme o
contrato. O histórico de fases abaixo é mantido como registro da evolução e
não representa um fallback ativo do runtime.

## Por que a migração não pode ser somente um campo novo

As coleções atuais são globais. Em especial, `clientes/{uid}` usa o UID do
Firebase Authentication como ID do documento. Um mesmo cliente poderia usar
mais de uma barbearia, portanto esse documento não pode representar o perfil
dele em mais de um tenant sem uma nova camada de vínculo.

Também existem IDs canônicos globais para agenda e ocupação:

```text
agendamentos/{barbeiroId}_{data}_{horario}
ocupacoes/{barbeiroId}_{data}_{horario}
```

Para impedir colisões entre empresas, eles precisarão ser namespaced pelo
tenant ou passar a usar IDs de barbeiro globalmente únicos e filtros obrigatórios
por `barbearia_id`.

## Arquitetura alvo

O desenho completo, as permissões, os índices, os fluxos e o rollback foram
consolidados em [`ARCHITECTURE_V2.md`](ARCHITECTURE_V2.md). Este arquivo mantém
somente o resumo de fases.

```text
barbearias/{barbeariaId}
barbearias/{barbeariaId}/membros/{uid}
barbearias/{barbeariaId}/clientes/{uid}
barbearias/{barbeariaId}/barbeiros/{barbeiroId}
barbearias/{barbeariaId}/servicos/{servicoId}
barbearias/{barbeariaId}/agendamentos/{agendamentoId}
barbearias/{barbeariaId}/ocupacoes/{ocupacaoId}
barbearias/{barbeariaId}/bloqueios/{bloqueioId}
barbearias/{barbeariaId}/assinaturas/{assinaturaId}
barbearias/{barbeariaId}/planos_assinatura/{planoId}
barbearias/{barbeariaId}/historico_assinaturas/{historicoId}
barbearias/{barbeariaId}/configuracoes/{id}
```

`membros/{uid}.papeis` será a fonte de verdade por barbearia para os papéis
`CLIENTE`, `BARBEIRO` e `ADMIN`, permitindo múltiplos papéis na mesma conta.
As Rules verificam pertencimento ao array, nunca posição. O frontend poderá mostrar opções de interface,
mas as Firestore Rules deverão consultar esse vínculo; nunca confiar em um
papel enviado pelo browser.

## Fases de execução

1. **Fundação (concluída):** definir o tenant Antunes centralmente, sem alterar
   consultas nem dados de produção.
2. **Modelo e migração:** criar a barbearia Antunes e seus vínculos, copiar os
   dados globais para a árvore namespaced com um script administrativo
   idempotente e verificável.
3. **Leitura compatível:** migrar uma área por vez (catálogo, agenda, perfil,
   assinaturas e financeiro), comparando contagens antes de trocar a origem.
4. **Escrita e regras:** apontar as novas gravações à árvore tenant, atualizar
   transações/IDs canônicos e aplicar Rules com isolamento por membro.
5. **Corte definitivo:** após auditoria, desativar o fallback global e manter
   os dados antigos somente como backup de migração por um período definido.

Nenhuma fase deve ser publicada sem validar cliente, barbeiro, admin,
agendamentos, assinaturas e financeiro no tenant interno da Antunes.
