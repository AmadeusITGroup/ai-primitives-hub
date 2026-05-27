import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  standardBenchCases,
} from '../../src/github/bench/cases';
import {
  renderBenchReport,
  runBench,
} from '../../src/github/bench/harness';

const enabled = process.env.RUN_BENCH === '1';
const describeIfEnabled = enabled ? describe : describe.skip;

describeIfEnabled('github/bench', () => {
  it('all standard cases meet their thresholds', async () => {
    const report = await runBench(standardBenchCases(), 200);
    process.stdout.write('\n' + renderBenchReport(report));
    expect(report.aggregate.allPassed).toBe(true);
  });
});

describe('github/bench smoke', () => {
  it('produces a renderable report at low iterations', async () => {
    const report = await runBench(standardBenchCases(), 2);
    expect(report.perCase.length).toBe(5);
    const md = renderBenchReport(report);
    expect(md).toMatch(/github middleware microbenchmark/);
    expect(md).toMatch(/\| `cold` \|/);
  });
});
