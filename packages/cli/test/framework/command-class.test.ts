/**
 * Tests for `framework/command-class.ts`.
 *
 * `copyCommandPrototype` copies prototype property descriptors from a base
 * command class to a dynamically-created subclass so clipanion can discover
 * inherited options and static metadata.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  copyCommandPrototype,
} from '../../src/framework';

describe('copyCommandPrototype', () => {
  it('copies prototype descriptors from the base class to the subclass', () => {
    class BaseCommand {
      public static paths = [['base']];

      public static usage = { description: 'Base command' };

      public greet = 'hello';
    }

    class SubCommand {}

    copyCommandPrototype(BaseCommand, SubCommand);

    expect((SubCommand.prototype as unknown as { greet: string }).greet).toBe('hello');

    expect((SubCommand as unknown as { paths: string[][] }).paths).toEqual([['base']]);

    expect((SubCommand as unknown as { usage: { description: string } }).usage).toEqual({ description: 'Base command' });
  });

  it('does not copy the constructor', () => {
    class BaseCommand {
      public static usage = {};
    }

    class SubCommand {
      public prop = 1;
    }

    copyCommandPrototype(BaseCommand, SubCommand);

    expect(new SubCommand().prop).toBe(1);
  });
});
