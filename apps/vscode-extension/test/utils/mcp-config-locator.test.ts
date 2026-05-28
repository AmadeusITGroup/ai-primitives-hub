import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

suite('McpConfigLocator Test Suite', () => {
  test('getUserMcpConfigPath returns correct path for current platform', () => {
    const configPath = McpConfigLocator.getUserMcpConfigPath();
    assert.ok(configPath, 'Config path should not be empty');
    assert.ok(configPath.includes('mcp.json'), 'Path should contain mcp.json');

    const platform = os.platform();
    switch (platform) {
      case 'linux': {
        assert.ok(configPath.includes('.config'), 'Linux path should contain .config');

        break;
      }
      case 'darwin': {
        assert.ok(configPath.includes('Library/Application Support'), 'macOS path should contain Library/Application Support');

        break;
      }
      case 'win32': {
        assert.ok(configPath.includes('AppData'), 'Windows path should contain AppData');

        break;
      }
    // No default
    }
  });

  test('getUserTrackingPath returns correct path parallel to mcp.json', () => {
    const trackingPath = McpConfigLocator.getUserTrackingPath();
    const configPath = McpConfigLocator.getUserMcpConfigPath();

    assert.ok(trackingPath, 'Tracking path should not be empty');
    assert.ok(trackingPath.includes('prompt-registry-mcp-tracking.json'),
      'Path should contain tracking filename');
    assert.strictEqual(
      path.dirname(trackingPath),
      path.dirname(configPath),
      'Tracking file should be in same directory as mcp.json'
    );
  });

  test('getMcpConfigLocation returns location info for user scope', () => {
    const location = McpConfigLocator.getMcpConfigLocation('user');

    assert.ok(location, 'Should return location object');
    assert.ok(location.configPath, 'Should have config path');
    assert.ok(location.trackingPath, 'Should have tracking path');
    assert.strictEqual(typeof location.exists, 'boolean', 'Should have exists flag');
  });
});
