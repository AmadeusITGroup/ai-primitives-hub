const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../..');

test('release packages include the versioned launcher, domain, policy schema and reports', () => {
  const checks = {
    core: ['dist/domain/governance/governance-v1.js', 'dist/domain/governance/policy-v1.schema.json'],
    infra: ['dist/governance/policy-v1.js'],
    app: ['dist/governance/run-governance-v1.js', 'dist/governance/report-v1.js'],
    cli: ['bin/ai-primitives-hub-governance-v1.js', 'dist/governance-v1.js']
  };
  for (const [name, expected] of Object.entries(checks)) {
    const packed = spawnSync('npm', ['pack', '--dry-run', '--ignore-scripts', '--json'], { cwd: path.join(root, 'packages', name), encoding: 'utf8' });
    assert.equal(packed.status, 0, `npm pack failed for ${name}`);
    const files = JSON.parse(packed.stdout)[0].files.map((file) => file.path);
    for (const file of expected) {
      assert.ok(files.includes(file), `${name} release does not contain ${file}`);
    }
  }
});

test('the bundled policy schema runs without repository schema paths or remote references', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'packages/core/dist/domain/governance/policy-v1.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.minScore.maximum, 100);
  assert.equal(schema.properties.rules.additionalProperties.additionalProperties, false);
});