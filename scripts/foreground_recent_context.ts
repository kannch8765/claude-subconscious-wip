import * as fs from 'fs';
import { escapeXmlContent } from './conversation_utils.js';
import { listMaintenanceQueueJobs } from './maintenance_queue.js';
import { extractAllContent, type TranscriptMessage } from './transcript_utils.js';

export interface ForegroundRecentTranscriptMessage {
  message_id?: string;
  role: 'user' | 'assistant';
  text: string;
  captured_at?: string;
}

const DEFAULT_MAX_MESSAGES = 8;
const DEFAULT_MAX_RENDER_CHARS = 6_000;
const DEFAULT_QUERY_CONTEXT_CHARS = 1_600;
const DEFAULT_TRANSCRIPT_TAIL_BYTES = 4 * 1024 * 1024;

function visibleTranscriptMessage(message: TranscriptMessage): ForegroundRecentTranscriptMessage | null {
  if (message.type !== 'user' && message.type !== 'assistant') return null;
  const text = extractAllContent(message).text?.trim() ?? '';
  if (!text) return null;
  return {
    ...(message.uuid ? { message_id: message.uuid } : {}),
    role: message.type,
    text,
    ...(message.timestamp ? { captured_at: message.timestamp } : {}),
  };
}

function identity(message: ForegroundRecentTranscriptMessage): string {
  return message.message_id
    ? `id:${message.message_id}`
    : `fallback:${message.role}\0${message.captured_at ?? ''}\0${message.text}`;
}

function boundRecent(
  messages: readonly ForegroundRecentTranscriptMessage[],
  currentPrompt: string,
  maxMessages = DEFAULT_MAX_MESSAGES,
): ForegroundRecentTranscriptMessage[] {
  const unique: ForegroundRecentTranscriptMessage[] = [];
  const seen = new Set<string>();
  for (const message of messages) {
    const key = identity(message);
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(message);
  }

  // UserPromptSubmit transcripts can already contain the current prompt. The
  // current prompt has its own trusted field, so keep this lane strictly prior.
  const normalizedPrompt = currentPrompt.trim();
  for (let i = unique.length - 1; i >= 0; i--) {
    if (unique[i].role === 'user') {
      if (normalizedPrompt && unique[i].text.trim() === normalizedPrompt) unique.splice(i, 1);
      break;
    }
  }
  return unique.slice(-Math.max(1, maxMessages));
}

function parseTranscriptTail(transcriptPath: string, maxTailBytes = DEFAULT_TRANSCRIPT_TAIL_BYTES): TranscriptMessage[] {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return [];
  const stat = fs.statSync(transcriptPath);
  if (stat.size <= 0) return [];
  const length = Math.min(stat.size, Math.max(4096, maxTailBytes));
  const start = stat.size - length;
  const fd = fs.openSync(transcriptPath, 'r');
  try {
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let text = buffer.toString('utf8');
    if (start > 0) {
      const firstNewline = text.indexOf('\n');
      if (firstNewline < 0) return [];
      text = text.slice(firstNewline + 1);
    }
    return text.split(/\r?\n/).flatMap((line) => {
      const trimmed = line.trim();
      if (!trimmed) return [];
      try { return [JSON.parse(trimmed) as TranscriptMessage]; }
      catch { return []; }
    });
  } finally {
    fs.closeSync(fd);
  }
}

export function readForegroundRecentTranscript(
  cwd: string,
  sessionId: string,
  currentPrompt: string,
  transcriptPath?: string,
  maxMessages = DEFAULT_MAX_MESSAGES,
): ForegroundRecentTranscriptMessage[] {
  if (transcriptPath) {
    try {
      const direct = parseTranscriptTail(transcriptPath)
        .map(visibleTranscriptMessage)
        .filter((item): item is ForegroundRecentTranscriptMessage => Boolean(item));
      const bounded = boundRecent(direct, currentPrompt, maxMessages);
      if (bounded.length > 0) return bounded;
    } catch {
      // Recent context is an optimization on the blocking foreground path.
      // Any transient transcript read failure must fall through rather than
      // delaying or failing the user's prompt.
    }
  }

  // Fallback for callers that cannot supply transcript_path yet. Queue jobs are
  // immutable transcript slices and include queued/in-flight maintenance turns.
  try {
    const queued = listMaintenanceQueueJobs(cwd, sessionId)
      .flatMap((job) => job.transcript_messages)
      .map(visibleTranscriptMessage)
      .filter((item): item is ForegroundRecentTranscriptMessage => Boolean(item));
    return boundRecent(queued, currentPrompt, maxMessages);
  } catch {
    return [];
  }
}

function boundedTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) return value;
  return `…[earlier recent context truncated]\n${value.slice(-maxChars)}`;
}

export function renderForegroundRecentTranscript(
  messages: readonly ForegroundRecentTranscriptMessage[],
  maxChars = DEFAULT_MAX_RENDER_CHARS,
): string {
  if (messages.length === 0) return '';
  let remaining = Math.max(400, maxChars);
  const selected: ForegroundRecentTranscriptMessage[] = [];
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const message = messages[i];
    const codePoints = [...message.text];
    const take = Math.min(codePoints.length, remaining);
    const text = take < codePoints.length
      ? `…[earlier message text truncated]${codePoints.slice(codePoints.length - take).join('')}`
      : message.text;
    selected.unshift({ ...message, text });
    remaining -= take;
  }
  const body = selected.map((message) => {
    const attrs = [
      `role="${message.role}"`,
      ...(message.message_id ? [`message_id="${escapeXmlContent(message.message_id)}"`] : []),
      ...(message.captured_at ? [`captured_at="${escapeXmlContent(message.captured_at)}"`] : []),
    ].join(' ');
    return `<message ${attrs}>${escapeXmlContent(message.text)}</message>`;
  }).join('\n');
  return `<recent_foreground_transcript trusted="transcript_provenance_only" canonical_status="noncanonical_context_only">\n${body}\n</recent_foreground_transcript>`;
}

export function contextualForegroundRecallQuery(
  latestUserMessage: string,
  messages: readonly ForegroundRecentTranscriptMessage[],
  fallbackContext = '',
  maxContextChars = DEFAULT_QUERY_CONTEXT_CHARS,
): string {
  const latest = latestUserMessage.trim();
  if (!latest) return latest;
  const structured = messages.map((message) => `${message.role === 'user' ? '猫' : '琥珀'}：${message.text}`).join('\n');
  const context = structured || fallbackContext.trim();
  if (!context) return latest;
  const bounded = boundedTail(context, Math.max(200, maxContextChars));
  return `${latest}\n\n最近 foreground 对话语境：\n${bounded}`;
}
