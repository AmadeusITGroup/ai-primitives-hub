import * as assert from 'node:assert';
import {
  Bm25Engine,
  type Bm25Doc,
} from '../../../src/services/search/bm25-engine';
import {
  tokenize,
} from '../../../src/services/search/tokenizer';

function makeDoc(id: string, title: string, tags: string[], description: string, bodyPreview: string): Bm25Doc {
  return {
    id,
    fields: {
      title: tokenize(title),
      tags: tags.flatMap((t) => tokenize(t)),
      description: tokenize(description),
      bodyPreview: tokenize(bodyPreview),
    },
  };
}

suite('Bm25Engine', () => {
  test('returns empty scores for empty query', () => {
    const engine = new Bm25Engine([
      makeDoc('1', 'Rust Mentor', ['rust'], 'A Rust mentoring prompt', 'Help with Rust code'),
    ]);
    const { scores } = engine.score([]);
    assert.strictEqual(scores.size, 0);
  });

  test('returns empty scores for empty corpus', () => {
    const engine = new Bm25Engine([]);
    const { scores } = engine.score(tokenize('rust'));
    assert.strictEqual(scores.size, 0);
  });

  test('scores relevant documents higher than irrelevant ones', () => {
    const docs = [
      makeDoc('1', 'Rust Code Review', ['rust', 'review'], 'Review Rust code', 'Check Rust best practices'),
      makeDoc('2', 'Python Testing', ['python', 'test'], 'Test Python code', 'Write Python unit tests'),
    ];
    const engine = new Bm25Engine(docs);
    const { scores } = engine.score(tokenize('rust'));
    assert.ok(scores.get(0)! > 0);
    assert.ok(!scores.has(1) || scores.get(1)! === 0 || scores.get(0)! > scores.get(1)!);
  });

  test('size returns document count', () => {
    const docs = [
      makeDoc('1', 'A', [], 'desc', 'body'),
      makeDoc('2', 'B', [], 'desc', 'body'),
      makeDoc('3', 'C', [], 'desc', 'body'),
    ];
    const engine = new Bm25Engine(docs);
    assert.strictEqual(engine.size, 3);
  });

  test('explain mode attaches match explanations', () => {
    const docs = [
      makeDoc('1', 'Rust Mentor', ['rust'], 'A Rust mentoring prompt', 'Help with Rust code'),
    ];
    const engine = new Bm25Engine(docs);
    const { explanations } = engine.score(tokenize('rust'), undefined, true);
    assert.ok(explanations);
    const expl = explanations!.get(0);
    assert.ok(expl);
    assert.ok(expl!.length > 0);
  });

  test('candidate set restricts scoring', () => {
    const docs = [
      makeDoc('1', 'Rust A', ['rust'], 'desc', 'body'),
      makeDoc('2', 'Rust B', ['rust'], 'desc', 'body'),
    ];
    const engine = new Bm25Engine(docs);
    const candidates = new Set([0]);
    const { scores } = engine.score(tokenize('rust'), candidates);
    assert.ok(scores.has(0));
    assert.ok(!scores.has(1));
  });

  test('is deterministic across runs', () => {
    const docs = [
      makeDoc('1', 'Rust Code Review', ['rust'], 'Review Rust', 'Check Rust'),
      makeDoc('2', 'Python Testing', ['python'], 'Test Python', 'Write Python tests'),
      makeDoc('3', 'Rust Testing', ['rust', 'test'], 'Test Rust', 'Write Rust tests'),
    ];
    const engineA = new Bm25Engine(docs);
    const engineB = new Bm25Engine(docs);
    const scoresA = engineA.score(tokenize('rust'));
    const scoresB = engineB.score(tokenize('rust'));
    assert.deepStrictEqual([...scoresA.scores.entries()].toSorted(), [...scoresB.scores.entries()].toSorted());
  });
});
