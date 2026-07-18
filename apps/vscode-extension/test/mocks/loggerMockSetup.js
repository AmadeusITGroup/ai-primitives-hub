/**
 * Logger Mock Setup for VS Code Extension Tests
 * Prevents "Channel has been closed" errors during testing
 */

/**
 * Mock VS Code API for testing environment
 */
const mockVSCode = {
  window: {
    createOutputChannel: (name) => ({
      appendLine: (message) => {
        // Safe logging for tests - just console.log instead of VS Code channels
        console.log(`[${name}] ${message}`);
      },
      show: () => {},
      hide: () => {},
      dispose: () => {}
    }),
    showInformationMessage: (message) => {
      console.log(`[INFO] ${message}`);
      return Promise.resolve();
    },
    showWarningMessage: (message) => {
      console.log(`[WARN] ${message}`);
      return Promise.resolve();
    },
    showErrorMessage: (message) => {
      console.log(`[ERROR] ${message}`);
      return Promise.resolve();
    }
  },
  workspace: {
    getConfiguration: (section) => ({
      get: (key) => {
        // Return mock configuration values
        const mockConfig = {
          'promptregistry.githubToken': process.env.GITHUB_TOKEN || null,
          'promptregistry.owner': 'microsoft',
          'promptregistry.repo': 'prompt-registry',
          'promptregistry.enablePrivateRepository': false
        };
        return mockConfig[`${section}.${key}`] || mockConfig[key];
      }
    }),
    workspaceFolders: [{
      uri: {
        fsPath: '/mock/workspace'
      }
    }]
  }
};

/**
 * Setup test environment with mock VS Code API
 * This prevents channel disposal errors during testing
 */
function setupTestEnvironment() {
  // Only mock if we're in a test environment
  if (process.env.NODE_ENV === 'test' || process.argv.some((arg) => arg.includes('mocha'))) {
    // Check if vscode module is already loaded
    try {
      const Module = require('node:module');
      const originalRequire = Module.prototype.require;

      Module.prototype.require = function (id) {
        if (id === 'vscode') {
          return mockVSCode;
        }
        return Reflect.apply(originalRequire, this, arguments);
      };

      console.log('✓ Test environment setup - VS Code API mocked to prevent channel disposal errors');
    } catch (error) {
      console.warn('⚠️ Could not setup VS Code mock:', error.message);
    }
  }
}

module.exports = {
  mockVSCode,
  setupTestEnvironment
};
