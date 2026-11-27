/**
 * Experimental quote selection for resurfacing a memory (view layer only; the store is untouched).
 *
 * Today a memory shows its first 4 and last 4 sentence pieces by time, so one
 * reinforcement fills the "latest" half. This sampler groups evidence into
 * episodes (the original capture and each reinforcement) and picks:
 *   - an anchor: the opening unit of the original capture,
 *   - the newest episode: at most one unit,
 *   - the rest: at most one unit per session-day, weighted by a forgetting curve
 *     with a floor, so old episodes come back now and then.
 * A unit is up to two consecutive pieces of one message, so a quote keeps some context.
 * The seed is (memory, session): stable within a session, different across sessions.
 */
import { createHash } from 'crypto';

export interface SamplerEvidence {
  evidence_id: string;
  quote: string;
  captured_at: string;
  conversation_id?: string;
  event_kind?: string;
}

export interface SamplerEpisode {
  /** 0 = original capture; reinforcements follow in time order. */
  index: number;
  at: string;
  evidence: SamplerEvidence[];
}

export interface SampledPiece {
  episode: number;
  evidence_id: string;
  piece: number;
  text: string;
  captured_at: string;
  session_key: string;
}

export interface SamplerOptions {
  maxPieces?: number;
  unitPieces?: number;
  halfLifeDays?: number;
  floor?: number;
  now?: string;
}

/** Same sentence split as RelationshipMemoryRuntime.splitSourceText. */
export function splitPieces(text: string): string[] {
  const pieces: string[] = [];
  for (const line of text.replace(/\r\n/g, '\n').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const sentences = trimmed.match(/[^。！？!?]+[。！？!?]+[」』”’]?|[^。！？!?]+$/gu) ?? [trimmed];
    for (const sentence of sentences) {
      const source = sentence.trim();
      if (!source) continue;
      const codePoints = [...source];
      for (let offset = 0; offset < codePoints.length; offset += 600) pieces.push(codePoints.slice(offset, offset + 600).join(''));
    }
  }
  return pieces;
}

function quotable(item: SamplerEvidence): boolean {
  return !item.event_kind || item.event_kind === 'user_text' || item.event_kind === 'assistant_text';
}

export function sessionKey(item: SamplerEvidence): string {
  return `${item.conversation_id ?? '?'}:${item.captured_at.slice(0, 10)}`;
}

function rng(seed: string): () => number {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >>> 17;
    state ^= state << 5; state >>>= 0;
    return state / 0x1_0000_0000;
  };
}

interface Unit { episode: number; at: string; session: string; pieces: SampledPiece[] }

function unitsOf(episode: SamplerEpisode, unitPieces: number): Unit[] {
  const units: Unit[] = [];
  const sorted = [...episode.evidence].filter(quotable).sort((a, b) => a.captured_at.localeCompare(b.captured_at) || a.evidence_id.localeCompare(b.evidence_id));
  for (const item of sorted) {
    const pieces = splitPieces(item.quote);
    for (let i = 0; i < pieces.length; i += unitPieces) {
      units.push({
        episode: episode.index, at: item.captured_at, session: sessionKey(item),
        pieces: pieces.slice(i, i + unitPieces).map((text, k) => ({ episode: episode.index, evidence_id: item.evidence_id, piece: i + k, text, captured_at: item.captured_at, session_key: sessionKey(item) })),
      });
    }
  }
  return units;
}

/** Baseline used today: first half and last half of all pieces by time. */
export function baselinePieces(episodes: SamplerEpisode[], maxPieces = 8): SampledPiece[] {
  const all = episodes.flatMap((episode) => unitsOf(episode, 1)).sort((a, b) => a.at.localeCompare(b.at)).flatMap((unit) => unit.pieces);
  if (all.length <= maxPieces) return all;
  return [...all.slice(0, Math.ceil(maxPieces / 2)), ...all.slice(-Math.floor(maxPieces / 2))];
}

export function samplePieces(memoryId: string, sessionId: string, episodes: SamplerEpisode[], options: SamplerOptions = {}): SampledPiece[] {
  const maxPieces = options.maxPieces ?? 8;
  const unitPieces = options.unitPieces ?? 2;
  const halfLife = options.halfLifeDays ?? 30;
  const floor = options.floor ?? 0.15;
  const now = Date.parse(options.now ?? new Date().toISOString());
  const random = rng(`${memoryId}\u0000${sessionId}`);
  const units = episodes.flatMap((episode) => unitsOf(episode, unitPieces));
  if (units.reduce((n, unit) => n + unit.pieces.length, 0) <= maxPieces) return units.flatMap((unit) => unit.pieces);

  const chosen: Unit[] = [];
  const used = new Set<Unit>();
  const sessions = new Set<string>();
  let count = 0;
  const take = (unit: Unit | undefined): void => {
    if (!unit || used.has(unit) || count + unit.pieces.length > maxPieces) return;
    used.add(unit); chosen.push(unit); sessions.add(unit.session); count += unit.pieces.length;
  };
  take(units.find((unit) => unit.episode === 0));
  const newest = Math.max(...units.map((unit) => unit.episode));
  if (newest > 0) {
    const pool = units.filter((unit) => unit.episode === newest);
    take(pool[Math.floor(random() * pool.length)]);
  }
  const weight = (unit: Unit): number => floor + Math.pow(0.5, Math.max(0, now - Date.parse(unit.at)) / 86_400_000 / halfLife);
  for (let guard = 0; guard < 64 && count < maxPieces; guard++) {
    const pool = units.filter((unit) => !used.has(unit) && !sessions.has(unit.session) && count + unit.pieces.length <= maxPieces);
    const fallback = pool.length ? pool : units.filter((unit) => !used.has(unit) && count + unit.pieces.length <= maxPieces);
    if (!fallback.length) break;
    const total = fallback.reduce((sum, unit) => sum + weight(unit), 0);
    let pick = random() * total;
    const unit = fallback.find((candidate) => (pick -= weight(candidate)) <= 0) ?? fallback[fallback.length - 1];
    take(unit);
  }
  return chosen.sort((a, b) => a.at.localeCompare(b.at)).flatMap((unit) => unit.pieces);
}
