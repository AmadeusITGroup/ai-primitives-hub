import { createRequire } from 'module';
import globals from 'globals';

// Load CommonJS `@o3r/eslint-config` via createRequire so this ESM
// shared config works even when the package exposes only CJS entrypoints.
const require = createRequire(import.meta.url);
const o3rConfig = require('@o3r/eslint-config');

/**
 * Shared ESLint configuration blocks used by both root and lib packages.
 * @param {object} options
 * @param {string} options.name - Config name prefix (e.g. 'prompt-registry' or 'collection-scripts')
 * @param {string[]} options.tsProjects - tsconfig files for type-checked linting
 * @param {string} options.tsconfigRootDir - Root directory for tsconfig resolution (use import.meta.dirname)
 * @param {string[]} [options.nodeGlobFiles] - File patterns for node globals (default: ['**\/*.ts'])
 */
export function createSharedConfig({ name, tsProjects, tsconfigRootDir, nodeGlobFiles = ['**/*.ts'] }) {
  return [
    ...o3rConfig,
    {
      name: `${name}/report-unused-disable-directives`,
      linterOptions: {
        reportUnusedDisableDirectives: 'error'
      }
    },
    {
      name: `${name}/typescript-type-checking`,
      files: ['**/*.ts'],
      languageOptions: {
        parserOptions: {
          project: tsProjects,
          tsconfigRootDir
        }
      }
    },
    {
      name: `${name}/node-globals`,
      files: nodeGlobFiles,
      languageOptions: {
        globals: {
          ...globals.node,
          NodeJS: true
        }
      }
    },
    {
      name: `${name}/overrides`,
      files: ['**/*.ts'],
      rules: {
        '@typescript-eslint/restrict-template-expressions': ['error', {
          allow: ['unknown']
        }]
      }
    },
    {
      name: `${name}/settings`,
      settings: {
        'import/resolver': {
          node: true,
          typescript: {
            project: tsProjects
          }
        }
      }
    }
  ];
}

// TODO to be discussed and fixed in future PRs
export const temporaryWarnRulesTs = {
  '@typescript-eslint/no-unsafe-member-access': 'warn',
  '@typescript-eslint/no-unsafe-argument': 'warn',
  '@typescript-eslint/no-unsafe-call': 'warn',
  '@typescript-eslint/no-unsafe-return': 'warn',
  '@typescript-eslint/no-unsafe-assignment': 'warn',
  '@typescript-eslint/require-await': 'warn'
};

// TODO to be discussed and fixed in future PRs
export const temporaryWarnRules = {
  'no-underscore-dangle': 'warn',
  'no-console': 'warn'
};
