import {
  defineConfig,
  globalIgnores,
} from 'eslint/config';

export default defineConfig([
  globalIgnores(
    [
      '**/node_modules/**',
      '**/dist/**',
      '**/out/**',
      '**/*.d.ts',
      'lib/',
    ],
    'workspace-root/ignores'
  ),
]);
