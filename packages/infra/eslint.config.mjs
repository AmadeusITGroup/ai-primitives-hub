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
    'infra/ignores'
  ),
  ...createSharedConfig({
    name: 'infra',
    tsProjects: ['tsconfig.json', 'tsconfig.test.json'],
    tsconfigRootDir: import.meta.dirname
  }),
  {
    // TODO to be discussed and fixed in a future PR
    name: 'infra/temporary-warn-rules-ts',
    files: ['**/*.ts'],
    rules: temporaryWarnRulesTs
  },
  {
    // TODO to be discussed and fixed in a future PR
    name: 'infra/temporary-warn-rules',
    files: ['**/*.{j,t}s'],
    rules: temporaryWarnRules
  },
  {
    // NFR4.7: install-record code never spawns processes (the git-root walk is filesystem-only).
    // Repeats the inherited `rxjs/internal/*` pattern because overriding the rule replaces its options.
    name: 'infra/install-record-no-child-process',
    files: ['src/domain/install/record*', 'src/records/**'],
    rules: {
      'no-restricted-imports': ['error', {
        paths: [
          { name: 'child_process', message: 'Install-record code must not spawn processes (NFR4.7).' },
          { name: 'node:child_process', message: 'Install-record code must not spawn processes (NFR4.7).' }
        ],
        patterns: ['rxjs/internal/*']
      }]
    }
  },
  {
    name: 'infra/test-ts-rules',
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
