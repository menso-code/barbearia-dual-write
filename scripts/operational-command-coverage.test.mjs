import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtime = await readFile(new URL("../functions/dual-write.js", import.meta.url), "utf8");
const frontend = await readFile(new URL("../public-hml/js/operational-commands.js", import.meta.url), "utf8");

const commands = [
  "cliente.garantir-perfil", "cliente.atualizar-perfil", "assinatura.solicitar",
  "bloqueio.criar", "bloqueio.remover", "agenda.disponibilidade.obter", "agenda.criar", "agenda.reagendar",
  "agenda.cliente_chegou", "agenda.em_atendimento", "agenda.concluir", "agenda.cancelar",
  "agenda.nao_compareceu", "admin.barbeiro.salvar", "admin.barbeiro.remover",
];

test("dispatcher contém os comandos prioritários", () => {
  for (const command of commands) {
    assert.ok(runtime.includes(`"${command}"`), `comando ausente no dispatcher: ${command}`);
  }
});

test("autenticação, tenant HML e autorização Admin estão no caminho do dispatcher", () => {
  assert.match(runtime, /requireAuth\(request\)/);
  assert.match(runtime, /async function resolveOperationalUid\(authUid, projectId, allowClientBootstrap = false\)/);
  assert.match(runtime, /resolveOperationalUid\(authUid, projectId, allowClientBootstrap\)/);
  assert.match(runtime, /async function requireAdmin\(tx, uid\)/);
  assert.match(runtime, /legacyRef\("admins", uid\)/);
  assert.match(runtime, /const TENANT_ID =/);
});

test("comandos mutáveis usam transação e projeções espelhadas", () => {
  assert.match(runtime, /async function transactionalCommand/);
  assert.match(runtime, /function mirrorSet\(tx/);
  assert.match(runtime, /function mirrorUpdate\(tx/);
  assert.match(runtime, /function mirrorDelete\(tx/);
  assert.match(runtime, /operationLogRef\(requestId\)/);
});

test("agenda possui guardas de estado e transição", () => {
  assert.match(runtime, /const active = \["agendado", "cliente_chegou", "em_atendimento"\]/);
  assert.match(runtime, /action === "cliente_chegou"/);
  assert.match(runtime, /action === "em_atendimento"/);
  assert.match(runtime, /action === "concluir"/);
  assert.match(runtime, /action === "cancelar"/);
  assert.match(runtime, /"nao_compareceu"/);
});

test("cliente do frontend preserva o envelope canônico", () => {
  assert.match(frontend, /command\(\{/);
  assert.match(frontend, /return result\.data/);
});

test("índice de email permanece namespaced e create-only", () => {
  assert.match(runtime, /const tenantId = context\?\.tenant\?\.id \|\| TENANT_ID/);
  assert.match(runtime, /barbearias\/\$\{tenantId\}\/email_acesso_index/);
  assert.match(runtime, /tx\.create\(emailIndexRef/);
  assert.match(runtime, /INDICE_EMAIL_INCONSISTENTE/);
  assert.match(runtime, /tx\.delete\(emailIndexRef\)/);
});
