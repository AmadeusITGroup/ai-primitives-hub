import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';

const entry = path.resolve(import.meta.dirname, '../dist/index.js');
const setup = (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'collection-action-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'collections'));
  fs.writeFileSync(path.join(root, 'test.prompt.md'), 'A test prompt');
  fs.writeFileSync(path.join(root, 'collections/test.collection.yml'), 'id: test\nname: Test\nauthor: test\nitems:\n  - path: test.prompt.md\n    kind: prompt\n');
  return root;
};
const run = (root, inputs = {}) => spawnSync(process.execPath, [entry], { cwd: root, encoding: 'utf8',
  env: { PATH: process.env.PATH, ...inputs, GITHUB_OUTPUT: path.join(root, 'outputs'), GITHUB_STEP_SUMMARY: path.join(root, 'summary') } });

test('the existing collection action retains its legacy invocation', (t) => {
  const root = setup(t);
  const result = run(root);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /All collections valid/);
});

test('the same action produces governance rule IDs, score, summary and outputs', (t) => {
  const root = setup(t);
  const result = run(root, { INPUT_GOVERNANCE: 'true', 'INPUT_MIN-SCORE': '100' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /verdict=fail\nscore=97\n/);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /COL006/);
  assert.match(result.stdout, /collection-validation-report/);
});

test('policy is handled by the shared engine rather than reimplemented in the action', (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'policy.yml'), 'rules:\n  COL006:\n    enabled: false\n    reason: Separate documentation review\n');
  const result = run(root, { 'INPUT_POLICY-PATH': 'policy.yml', 'INPUT_MIN-SCORE': '100' });
  assert.equal(result.status, 0, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /verdict=pass\nscore=100\n/);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /Separate documentation review/);
});

test('the bundled action runs standalone without provider workspace dependencies', (t) => {
  const root = setup(t);
  const standalone = path.join(root, 'action.mjs');
  fs.copyFileSync(entry, standalone);
  const result = spawnSync(process.execPath, [standalone], { cwd: root, encoding: 'utf8', env: { INPUT_GOVERNANCE: 'true' } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /COL006/);
});

test('the action fails closed and still reports an invalid mandatory-rule policy', (t) => {
  const root = setup(t);
  fs.writeFileSync(path.join(root, 'policy.yml'), 'rules:\n  COL005:\n    enabled: false\n');
  const result = run(root, { 'INPUT_POLICY-PATH': 'policy.yml' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /CFG003/);
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /verdict=fail/);
});

test('whitespace is not accepted as a zero score threshold', (t) => {
  const root = setup(t);
  const result = run(root, { 'INPUT_MIN-SCORE': '   ' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /CFG004/);
});

test('release checks opt into governance and fail unverified when repository context is missing', (t) => {
  const root = setup(t);
  const result = run(root, { 'INPUT_CHECK-RELEASES': 'true' });
  assert.equal(result.status, 1, result.stderr);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /COL002/);
  assert.match(fs.readFileSync(path.join(root, 'summary'), 'utf8'), /unverified/);
  assert.match(fs.readFileSync(path.join(root, 'outputs'), 'utf8'), /verdict=fail\nscore=97\n/);
});

test('repository input alone does not enable source access', (t) => {
  const root = setup(t);
  const result = run(root, { INPUT_GOVERNANCE: 'true', INPUT_REPOSITORY: 'owner/repo' });
  assert.equal(result.status, 0, result.stderr);
  // COL002 is listed under "Not checked", never as a finding row.
  assert.doesNotMatch(result.stdout, /\| COL002 \|/);
  assert.match(result.stdout, /Not checked/);
  assert.match(result.stdout, /Offline/);
});