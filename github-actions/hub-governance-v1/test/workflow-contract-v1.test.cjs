const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
// Reuse the provider's existing YAML parser; no new workspace dependency is needed.
const yaml = createRequire(path.resolve(__dirname, '../../../packages/infra/package.json'))('js-yaml');
const root = path.resolve(__dirname, '../../..');
const workflow = yaml.load(fs.readFileSync(path.join(root, '.github/workflows/hub-governance-v1.yml'), 'utf8'));
const action = yaml.load(fs.readFileSync(path.join(root, 'github-actions/hub-governance-v1/action.yml'), 'utf8'));

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
  assert.equal(workflow.jobs.validate.steps.find((step) => step.id === 'validation').with['fail-on-error'], 'false');
  assert.equal(action.runs.steps.find((step) => step.id === 'publish').if, "always() && steps.prepare.outcome == 'success'");
});

test('consumer content is never executed with provider setup or write permissions', () => {
  const install = action.runs.steps.find((step) => step.id === 'install');
  assert.match(install.run, /--ignore-scripts/);
  assert.equal(install['working-directory'], '${{ runner.temp }}');
  for (const step of workflow.jobs.validate.steps.filter((candidate) => candidate.uses?.startsWith('actions/checkout@'))) {
    assert.equal(step.with['persist-credentials'], false);
  }
});