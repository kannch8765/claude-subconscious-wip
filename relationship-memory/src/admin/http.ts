import type { EffectiveSearchQuery } from '../owner/index.js';
import { MEMORY_KINDS, type MemoryKind } from '../schema/index.js';
import type {
  EffectiveMemoryAdminRow,
  SubconsciousAdminSnapshot,
  SubconsciousAdminSnapshotOptions,
} from './index.js';

export const SUBCONSCIOUS_ADMIN_HTTP_PREFIX = '/api/subconscious/admin/v1';
export const SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH = `${SUBCONSCIOUS_ADMIN_HTTP_PREFIX}/snapshot`;
export const SUBCONSCIOUS_ADMIN_MEMORIES_PATH = `${SUBCONSCIOUS_ADMIN_HTTP_PREFIX}/memories`;

const MAX_RUN_LIMIT = 100;
const MAX_QUERY_LENGTH = 500;
const MAX_MEMORY_ID_LENGTH = 200;

export interface SubconsciousAdminHttpReadModel {
  snapshot(options?: SubconsciousAdminSnapshotOptions): Promise<SubconsciousAdminSnapshot>;
  queryMemories(query?: EffectiveSearchQuery): EffectiveMemoryAdminRow[];
}

export type SubconsciousAdminHttpHandler = (request: Request) => Promise<Response>;

class ClientQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ClientQueryError';
  }
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

function clientError(message: string): Response {
  return jsonResponse({ error: { code: 'invalid_query', message } }, 400);
}

function serverReadError(): Response {
  return jsonResponse({ error: { code: 'admin_read_failed', message: 'Admin read failed.' } }, 500);
}

function singleParam(params: URLSearchParams, name: string): string | undefined {
  const values = params.getAll(name);
  if (values.length > 1) throw new ClientQueryError(`${name} may be provided at most once.`);
  return values[0];
}

function assertAllowedParams(params: URLSearchParams, allowed: ReadonlySet<string>): void {
  for (const name of params.keys()) {
    if (!allowed.has(name)) throw new ClientQueryError('Unsupported query parameter.');
  }
}

function boundedText(params: URLSearchParams, name: string, maxLength: number): string | undefined {
  const value = singleParam(params, name);
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!trimmed) throw new ClientQueryError(`${name} must be a non-empty string.`);
  if (trimmed.length > maxLength) throw new ClientQueryError(`${name} is too long.`);
  return trimmed;
}

function positiveLimit(params: URLSearchParams, name: string): number | undefined {
  const value = singleParam(params, name);
  if (value === undefined) return undefined;
  if (!/^[1-9]\d*$/.test(value)) throw new ClientQueryError(`${name} must be a positive integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed > MAX_RUN_LIMIT) {
    throw new ClientQueryError(`${name} must be between 1 and ${MAX_RUN_LIMIT}.`);
  }
  return parsed;
}

function activeFilter(params: URLSearchParams): boolean | undefined {
  const value = singleParam(params, 'active');
  if (value === undefined) return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new ClientQueryError('active must be "true" or "false".');
}

function kindFilter(params: URLSearchParams): MemoryKind | undefined {
  const value = singleParam(params, 'kind');
  if (value === undefined) return undefined;
  if (!MEMORY_KINDS.includes(value as MemoryKind)) throw new ClientQueryError('kind is not supported.');
  return value as MemoryKind;
}

const memoryParamNames = new Set(['query', 'kind', 'active', 'memoryId']);
const snapshotParamNames = new Set([...memoryParamNames, 'recentRunLimit', 'cacheRunLimit']);

function decodeMemoryQuery(params: URLSearchParams): EffectiveSearchQuery {
  const query = boundedText(params, 'query', MAX_QUERY_LENGTH);
  const kind = kindFilter(params);
  const active = activeFilter(params);
  const memoryId = boundedText(params, 'memoryId', MAX_MEMORY_ID_LENGTH);
  return {
    ...(query !== undefined ? { query } : {}),
    ...(kind !== undefined ? { kind } : {}),
    ...(active !== undefined ? { active } : {}),
    ...(memoryId !== undefined ? { memory_id: memoryId } : {}),
  };
}

function decodeSnapshotOptions(params: URLSearchParams): SubconsciousAdminSnapshotOptions {
  assertAllowedParams(params, snapshotParamNames);
  const recentRunLimit = positiveLimit(params, 'recentRunLimit');
  const cacheRunLimit = positiveLimit(params, 'cacheRunLimit');
  const memoryQuery = decodeMemoryQuery(params);
  return {
    ...(recentRunLimit !== undefined ? { recentRunLimit } : {}),
    ...(cacheRunLimit !== undefined ? { cacheRunLimit } : {}),
    ...(Object.keys(memoryQuery).length ? { memoryQuery } : {}),
  };
}

export function createSubconsciousAdminHttpHandler(readModel: SubconsciousAdminHttpReadModel): SubconsciousAdminHttpHandler {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'GET') {
      return jsonResponse(
        { error: { code: 'method_not_allowed', message: 'Only GET is supported.' } },
        405,
        { allow: 'GET' },
      );
    }

    const url = new URL(request.url);
    try {
      if (url.pathname === SUBCONSCIOUS_ADMIN_SNAPSHOT_PATH) {
        const snapshot = await readModel.snapshot(decodeSnapshotOptions(url.searchParams));
        return jsonResponse(snapshot);
      }
      if (url.pathname === SUBCONSCIOUS_ADMIN_MEMORIES_PATH) {
        assertAllowedParams(url.searchParams, memoryParamNames);
        const rows = readModel.queryMemories(decodeMemoryQuery(url.searchParams));
        return jsonResponse(rows);
      }
      return jsonResponse({ error: { code: 'not_found', message: 'Admin route not found.' } }, 404);
    } catch (error) {
      if (error instanceof ClientQueryError) return clientError(error.message);
      return serverReadError();
    }
  };
}
