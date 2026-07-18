const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { runTests } = require('@vscode/test-electron');

async function main() {
  // Create a fresh, isolated user data directory for each test run
  // This ensures tests start with a clean state (no first-run dialogs, no cached state)
  const userDataDir = path.join(os.tmpdir(), `vscode-test-${Date.now()}`);
  
  try {
    // The folder containing the Extension Manifest package.json
    const extensionDevelopmentPath = path.resolve(__dirname, '../');
    // The path to the test suite (in compiled test-dist directory)
    const extensionTestsPath = path.resolve(__dirname, '../test-dist/test/suite/index.js');
    
    await runTests({ 
      extensionDevelopmentPath, 
      extensionTestsPath,
      // Use isolated user data directory for clean test environment
      launchArgs: [
        '--user-data-dir', userDataDir,
        '--disable-extensions',  // Disable other extensions to avoid interference
        '--disable-gpu',         // Helps with CI environments
        '--no-sandbox'           // Required for some CI environments
      ]
    });
  } catch (err) {
    console.error('Failed to run extension tests');
    process.exit(1);
  } finally {
    // Clean up the temporary user data directory
    try {
      if (fs.existsSync(userDataDir)) {
        fs.rmSync(userDataDir, { recursive: true, force: true });
      }
    } catch (cleanupErr) {
      console.warn('Failed to clean up test user data directory:', cleanupErr.message);
    }
  }
}

main();
