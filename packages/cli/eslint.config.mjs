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
    ['dist/', 'test-dist/', '**/*.d.ts', 'node_modules/'],
    'cli/ignores'
  ),
  ...createSharedConfig({
    name: 'cli',
    tsProjects: ['tsconfig.json', 'tsconfig.test.json'],
    tsconfigRootDir: import.meta.dirname
  }),
  {
    name: 'cli/clipanion-patterns',
    files: ['**/*.ts'],
    rules: {
      // Command.Usage is a Clipanion static factory method, not a constructor
      'new-cap': ['error', { capIsNewExceptionPattern: '^Command\\.' }]
    }
  },
  {
    name: 'cli/temporary-warn-rules-ts',
    files: ['**/*.ts'],
    rules: temporaryWarnRulesTs
  },
  {
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
