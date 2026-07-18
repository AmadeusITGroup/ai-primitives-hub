# Test Fixtures & Example Prompt Libraries

This directory contains test fixtures and example prompt libraries for testing and demonstration purposes.

## Directory Structure

```
fixtures/
├── local-library/          # Example local bundles
│   ├── example-bundle/     # Code quality prompts
│   └── testing-bundle/     # Testing & QA prompts
├── github/                 # GitHub API response mocks
│   └── releases-response.json
└── apm/                    # APM registry mocks
    └── index.json
```

## Local Library Examples

### Example Bundle (v1.0.0)
**Path:** `local-library/example-bundle/`

A comprehensive code quality bundle containing:
- **Code Review Assistant** - Provides structured code review feedback
- **Bug Analyzer** - Identifies potential bugs and issues systematically
- **Refactoring Guide** - Guides refactoring with best practices

**Use Cases:**
- Testing local adapter functionality
- Demonstrating prompt structure
- Integration testing with real manifests

### Testing Bundle (v2.1.0)
**Path:** `local-library/testing-bundle/`

A testing-focused bundle containing:
- **Unit Test Generator** - Creates unit tests with edge cases
- **Test Coverage Analyzer** - Identifies coverage gaps
- **E2E Scenario Designer** - Designs end-to-end test scenarios

**Use Cases:**
- Testing multi-bundle scenarios
- Demonstrating version handling
- Testing dependency resolution

## API Response Mocks

### GitHub Releases (`github/releases-response.json`)

Simulates GitHub Releases API responses with:
- Multiple releases (v1.0.0, v2.1.0, v0.5.0-beta)
- Complete release metadata
- Asset information (manifest + bundle)
- Release notes and descriptions

**Used for:**
- Testing GitHubAdapter without real API calls
- Testing release filtering and parsing
- Testing authentication scenarios

## Using Test Fixtures

### In Unit Tests

```typescript
import * as path from 'path';
import * as fs from 'fs';

// Load local bundle manifest
const manifestPath = path.join(__dirname, 'fixtures/local-library/example-bundle/deployment-manifest.yml');
const manifest = fs.readFileSync(manifestPath, 'utf8');

// Load GitHub API mock
const githubResponse = require('./fixtures/github/releases-response.json');
```

### In Integration Tests

```typescript
import { LocalAdapter } from '../adapters/LocalAdapter';

const source = {
    id: 'test-local',
    type: 'local',
    url: path.join(__dirname, 'fixtures/local-library'),
    // ... other source properties
};

const adapter = new LocalAdapter(source);
const bundles = await adapter.fetchBundles();
```

### With Mocking Libraries (nock)

```typescript
import nock from 'nock';

// Mock GitHub API
nock('https://api.github.com')
    .get('/repos/example/example-bundle/releases')
    .reply(200, require('./fixtures/github/releases-response.json'));
```

### With Repository Fixture Helpers (E2E Tests)

For E2E tests involving GitHub releases, use the shared repository fixture helpers:

```typescript
import {
    setupReleaseMocks,
    createMockGitHubSource,
    cleanupReleaseMocks
} from '../helpers/repository-fixture-helpers';

// Set up complete GitHub release mocks
setupReleaseMocks(
    { owner: 'test-owner', repo: 'test-repo', manifestId: 'test-bundle' },
    [
        { tag: 'v1.0.0', version: '1.0.0', content: 'initial' },
        { tag: 'v2.0.0', version: '2.0.0', content: 'updated' }
    ]
);

// Create matching source
const source = createMockGitHubSource('test-source', {
    owner: 'test-owner',
    repo: 'test-repo',
    manifestId: 'test-bundle'
});

// Clean up after test
cleanupReleaseMocks();
```

## Creating New Fixtures

### Local Bundle Structure

```
new-bundle/
├── deployment-manifest.yml    # Bundle metadata (REQUIRED)
└── prompts/                   # Prompt files
    ├── prompt1.md
    └── prompt2.md
```

### Manifest Format (YAML)

```yaml
id: bundle-id
version: 1.0.0
name: Bundle Name
description: Bundle description
author: Author Name
tags: [tag1, tag2]
environments: [vscode, windsurf]
license: MIT

prompts:
  - id: prompt-id
    name: Prompt Name
    description: Prompt description
    file: prompts/filename.md
    tags: [tag1, tag2]

dependencies: []
```

### API Response Mocks

Follow the structure of existing mocks:
- Include all required fields
- Use realistic data
- Add variety for testing edge cases
- Document the purpose

## Maintenance

- Keep fixtures up-to-date with schema changes
- Add new fixtures when testing new features
- Remove outdated or unused fixtures
- Document any special test scenarios

## Notes

- All fixtures are version-controlled
- Do not include sensitive data (tokens, keys, etc.)
- Use example.com domains for URLs
- Keep file sizes reasonable for fast tests
