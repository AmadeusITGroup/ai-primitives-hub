/**
 * Context detection types.
 *
 * Defines the structure for detected context including tech stack,
 * domain, and activity information.
 * @module app/context-detection/types
 */

/**
 * Detected tech stack information.
 */
export interface TechStack {
  /** Programming languages detected. */
  languages: string[];
  /** Frameworks detected (e.g., React, Vue, Express). */
  frameworks: string[];
  /** Package managers detected (e.g., npm, yarn, pnpm). */
  packageManagers: string[];
  /** Build tools detected (e.g., webpack, vite, esbuild). */
  buildTools: string[];
  /** Testing frameworks detected (e.g., jest, vitest, mocha). */
  testFrameworks: string[];
}

/**
 * Detected domain information.
 */
export interface Domain {
  /** Domain category inferred from project structure. */
  category?: string;
  /** Business domain inferred from naming patterns. */
  businessDomain?: string;
  /** Technical domain (e.g., frontend, backend, fullstack). */
  technicalDomain?: string;
}

/**
 * Detected activity information.
 */
export interface Activity {
  /** Recently modified files. */
  recentFiles: string[];
  /** Git branch if in a git repository. */
  branch?: string;
  /** Last commit message if in a git repository. */
  lastCommitMessage?: string;
  /** Working directory. */
  workingDirectory: string;
}

/**
 * Complete detected context.
 */
export interface DetectedContext {
  /** Tech stack information. */
  techStack: TechStack;
  /** Domain information. */
  domain: Domain;
  /** Activity information. */
  activity: Activity;
  /** Timestamp when context was detected. */
  detectedAt: string;
}

/**
 * Context detection options.
 */
export interface ContextDetectionOptions {
  /** Working directory to analyze. */
  cwd: string;
  /** Maximum number of recent files to track. */
  maxRecentFiles?: number;
  /** Whether to include git history. */
  includeGitHistory?: boolean;
}
