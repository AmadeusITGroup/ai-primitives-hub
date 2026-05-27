/**
 * Tests for context detection layer.
 * @module test/app-context-detection
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ContextDetector,
} from '../../src/context-detection';

describe('ContextDetector', () => {
  let tempDir: string;

  beforeEach(async () => {
    // Create a temporary directory for test fixtures
    tempDir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? '/tmp', 'context-detection-test-'));
  });

  it('should detect TypeScript from tsconfig.json', async () => {
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toContain('TypeScript');
  });

  it('should detect React from package.json dependencies', async () => {
    const packageJson = {
      dependencies: {
        react: '^18.0.0',
        typescript: '^5.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.frameworks).toContain('React');
    expect(context.techStack.languages).toContain('TypeScript');
  });

  it('should detect Vue from package.json dependencies', async () => {
    const packageJson = {
      dependencies: {
        vue: '^3.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.frameworks).toContain('Vue');
  });

  it('should detect Express from package.json dependencies', async () => {
    const packageJson = {
      dependencies: {
        express: '^4.18.0',
        typescript: '^5.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.frameworks).toContain('Express');
  });

  it('should detect build tools from package.json', async () => {
    const packageJson = {
      devDependencies: {
        vite: '^5.0.0',
        webpack: '^5.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.buildTools).toContain('vite');
    expect(context.techStack.buildTools).toContain('webpack');
  });

  it('should detect test frameworks from package.json', async () => {
    const packageJson = {
      devDependencies: {
        vitest: '^1.0.0',
        '@vitest/coverage-v8': '^1.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.testFrameworks).toContain('Vitest');
  });

  it('should detect package managers from lockfiles', async () => {
    await fs.writeFile(path.join(tempDir, 'package-lock.json'), '{}');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.packageManagers).toContain('npm');
  });

  it('should detect yarn from yarn.lock', async () => {
    await fs.writeFile(path.join(tempDir, 'yarn.lock'), '');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.packageManagers).toContain('yarn');
  });

  it('should detect pnpm from pnpm-lock.yaml', async () => {
    await fs.writeFile(path.join(tempDir, 'pnpm-lock.yaml'), '');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.packageManagers).toContain('pnpm');
  });

  it('should detect Go from go.mod', async () => {
    await fs.writeFile(path.join(tempDir, 'go.mod'), 'module example');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toContain('Go');
  });

  it('should detect Python from pyproject.toml', async () => {
    await fs.writeFile(path.join(tempDir, 'pyproject.toml'), '[project]');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toContain('Python');
  });

  it('should detect Python from requirements.txt', async () => {
    await fs.writeFile(path.join(tempDir, 'requirements.txt'), 'pytest==7.0.0');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toContain('Python');
  });

  it('should detect frontend technical domain from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.mkdir(path.join(tempDir, 'public'));
    await fs.mkdir(path.join(tempDir, 'assets'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.technicalDomain).toBe('frontend');
  });

  it('should detect backend technical domain from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.mkdir(path.join(tempDir, 'api'));
    await fs.mkdir(path.join(tempDir, 'routes'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.technicalDomain).toBe('backend');
  });

  it('should detect fullstack technical domain from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'src'));
    await fs.mkdir(path.join(tempDir, 'test'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.technicalDomain).toBe('fullstack');
  });

  it('should detect web application category from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'components'));
    await fs.mkdir(path.join(tempDir, 'pages'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.category).toBe('web-application');
  });

  it('should detect api server category from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'controllers'));
    await fs.mkdir(path.join(tempDir, 'models'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.category).toBe('api-server');
  });

  it('should detect cli tool category from directory structure', async () => {
    await fs.mkdir(path.join(tempDir, 'bin'));
    await fs.mkdir(path.join(tempDir, 'cli'));

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.category).toBe('cli-tool');
  });

  it('should detect authentication business domain from file patterns', async () => {
    await fs.writeFile(path.join(tempDir, 'auth.ts'), '');
    await fs.writeFile(path.join(tempDir, 'login.ts'), '');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.businessDomain).toBe('authentication');
  });

  it('should detect payments business domain from file patterns', async () => {
    await fs.writeFile(path.join(tempDir, 'payment.ts'), '');
    await fs.writeFile(path.join(tempDir, 'billing.ts'), '');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.businessDomain).toBe('payments');
  });

  it('should detect ecommerce business domain from file patterns', async () => {
    await fs.writeFile(path.join(tempDir, 'order.ts'), '');
    await fs.writeFile(path.join(tempDir, 'cart.ts'), '');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.domain.businessDomain).toBe('ecommerce');
  });

  it('should include detected timestamp', async () => {
    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.detectedAt).toBeDefined();
    expect(new Date(context.detectedAt)).toBeInstanceOf(Date);
  });

  it('should include working directory in activity', async () => {
    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.activity.workingDirectory).toBe(tempDir);
  });

  it('should handle missing package.json gracefully', async () => {
    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toEqual([]);
    expect(context.techStack.frameworks).toEqual([]);
  });

  it('should handle malformed package.json gracefully', async () => {
    await fs.writeFile(path.join(tempDir, 'package.json'), 'invalid json');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    expect(context.techStack.languages).toEqual([]);
  });

  it('should deduplicate detected items', async () => {
    const packageJson = {
      dependencies: {
        typescript: '^5.0.0'
      },
      devDependencies: {
        typescript: '^5.0.0'
      }
    };
    await fs.writeFile(path.join(tempDir, 'package.json'), JSON.stringify(packageJson));
    await fs.writeFile(path.join(tempDir, 'tsconfig.json'), '{}');

    const detector = new ContextDetector({ cwd: tempDir });
    const context = await detector.detect();

    const typeScriptCount = context.techStack.languages.filter((l) => l === 'TypeScript').length;
    expect(typeScriptCount).toBe(1);
  });
});
