import {
  defineConfig,
  globalIgnores,
} from 'eslint/config';
import globals from 'globals';
import jsonParser from 'jsonc-eslint-parser';
import {
  createSharedConfig,
  temporaryWarnRules,
  temporaryWarnRulesTs,
} from '../../eslint.shared.mjs';

export default defineConfig([
  globalIgnores(
    [
      'out/',
      'test-out/',
      'dist/',
      'test-dist/',
      '**/*.d.ts',
      'node_modules/',
      'test/**/*.js',
    ],
    'prompt-registry-extension/ignores'
  ),
  ...createSharedConfig({
    name: 'prompt-registry-extension',
    tsProjects: ['tsconfig.json', 'tsconfig.test.json'],
    tsconfigRootDir: import.meta.dirname,
    nodeGlobFiles: ['src/**/*.ts']
  }),
  {
    name: 'prompt-registry-extension/temporary-warn-rules-ts',
    files: ['**/*.ts'],
    rules: {
      ...temporaryWarnRulesTs
    }
  },
  {
    name: 'prompt-registry-extension/test-ts-rules',
    files: ['test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-require-imports': 'off'
    }
  },
  {
    name: 'prompt-registry-extension/temporary-warn-rules',
    files: ['**/*.{j,t}s'],
    rules: {
      ...temporaryWarnRules
    }
  },
  {
    name: 'prompt-registry-extension/parser/json',
    files: ['**/*.json'],
    languageOptions: {
      parser: jsonParser
    }
  },
  {
    name: 'prompt-registry-extension/webview-js',
    files: ['src/ui/webview/**/*.js'],
    languageOptions: {
      ecmaVersion: 2020,
      sourceType: 'module',
      globals: {
        ...globals.browser,
        acquireVsCodeApi: 'readonly'
      }
    }
  },
  {
    name: 'prompt-registry-extension/test',
    files: ['test/**/*.ts'],
    languageOptions: {
      globals: {
        ...globals.node,
        ...globals.mocha,
        NodeJS: true
      }
    }
  }
]);
