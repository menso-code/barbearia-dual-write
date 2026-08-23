#!/usr/bin/env node
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const PROJECT = 'teste-483f6';
const FORBIDDEN = 'barber-a01e7';
const TENANT = 'tnt_80b2fda7ad644a1dbeff050aa8e0d595';
const ADMIN = 'gVAwqbquC3V3fMjAjoJzJUndFlJ3';
const AUTH = 'eEhjqVfcDeM0yCwiVVlb8JD8xZC3';
const root = `projects/${PROJECT}/databases/(default)/documents`;
const api = `https://firestore.googleapis.com/v1/${root}`;
const collections = ['clientes','barbeiros','servicos','agendamentos','ocupacoes','bloqueios','configuracoes','fechamentos_globais','planos_assinatura','solicitacoes_assinatura','historico_assinaturas','financeiro','admins','usuarios','homologacao_mapeamentos','vinculos_barbeiro'];
const v2Collections = ['clientes','barbeiros','servicos','agendamentos','ocupacoes','bloqueios','configuracoes','fechamentos','planos_assinatura','assinaturas','historico_assinaturas','financeiro'];
const preserve = new Set([
  `admins/${ADMIN}`, `usuarios/${ADMIN}`, `homologacao_mapeamentos/${AUTH}`,
  `barbearias/${TENANT}`, `barbearias/${TENANT}/membros/${ADMIN}`, `system/version`
]);
function lock() { if (PROJECT !== 'teste-483f6' || JSON.stringify(process.argv).includes(FORBIDDEN) || JSON.stringify(process.env).includes(FORBIDDEN)) throw new Error('ABORT: projeto inválido/produção detectada'); if (!process.env.FIRESTORE_ACCESS_TOKEN) throw new Error('FIRESTORE_ACCESS_TOKEN ausente'); }
async function get(url) { const r=await fetch(url,{headers:{authorization:`Bearer ${process.env.FIRESTORE_ACCESS_TOKEN}`}}); const b=await r.json().catch(()=>({})); if(r.status===404)return null; if(!r.ok)throw new Error(`${r.status}: ${b.error?.message||'Firestore'}`); return b; }
async function list(pathname) { let out=[], token=''; do { const q=token?`?pageSize=1000&pageToken=${encodeURIComponent(token)}`:'?pageSize=1000'; const p=await get(`${api}/${pathname}${q}`); out.push(...(p?.documents||[])); token=p?.nextPageToken||''; } while(token); return out; }
function docPath(d){return String(d.name).replace(`${root}/`,'');}
function sha(s){return createHash('sha256').update(s).digest('hex');}
async function main(){ lock(); const docs=[]; for(const c of collections) docs.push(...(await list(c))); for(const c of v2Collections) docs.push(...(await list(`barbearias/${TENANT}/${c}`))); docs.push(...(await list(`barbearias/${TENANT}/membros`))); docs.push(await get(`${api}/barbearias/${TENANT}`), await get(`${api}/system/version`)); const unique=new Map(docs.filter(Boolean).map(d=>[d.name,d])); const rows=[...unique.values()].map(d=>{const p=docPath(d); const keep=preserve.has(p); return {path:p,classification:keep?'PRESERVE_GO_LIVE':'REMOVE_TEST_DATA',document:d};}); const removable=rows.filter(x=>x.classification==='REMOVE_TEST_DATA'); const snapshot={kind:'HML_PRE_GO_LIVE_RESET_SNAPSHOT',project_id:PROJECT,tenant_id:TENANT,generated_at:new Date().toISOString(),applied:false,write_methods:[],preserved:[...preserve],documents:removable}; const raw=JSON.stringify(snapshot,null,2)+'\n'; const dir=path.resolve('reports','dual-write','pre-go-live-snapshots'); await mkdir(dir,{recursive:true}); const stamp=snapshot.generated_at.replace(/[:.]/g,'-'); const file=path.join(dir,`before-reset-${stamp}.json`); const hash=sha(raw); await writeFile(file,raw,'utf8'); await writeFile(`${file}.sha256`,`${hash}  ${path.basename(file)}\n`,'utf8'); const counts={legacy:removable.filter(x=>!x.path.startsWith('barbearias/')).length,v2:removable.filter(x=>x.path.startsWith('barbearias/')).length,preserved:rows.length-removable.length,removed:removable.length}; console.log(JSON.stringify({project_id:PROJECT,auth_admin:{email:'mmenso43@gmail.com',uid:AUTH},counts,preserved:[...preserve],snapshot:file,sha256:hash,writes:0,applied:false},null,2)); }
main().catch(e=>{console.error(`PREPARE INTERROMPIDO: ${e.message}`);process.exitCode=1;});
