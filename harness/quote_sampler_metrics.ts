#!/usr/bin/env npx tsx
/**
 * Offline comparison of quote selection: today's first/last-half baseline vs samplePieces.
 * Reads a store directory; prints numbers only.
 * Usage: tsx harness/quote_sampler_metrics.ts <store dir> [--now ISO] [--half-life days] [--floor f] [--unit n] [--min-sessions n]
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
const options = { now, halfLifeDays: Number(opt('half-life', '30')), floor: Number(opt('floor', '0.15')), unitPieces: Number(opt('unit', '2')),
  timeMode: opt('time-mode', 'relative') as 'absolute' | 'relative', halfSpan: Number(opt('half-span', '0.25')) };
// --stretch k: pretend every memory's history is k times longer (ages from `now` multiplied by k).
const stretch = Number(opt('stretch', '1'));
const nowAt = Date.parse(now);
const stretched = (iso: string): string => stretch === 1 || !iso ? iso : new Date(nowAt - stretch * (nowAt - Date.parse(iso))).toISOString();
const jsonl = (name: string): any[] => fs.readFileSync(path.join(dir, name), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));

const evidenceByMemory = new Map<string, SamplerEvidence[]>();
for (const e of jsonl('evidence.jsonl')) {
  e.captured_at = stretched(e.captured_at);
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

// Legacy-origin memories keep their original capture in a legacy source, not in evidence.
// It becomes part of episode 0 so the anchor exists for them too (the live view already shows legacy snippets).
const legacySources = new Map(jsonl('legacy-assistant-sources.jsonl').map((s) => [s.legacy_source_id, s]));
const legacyByMemory = new Map<string, SamplerEvidence[]>();
for (const p of jsonl('legacy-memory-provenance.jsonl')) {
  const source = legacySources.get(p.legacy_source_id);
  const text = source?.body_text?.trim() || source?.frontmatter?.name || '';
  if (!source || !text) continue;
  const list = legacyByMemory.get(p.canonical_memory_id) ?? [];
  list.push({ evidence_id: source.legacy_source_id, quote: text, captured_at: stretched(source.created_at_utc ?? p.recorded_at), conversation_id: `legacy:${source.legacy_source_id}` });
  legacyByMemory.set(p.canonical_memory_id, list);
}

function episodesOf(memoryId: string): SamplerEpisode[] {
  const evidence = evidenceByMemory.get(memoryId) ?? [];
  const byId = new Map(evidence.map((e) => [e.evidence_id, e]));
  const reinforcements = (reinforcementsByMemory.get(memoryId) ?? []).sort((a, b) => a.recorded_at.localeCompare(b.recorded_at));
  const inReinforcement = new Set(reinforcements.flatMap((r) => r.evidence_ids));
  const original = evidence.filter((e) => !inReinforcement.has(e.evidence_id));
  const episodes: SamplerEpisode[] = [{ index: 0, at: '', evidence: [...(legacyByMemory.get(memoryId) ?? []), ...original] }];
  reinforcements.forEach((r, i) => episodes.push({ index: i + 1, at: r.recorded_at, evidence: r.evidence_ids.map((id: string) => byId.get(id)).filter(Boolean) }));
  return episodes.filter((episode) => episode.evidence.length > 0 || episode.index === 0);
}

const q = (v: number[], p: number): number => { const s = [...v].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const mean = (v: number[]): number => v.reduce((a, b) => a + b, 0) / Math.max(1, v.length);

interface Stats { episodes: number[]; sessions: number[]; newestShare: number[]; original: number[]; olderReinf: number[]; chars: number[]; age: number[]; old: number[]; thirds: number[][] }
const empty = (): Stats => ({ episodes: [], sessions: [], newestShare: [], original: [], olderReinf: [], chars: [], age: [], old: [], thirds: [] });
const nowMs = Date.parse(now);
const ageDays = (p: SampledPiece): number => (nowMs - Date.parse(p.captured_at)) / 86_400_000;
const base = empty(); const samp = empty(); const overlap: number[] = [];
let reinforced = 0;

function record(stats: Stats, pieces: SampledPiece[], newestEpisode: number, totalEpisodes: number, span?: [number, number]): void {
  // where non-anchor pieces sit inside the memory's own time span: oldest / middle / newest third
  if (span && span[1] > span[0]) {
    const rest = pieces.filter((p) => p.episode > 0);
    const t = [0, 0, 0];
    for (const p of rest) t[Math.min(2, Math.floor(3 * (Date.parse(p.captured_at) - span[0]) / (span[1] - span[0])))]++;
    if (rest.length) stats.thirds.push(t.map((x) => x / rest.length));
  }
  stats.episodes.push(new Set(pieces.map((p) => p.episode)).size);
  stats.sessions.push(new Set(pieces.map((p) => p.session_key)).size);
  const newestSession = pieces.filter((p) => p.episode === newestEpisode).map((p) => p.session_key)[0];
  stats.newestShare.push(pieces.length ? pieces.filter((p) => p.session_key === newestSession).length / pieces.length : 0);
  stats.original.push(pieces.filter((p) => p.episode === 0).length);
  stats.olderReinf.push(totalEpisodes > 2 ? pieces.filter((p) => p.episode > 0 && p.episode < newestEpisode).length : 0);
  stats.chars.push(mean(pieces.map((p) => [...p.text].length)));
  // age of the pieces other than the anchor (episode 0), and the share older than 45 days
  const rest = pieces.filter((p) => p.episode > 0);
  if (rest.length) { stats.age.push(mean(rest.map(ageDays))); stats.old.push(rest.filter((p) => ageDays(p) > 45).length / rest.length); }
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
  const times = episodes.flatMap((e) => e.evidence.map((x) => Date.parse(x.captured_at))).filter(Number.isFinite);
  const span: [number, number] = [Math.min(...times), Math.max(...times)];
  record(base, baselinePieces(episodes), newest, episodes.length, span);
  const a = samplePieces(memory.memory_id, 'session-A', episodes, options);
  const b = samplePieces(memory.memory_id, 'session-B', episodes, options);
  record(samp, a, newest, episodes.length, span);
  const key = (p: SampledPiece): string => `${p.evidence_id}#${p.piece}`;
  const setA = new Set(a.map(key)); const setB = new Set(b.map(key));
  overlap.push([...setA].filter((k) => setB.has(k)).length / Math.max(1, new Set([...setA, ...setB]).size));
}

console.log(`reinforced memories: ${reinforced}; options ${JSON.stringify(options)}`);
const line = (label: string, s: Stats): string => `${label.padEnd(9)} episodes covered p50 ${q(s.episodes, .5)} mean ${mean(s.episodes).toFixed(2)} | session-days p50 ${q(s.sessions, .5)} mean ${mean(s.sessions).toFixed(2)}`
  + ` | non-anchor age mean ${mean(s.age).toFixed(0)}d, >45d ${(mean(s.old) * 100).toFixed(0)}%`
  + ` | span thirds old/mid/new ${[0, 1, 2].map((i) => (mean(s.thirds.map((t) => t[i])) * 100).toFixed(0)).join('/')}%`
  + ` | newest-session share mean ${(mean(s.newestShare) * 100).toFixed(0)}% | original pieces mean ${mean(s.original).toFixed(2)} | older reinforcements pieces mean ${mean(s.olderReinf).toFixed(2)} | piece chars mean ${mean(s.chars).toFixed(0)}`;
console.log(line('baseline', base));
console.log(line('sampler', samp));
console.log(`sampler: same pieces between two sessions (jaccard) mean ${(mean(overlap) * 100).toFixed(0)}%`);
