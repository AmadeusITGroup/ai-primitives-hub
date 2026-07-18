/**
 * Mock data and utilities for testing Prompt Registry bundle functionality
 */

/**
 * Create a temporary workspace directory for testing
 */
export const createTestWorkspace = (): string => {
  const path = require('node:path');
  const fs = require('node:fs');
  const os = require('node:os');

  const testDir = path.join(os.tmpdir(), `prompt-registry-test-${Date.now()}`);
  fs.mkdirSync(testDir, { recursive: true });

  return testDir;
};

/**
 * Clean up test workspace
 * @param workspacePath
 */
export const cleanupTestWorkspace = (workspacePath: string): void => {
  const fs = require('node:fs');

  if (fs.existsSync(workspacePath)) {
    fs.rmSync(workspacePath, { recursive: true, force: true });
  }
};
