import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'vitest';

import { stripeHistoricalDarioTouchBatch } from '../../scripts/stripe_historical_dariotouch_batch.js';

function row(type: 'user' | 'assistant', text: string) {
  return { type, uuid: `${type}-${text}`, message: { content: [{ type: 'text', text }] } };
}

async function writeJsonl(path: string, rows: unknown[]): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${rows.map((item) => JSON.stringify(item)).join('\n')}\n`, 'utf8');
}

test('batch mirrors trees, stripes strict pairs, writes complete manifest, and resumes by hashes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dariotouch-batch-'));
  try {
    const input = join(root, 'input');
    const output = join(root, 'output');
    await mkdir(join(input, 'nested'), { recursive: true });
    await writeJsonl(join(input, 'one.jsonl'), [row('user', '🫳'), {}, row('assistant', '🫳')]);
    await writeJsonl(join(input, 'nested', 'two.jsonl'), [row('user', '🫳'), row('assistant', 'normal')]);

    const first = await stripeHistoricalDarioTouchBatch(input, output);
    assert.equal(first.complete, true);
    assert.equal(first.summary.files_total, 2);
    assert.equal(first.summary.files_processed, 2);
    assert.equal(first.summary.files_skipped, 0);
    assert.equal(first.summary.pairs_striped, 1);
    assert.equal(first.summary.records_striped, 2);
    assert.equal(first.entries.length, 2);
    assert.equal((await readFile(join(output, 'one.jsonl'), 'utf8')).trim(), '{}\n{}\n{}');
    assert.match(await readFile(join(output, 'nested', 'two.jsonl'), 'utf8'), /normal/);

    const second = await stripeHistoricalDarioTouchBatch(input, output);
    assert.equal(second.complete, true);
    assert.equal(second.summary.files_processed, 0);
    assert.equal(second.summary.files_skipped, 2);
    assert.equal(second.summary.pairs_striped, 1);
    assert.equal(second.entries.length, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('batch refuses overlapping roots and ambiguous outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dariotouch-batch-'));
  try {
    const input = join(root, 'input');
    await mkdir(input, { recursive: true });
    await writeJsonl(join(input, 'one.jsonl'), [row('user', '🫳'), row('assistant', '🫳')]);
    await assert.rejects(() => stripeHistoricalDarioTouchBatch(input, join(input, 'out')), /disjoint/);

    const output = join(root, 'output');
    await mkdir(output, { recursive: true });
    await writeFile(join(output, 'one.jsonl'), 'orphan\n', 'utf8');
    await assert.rejects(() => stripeHistoricalDarioTouchBatch(input, output), /ambiguous existing output/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
