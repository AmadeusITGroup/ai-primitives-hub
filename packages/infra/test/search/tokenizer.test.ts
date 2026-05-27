import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  stem,
  tokenize,
} from '../../src/search/tokenizer';

describe('tokenizer', () => {
  it('lowercases and splits on non-word chars', () => {
    const out = tokenize('Hello, Terraform World!');
    expect(out).toStrictEqual(['hello', 'terraform', 'world']);
  });

  it('splits camelCase', () => {
    expect(tokenize('reviewTerraformModule')).toStrictEqual(['review', 'terraform', 'module']);
  });

  it('drops stopwords and very short tokens', () => {
    const out = tokenize('I am a Rust mentor for you');
    expect(out.includes('i')).toBe(false);
    expect(out.includes('a')).toBe(false);
    expect(out.includes('for')).toBe(false);
    expect(out.includes('rust')).toBe(true);
    expect(out.includes('mentor')).toBe(true);
  });

  it('returns [] on null/empty', () => {
    expect(tokenize('')).toStrictEqual([]);
    expect(tokenize(null as any)).toStrictEqual([]);
    expect(tokenize(undefined as any)).toStrictEqual([]);
  });

  it('stem() strips common suffixes conservatively', () => {
    expect(stem('reviewers')).toBe('review');
    expect(stem('reviewing')).toBe('review');
    expect(stem('code')).toBe('code');
    expect(stem('rs')).toBe('rs');
  });

  it('keepStopwords honours caller intent', () => {
    const out = tokenize('for the module', { keepStopwords: true, stem: false });
    expect(out.includes('for')).toBe(true);
    expect(out.includes('the')).toBe(true);
  });
});
