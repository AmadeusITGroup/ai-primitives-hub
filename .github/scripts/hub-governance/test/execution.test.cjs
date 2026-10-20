const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const { publishValidation } = require('../run.cjs');
const root = path.resolve(__dirname, '../../../..');
const yaml = createRequire(path.join(root, 'packages/infra/package.json'))('js-yaml');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/hub-governance.yml'), 'utf8'));
const validation = workflow.jobs.validate.steps.find((step) => step.id === 'run');

// Exercise the actual workflow shell and helper against a fake installed CLI boundary.
function executeValidation(env) {
  return spawnSync('bash', ['-c', validation.run], {
    encoding: 'utf8', cwd: env.WORKING_DIRECTORY, env: {
      PATH: process.env.PATH, POLICY_PATH: '', MIN_SCORE: '', COLLECTION_FILE: '',
      BASE_REF: '', HEAD_REF: '', SCOPE_FILE: '',
      SKILLS_DIR: 'skills', CHECK_SOURCES: 'false', CHECK_RELEASES: 'false', REPOSITORY: '',
      ...Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)),
      PROVIDER_SCRIPT_PATH: path.resolve(__dirname, '..')
    }
  });
}

function runValidation(env) {
  return executeValidation(env).status ?? 1;
}

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'governance-workflow-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { SUBJECT: 'hub', CONFIG_PATH: 'hub-config.yml', REPORT_DIR: dir, WORKING_DIRECTORY: dir, GITHUB_OUTPUT: path.join(dir, 'outputs'), GITHUB_STEP_SUMMARY: path.join(dir, 'summary') };
  return { dir, env };
}

function installedProvider(t) {
  const { dir, env } = fixture(t);
  const launcher = path.join(dir, 'tools/node_modules/@ai-primitives-hub/cli/bin/ai-primitives-hub.js');
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  // Probe the external CLI boundary without writing credential values to its output.
  fs.writeFileSync(launcher, `process.stdout.write(JSON.stringify({
    args: process.argv.slice(2),
    githubTokenPresent: 'GITHUB_TOKEN' in process.env,
    ghTokenPresent: 'GH_TOKEN' in process.env,
    ghTokenIsExplicit: process.env.GH_TOKEN === 'explicit-test-token',
    sourceTokenPresent: 'SOURCE_TOKEN' in process.env,
    nodeOptionsPresent: 'NODE_OPTIONS' in process.env,
    nodePathPresent: 'NODE_PATH' in process.env,
    ghCliDisabled: process.env.AI_PRIMITIVES_HUB_DISABLE_GH_CLI === '1'
  }));`);
  return { dir, env, result: () => JSON.parse(fs.readFileSync(path.join(dir, 'result.json'), 'utf8')) };
}

const ambientCredentials = {
  GITHUB_TOKEN: 'ambient-github-test-token',
  GH_TOKEN: 'ambient-gh-test-token',
  NODE_OPTIONS: '--invalid-option',
  NODE_PATH: '/untrusted/modules'
};

test('passes exact comparison commits literally to the standard Hub CLI', (t) => {
  const { env, result } = installedProvider(t);
  const base = 'a'.repeat(40);
  const head = 'b'.repeat(40);
  assert.equal(runValidation({ ...env, BASE_REF: base, HEAD_REF: head }), 0);
  const args = result().args;
  assert.equal(args[args.indexOf('--base-ref') + 1], base);
  assert.equal(args[args.indexOf('--head-ref') + 1], head);
});

test('passes a scope path literally without executing its content', (t) => {
  const { dir, env, result } = installedProvider(t);
  const selector = 'scope $(touch should-not-exist).json';
  assert.equal(runValidation({ ...env, SCOPE_FILE: selector }), 0);
  const args = result().args;
  assert.equal(args[args.indexOf('--scope-file') + 1], selector);
  assert.equal(fs.existsSync(path.join(dir, 'should-not-exist')), false);
});

test('rejects Hub scope arguments for other subjects before starting the CLI', (t) => {
  const { dir, env } = installedProvider(t);
  const execution = executeValidation({ ...env, SUBJECT: 'skill', SCOPE_FILE: 'scope.json' });
  assert.notEqual(execution.status, 0);
  assert.match(execution.stderr, /hub validation only/);
  assert.equal(fs.existsSync(path.join(dir, 'result.json')), false);
});

test('publishes a failing summary when provider installation never completed', (t) => {
  const { dir, env } = fixture(t);
  assert.equal(publishValidation(env), 1);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /verdict=fail\nscore=\nexit-code=1/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*FAIL\*\*/);
  assert.match(fs.readFileSync(path.join(dir, 'report.md'), 'utf8'), /^<!-- hub-validation-report -->/);
});

test('publishes the actual provider report for a successful validation', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'ok', data: { schemaVersion: 1, subject: 'hub', verdict: 'pass', score: 100 } }));
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '0\n');
  fs.writeFileSync(path.join(dir, 'report.md'), '<!-- hub-validation-report -->\nPASS\n');
  assert.equal(publishValidation(env), 0);
  assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /verdict=pass\nscore=100\nexit-code=0/);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /PASS/);
});

test('fails closed for malformed JSON instead of returning an empty success', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), '{}');
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '0\n');
  assert.equal(publishValidation(env), 1);
});

test('a nonzero CLI exit is authoritative even if the JSON says pass', (t) => {
  const { dir, env } = fixture(t);
  fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ status: 'ok', data: { schemaVersion: 1, subject: 'hub', verdict: 'pass', score: 100 } }));
  fs.writeFileSync(path.join(dir, 'exit-code.txt'), '1\n');
  fs.writeFileSync(path.join(dir, 'report.md'), '<!-- hub-validation-report -->\nPASS\n');
  assert.equal(publishValidation(env), 1);
  assert.match(fs.readFileSync(env.GITHUB_STEP_SUMMARY, 'utf8'), /\*\*FAIL\*\*/);
});

for (const subject of ['hub', 'collection', 'skill']) {
  for (const check of [undefined, 'false']) {
    test(`${subject} offline validation strips explicit and ambient credentials (${check ?? 'default'})`, (t) => {
      const { dir, env, result } = installedProvider(t);
      assert.equal(runValidation({
        ...env, ...ambientCredentials, SUBJECT: subject, SKILLS_DIR: 'skills',
        CHECK_SOURCES: check, CHECK_RELEASES: check, SOURCE_TOKEN: 'explicit-test-token'
      }), 0);
      const observed = result();
      assert.deepEqual(observed, {
        args: [subject, 'validate', '--governance', '--output', 'json', '--report-path', path.join(dir, 'report.md'),
          ...(subject === 'hub' ? ['--config', 'hub-config.yml'] : []),
          ...(subject === 'skill' ? ['--skills-dir', 'skills'] : [])],
        githubTokenPresent: false, ghTokenPresent: false, ghTokenIsExplicit: false,
        sourceTokenPresent: false, nodeOptionsPresent: false, nodePathPresent: false,
        ghCliDisabled: true
      });
    });
  }
}

for (const [subject, inputs] of [
  ['hub', {}],
  ['hub', { CHECK_SOURCES: 'true' }],
  ['collection', { CHECK_RELEASES: 'true', REPOSITORY: 'owner/repo' }]
]) {
  test(`${subject} disables host gh login fallback (${Object.keys(inputs).join(', ') || 'offline'})`, (t) => {
    const { env, result } = installedProvider(t);
    assert.equal(runValidation({
      ...env, ...inputs, SUBJECT: subject,
      PATH: process.env.PATH, HOME: process.env.HOME,
      AI_PRIMITIVES_HUB_DISABLE_GH_CLI: '0'
    }), 0);
    assert.equal(result().ghCliDisabled, true);
    assert.equal(result().ghTokenPresent, false);
  });
}

for (const [subject, flag, checks] of [
  ['hub', '--check-sources', { CHECK_SOURCES: 'true' }],
  ['collection', '--check-releases', { CHECK_RELEASES: 'true', REPOSITORY: 'owner/repo' }]
]) {
  test(`${subject} forwards its opt-in check and only the explicit source token`, (t) => {
    const { env, result } = installedProvider(t);
    assert.equal(runValidation({ ...env, ...ambientCredentials, ...checks, SUBJECT: subject, SOURCE_TOKEN: 'explicit-test-token' }), 0);
    const observed = result();
    assert.ok(observed.args.includes(flag));
    assert.ok(!observed.args.includes(subject === 'hub' ? '--check-releases' : '--check-sources'));
    if (subject === 'collection') {
      const repositoryIndex = observed.args.indexOf('--repository');
      assert.ok(repositoryIndex >= 0);
      assert.equal(observed.args[repositoryIndex + 1], 'owner/repo');
    } else {
      assert.ok(!observed.args.includes('--repository'));
    }
    assert.equal(observed.ghTokenPresent, true);
    assert.equal(observed.ghTokenIsExplicit, true);
    assert.equal(observed.githubTokenPresent, false);
    assert.equal(observed.sourceTokenPresent, false);
    assert.equal(observed.nodeOptionsPresent, false);
    assert.equal(observed.nodePathPresent, false);
  });

  for (const sourceToken of [undefined, '']) {
    test(`${subject} opt-in checks never fall back to ambient credentials (${sourceToken === '' ? 'empty' : 'absent'} token)`, (t) => {
      const { env, result } = installedProvider(t);
      assert.equal(runValidation({ ...env, ...ambientCredentials, ...checks, SUBJECT: subject, SOURCE_TOKEN: sourceToken }), 0);
      assert.ok(result().args.includes(flag));
      assert.equal(result().ghTokenPresent, false);
      assert.equal(result().githubTokenPresent, false);
      assert.equal(result().sourceTokenPresent, false);
      assert.equal(result().nodeOptionsPresent, false);
      assert.equal(result().nodePathPresent, false);
    });
  }
}

test('an explicitly selected collection repository does not enable network checks or credentials', (t) => {
  const { env, result } = installedProvider(t);
  assert.equal(runValidation({ ...env, ...ambientCredentials, SUBJECT: 'collection', REPOSITORY: 'owner/repo', SOURCE_TOKEN: 'explicit-test-token' }), 0);
  const observed = result();
  const repositoryIndex = observed.args.indexOf('--repository');
  assert.ok(repositoryIndex >= 0);
  assert.equal(observed.args[repositoryIndex + 1], 'owner/repo');
  assert.ok(!observed.args.includes('--check-releases'));
  assert.ok(!observed.args.includes('--check-sources'));
  assert.equal(observed.ghTokenPresent, false);
  assert.equal(observed.githubTokenPresent, false);
  assert.equal(observed.sourceTokenPresent, false);
});

for (const [subject, inputs, flag] of [
  ['hub', { CHECK_RELEASES: 'true' }, '--check-releases'],
  ['collection', { CHECK_SOURCES: 'true' }, '--check-sources'],
  ['skill', { CHECK_SOURCES: 'true' }, '--check-sources'],
  ['skill', { CHECK_RELEASES: 'true' }, '--check-releases'],
  ['hub', { CHECK_SOURCES: 'true', CHECK_RELEASES: 'true' }, '--check-releases'],
  ['collection', { CHECK_SOURCES: 'true', CHECK_RELEASES: 'true' }, '--check-sources'],
  ['hub', { REPOSITORY: 'owner/repo' }, '--repository'],
  ['skill', { REPOSITORY: 'owner/repo' }, '--repository']
]) {
  test(`${subject} fails closed for unsupported ${flag} (${Object.keys(inputs).join(', ')})`, (t) => {
    const { dir, env } = installedProvider(t);
    const execution = executeValidation({ ...env, ...inputs, SUBJECT: subject, SOURCE_TOKEN: 'explicit-test-token' });
    assert.notEqual(execution.status, 0);
    assert.ok(execution.stderr.includes(flag));
    assert.ok(!execution.stderr.includes('explicit-test-token'));
    assert.equal(fs.existsSync(path.join(dir, 'result.json')), false, 'The installed CLI must not run for an invalid subject/check combination');
    assert.equal(publishValidation({ ...env, SUBJECT: subject }), 1);
    assert.match(fs.readFileSync(env.GITHUB_OUTPUT, 'utf8'), /verdict=fail\nscore=\nexit-code=1/);
  });
}

for (const subject of ['hub', 'collection', 'skill']) {
  test(`${subject} passes policy, threshold and paths literally through the workflow shell`, (t) => {
    const { dir, env, result } = installedProvider(t);
    const literal = 'folder with spaces/$(touch should-not-exist); file.yml';
    assert.equal(runValidation({
      ...env, SUBJECT: subject, CONFIG_PATH: literal, POLICY_PATH: literal,
      COLLECTION_FILE: literal, SKILLS_DIR: literal, MIN_SCORE: '99'
    }), 0);
    const args = result().args;
    assert.equal(args[args.indexOf('--policy') + 1], literal);
    assert.equal(args[args.indexOf('--min-score') + 1], '99');
    const selection = { hub: '--config', collection: '--collection-file', skill: '--skills-dir' }[subject];
    assert.equal(args[args.indexOf(selection) + 1], literal);
    assert.equal(fs.existsSync(path.join(dir, 'should-not-exist')), false);
  });
}