import { describe, expect, it } from 'vitest';
import { hybridScore, lexicalTextScore } from '../src/index.js';

describe('lexical scoring behavior', () => {
  it('matches a Chinese query at token level without requiring the whole query substring', () => {
    const score = lexicalTextScore('今天又去喝咖啡了', '喜欢咖啡');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('matches a Japanese query with kana at token level without requiring the whole query substring', () => {
    const score = lexicalTextScore('朝はコーヒーを飲む', 'コーヒーが好き');
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(100);
  });

  it('keeps Latin words and CJK n-grams side by side for mixed text', () => {
    expect(lexicalTextScore('coffee と一緒に咖啡も飲んだ', 'coffee咖啡')).toBeGreaterThan(0);
  });

  it('preserves the existing English scoring behavior', () => {
    expect(lexicalTextScore('I brought a Kyoto gift home.', 'Kyoto gift')).toBe(126);
    expect(lexicalTextScore('I brought a Kyoto souvenir home.', 'Kyoto gift')).toBe(14);
  });

  it('keeps an exact-substring hit when the query has no eligible lexical tokens', () => {
    expect(lexicalTextScore('猫🐾', '🐾')).toBe(100);
  });
});

describe('hybrid scoring behavior', () => {
  it('does not rank a missing semantic vector above a known negative similarity', () => {
    const missing = hybridScore(0, undefined);
    const knownNegative = hybridScore(0, -0.3);
    expect(knownNegative).toBeGreaterThan(missing);
  });
});
