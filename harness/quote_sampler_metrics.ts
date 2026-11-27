#!/usr/bin/env npx tsx
/**
 * Offline comparison of quote selection: today's first/last-half baseline vs samplePieces.
 * Reads a store directory; prints numbers only.
 * Usage: tsx harness/quote_sampler_metrics.ts <store dir> [--now ISO] [--half-life days] [--floor f] [--unit n]
 */
import * as fs from 'fs';
import * as path from 'path';
import { baselinePieces, samplePieces, type SampledPiece, type SamplerEpisode, type SamplerEvidence } from './quote_sampler.js';

const dir = process.argv[2];
const opt = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
};
const now = opt('now', '2026-11-27T00:00:00Z');
const options = { now, halfLifeDays: Number(opt('half-life', '30')), floor: Number(opt('floor', '0.15')), unitPieces: Number(opt('unit', '2')) };
const jsonl = (name: string): any[] => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const evidenceByMemory = new Map<string, SamplerEvidence[]>();
for (const e of jsonl('evidence.jsonl')) {
  const list = evidenceByMemory.get(e.memory_id) ?? [];
  list.push(e);
  evidenceByMemory.set(e.memory_id, list);
}
const reinforcementsByMemory = new Map<string, any[]>();
for (const r of jsonl('reinforcements.jsonl')) {
  const list = reinforcementsByMemory.get(r.memory_id) ?? [];
  list.push(r);
  reinforcementsByMemory.set(r.memory_id, list);
}

function episodesOf(memoryId: string): SamplerEpisode[] {
  const evidence = evidenceByMemory.get(memoryId) ?? [];
  const byId = new Map(evidence.map((e) => [e.evidence_id, e]));
  const reinforcements = (reinforcementsByMemory.get(memoryId) ?? []).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const inReinforcement = new Set(reinforcements.flatMap((r) => r.evidence_ids));
  const episodes: SamplerEpisode[] = [{ index: 0, at: '', evidence: evidence.filter((e) => !inReinforcement.has(e.evidence_id)) }];
  reinforcements.forEach((r, i) => episodes.push({ index: i + 1, at: r.recorded_at, evidence: r.evidence_ids.map((id: string) => byId.get(id)).filter(Boolean) }));
  return episodes.filter((episode) => episode.evidence.length > 0 || episode.index === 0);
}

const q = (v: number[], p: number): number => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

interface Stats { episodes: number[]; sessions: number[]; newestShare: number[]; original: number[]; olderReinf: number[]; chars: number[] }
const empty = (): Stats => ({ episodes: [], sessions: [], newestShare: [], original: [], olderReinf: [], chars: [] });
const base = empty(); const samp = empty(); const overlap: number[] = [];
let reinforced = 0;

function record(stats: Stats, pieces: SampledPiece[], newestEpisode: number, totalEpisodes: number): void {
  stats.episodes.push(new Set(pieces.map((p) => p.episode)).size);
  stats.sessions.push(new Set(pieces.map((p) => p.session_key)).size);
  const newestSession = pieces.filter((p) => p.episode === newestEpisode).map((p) => p.session_key)[0];
  stats.newestShare.push(pieces.length ? pieces.filter((p) => p.session_key === newestSession).length / pieces.length : 0);
  stats.original.push(pieces.filter((p) => p.episode === 0).length);
  stats.olderReinf.push(totalEpisodes > 2 ? pieces.filter((p) => p.episode > 0 && p.episode < newestEpisode).length : 0);
  stats.chars.push(mean(pieces.map((p) => [...p.text].length)));
}

for (const memory of jsonl('memories.jsonl')) {
  const episodes = episodesOf(memory.memory_id);
  if (episodes.length < 2) continue;
  const minSessions = Number(opt('min-sessions', '1'));
  const available = new Set(episodes.flatMap((e) => e.evidence.map((x) => `${x.conversation_id ?? '?'}:${x.captured_at.slice(0, 10)}`)));
  if (available.size < minSessions) continue;
  const total = episodes.reduce((n, e) => n + e.evidence.length, 0);
  if (!total) continue;
  reinforced++;
  const newest = Math.max(...episodes.map((e) => e.index));
  record(base, baselinePieces(episodes), newest, episodes.length);
  const a = samplePieces(memory.memory_id, 'session-A', episodes, options);
  const b = samplePieces(memory.memory_id, 'session-B', episodes, options);
  record(samp, a, newest, episodes.length);
  const key = (p: SampledPiece): string => `${p.evidence_id}#${p.piece}`;
  const setA = new Set(a.map(key)); const setB = new Set(b.map(key));
  overlap.push([...setA].filter((k) => setB.has(k)).length / Math.max(1, new Set([...setA, ...setB]).size));
}

console.log(`reinforced memories: ${reinforced}; options ${JSON.stringify(options)}`);
const line = (label: string, s: Stats): string => `${label.padEnd(9)} episodes covered p50 ${q(s.episodes, .5)} mean ${mean(s.episodes).toFixed(2)} | session-days p50 ${q(s.sessions, .5)} mean ${mean(s.sessions).toFixed(2)}`
  + ` | newest-session share mean ${(mean(s.newestShare) * 100).toFixed(0)}% | original pieces mean ${mean(s.original).toFixed(2)} | older reinforcements pieces mean ${mean(s.olderReinf).toFixed(2)} | piece chars mean ${mean(s.chars).toFixed(0)}`;
console.log(line('baseline', base));
console.log(line('sampler', samp));
console.log(`sampler: same pieces between two sessions (jaccard) mean ${(mean(overlap) * 100).toFixed(0)}%`);
