import {
  defineConfig,
} from 'vitest/config';

/**
 * Vitest configuration for `@ai-primitives-hub/core`.
 *
 * Test discovery keeps the Vitest defaults the package used before this file
 * existed. The only addition is the coverage gate for the install-record code
 * (format 3.0.0): `test:coverage` fails when line coverage of these files drops
 * below 80%.
 */
export default defineConfig({
  test: {
    coverage: {
      provider: 'v8',
      include: [
        'src/domain/install/record-*.ts',
        'src/ports/record-fs.ts'
      ],
      thresholds: {
        lines: 80
      }
    }
  }
});
