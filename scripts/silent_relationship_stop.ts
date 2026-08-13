#!/usr/bin/env npx tsx
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { getAgentId } from './agent_config.js';
import { createConversation, getDurableStateDir, getMode, getSyncStateFile, getTempStateDir, loadSyncState, saveSyncState, spawnSilentWorker } from './conversation_utils.js';
import { readTranscript, formatMessagesForLetta } from './transcript_utils.js';
import { buildCanonicalMessages, makeBatchId, relationshipMemoryRoot } from '../relationship-memory/src/adapter/index.js';
import { extractAssistantRememberIntents, persistAssistantRememberIntents } from '../relationship-memory/src/intent/index.js';
import { RelationshipMemoryStore } from '../relationship-memory/src/store/index.js';

interface HookInput { session_id: string; transcript_path: string; stop_hook_active?: boolean; cwd: string; }
function cacheFile(cwd: string, sessionId: string) { const key = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0,24); return path.join(getDurableStateDir(cwd), `prompt-memory-search-${key}.json`); }
function escape(value: string) { return value.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function legacy(raw: string): never { const here=path.dirname(fileURLToPath(import.meta.url)); const wrapper=path.join(here,'..','hooks','silent-npx.cjs'); const child=spawnSync(process.execPath,[wrapper,'tsx',path.join(here,'send_messages_to_letta.ts')],{input:raw,env:process.env,encoding:'utf8'}); if(child.stdout)process.stdout.write(child.stdout); if(child.stderr)process.stderr.write(child.stderr); process.exit(child.status??0); }
const raw = await new Promise<string>((resolve)=>{let data='';process.stdin.setEncoding('utf8');process.stdin.on('data',(c)=>{data+=c});process.stdin.on('end',()=>resolve(data));});
const mode=getMode(); if(mode==='full') legacy(raw); if(mode==='off') process.exit(0);
let input:HookInput; try{input=JSON.parse(raw)}catch{process.exit(0)}; if(input.stop_hook_active)process.exit(0);
const rootDir=process.env.RELATIONSHIP_MEMORY_DIR?.trim(); const subjectId=process.env.RELATIONSHIP_MEMORY_SUBJECT_ID?.trim(); const apiKey=process.env.LETTA_API_KEY; if(!rootDir||!subjectId||!apiKey)process.exit(0);
const messages=await readTranscript(input.transcript_path,()=>{}); if(!messages.length)process.exit(0);
const state=loadSyncState(input.cwd,input.session_id); const newMessages=formatMessagesForLetta(messages,state.lastProcessedIndex,()=>{}); if(!newMessages.length)process.exit(0);
const store=new RelationshipMemoryStore(relationshipMemoryRoot(),subjectId); const intents=persistAssistantRememberIntents(store,extractAssistantRememberIntents(messages,state.lastProcessedIndex,input.session_id,subjectId));
const agentId=await getAgentId(apiKey); const conversationId=await createConversation(apiKey,agentId); saveSyncState(input.cwd,state);
const canonical=buildCanonicalMessages(messages,state.lastProcessedIndex,conversationId); const batchId=makeBatchId(input.session_id,state.lastProcessedIndex,messages.length-1);
const transcript=newMessages.map((m)=>`<message role="${m.role==='user'?'user':m.role==='assistant'?'claude_code':'system'}">\n${escape(m.text)}\n</message>`).join('\n');
let cached='none'; try{const x=JSON.parse(fs.readFileSync(cacheFile(input.cwd,input.session_id),'utf8')); const latest=[...newMessages].reverse().find((m)=>m.role==='user')?.text.trim(); if(latest&&x?.prompt?.trim()===latest)cached=escape(JSON.stringify(x.results??[]));}catch{}
const message=`<claude_code_session_update>\n<session_id>${input.session_id}</session_id>\n<transcript>\n${transcript}\n</transcript>\n<current_prompt_memory_search_results>${cached}</current_prompt_memory_search_results>\n<instructions>This is silent post-turn relationship-memory maintenance. Continue the real background work: memory_search when needed, memory_reinforce existing durable memories, memory_remember genuinely new durable memories, entity maintenance when warranted, or no-op. Reuse current_prompt_memory_search_results for sameness/dedupe/reinforcement when applicable instead of repeating the identical search merely for the latest prompt. Search again only for genuinely new semantic material or insufficient cached results. Do not produce a user-facing whisper, guidance note, storage report, IDs, reinforce/remember decisions, or no-op explanation. Ordinary assistant prose is private and discarded.</instructions>\n</claude_code_session_update>`;
const payload={agentId,conversationId,sessionId:input.session_id,message,stateFile:getSyncStateFile(input.cwd,input.session_id),newLastProcessedIndex:messages.length-1,cwd:input.cwd,batchId,canonicalMessages:canonical,assistantIntents:intents};
const file=path.join(getTempStateDir(),`silent-maintenance-${input.session_id}-${Date.now()}.json`); fs.mkdirSync(path.dirname(file),{recursive:true}); fs.writeFileSync(file,JSON.stringify(payload),{mode:0o600});
const here=path.dirname(fileURLToPath(import.meta.url)); spawnSilentWorker(path.join(here,'silent_relationship_worker.ts'),file,input.cwd); process.exit(0);
