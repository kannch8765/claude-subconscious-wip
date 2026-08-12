import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  isExactDarioTouchRecord,
  stripeDarioTouchRecords,
  stripeHistoricalDarioTouchFile,
} from '../../scripts/stripe_historical_dariotouch.js';

function user(text: string) {
  return { type: 'user', uuid: `u-${text}`, message: { content: [{ type: 'text', text }] } };
}

function assistant(text: string) {
  return { type: 'assistant', uuid: `a-${text}`, message: { content: [{ type: 'text', text }] } };
}

test('recognizes only exact single-text DarioTouch records', () => {
  assert.equal(isExactDarioTouchRecord(user('🫳'), 'user'), true);
  assert.equal(isExactDarioTouchRecord(assistant('🫳'), 'assistant'), true);
  assert.equal(isExactDarioTouchRecord(user(' 🫳'), 'user'), false);
  assert.equal(isExactDarioTouchRecord(user('🫳!'), 'user'), false);
  assert.equal(isExactDarioTouchRecord({ type: 'user', message: { content: [{ type: 'text', text: '🫳' }, { type: 'text', text: 'x' }] } }, 'user'), false);
  assert.equal(isExactDarioTouchRecord({ type: 'assistant', message: { content: [{ type: 'text', text: '🫳' }, { type: 'tool_use', id: 't', name: 'Write', input: {} }] } }, 'assistant'), false);
});

test('stripes exact user/assistant pairs across positional placeholders only', () => {
  const original = [
    user('before'),
    user('🫳'),
    {},
    {},
    assistant('🫳'),
    assistant('after'),
  ];
  const { records, stats } = stripeDarioTouchRecords(original);
  assert.deepEqual(records, [user('before'), {}, {}, {}, {}, assistant('after')]);
  assert.deepEqual(stats, {
    records: 6,
    pairs_striped: 1,
    records_striped: 2,
    placeholders_seen_between_pairs: 2,
  });
});

test('does not stripe unpaired, reversed, interrupted, or non-exact hand records', () => {
  const cases = [
    [user('🫳'), assistant('normal')],
    [assistant('🫳'), user('🫳')],
    [user('🫳'), {}, user('other'), assistant('🫳')],
    [user('🫳'), {}, { type: 'assistant', message: { content: [{ type: 'text', text: '🫳' }, { type: 'text', text: 'extra' }] } }],
  ];
  for (const records of cases) {
    const result = stripeDarioTouchRecords(records);
    assert.deepEqual(result.records, records);
    assert.equal(result.stats.pairs_striped, 0);
  }
});

test('streaming file stripe preserves line count and non-matched bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dariotouch-stripe-'));
  try {
    const input = join(root, 'input.jsonl');
    const output = join(root, 'output.jsonl');
    const rows = [
      user('before'),
      user('🫳'),
      {},
      assistant('🫳'),
      user('🫳'),
      {},
      assistant('normal'),
      assistant('after'),
    ];
    const rawLines = rows.map((row, index) => index === 0 ? JSON.stringify(row, null, 0) : JSON.stringify(row));
    await writeFile(input, `${rawLines.join('\n')}\n`, 'utf8');

    const stats = await stripeHistoricalDarioTouchFile(input, output);
    const outputLines = (await readFile(output, 'utf8')).trimEnd().split('\n');

    assert.equal(outputLines.length, rawLines.length);
    assert.equal(outputLines[0], rawLines[0]);
    assert.equal(outputLines[1], '{}');
    assert.equal(outputLines[2], rawLines[2]);
    assert.equal(outputLines[3], '{}');
    assert.equal(outputLines[4], rawLines[4]);
    assert.equal(outputLines[5], rawLines[5]);
    assert.equal(outputLines[6], rawLines[6]);
    assert.equal(outputLines[7], rawLines[7]);
    assert.equal(stats.pairs_striped, 1);
    assert.equal(stats.records_striped, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('refuses in-place writes and existing outputs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dariotouch-stripe-'));
  try {
    const input = join(root, 'input.jsonl');
    const output = join(root, 'output.jsonl');
    await writeFile(input, `${JSON.stringify(user('🫳'))}\n`, 'utf8');
    await assert.rejects(() => stripeHistoricalDarioTouchFile(input, input), /in-place/);
    await writeFile(output, 'existing\n', 'utf8');
    await assert.rejects(() => stripeHistoricalDarioTouchFile(input, output), /overwrite/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
