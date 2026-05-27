/**
 * Context detection implementation.
 *
 * Analyzes project structure and environment to detect tech stack,
 * domain, and activity information.
 * @module app/context-detection/detector
 */

import * as path from 'node:path';
import type {
  Activity,
  ContextDetectionOptions,
  DetectedContext,
  Domain,
  TechStack,
} from './types';

/**
 * Context detector class.
 */
export class ContextDetector {
  private readonly options: ContextDetectionOptions;

  constructor(options: ContextDetectionOptions) {
    this.options = {
      maxRecentFiles: 10,
      includeGitHistory: true,
      ...options
    };
  }

  /**
   * Detect languages from package dependencies.
   * @param deps Package dependencies.
   * @returns Detected languages.
   */
  private detectLanguages(deps: Record<string, unknown>): string[] {
    const languages: string[] = [];
    if (deps.typescript || deps['@types/node']) {
      languages.push('TypeScript');
    }
    if (deps.react || deps['@types/react']) {
      languages.push('JavaScript');
    }
    if (deps.vue) {
      languages.push('JavaScript');
    }
    if (deps.angular || deps['@angular/core']) {
      languages.push('TypeScript');
    }
    return languages;
  }

  /**
   * Detect frameworks from package dependencies.
   * @param deps Package dependencies.
   * @returns Detected frameworks.
   */
  private detectFrameworks(deps: Record<string, unknown>): string[] {
    const frameworks: string[] = [];
    if (deps.react || deps['@types/react']) {
      frameworks.push('React');
    }
    if (deps.vue) {
      frameworks.push('Vue');
    }
    if (deps.angular || deps['@angular/core']) {
      frameworks.push('Angular');
    }
    if (deps.express || deps['@types/express']) {
      frameworks.push('Express');
    }
    if (deps.next || deps['next.js']) {
      frameworks.push('Next.js');
    }
    if (deps.nuxt || deps['@nuxt/core']) {
      frameworks.push('Nuxt');
    }
    return frameworks;
  }

  /**
   * Detect build tools from package dependencies.
   * @param deps Package dependencies.
   * @returns Detected build tools.
   */
  private detectBuildTools(deps: Record<string, unknown>): string[] {
    const buildTools: string[] = [];
    if (deps.webpack || deps['webpack-cli']) {
      buildTools.push('webpack');
    }
    if (deps.vite) {
      buildTools.push('vite');
    }
    if (deps.esbuild) {
      buildTools.push('esbuild');
    }
    if (deps.rollup) {
      buildTools.push('rollup');
    }
    return buildTools;
  }

  /**
   * Detect test frameworks from package dependencies.
   * @param deps Package dependencies.
   * @returns Detected test frameworks.
   */
  private detectTestFrameworks(deps: Record<string, unknown>): string[] {
    const testFrameworks: string[] = [];
    if (deps.jest || deps['@types/jest']) {
      testFrameworks.push('Jest');
    }
    if (deps.vitest || deps['@vitest']) {
      testFrameworks.push('Vitest');
    }
    if (deps.mocha || deps['@types/mocha']) {
      testFrameworks.push('Mocha');
    }
    return testFrameworks;
  }

  /**
   * Detect tech stack from project files.
   * @returns Tech stack information.
   */
  private async detectTechStack(): Promise<TechStack> {
    const languages: string[] = [];
    const frameworks: string[] = [];
    const packageManagers: string[] = [];
    const buildTools: string[] = [];
    const testFrameworks: string[] = [];

    // Detect from package.json
    const packageJsonPath = path.join(this.options.cwd, 'package.json');
    if (await this.fileExists(packageJsonPath)) {
      try {
        const content = await this.readFile(packageJsonPath);
        const pkg = JSON.parse(content) as Record<string, unknown>;

        // Detect from dependencies
        const deps = { ...(pkg.dependencies as Record<string, unknown>), ...(pkg.devDependencies as Record<string, unknown>) };
        languages.push(...this.detectLanguages(deps));
        frameworks.push(...this.detectFrameworks(deps));
        buildTools.push(...this.detectBuildTools(deps));
        testFrameworks.push(...this.detectTestFrameworks(deps));
      } catch {
        // Ignore parse errors
      }
    }

    // Detect from tsconfig.json
    const tsconfigPath = path.join(this.options.cwd, 'tsconfig.json');
    if (await this.fileExists(tsconfigPath) && !languages.includes('TypeScript')) {
      languages.push('TypeScript');
    }

    // Detect from go.mod
    const goModPath = path.join(this.options.cwd, 'go.mod');
    if (await this.fileExists(goModPath)) {
      languages.push('Go');
    }

    // Detect from pyproject.toml or requirements.txt
    const pyprojectPath = path.join(this.options.cwd, 'pyproject.toml');
    const requirementsPath = path.join(this.options.cwd, 'requirements.txt');
    if (await this.fileExists(pyprojectPath) || await this.fileExists(requirementsPath)) {
      languages.push('Python');
    }

    // Detect package managers from lockfiles
    const packageLockPath = path.join(this.options.cwd, 'package-lock.json');
    const yarnLockPath = path.join(this.options.cwd, 'yarn.lock');
    const pnpmLockPath = path.join(this.options.cwd, 'pnpm-lock.yaml');
    if (await this.fileExists(packageLockPath)) {
      packageManagers.push('npm');
    }
    if (await this.fileExists(yarnLockPath)) {
      packageManagers.push('yarn');
    }
    if (await this.fileExists(pnpmLockPath)) {
      packageManagers.push('pnpm');
    }

    return {
      languages: [...new Set(languages)],
      frameworks: [...new Set(frameworks)],
      packageManagers: [...new Set(packageManagers)],
      buildTools: [...new Set(buildTools)],
      testFrameworks: [...new Set(testFrameworks)]
    };
  }

  /**
   * Detect technical domain from directory structure.
   * @param dirs Directory names.
   * @returns Technical domain.
   */
  private detectTechnicalDomain(dirs: string[]): string {
    if (dirs.includes('src') && dirs.includes('test')) {
      return 'fullstack';
    }
    if (dirs.includes('src') || dirs.includes('lib')) {
      if (dirs.includes('public') || dirs.includes('static') || dirs.includes('assets')) {
        return 'frontend';
      }
      if (dirs.includes('server') || dirs.includes('api') || dirs.includes('routes')) {
        return 'backend';
      }
      return 'backend';
    }
    return '';
  }

  /**
   * Detect category from directory structure.
   * @param dirs Directory names.
   * @returns Category.
   */
  private detectCategory(dirs: string[]): string {
    if (dirs.includes('components') || dirs.includes('pages') || dirs.includes('views')) {
      return 'web-application';
    }
    if (dirs.includes('controllers') || dirs.includes('models') || dirs.includes('services')) {
      return 'api-server';
    }
    if (dirs.includes('tests') || dirs.includes('spec') || dirs.includes('__tests__')) {
      return 'library';
    }
    if (dirs.includes('bin') || dirs.includes('cli')) {
      return 'cli-tool';
    }
    return '';
  }

  /**
   * Detect business domain from file names.
   * @param files File names.
   * @returns Business domain.
   */
  private detectBusinessDomain(files: string[]): string {
    for (const file of files) {
      const lower = file.toLowerCase();
      if (lower.includes('auth') || lower.includes('login') || lower.includes('user')) {
        return 'authentication';
      }
      if (lower.includes('payment') || lower.includes('billing') || lower.includes('invoice')) {
        return 'payments';
      }
      if (lower.includes('order') || lower.includes('cart') || lower.includes('checkout')) {
        return 'ecommerce';
      }
    }
    return '';
  }

  /**
   * Detect domain from project structure.
   * @returns Domain information.
   */
  private async detectDomain(): Promise<Domain> {
    const dirs = await this.listDirectories(this.options.cwd);
    const files = await this.listFiles(this.options.cwd);

    return {
      category: this.detectCategory(dirs),
      businessDomain: this.detectBusinessDomain(files),
      technicalDomain: this.detectTechnicalDomain(dirs)
    };
  }

  /**
   * Detect activity from recent files and git history.
   * @returns Activity information.
   */
  private async detectActivity(): Promise<Activity> {
    const recentFiles = await this.getRecentFiles();
    const branch = this.options.includeGitHistory ? await this.getGitBranch() : undefined;
    const lastCommitMessage = this.options.includeGitHistory ? await this.getLastCommitMessage() : undefined;

    return {
      recentFiles,
      branch,
      lastCommitMessage,
      workingDirectory: this.options.cwd
    };
  }

  /**
   * Get recently modified files.
   * @returns List of recent file paths.
   */
  private async getRecentFiles(): Promise<string[]> {
    // For now, return empty array. In a full implementation, this would
    // use filesystem timestamps to find recently modified files.
    await Promise.resolve();
    return [];
  }

  /**
   * Get current git branch.
   * @returns Git branch name or undefined.
   */
  private async getGitBranch(): Promise<string | undefined> {
    // For now, return undefined. In a full implementation, this would
    // run `git branch --show-current` to get the current branch.
    await Promise.resolve();
    return undefined;
  }

  /**
   * Get last commit message.
   * @returns Last commit message or undefined.
   */
  private async getLastCommitMessage(): Promise<string | undefined> {
    // For now, return undefined. In a full implementation, this would
    // run `git log -1 --pretty=%B` to get the last commit message.
    await Promise.resolve();
    return undefined;
  }

  /**
   * Check if a file exists.
   * @param filePath File path.
   * @returns True if file exists.
   */
  private async fileExists(filePath: string): Promise<boolean> {
    // This would use the filesystem adapter in a full implementation.
    // For now, we'll use a simple check.
    try {
      const fs = await import('node:fs/promises');
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Read a file.
   * @param filePath File path.
   * @returns File content.
   */
  private async readFile(filePath: string): Promise<string> {
    const fs = await import('node:fs/promises');
    return fs.readFile(filePath, 'utf8');
  }

  /**
   * List directories in a path.
   * @param dirPath Directory path.
   * @returns List of directory names.
   */
  private async listDirectories(dirPath: string): Promise<string[]> {
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.filter((e) => e.isDirectory()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * List files in a path.
   * @param dirPath Directory path.
   * @returns List of file names.
   */
  private async listFiles(dirPath: string): Promise<string[]> {
    try {
      const fs = await import('node:fs/promises');
      const entries = await fs.readdir(dirPath, { withFileTypes: true });
      return entries.filter((e) => e.isFile()).map((e) => e.name);
    } catch {
      return [];
    }
  }

  /**
   * Detect context from working directory.
   * @returns Detected context.
   */
  public async detect(): Promise<DetectedContext> {
    const techStack = await this.detectTechStack();
    const domain = await this.detectDomain();
    const activity = await this.detectActivity();

    return {
      techStack,
      domain,
      activity,
      detectedAt: new Date().toISOString()
    };
  }
}
