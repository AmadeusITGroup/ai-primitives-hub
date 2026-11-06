import {
  defineConfig,
  globalIgnores,
} from 'eslint/config';
import {
  createSharedConfig,
  temporaryWarnRules,
  temporaryWarnRulesTs,
} from '../../eslint.shared.mjs';

export default defineConfig([
  globalIgnores(
    [
      'dist/',
      '**/*.d.ts',
      'node_modules/'
    ],
    'cli/ignores'
  ),
  ...createSharedConfig({
    name: 'cli',
    tsProjects: ['tsconfig.json', 'tsconfig.test.json'],
    tsconfigRootDir: import.meta.dirname
  }),
  {
    // Clipanion's `Command.Usage(...)` is a static factory, not a
    // constructor — exempt it from `new-cap`'s "capitalized names must
    // be `new`-called" heuristic.
    name: 'cli/clipanion-usage-factory',
    files: ['**/*.ts'],
    rules: {
      'new-cap': ['error', { capIsNewExceptions: ['Usage'] }]
    }
  },
  {
    // TODO to be discussed and fixed in a future PR
    name: 'cli/temporary-warn-rules-ts',
    files: ['**/*.ts'],
    rules: temporaryWarnRulesTs
  },
  {
    // TODO to be discussed and fixed in a future PR
    name: 'cli/temporary-warn-rules',
    files: ['**/*.{j,t}s'],
    rules: temporaryWarnRules
  },
  {
    name: 'cli/test-ts-rules',
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  }
]);
