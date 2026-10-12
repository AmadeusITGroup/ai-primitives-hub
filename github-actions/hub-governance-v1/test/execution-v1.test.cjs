const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { publishValidationV1, runValidationV1 } = require('../run-v1.cjs');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-action-v1-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { SUBJECT: 'hub', CONFIG_PATH: 'hub-config.yml', REPORT_DIR: dir, WORKING_DIRECTORY: dir, GITHUB_OUTPUT: path.join(dir, 'outputs'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary') };
  return { dir, env };
}

test('publishes a failing summary when provider installation never completed', (t) => {
  const { dir, env } = fixture(t);
  assert.equal(publishValidationV1(env), 1);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /verdict=fail\nscore=\nexit-code=1/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*FAIL\*\*/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^<!-- hub-validation-report -->/);
});

test('publishes the actual provider report for a successful validation', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'ok', data: { schemaVersion: 1, subject: 'hub', verdict: 'pass', score: 100 } }));
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '0\n');
  fs.writeFileSync(path.join(dir, 'report.md'), '<!-- hub-validation-report -->\nPASS\n');
  assert.equal(publishValidationV1(env), 0);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /verdict=pass\nscore=100\nexit-code=0/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /PASS/);
});

test('fails closed for malformed JSON instead of returning an empty success', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), '{}');
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '0\n');
  assert.equal(publishValidationV1(env), 1);
});

test('a nonzero CLI exit is authoritative even if the JSON says pass', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'ok', data: { schemaVersion: 1, subject: 'hub', verdict: 'pass', score: 100 } }));
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '1\n');
  fs.writeFileSync(path.join(dir, 'report.md'), '<!-- hub-validation-report -->\nPASS\n');
  assert.equal(publishValidationV1(env), 1);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*FAIL\*\*/);
});

test('only executes the installed provider and does not inherit tokens or NODE_OPTIONS', (t) => {
  const { dir, env } = fixture(t);
  const launcher = path.join(dir, 'tools/node_modules/@ai-primitives-hub/cli/bin/ai-primitives-hub-governance-v1.js');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  // Fake the external installed binary, not the production runner under test.
  fs.writeFileSync(launcher, 'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), token: process.env.GITHUB_TOKEN, options: process.env.NODE_OPTIONS }));');
  assert.equal(runValidationV1({ ...env, GITHUB_TOKEN: 'test-secret', NODE_OPTIONS: '--invalid-option' }), 0);
  const result = JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8'));
  assert.equal(result.token, undefined);
  assert.equal(result.options, undefined);
  assert.deepEqual(result.args.slice(0, 4), ['hub', 'validate', '--output', 'json']);
});