import type { ProviderUsageSlot } from './index.js';

export const OPENCODE_USAGE_EXPORT_PATH = '/api/v1/usage/export' as const;
export type OpenCodeUsageRange = '24h' | '7d' | '30d';
export type OpenCodeUsageScope = 'organization' | 'member' | 'service_account' | 'model';

export type OpenCodeUsageExportRequest =
  | { range: OpenCodeUsageRange; scope: 'organization' }
  | { range: OpenCodeUsageRange; scope: 'member'; userEmail: string }
  | { range: OpenCodeUsageRange; scope: 'service_account'; serviceAccountId: string }
  | { range: OpenCodeUsageRange; scope: 'model'; provider: string; model: string };

export interface OpenCodeUsageHttpRequest { method: 'GET'; path: typeof OPENCODE_USAGE_EXPORT_PATH; query: URLSearchParams; accept: 'text/csv'; }
export interface OpenCodeUsageExportTransport { exportCsv(request: OpenCodeUsageHttpRequest): Promise<string>; }

export interface OpenCodeUsageAggregate {
  status: 'success'; provider: 'opencode-console'; endpoint: typeof OPENCODE_USAGE_EXPORT_PATH;
  range: OpenCodeUsageRange; scope: OpenCodeUsageScope;
  /** Console export ranges start at midnight UTC and are not rolling quota windows. */
  windowSemantics: 'console_export_midnight_utc';
  rowCount: number; inputTokens: number; outputTokens: number;
  /** input + output only; reasoning is an output breakdown and is not added again. */
  totalTokens: number;
  reasoningTokens: number; cacheReadTokens: number; cacheWrite5mTokens: number; cacheWrite1hTokens: number;
  /** Provider-reported microcents. 100,000,000 microcents = USD 1. */
  costMicroCents: number;
  earliestCreatedAt?: string; latestCreatedAt?: string; observedAt: string;
}

export type OpenCodeUsageUnavailableKind = 'unconfigured' | 'transport_error' | 'invalid_csv';
export type OpenCodeUsageObservation =
  | { availability: 'available'; aggregate: OpenCodeUsageAggregate; providerUsage: ProviderUsageSlot }
  | { availability: 'unavailable'; error: { kind: OpenCodeUsageUnavailableKind; message: string }; providerUsage: ProviderUsageSlot };

export class OpenCodeUsageError extends Error {
  constructor(public readonly kind: Exclude<OpenCodeUsageUnavailableKind, 'unconfigured'>, message: string) { super(message); this.name = 'OpenCodeUsageError'; }
}

const VALID_RANGES = new Set<OpenCodeUsageRange>(['24h', '7d', '30d']);
const nonEmpty = (value: unknown, label: string) => {
  if (typeof value !== 'string' || value.trim() === '') throw new TypeError(`${label} must be a non-empty string`);
  return value;
};

export function buildOpenCodeUsageExportRequest(request: OpenCodeUsageExportRequest): OpenCodeUsageHttpRequest {
  if (!request || typeof request !== 'object') throw new TypeError('OpenCode usage export request is required');
  if (!VALID_RANGES.has(request.range)) throw new TypeError(`Unsupported OpenCode Console usage range: ${String(request.range)}`);
  const query = new URLSearchParams({ scope: request.scope, range: request.range });
  switch (request.scope) {
    case 'organization': break;
    case 'member': query.set('user_email', nonEmpty(request.userEmail, 'userEmail')); break;
    case 'service_account': query.set('service_account_id', nonEmpty(request.serviceAccountId, 'serviceAccountId')); break;
    case 'model': query.set('provider', nonEmpty(request.provider, 'provider')); query.set('model', nonEmpty(request.model, 'model')); break;
    default: throw new TypeError(`Unsupported OpenCode Console usage scope: ${String((request as { scope?: unknown }).scope)}`);
  }
  return { method: 'GET', path: OPENCODE_USAGE_EXPORT_PATH, query, accept: 'text/csv' };
}

export class FetchOpenCodeUsageExportTransport implements OpenCodeUsageExportTransport {
  constructor(private readonly serviceAccountApiKey: string, private readonly baseUrl = 'https://console.opencode.ai') {}
  async exportCsv(request: OpenCodeUsageHttpRequest): Promise<string> {
    const url = new URL(request.path, this.baseUrl); url.search = request.query.toString();
    let response: Response;
    try {
      response = await fetch(url, { method: request.method, headers: { Authorization: `Bearer ${this.serviceAccountApiKey}`, Accept: request.accept } });
    } catch (error) {
      throw new OpenCodeUsageError('transport_error', `OpenCode Console usage export request failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new OpenCodeUsageError('transport_error', `OpenCode Console usage export failed (${response.status})`);
    return response.text();
  }
}

function parseCsv(csv: string): string[][] {
  const rows: string[][] = []; let row: string[] = []; let field = ''; let quoted = false;
  for (let i = 0; i < csv.length; i += 1) {
    const char = csv[i];
    if (quoted) {
      if (char === '"' && csv[i + 1] === '"') { field += '"'; i += 1; }
      else if (char === '"') quoted = false;
      else field += char;
      continue;
    }
    if (char === '"' && field.length === 0) quoted = true;
    else if (char === ',') { row.push(field); field = ''; }
    else if (char === '\n') { row.push(field.replace(/\r$/, '')); rows.push(row); row = []; field = ''; }
    else field += char;
  }
  if (quoted) throw new OpenCodeUsageError('invalid_csv', 'Malformed OpenCode usage CSV: unterminated quoted field');
  if (field.length > 0 || row.length > 0) { row.push(field.replace(/\r$/, '')); rows.push(row); }
  return rows.filter(candidate => !(candidate.length === 1 && candidate[0] === ''));
}

const REQUIRED_COLUMNS = ['input_tokens','output_tokens','reasoning_tokens','cache_read_tokens','cache_write_5m_tokens','cache_write_1h_tokens','cost_micro_cents','created_at'] as const;
function parseNonNegativeInteger(value: string, column: string, rowNumber: number): number {
  if (!/^(0|[1-9]\d*)$/.test(value)) throw new OpenCodeUsageError('invalid_csv', `Malformed OpenCode usage CSV: ${column} at data row ${rowNumber} is not a non-negative integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new OpenCodeUsageError('invalid_csv', `Malformed OpenCode usage CSV: ${column} at data row ${rowNumber} exceeds safe integer range`);
  return parsed;
}

export function aggregateOpenCodeUsageCsv(csv: string, request: OpenCodeUsageExportRequest, observedAt = new Date().toISOString()): OpenCodeUsageAggregate {
  if (csv.trim() === '') {
    return { status:'success', provider:'opencode-console', endpoint:OPENCODE_USAGE_EXPORT_PATH, range:request.range, scope:request.scope, windowSemantics:'console_export_midnight_utc', rowCount:0, inputTokens:0, outputTokens:0, totalTokens:0, reasoningTokens:0, cacheReadTokens:0, cacheWrite5mTokens:0, cacheWrite1hTokens:0, costMicroCents:0, observedAt };
  }
  const rows = parseCsv(csv);
  const headers = rows[0]; const indexes = Object.fromEntries(headers.map((header, index) => [header, index])) as Record<string, number>;
  for (const column of REQUIRED_COLUMNS) if (indexes[column] === undefined) throw new OpenCodeUsageError('invalid_csv', `Malformed OpenCode usage CSV: missing ${column} column`);
  let inputTokens=0, outputTokens=0, reasoningTokens=0, cacheReadTokens=0, cacheWrite5mTokens=0, cacheWrite1hTokens=0, costMicroCents=0;
  let earliestCreatedAt: string | undefined; let latestCreatedAt: string | undefined;
  rows.slice(1).forEach((cells, index) => {
    const rowNumber = index + 1;
    if (cells.length !== headers.length) throw new OpenCodeUsageError('invalid_csv', `Malformed OpenCode usage CSV: data row ${rowNumber} has ${cells.length} columns; expected ${headers.length}`);
    const numeric = (column: typeof REQUIRED_COLUMNS[number]) => parseNonNegativeInteger(cells[indexes[column]], column, rowNumber);
    inputTokens += numeric('input_tokens'); outputTokens += numeric('output_tokens'); reasoningTokens += numeric('reasoning_tokens'); cacheReadTokens += numeric('cache_read_tokens');
    cacheWrite5mTokens += numeric('cache_write_5m_tokens'); cacheWrite1hTokens += numeric('cache_write_1h_tokens'); costMicroCents += numeric('cost_micro_cents');
    const createdAt = cells[indexes.created_at];
    if (!createdAt || Number.isNaN(Date.parse(createdAt))) throw new OpenCodeUsageError('invalid_csv', `Malformed OpenCode usage CSV: created_at at data row ${rowNumber} is invalid`);
    earliestCreatedAt = earliestCreatedAt === undefined || createdAt < earliestCreatedAt ? createdAt : earliestCreatedAt;
    latestCreatedAt = latestCreatedAt === undefined || createdAt > latestCreatedAt ? createdAt : latestCreatedAt;
  });
  return { status:'success', provider:'opencode-console', endpoint:OPENCODE_USAGE_EXPORT_PATH, range:request.range, scope:request.scope, windowSemantics:'console_export_midnight_utc', rowCount:rows.length-1, inputTokens, outputTokens, totalTokens:inputTokens+outputTokens, reasoningTokens, cacheReadTokens, cacheWrite5mTokens, cacheWrite1hTokens, costMicroCents, ...(earliestCreatedAt?{earliestCreatedAt}:{}), ...(latestCreatedAt?{latestCreatedAt}:{}), observedAt };
}

export function projectOpenCodeUsageToProviderSlot(aggregate: OpenCodeUsageAggregate): ProviderUsageSlot {
  return { quality:'provider_reported', source:`OpenCode Console usage export; range=${aggregate.range}; scope=${aggregate.scope}; window=midnight_utc_export`, observedAt:aggregate.observedAt, promptTokens:aggregate.inputTokens, completionTokens:aggregate.outputTokens, totalTokens:aggregate.totalTokens, unit:'tokens' };
}

function unavailableSlot(observedAt: string, source: string): ProviderUsageSlot {
  return { quality: 'unavailable', source, observedAt };
}

export async function observeOpenCodeUsage(transport: OpenCodeUsageExportTransport | undefined, request: OpenCodeUsageExportRequest, options: { now?: () => Date } = {}): Promise<OpenCodeUsageObservation> {
  const observedAt = (options.now?.() ?? new Date()).toISOString();
  const unavailableSource = `OpenCode Console usage export unavailable; range=${request.range}; scope=${request.scope}`;
  if (!transport) return { availability:'unavailable', error:{kind:'unconfigured',message:'OpenCode Console usage adapter is not configured'}, providerUsage:unavailableSlot(observedAt, unavailableSource) };
  try {
    const csv = await transport.exportCsv(buildOpenCodeUsageExportRequest(request));
    const aggregate = aggregateOpenCodeUsageCsv(csv, request, observedAt);
    return { availability:'available', aggregate, providerUsage:projectOpenCodeUsageToProviderSlot(aggregate) };
  } catch (error) {
    const kind = error instanceof OpenCodeUsageError ? error.kind : 'transport_error';
    const message = error instanceof Error ? error.message : String(error);
    return { availability:'unavailable', error:{kind,message}, providerUsage:unavailableSlot(observedAt, unavailableSource) };
  }
}
