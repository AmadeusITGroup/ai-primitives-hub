const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { test } = require('node:test');
const root = path.resolve(__dirname, '../../../..');

test('release packages include the standard launcher, integrated commands, source checks, configuration schema and reports', () => {
  const checks = {
    core: ['dist/domain/governance/rule-registry.js', 'dist/domain/governance/evaluate.js', 'dist/domain/governance/rules/collection.js',
      'dist/domain/governance/rules/primitive.js', 'dist/ports/release-lookup.d.ts', 'dist/ports/hub-collection-index.d.ts', 'dist/public/schemas/hub-governance.schema.json'],
    infra: ['dist/governance/governance-config.js', 'dist/governance/ajv-schema-validator.js', 'dist/governance/index.js', 'dist/governance/github-release-lookup.js', 'dist/governance/hub-source-collection-index.js', 'dist/fs/index.js', 'dist/http/index.js'],
    app: ['dist/governance/run-governance.js', 'dist/governance/report.js', 'dist/governance/collection-entry.js', 'dist/governance/validate-collection-governance.js', 'dist/governance/source-checks.js'],
    cli: ['bin/ai-primitives-hub.js', 'dist/commands/validation-governance.js', 'dist/commands/hub.js', 'dist/commands/collection-validate.js', 'dist/commands/skill-validate.js', 'dist/commands/primitive-validate.js']
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

test('the bundled governance configuration schema runs without repository schema paths or remote references', () => {
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'packages/core/dist/public/schemas/hub-governance.schema.json'), 'utf8'));
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.$ref, undefined);
  assert.equal(schema.properties.rules.additionalProperties.additionalProperties, false);
});