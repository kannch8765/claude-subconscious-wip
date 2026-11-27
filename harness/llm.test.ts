import { describe, expect, it } from 'vitest';
import { requestJson } from './llm.js';

describe('requestJson', () => {
  it('replaces a half emoji left by a cut string, keeps whole ones, and stays valid JSON', () => {
    const cut = 'ok 🐱'.slice(0, 4);
    const json = requestJson({ messages: [{ role: 'user', content: cut }, { role: 'user', content: '完整 🐱' }], n: 1 });
    expect(json).not.toMatch(/\\ud[89ab][0-9a-f]{2}/i);
    expect(JSON.parse(json).messages[0].content).toBe('ok �');
    expect(JSON.parse(json).messages[1].content).toBe('完整 🐱');
    expect(requestJson({ s: '\uDC31x' })).toBe(JSON.stringify({ s: '�x' }));
  });
});
