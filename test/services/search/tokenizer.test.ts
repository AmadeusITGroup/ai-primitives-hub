import * as assert from 'node:assert';
import {
  stem,
  tokenize,
} from '../../../src/services/search/tokenizer';

suite('Tokenizer', () => {
  test('lowercases and splits on non-word chars', () => {
    const out = tokenize('Hello, Terraform World!');
    assert.deepStrictEqual(out, ['hello', 'terraform', 'world']);
  });

  test('splits camelCase', () => {
    assert.deepStrictEqual(
      tokenize('reviewTerraformModule'),
      ['review', 'terraform', 'module']
    );
  });

  test('drops stopwords and very short tokens', () => {
    const out = tokenize('I am a Rust mentor for you');
    assert.ok(!out.includes('i'));
    assert.ok(!out.includes('a'));
    assert.ok(!out.includes('for'));
    assert.ok(out.includes('rust'));
    assert.ok(out.includes('mentor'));
  });

  test('returns [] on null/empty', () => {
    assert.deepStrictEqual(tokenize(''), []);
    assert.deepStrictEqual(tokenize(null as any), []);
    assert.deepStrictEqual(tokenize(undefined as any), []);
  });

  test('stem() strips common suffixes conservatively', () => {
    assert.strictEqual(stem('reviewers'), 'review');
    assert.strictEqual(stem('reviewing'), 'review');
    assert.strictEqual(stem('code'), 'code');
    assert.strictEqual(stem('rs'), 'rs');
  });

  test('keepStopwords honours caller intent', () => {
    const out = tokenize('for the module', { keepStopwords: true, stem: false });
    assert.ok(out.includes('for'));
    assert.ok(out.includes('the'));
  });
});
