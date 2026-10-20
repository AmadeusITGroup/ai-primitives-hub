const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const { runInNewContext } = require('node:vm');
// Reuse the provider's existing YAML parser; no new workspace dependency is needed.
const yaml = createRequire(path.resolve(__dirname, '../../../../packages/infra/package.json'))('js-yaml');
const root = path.resolve(__dirname, '../../../..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/hub-governance.yml'), 'utf8'));

test('the workflow invokes standard CLI validation without a separate governance action', () => {
  assert.equal(fs.existsSync(path.join(root, 'github-actions/hub-governance/action.yml')), false);
  const steps = workflow.jobs.validate.steps;
  assert.ok(steps.find((step) => step.id === 'install' && /npm install/.test(step.run)));
  const validation = steps.find((step) => step.id === 'run');
  assert.match(validation?.run ?? '', /ai-primitives-hub "\$SUBJECT" validate --governance/);
  assert.ok(steps.find((step) => step.id === 'validation' && /run\.cjs" publish/.test(step.run)));
  assert.ok(!steps.some((step) => step.uses?.includes('hub-governance')));
});

test('the callable workflow requires explicit provider and CLI releases', () => {
  assert.equal(workflow.on.workflow_call.inputs['provider-ref'].required, true);
  assert.equal(workflow.on.workflow_call.inputs['cli-version'].required, true);
  assert.equal(workflow.on.workflow_call.inputs['post-comment'].default, false);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses && !step.uses.startsWith('./')) {
        assert.match(step.uses, /@[a-f0-9]{40}$/, `${step.name} must use an immutable action reference`);
      }
    }
  }
});

test('keeps the reusable input/output contract and provider CI script paths', () => {
  assert.deepEqual(Object.keys(workflow.on.workflow_call.inputs).sort(), [
    'provider-ref', 'cli-version', 'subject', 'config-path', 'policy-path', 'min-score',
    'base-ref', 'head-ref', 'scope-file',
    'collection-file', 'skills-dir', 'check-sources', 'check-releases', 'repository', 'runner', 'post-comment'
  ].sort());
  assert.deepEqual(Object.keys(workflow.on.workflow_call.outputs).sort(), ['exit-code', 'score', 'verdict']);
  assert.deepEqual(Object.keys(workflow.on.workflow_call.secrets), ['source-token']);
  const provider = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/governance-provider.yml'), 'utf8'));
  for (const event of ['push', 'pull_request']) {
    assert.ok(provider.on[event].paths.includes('.github/scripts/hub-governance/**'));
    assert.ok(!provider.on[event].paths.includes('github-actions/hub-governance/**'));
  }
  assert.ok(provider.jobs['provider-tests'].steps.some((step) => step.run === 'node --test .github/scripts/hub-governance/test/*.test.cjs'));
  const comment = workflow.jobs.report.steps.find((step) => step.uses?.startsWith('actions/github-script@'));
  assert.match(comment.with.script, /require\('\.\/\.github\/scripts\/hub-governance\/post-comment\.cjs'\)/);
  assert.match(comment.with.script, /github.rest.pulls.get/);
});

for (const [validationResult, exitCode, reportResult, expected] of [
  ['success', '0', 'skipped', 0],
  ['success', '0', 'success', 0],
  ['success', '', 'skipped', 1],
  ['success', '1', 'success', 1],
  ['failure', '0', 'skipped', 1],
  ['cancelled', '0', 'skipped', 1],
  ['success', '0', 'failure', 1],
  ['success', '0', 'cancelled', 1]
]) {
  test(`actual gate shell enforces validation=${validationResult}, exit=${exitCode || 'missing'}, report=${reportResult}`, () => {
    const gate = workflow.jobs.gate.steps[0];
    const result = spawnSync('bash', ['-c', gate.run], {
      encoding: 'utf8', env: { PATH: process.env.PATH, VALIDATION_RESULT: validationResult, EXIT_CODE: exitCode, REPORT_RESULT: reportResult }
    });
    assert.equal(result.status, expected, result.stderr);
  });
}

test('only the separate reporting job can write to pull requests', () => {
  assert.deepEqual(workflow.jobs.validate.permissions, { contents: 'read' });
  assert.equal(workflow.jobs.report.permissions['pull-requests'], 'write');
  assert.deepEqual(workflow.jobs.gate.permissions, {});
  assert.match(workflow.jobs.report.if, /head.repo.full_name == github.repository/);
  assert.match(workflow.jobs.report.if, /github.event_name == 'pull_request'/);
  const checkouts = workflow.jobs.report.steps.filter((step) => step.uses?.startsWith('actions/checkout@'));
  assert.equal(checkouts.length, 1);
  assert.equal(checkouts[0].with.repository, 'AmadeusITGroup/ai-primitives-hub');
  assert.equal(checkouts[0].with['persist-credentials'], false);
});

test('enforces the gate only after validation and optional reporting have finished', () => {
  assert.deepEqual(workflow.jobs.gate.needs, ['validate', 'report']);
  assert.equal(workflow.jobs.gate.if, 'always()');
  const steps = workflow.jobs.validate.steps;
  assert.equal(steps.find((step) => step.id === 'install')['continue-on-error'], true);
  assert.equal(steps.find((step) => step.id === 'run')['continue-on-error'], true);
  assert.equal(steps.find((step) => step.id === 'validation').if, "always() && steps.prepare.outcome == 'success'");
  assert.equal(workflow.jobs.validate.outputs['exit-code'], '${{ steps.validation.outputs.exit-code }}');
  const artifact = steps.find((step) => step.uses?.startsWith('actions/upload-artifact@'));
  assert.equal(artifact.if, "always() && steps.validation.outputs.report-path != ''");
  assert.equal(artifact.with.name, 'governance-${{ inputs.subject }}');
  assert.match(artifact.with.path, /steps.validation.outputs.report-path/);
  assert.match(artifact.with.path, /steps.validation.outputs.result-path/);
  assert.equal(artifact.with['if-no-files-found'], 'error');
});

test('consumer content is never executed with provider setup or write permissions', () => {
  const install = workflow.jobs.validate.steps.find((step) => step.id === 'install');
  assert.match(install.run, /--ignore-scripts/);
  assert.match(install.run, /--prefix "\$REPORT_DIR\/tools"/);
  assert.match(install.run, /--registry=https:\/\/registry.npmjs.org/);
  assert.equal(install.env.NPM_CONFIG_USERCONFIG, '/dev/null');
  assert.equal(install['working-directory'], '${{ runner.temp }}');
  for (const step of workflow.jobs.validate.steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
    assert.equal(step.with['persist-credentials'], false);
  }
});

test('network checks and repository selection are explicit workflow inputs with offline defaults', () => {
  for (const input of ['check-sources', 'check-releases']) {
    assert.equal(workflow.on.workflow_call.inputs[input]?.type, 'boolean');
    assert.equal(workflow.on.workflow_call.inputs[input]?.default, false);
  }
  assert.equal(workflow.on.workflow_call.inputs.repository?.type, 'string');
  assert.equal(workflow.on.workflow_call.inputs.repository?.default, '');
  assert.equal(workflow.on.workflow_call.secrets?.['source-token']?.required, false);
  const validation = workflow.jobs.validate.steps.find((step) => step.id === 'run');
  for (const [key, input] of Object.entries({ CHECK_SOURCES: 'check-sources', CHECK_RELEASES: 'check-releases', REPOSITORY: 'repository' })) {
    assert.equal(validation.env[key], `\${{ inputs.${input} }}`);
  }
});

test('only the workflow validation runner receives source credentials, never installation or reporting', () => {
  const mappings = { CHECK_SOURCES: 'check-sources', CHECK_RELEASES: 'check-releases', REPOSITORY: 'repository' };
  const validation = workflow.jobs.validate.steps.find((step) => step.id === 'run');
  assert.ok(validation);
  for (const [key, input] of Object.entries(mappings)) {
    assert.equal(validation.env[key], `\${{ inputs.${input} }}`);
  }
  for (const job of Object.values(workflow.jobs)) {
    assert.notEqual(job.secrets, 'inherit');
    for (const step of job.steps.filter((candidate) => candidate !== validation)) {
      assert.equal(step.env?.SOURCE_TOKEN, undefined);
      assert.doesNotMatch(JSON.stringify(step), /secrets\.source-token/);
    }
  }
});

test('source-token is withheld for offline, mismatched subjects, forks and untrusted events', () => {
  const validation = workflow.jobs.validate.steps.find((step) => step.id === 'run');
  const expression = validation.env.SOURCE_TOKEN;
  assert.equal(typeof expression, 'string');
  assert.match(expression, /github\.event_name/);
  assert.match(expression, /github\.event\.pull_request\.head\.repo\.full_name == github\.repository/);
  assert.match(expression, /secrets\.source-token/);
  // Evaluate the trusted YAML expression itself, rather than a duplicate of its guard.
  const guard = expression.slice(3, -2).replace(/\b(inputs|secrets)\.([a-z][a-z-]*)/g, "$1['$2']");
  const tokenFor = (inputs, eventName, headRepository = 'org/consumer') => runInNewContext(guard, {
    inputs: { subject: 'hub', 'check-sources': false, 'check-releases': false, ...inputs },
    secrets: { 'source-token': 'workflow-test-token' },
    github: { event_name: eventName, repository: 'org/consumer', event: {
      ...(['pull_request', 'pull_request_target'].includes(eventName) ? { pull_request: { head: { repo: { full_name: headRepository } } } } : {})
    } }
  });
  for (const eventName of ['push', 'workflow_dispatch', 'schedule', 'pull_request']) {
    assert.equal(tokenFor({}, eventName), '', `Offline ${eventName} must not receive a supplied secret`);
    assert.equal(tokenFor({ subject: 'collection', repository: 'owner/repo' }, eventName), '');
    assert.equal(tokenFor({ subject: 'hub', 'check-releases': true }, eventName), '');
    assert.equal(tokenFor({ subject: 'collection', 'check-sources': true }, eventName), '');
    assert.equal(tokenFor({ subject: 'skill', 'check-sources': true, 'check-releases': true }, eventName), '');
    assert.equal(tokenFor({ 'check-sources': true }, eventName), 'workflow-test-token');
    assert.equal(tokenFor({ subject: 'collection', 'check-releases': true }, eventName), 'workflow-test-token');
  }
  for (const eventName of ['pull_request', 'pull_request_target']) {
    for (const headRepository of ['other/fork', '']) {
      assert.equal(tokenFor({ 'check-sources': true }, eventName, headRepository), '', `${eventName} fork must not receive a source token`);
      assert.equal(tokenFor({ subject: 'collection', 'check-releases': true }, eventName, headRepository), '');
    }
  }
  for (const eventName of ['workflow_run', 'repository_dispatch', 'pull_request_target']) {
    assert.equal(tokenFor({ 'check-sources': true }, eventName), '');
    assert.equal(tokenFor({ subject: 'collection', 'check-releases': true }, eventName), '');
  }
});