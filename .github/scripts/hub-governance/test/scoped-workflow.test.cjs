const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { test } = require('node:test');
const yaml = createRequire(path.resolve(__dirname, '../../../../packages/infra/package.json'))('js-yaml');
const workflow = yaml.load(fs.readFileSync(path.resolve(__dirname, '../../../workflows/hub-governance.yml'), 'utf8'));

test('standard Hub validation receives optional scope arguments without a new command', () => {
  const inputs = workflow.on.workflow_call.inputs;
  const run = workflow.jobs.validate.steps.find((step) => step.id === 'run');
  for (const [input, variable] of [['base-ref', 'BASE_REF'], ['head-ref', 'HEAD_REF'], ['scope-file', 'SCOPE_FILE']]) {
    assert.equal(inputs[input]?.default, '');
    assert.equal(run.env[variable], `\${{ inputs.${input} }}`);
    assert.ok(run.run.includes(`command+=(--${input} "$${variable}")`));
  }
  assert.match(run.run, /ai-primitives-hub "\$SUBJECT" validate --governance/);
  assert.match(run.run, /Scope arguments are supported for hub validation only/);
  assert.match(run.run, /Comparison refs are supported for hub and collection validation only/);
});

test('comparison history is available and the exact supplied head is checked out', () => {
  const checkout = workflow.jobs.validate.steps.find((step) => step.name === 'Checkout consumer configuration');
  assert.equal(checkout.with['fetch-depth'], 0);
  assert.equal(checkout.with.ref, '${{ inputs.head-ref || github.sha }}');
  assert.equal(checkout.with['persist-credentials'], false);
});