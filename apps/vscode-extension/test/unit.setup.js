// Unit test configuration for better mocking
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

// Export for use in tests if needed
module.exports = {
  setupMocks,
  mockRelease,
  mockRepo
};
