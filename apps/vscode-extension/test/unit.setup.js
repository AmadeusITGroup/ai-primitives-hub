// Unit test configuration for better mocking
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const nock = require('nock');

// Mock GitHub API responses to avoid rate limiting in unit tests
const mockRelease = {
  id: 123456,
  tag_name: 'v1.2.3',
  name: 'Test Release v1.2.3',
  published_at: '2025-09-16T08:00:00Z',
  assets: [
    {
      id: 1,
      name: 'vscode-bundle.zip',
      browser_download_url: 'https://github.com/test-owner/test-repo/releases/download/v1.2.3/vscode-bundle.zip',
      size: 4096,
      content_type: 'application/zip'
    }
  ]
};

const mockRepo = {
  id: 123456,
  name: 'test-repo',
  full_name: 'test-owner/test-repo',
  private: false
};

// Set up GitHub API mocks
function setupMocks() {
  // Clean up any existing mocks
  nock.cleanAll();

  // Mock all GitHub API endpoints
  nock('https://api.github.com')
    .get('/repos/test-owner/test-repo/releases/latest')
    .reply(200, mockRelease)
    .persist();

  nock('https://api.github.com')
    .get('/repos/test-owner/test-repo/releases')
    .query(true)
    .reply(200, [mockRelease])
    .persist();

  nock('https://api.github.com')
    .get(/\/repos\/test-owner\/test-repo\/releases\/tags\/.+/)
    .reply(200, mockRelease)
    .persist();

  nock('https://api.github.com')
    .get('/repos/test-owner/test-repo')
    .reply(200, mockRepo)
    .persist();
}

// Setup mocks immediately
setupMocks();

/** The current test's XDG config folder and the value it replaced. */
const xdgIsolation = { saved: undefined, temp: '' };

// Outside a test (suite setup, module load) a run-wide XDG config folder is
// used, so nothing ever reads or writes the real ~/.config.
const runXdgConfigHome = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-xdg-config-run-'));
process.env.XDG_CONFIG_HOME = runXdgConfigHome;
process.on('exit', () => fs.rmSync(runXdgConfigHome, { recursive: true, force: true }));

// Export for use in tests if needed
module.exports = {
  setupMocks,
  mockRelease,
  mockRepo,
  // Every test gets its own XDG config folder, so the shared user record
  // (`$XDG_CONFIG_HOME/ai-primitives-hub/ai-primitives-hub.user.lock.json`)
  // written by user-scope installs never touches the real ~/.config and is
  // never seen by another test.
  mochaHooks: {
    beforeEach() {
      xdgIsolation.saved = process.env.XDG_CONFIG_HOME;
      xdgIsolation.temp = fs.mkdtempSync(path.join(os.tmpdir(), 'unit-xdg-config-'));
      process.env.XDG_CONFIG_HOME = xdgIsolation.temp;
    },
    afterEach() {
      if (xdgIsolation.saved === undefined) {
        delete process.env.XDG_CONFIG_HOME;
      } else {
        process.env.XDG_CONFIG_HOME = xdgIsolation.saved;
      }
      fs.rmSync(xdgIsolation.temp, { recursive: true, force: true });
    }
  }
};
