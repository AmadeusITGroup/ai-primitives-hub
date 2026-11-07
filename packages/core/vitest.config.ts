import {
  defineConfig,
} from 'vitest/config';

/** Vitest defaults plus an 80% line-coverage gate on the install-record code. */
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
