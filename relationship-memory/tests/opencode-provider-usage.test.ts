import { describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import {
  aggregateOpenCodeUsageCsv, buildOpenCodeUsageExportRequest, composeSubconsciousAdminSnapshot,
  observeOpenCodeUsage, projectOpenCodeUsageToProviderSlot, RelationshipMemoryOwnerControlPlane,
  RelationshipMemoryStore, type LettaReadTransport, type OpenCodeUsageExportTransport,
} from '../src/index.js';

const HEADER = 'id,user_email,service_account_name,app,provider,model,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_5m_tokens,cache_write_1h_tokens,reasoning_mode,reasoning_effort,reasoning_budget_tokens,reasoning_source,billing_source,cost_micro_cents,created_at';
const CSV = `${HEADER}\n1,synthetic@example.invalid,fixture,tests,opencode,deepseek-v4-flash,100,20,5,60,7,3,disabled,,,fixture,free,0,2026-08-08T00:01:00Z\n2,synthetic@example.invalid,fixture,tests,opencode,deepseek-v4-flash,40,10,2,20,1,4,disabled,,,fixture,managed-inference,25000000,2026-08-08T04:00:00Z\n`;

class CsvTransport implements OpenCodeUsageExportTransport {
  constructor(private readonly csv: string | Error) {}
  async exportCsv(): Promise<string> { if (this.csv instanceof Error) throw this.csv; return this.csv; }
}
class AdminTransport implements LettaReadTransport {
  async getJson<T>(path: string): Promise<T> {
    const f: Record<string, unknown> = {'/agents/a':{id:'a'},'/agents/a/context':{context_window_size_current:0,context_window_size_max:100},'/runs/active':[],'/runs/':[]};
    if (!(path in f)) throw new Error(`missing fixture ${path}`); return f[path] as T;
  }
}

describe('OpenCode Console provider usage adapter', () => {
  it('validates and encodes documented ranges/scopes exactly', () => {
    expect(buildOpenCodeUsageExportRequest({range:'7d',scope:'organization'}).query.toString()).toBe('scope=organization&range=7d');
    expect(buildOpenCodeUsageExportRequest({range:'24h',scope:'member',userEmail:'synthetic@example.invalid'}).query.toString()).toBe('scope=member&range=24h&user_email=synthetic%40example.invalid');
    expect(buildOpenCodeUsageExportRequest({range:'30d',scope:'service_account',serviceAccountId:'svcacct_fixture'}).query.toString()).toBe('scope=service_account&range=30d&service_account_id=svcacct_fixture');
    expect(buildOpenCodeUsageExportRequest({range:'7d',scope:'model',provider:'opencode',model:'deepseek-v4-flash'}).query.toString()).toBe('scope=model&range=7d&provider=opencode&model=deepseek-v4-flash');
    expect(() => buildOpenCodeUsageExportRequest({range:'5h',scope:'organization'} as never)).toThrow(/range/);
  });

  it('aggregates tokens/cache/reasoning/cost without double-counting reasoning', () => {
    const a = aggregateOpenCodeUsageCsv(CSV,{range:'7d',scope:'organization'},'2026-08-08T05:00:00Z');
    expect(a).toMatchObject({rowCount:2,inputTokens:140,outputTokens:30,totalTokens:170,reasoningTokens:7,cacheReadTokens:80,cacheWrite5mTokens:8,cacheWrite1hTokens:7,costMicroCents:25000000});
  });

  it('distinguishes successful empty export from unavailable telemetry', async () => {
    const ok = await observeOpenCodeUsage(new CsvTransport(''),{range:'24h',scope:'organization'});
    expect(ok.availability).toBe('available'); if (ok.availability === 'available') expect(ok.aggregate).toMatchObject({rowCount:0,totalTokens:0});
    const missing = await observeOpenCodeUsage(undefined,{range:'24h',scope:'organization'});
    expect(missing).toMatchObject({availability:'unavailable',providerUsage:{quality:'unavailable'}}); expect(missing.providerUsage.totalTokens).toBeUndefined();
  });

  it('rejects malformed numeric telemetry instead of coercing it to zero', async () => {
    const bad = CSV.replace(',100,20,',',bad,20,');
    expect(() => aggregateOpenCodeUsageCsv(bad,{range:'7d',scope:'organization'})).toThrow(/input_tokens/);
    const result = await observeOpenCodeUsage(new CsvTransport(bad),{range:'7d',scope:'organization'});
    expect(result).toMatchObject({availability:'unavailable',error:{kind:'invalid_csv'},providerUsage:{quality:'unavailable'}});
  });

  it('projects provider-reported Console windows, never Go quota semantics', () => {
    for (const range of ['24h','7d','30d'] as const) {
      const a = aggregateOpenCodeUsageCsv(CSV,{range,scope:'organization'},'2026-08-08T05:00:00Z'); const slot = projectOpenCodeUsageToProviderSlot(a);
      expect(a.windowSemantics).toBe('console_export_midnight_utc'); expect(slot.quality).toBe('provider_reported'); expect(slot.source).toContain(`range=${range}`); expect(slot.source).toContain('midnight_utc_export');
      expect(slot.remaining).toBeUndefined(); expect(slot.limit).toBeUndefined(); expect(slot.totalTokens).toBe(170);
    }
  });

  it('does not serialize service-account credentials in failed observations', async () => {
    const credential = 'fixture-service-credential-value'; const oldFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('denied',{status:401})) as typeof fetch;
    try {
      const {FetchOpenCodeUsageExportTransport} = await import('../src/index.js');
      const result = await observeOpenCodeUsage(new FetchOpenCodeUsageExportTransport(credential),{range:'7d',scope:'organization'});
      expect(JSON.stringify(result)).not.toContain(credential); expect(result.availability).toBe('unavailable');
    } finally { globalThis.fetch = oldFetch; }
  });

  it('survives 093F composition unchanged through dependency injection', async () => {
    const slot = projectOpenCodeUsageToProviderSlot(aggregateOpenCodeUsageCsv(CSV,{range:'7d',scope:'model',provider:'opencode',model:'deepseek-v4-flash'},'2026-08-08T05:00:00Z'));
    const dir = fs.mkdtempSync(`${os.tmpdir()}/rm-093g-`);
    try {
      const owner = new RelationshipMemoryOwnerControlPlane(new RelationshipMemoryStore(dir,'subject'));
      const snapshot = await composeSubconsciousAdminSnapshot({owner,transport:new AdminTransport(),agentId:'a',providerUsage:slot,now:()=>new Date('2026-08-08T05:00:00Z')});
      expect(snapshot.runtime.overview.providerUsage).toEqual(slot);
    } finally { fs.rmSync(dir,{recursive:true,force:true}); }
  });
});
