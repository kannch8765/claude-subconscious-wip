import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { getDurableStateDir } from './conversation_utils.js';

export interface PendingSubconWhisper {
  whisper_id: string;
  session_id: string;
  batch_id: string;
  text: string;
  created_at: string;
}

export interface PendingSubconWhisperFile {
  file: string;
  whisper: PendingSubconWhisper;
}

function queueDir(cwd: string, sessionId: string): string {
  const sessionKey = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 24);
  return path.join(getDurableStateDir(cwd), 'subcon-whispers', sessionKey);
}

function stableWhisperId(sessionId: string, batchId: string): string {
  return `whisper_${crypto.createHash('sha256').update(`${sessionId}\0${batchId}`).digest('hex').slice(0, 24)}`;
}

const maintenanceLeakPatterns = [
  /\bmem_[a-z0-9]+\b/i,
  /\btranscript_ev_[a-z0-9]+\b/i,
  /\bevidence[_ -]?ids?\b/i,
  /\bmemory_(?:search|reinforce|remember)\b/i,
  /\bdedupe\b/i,
  /(?:已|需要|无需|不需要).{0,10}(?:reinforce|remember|写入|建档|存档|记忆操作)/i,
  /新证据.{0,12}(?:值得处理|需要处理|reinforce|remember)/i,
];

export function assertForegroundWhisper(text: string): void {
  for (const pattern of maintenanceLeakPatterns) {
    if (pattern.test(text)) throw new Error('deliver_whisper rejected relationship-memory maintenance prose');
  }
}

export function queueSubconWhisper(cwd: string, sessionId: string, batchId: string, text: string): PendingSubconWhisper | null {
  const cleaned = text.replace(/\r\n/g, '\n').trim();
  if (!cleaned) return null;
  assertForegroundWhisper(cleaned);
  const dir = queueDir(cwd, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const whisper: PendingSubconWhisper = {
    whisper_id: stableWhisperId(sessionId, batchId),
    session_id: sessionId,
    batch_id: batchId,
    text: cleaned,
    created_at: new Date().toISOString(),
  };
  const file = path.join(dir, `${whisper.whisper_id}.json`);
  const deliveredMarker = path.join(dir, `${whisper.whisper_id}.delivered`);
  if (fs.existsSync(deliveredMarker)) return null;
  if (fs.existsSync(file)) return whisper;
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(whisper)}\n`, { mode: 0o600 });
  try {
    fs.renameSync(temp, file);
  } catch (error) {
    try { fs.unlinkSync(temp); } catch { /* best effort */ }
    if (!fs.existsSync(file)) throw error;
  }
  return whisper;
}

export function readPendingSubconWhispers(cwd: string, sessionId: string): PendingSubconWhisperFile[] {
  const dir = queueDir(cwd, sessionId);
  if (!fs.existsSync(dir)) return [];
  const items: PendingSubconWhisperFile[] = [];
  for (const name of fs.readdirSync(dir).filter((item) => item.endsWith('.json')).sort()) {
    const file = path.join(dir, name);
    try {
      const whisper = JSON.parse(fs.readFileSync(file, 'utf8')) as PendingSubconWhisper;
      if (whisper?.session_id === sessionId && typeof whisper.text === 'string' && whisper.text.trim()) {
        items.push({ file, whisper });
      }
    } catch { /* malformed derivative queue entries are ignored */ }
  }
  return items.sort((a, b) => a.whisper.created_at.localeCompare(b.whisper.created_at));
}

export function acknowledgePendingSubconWhispers(items: PendingSubconWhisperFile[]): void {
  for (const item of items) {
    const marker = item.file.replace(/\.json$/, '.delivered');
    try {
      fs.renameSync(item.file, marker);
    } catch {
      // If another hook already acknowledged it, the marker is sufficient.
      // Otherwise leave the pending file in place so delivery can retry.
      if (!fs.existsSync(marker)) continue;
    }
  }
}

export function formatPendingSubconWhispers(items: PendingSubconWhisperFile[]): string {
  return items.map(({ whisper }, index) => {
    const ordinal = items.length > 1 ? ` (${index + 1}/${items.length})` : '';
    return `<subcon_whisper${ordinal ? ` ordinal="${index + 1}/${items.length}"` : ''} timestamp="${whisper.created_at}">\n${whisper.text}\n</subcon_whisper>`;
  }).join('\n\n');
}
