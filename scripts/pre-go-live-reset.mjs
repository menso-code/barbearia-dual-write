#!/usr/bin/env node
/** Executor PRE-GO-LIVE RESET HML. Não aplica por padrão. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT = 'teste-483f6';
const FORBIDDEN = 'barber-a01e7';
const SNAPSHOT = path.resolve('reports/dual-write/pre-go-live-snapshots/before-reset-2026-08-20T14-20-08-574Z.json');
const PRESERVE = new Set([
  'admins/gVAwqbquC3V3fMjAjoJzJUndFlJ3',
  'usuarios/gVAwqbquC3V3fMjAjoJzJUndFlJ3',
  'homologacao_mapeamentos/eEhjqVfcDeM0yCwiVVlb8JD8xZC3',
  'barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595',
  'barbearias/tnt_80b2fda7ad644a1dbeff050aa8e0d595/membros/gVAwqbquC3V3fMjAjoJzJUndFlJ3',
  'system/version',
]);
const ADMIN_AUTH = 'eEhjqVfcDeM0yCwiVVlb8JD8xZC3';
function assertLock() { if (PROJECT !== 'teste-483f6' || PROJECT.includes(FORBIDDEN) || JSON.stringify(process.argv).includes(FORBIDDEN)) throw new Error('ABORT: projeto inválido ou produção detectada'); }
function sha(s) { return createHash('sha256').update(s).digest('hex'); }
async function loadPlan() { const raw=await readFile(SNAPSHOT,'utf8'); const expected=(await readFile(`${SNAPSHOT}.sha256`,'utf8')).trim().split(/\s+/)[0]; if(sha(raw)!==expected) throw new Error('ABORT: SHA-256 do snapshot não confere'); const plan=JSON.parse(raw); if(plan.project_id!==PROJECT || plan.applied || plan.write_methods?.length) throw new Error('ABORT: snapshot/plano inválido'); for(const p of plan.preserved||[]) if(!PRESERVE.has(p)) throw new Error(`ABORT: preservação inesperada ${p}`); for(const d of plan.documents||[]) if(PRESERVE.has(d.path)) throw new Error(`ABORT: item preservado no plano ${d.path}`); return {raw,plan,sha:expected}; }
async function main(){ assertLock(); const dry=process.argv.includes('--dry-run'); const apply=process.argv.includes('--apply'); if(!dry&&!apply) { console.log(JSON.stringify({status:'SAFE_STOP',message:'Nenhuma ação executada. Use --dry-run para validar ou --apply com confirmação adicional.',project_id:PROJECT},null,2)); return; } if(apply && process.env.PRE_GO_LIVE_RESET_CONFIRM!=='teste-483f6:APPLY:2026-08-20') throw new Error('ABORT: confirmação explícita ausente'); const {plan,sha}=await loadPlan(); const removable=plan.documents||[]; const result={project_id:PROJECT,mode:dry?'dry-run':'apply',snapshot_sha256:sha,documents_to_remove:removable.length,preserved:[...PRESERVE],auth_admin_uid:ADMIN_AUTH,firestore_writes:apply?removable.length:0,auth_deletes:0,rollback:`restaurar somente os documentos do snapshot ${SNAPSHOT}`,applied:false}; if(apply) throw new Error('ABORT: executor Firestore/Auth ainda requer implementação e validação de lista Auth; nenhuma exclusão feita'); console.log(JSON.stringify(result,null,2)); }
main().catch(e=>{console.error(`PRE-GO-LIVE RESET BLOQUEADO: ${e.message}`);process.exitCode=1;});
