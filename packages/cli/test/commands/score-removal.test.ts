import {
  expect,
  it,
} from 'vitest';
import {
  CollectionValidateCommand,
} from '../../src/commands/collection-validate';
import {
  HubValidateCommand,
} from '../../src/commands/hub';
import {
  PrimitiveValidateCommand,
} from '../../src/commands/primitive-validate';
import {
  SkillValidateCommand,
} from '../../src/commands/skill-validate';
import {
  runCommand,
} from '../../src/framework';

it.each(['hub', 'collection', 'primitive', 'skill'])('rejects removed --min-score for %s validation', async (subject) => {
  const result = await runCommand([subject, 'validate', '--min-score', '0'], {
    commandClasses: [HubValidateCommand, CollectionValidateCommand, PrimitiveValidateCommand, SkillValidateCommand]
  });
  expect(result.exitCode).not.toBe(0);
  expect(result.stdout + result.stderr).toContain('Unsupported option name ("--min-score")');
});
