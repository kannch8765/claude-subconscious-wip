import * as fs from 'fs';
import * as path from 'path';

/**
 * In-process read cache for relationship-memory files.
 *
 * Several processes write the same store (MCP servers, hooks, replay runners), so
 * every read re-checks the file: one fstat plus two small guard reads. Time never
 * decides whether a cached value is valid. The idle timer below only releases
 * memory in long-lived processes that read rarely.
 *
 * Cached records are shared between callers. Callers get a fresh array, but must
 * never mutate the records inside it.
 */

const GUARD_BYTES = 4096;
const DEFAULT_IDLE_MS = 300_000;
const NEWLINE = 0x0a;

export function readCacheEnabled(): boolean {
  const raw = process.env.RELATIONSHIP_MEMORY_READ_CACHE?.trim().toLowerCase();
  return raw !== 'off' && raw !== '0' && raw !== 'false';
}

const clearers: Array<() => void> = [];
let lastUseAt = 0;
let idleTimer: NodeJS.Timeout | undefined;

function idleMs(): number {
  const parsed = Number.parseInt(process.env.RELATIONSHIP_MEMORY_READ_CACHE_IDLE_MS ?? '', 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_IDLE_MS;
}

function armIdleTimer(delayMs: number): void {
  idleTimer = setTimeout(() => {
    idleTimer = undefined;
    const idleFor = performance.now() - lastUseAt;
    const limit = idleMs();
    if (idleFor >= limit) clearReadCaches();
    else armIdleTimer(limit - idleFor);
  }, delayMs);
  idleTimer.unref();
}

/** Marks a cached read; all caches are dropped once reads stop for the idle period. */
export function noteReadCacheUse(): void {
  lastUseAt = performance.now();
  if (!idleTimer) armIdleTimer(idleMs());
}

export function registerReadCache(clear: () => void): void {
  clearers.push(clear);
}

export function clearReadCaches(): void {
  for (const clear of clearers) clear();
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
}

function identityOf(stat: fs.BigIntStats): FileIdentity {
  return { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeNs: stat.mtimeNs, ctimeNs: stat.ctimeNs };
}

function sameInode(a: FileIdentity, b: FileIdentity): boolean {
  return a.dev === b.dev && a.ino === b.ino;
}

/** Opens a file for one consistent read. Missing files return undefined, like the old existsSync check. */
function openForRead(file: string): number | undefined {
  try {
    return fs.openSync(file, 'r');
  } catch (error) {
    if (!fs.existsSync(file)) return undefined;
    throw error;
  }
}

function readRange(fd: number, position: number, length: number): Buffer {
  const buffer = Buffer.allocUnsafe(Math.max(0, length));
  let offset = 0;
  while (offset < buffer.length) {
    const read = fs.readSync(fd, buffer, offset, buffer.length - offset, position + offset);
    if (read === 0) break;
    offset += read;
  }
  return offset === buffer.length ? buffer : buffer.subarray(0, offset);
}

// ---------------------------------------------------------------------------
// Semantic index and other whole-file JSON
// ---------------------------------------------------------------------------

type JsonReadResult = { ok: true; value: unknown } | { ok: false };

interface JsonFileCacheEntry {
  identity: FileIdentity;
  result: JsonReadResult;
}

const jsonFileCache = new Map<string, JsonFileCacheEntry>();
registerReadCache(() => jsonFileCache.clear());

/**
 * Parses a JSON file that writers only ever replace by rename. The cache key is
 * (dev, ino, size, mtimeNs); every replacement gets a new inode, so it always
 * misses. Read or parse failures return { ok: false }, as the old catch-all did.
 */
export function readJsonFileCached(file: string): JsonReadResult {
  const key = path.resolve(file);
  let fd: number;
  try { fd = fs.openSync(key, 'r'); } catch {
    jsonFileCache.delete(key);
    return { ok: false };
  }
  try {
    const identity = identityOf(fs.fstatSync(fd, { bigint: true }));
    const cached = jsonFileCache.get(key);
    noteReadCacheUse();
    if (cached && sameInode(cached.identity, identity) && cached.identity.size === identity.size && cached.identity.mtimeNs === identity.mtimeNs) {
      return cached.result;
    }
    const raw = readRange(fd, 0, Number(identity.size));
    let result: JsonReadResult;
    try { result = { ok: true, value: JSON.parse(raw.toString('utf8')) }; } catch { result = { ok: false }; }
    // A short read means the file changed under us; serve it once without caching.
    if (raw.length === Number(identity.size)) jsonFileCache.set(key, { identity, result });
    else jsonFileCache.delete(key);
    return result;
  } catch {
    jsonFileCache.delete(key);
    return { ok: false };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Append-only JSONL
// ---------------------------------------------------------------------------

interface AppendOnlyEntry<T> {
  identity: FileIdentity;
  /** Bytes through the last newline. Only complete lines are ever cached. */
  consumed: number;
  /** Copies of the first and the last min(GUARD_BYTES, consumed) cached bytes. */
  head: Buffer;
  tail: Buffer;
  data: T;
}

/** One way of caching what the complete lines of a JSONL file hold. */
interface AppendOnlyView<T> {
  readonly entries: Map<string, AppendOnlyEntry<T>>;
  create(): T;
  /** Adds the complete lines in chunk[0, end) to data; base is the file offset of chunk[0]. */
  ingest(data: T, chunk: Buffer, end: number, base: number): void;
}

const views: Array<AppendOnlyView<unknown>> = [];
registerReadCache(() => { for (const view of views) view.entries.clear(); });

function lastBytes(buffer: Buffer, count: number): Buffer {
  // Copy, so the cache never pins the whole buffer it was cut from.
  return Buffer.from(buffer.subarray(Math.max(0, buffer.length - count)));
}

/** Calls visit(start, end) for every non-empty line in chunk[0, end). */
function forEachLine(chunk: Buffer, end: number, visit: (start: number, end: number) => void): void {
  let lineStart = 0;
  while (lineStart < end) {
    const newline = chunk.indexOf(NEWLINE, lineStart);
    const lineEnd = newline < 0 || newline >= end ? end : newline;
    if (lineEnd > lineStart) visit(lineStart, lineEnd);
    lineStart = lineEnd + 1;
  }
}

function guardsMatch(fd: number, entry: AppendOnlyEntry<unknown>): boolean {
  if (entry.consumed === 0) return true;
  if (!readRange(fd, 0, entry.head.length).equals(entry.head)) return false;
  return readRange(fd, entry.consumed - entry.tail.length, entry.tail.length).equals(entry.tail);
}

function loadAppendOnly<T>(view: AppendOnlyView<T>, fd: number, identity: FileIdentity): { entry: AppendOnlyEntry<T>; unterminated: Buffer; complete: boolean } {
  const size = Number(identity.size);
  const raw = readRange(fd, 0, size);
  const consumed = raw.lastIndexOf(NEWLINE) + 1;
  const data = view.create();
  view.ingest(data, raw, consumed, 0);
  return {
    entry: {
      identity,
      consumed,
      head: Buffer.from(raw.subarray(0, Math.min(GUARD_BYTES, consumed))),
      tail: lastBytes(raw.subarray(0, consumed), GUARD_BYTES),
      data,
    },
    unterminated: raw.subarray(consumed),
    complete: raw.length === size,
  };
}

/** Ingests only the bytes appended since the cached read; undefined if the read came up short. */
function extendAppendOnly<T>(view: AppendOnlyView<T>, fd: number, cached: AppendOnlyEntry<T>, identity: FileIdentity): { entry: AppendOnlyEntry<T>; unterminated: Buffer } | undefined {
  const size = Number(identity.size);
  const chunk = readRange(fd, cached.consumed, size - cached.consumed);
  if (chunk.length !== size - cached.consumed) return undefined;
  const completeLength = chunk.lastIndexOf(NEWLINE) + 1;
  const complete = chunk.subarray(0, completeLength);
  view.ingest(cached.data, complete, completeLength, cached.consumed);
  const consumed = cached.consumed + completeLength;
  // While consumed < GUARD_BYTES the head guard is the whole cached prefix, so it
  // grows with the new bytes. The tail guard always ends at the new boundary.
  const head = cached.head.length < GUARD_BYTES
    ? Buffer.from(Buffer.concat([cached.head, complete]).subarray(0, Math.min(GUARD_BYTES, consumed)))
    : cached.head;
  const tail = lastBytes(Buffer.concat([cached.tail, complete]), GUARD_BYTES);
  return { entry: { identity, consumed, head, tail, data: cached.data }, unterminated: chunk.subarray(completeLength) };
}

/**
 * Runs use() on the view's data for the file's current complete lines, with the
 * still-open fd and the unterminated tail (bytes after the last newline: a writer
 * mid-append, or a file without a final newline). Missing files return undefined.
 *
 * - Same inode, same size, mtime and ctime, guards intact: cache hit.
 * - Same inode, file grew, guards intact: ingest only the new complete lines.
 * - Anything else (new inode, shrink, same-size rewrite, changed guard bytes): full reload.
 */
function readAppendOnly<T, R>(view: AppendOnlyView<T>, file: string, use: (data: T, unterminated: string, fd: number) => R): R | undefined {
  const key = path.resolve(file);
  const fd = openForRead(key);
  if (fd === undefined) {
    view.entries.delete(key);
    return undefined;
  }
  try {
    noteReadCacheUse();
    const identity = identityOf(fs.fstatSync(fd, { bigint: true }));
    const size = Number(identity.size);
    const cached = view.entries.get(key);
    let current: { entry: AppendOnlyEntry<T>; unterminated: Buffer } | undefined;
    if (cached && sameInode(cached.identity, identity) && size >= cached.consumed && guardsMatch(fd, cached)) {
      const unchanged = identity.size === cached.identity.size
        && identity.mtimeNs === cached.identity.mtimeNs
        && identity.ctimeNs === cached.identity.ctimeNs;
      if (unchanged) current = { entry: cached, unterminated: readRange(fd, cached.consumed, size - cached.consumed) };
      else if (identity.size > cached.identity.size) current = extendAppendOnly(view, fd, cached, identity);
      if (current) view.entries.set(key, current.entry);
    }
    if (!current) {
      const loaded = loadAppendOnly(view, fd, identity);
      if (loaded.complete) view.entries.set(key, loaded.entry);
      else view.entries.delete(key);
      current = loaded;
    }
    return use(current.entry.data, current.unterminated.toString('utf8'), fd);
  } finally {
    fs.closeSync(fd);
  }
}

function registerView<T>(view: AppendOnlyView<T>): AppendOnlyView<T> {
  views.push(view as AppendOnlyView<unknown>);
  return view;
}

/**
 * Parses the unterminated tail. A complete record that lacks only its newline is
 * returned (never cached). An unparseable tail is a writer mid-append: outside
 * the mutation lock it is ignored until the line completes. Under the lock
 * (strict) no writer can be mid-append, so it throws as the old reader did.
 */
function parseUnterminated(text: string, strict: boolean): { present: boolean; record?: unknown } {
  if (!text) return { present: false };
  try {
    return { present: true, record: JSON.parse(text) as unknown };
  } catch (error) {
    if (strict) throw error;
    return { present: false };
  }
}

// Parsed records ------------------------------------------------------------

interface ParsedLines {
  records: unknown[];
  /** Complete lines that JSON.parse rejected, in file order. */
  invalidLines: string[];
}

const parsedLines = registerView<ParsedLines>({
  entries: new Map(),
  create: () => ({ records: [], invalidLines: [] }),
  ingest(data, chunk, end) {
    // Decode per line: '\n' never occurs inside a UTF-8 sequence, so this equals
    // decoding the whole file and splitting it, without one giant string.
    forEachLine(chunk, end, (start, lineEnd) => {
      const line = chunk.toString('utf8', start, lineEnd);
      try { data.records.push(JSON.parse(line) as unknown); } catch { data.invalidLines.push(line); }
    });
  },
});

/** Cached equivalent of reading a JSONL file and JSON.parse-ing every non-empty line. */
export function readJsonlCached<T>(file: string, strict: boolean): T[] {
  return readAppendOnly(parsedLines, file, (data, unterminated) => {
    // Re-parse to throw the same SyntaxError the old line-by-line parse hit first.
    if (data.invalidLines.length > 0) JSON.parse(data.invalidLines[0]);
    const records = data.records.slice() as T[];
    const tail = parseUnterminated(unterminated, strict);
    if (tail.present) records.push(tail.record as T);
    return records;
  }) ?? [];
}

// Line offsets by field value -------------------------------------------------

/**
 * Byte ranges of the lines that contain `"<field>":<literal>`, keyed by the
 * literal's raw bytes (latin1-decoded, so keys compare byte for byte). Stored as
 * a flat [start, end, start, end, ...] list in file order.
 */
type LineRangesByLiteral = Map<string, number[]>;

/** End (exclusive) of the JSON string literal starting at buffer[start], or -1. */
function jsonStringLiteralEnd(buffer: Buffer, start: number): number {
  if (buffer[start] !== 0x22) return -1;
  for (let index = start + 1; index < buffer.length; index += 1) {
    if (buffer[index] === 0x5c) index += 1;
    else if (buffer[index] === 0x22) return index + 1;
  }
  return -1;
}

const fieldViews = new Map<string, AppendOnlyView<LineRangesByLiteral>>();

function fieldLineView(field: string): AppendOnlyView<LineRangesByLiteral> {
  let view = fieldViews.get(field);
  if (view) return view;
  const prefix = Buffer.from(`${JSON.stringify(field)}:`, 'utf8');
  view = registerView<LineRangesByLiteral>({
    entries: new Map(),
    create: () => new Map(),
    ingest(ranges, chunk, end, base) {
      forEachLine(chunk, end, (lineStart, lineEnd) => {
        const line = chunk.subarray(lineStart, lineEnd);
        for (let at = line.indexOf(prefix); at >= 0; at = line.indexOf(prefix, at + 1)) {
          const literalStart = at + prefix.length;
          const literalEnd = jsonStringLiteralEnd(line, literalStart);
          if (literalEnd < 0) continue;
          const literal = line.toString('latin1', literalStart, literalEnd);
          const list = ranges.get(literal);
          if (!list) ranges.set(literal, [base + lineStart, base + lineEnd]);
          else if (list[list.length - 2] !== base + lineStart) list.push(base + lineStart, base + lineEnd);
        }
      });
    },
  });
  fieldViews.set(field, view);
  return view;
}

/**
 * Cached equivalent of the byte search for `"<field>":<JSON value>` per requested
 * value: requested values in input order (deduplicated), each value's lines in
 * file order, every matching line parsed (so a corrupt matching line throws, and
 * a corrupt line that matches nothing is never touched). Only line offsets are
 * cached; the matching lines are re-read through the same fd and parsed fresh.
 */
export function readJsonlCachedByField<T>(file: string, field: string, values: readonly string[], strict: boolean): T[] {
  if (values.length === 0) return [];
  return readAppendOnly(fieldLineView(field), file, (ranges, unterminated, fd) => {
    const result: T[] = [];
    for (const value of new Set(values)) {
      const literal = JSON.stringify(value);
      const list = ranges.get(Buffer.from(literal, 'utf8').toString('latin1')) ?? [];
      for (let index = 0; index < list.length; index += 2) {
        result.push(JSON.parse(readRange(fd, list[index], list[index + 1] - list[index]).toString('utf8')) as T);
      }
      if (unterminated.includes(`${JSON.stringify(field)}:${literal}`)) {
        const tail = parseUnterminated(unterminated, strict);
        if (tail.present) result.push(tail.record as T);
      }
    }
    return result;
  }) ?? [];
}
