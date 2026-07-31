import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  McpConfigLocator,
} from '../../src/utils/mcp-config-locator';

suite('McpConfigLocator Test Suite', () => {
  test('user-scope path for VS Code resolves per platform', () => {
    // Host detection defaults to VS Code under the test mock, whose user path is
    // derived from the ${vscodeUserDir} token rather than a HOME-relative template.
    const configPath = McpConfigLocator.getMcpConfigPath('user', 'vscode');
    assert.ok(configPath, 'Config path should not be empty');
    assert.ok(configPath.includes('mcp.json'), 'Path should contain mcp.json');
    assert.ok(!configPath.includes('${'), 'All tokens should be resolved');

    const platform = os.platform();
    switch (platform) {
      case 'linux': {
        assert.ok(configPath.includes('.config'), 'Linux path should contain .config');

        break;
      }
      case 'darwin': {
        assert.ok(configPath.includes(path.join('Library', 'Application Support')),
          'macOS path should contain Library/Application Support');

        break;
      }
      case 'win32': {
        assert.ok(configPath.includes('AppData'), 'Windows path should contain AppData');

        break;
      }
    // No default
    }
  });

  test('tracking path sits parallel to the config file', () => {
    const location = McpConfigLocator.getMcpConfigLocation('user', 'vscode');

    assert.ok(location, 'Should resolve a user-scope location');
    assert.ok(location.trackingPath.includes('prompt-registry-mcp-tracking.json'),
      'Path should contain tracking filename');
    assert.strictEqual(
      path.dirname(location.trackingPath),
      path.dirname(location.configPath),
      'Tracking file should be in same directory as mcp.json'
    );
  });

  test('getMcpConfigLocation returns location info for user scope', () => {
    const location = McpConfigLocator.getMcpConfigLocation('user');

    assert.ok(location, 'Should return location object');
    assert.ok(location.configPath, 'Should have config path');
    assert.ok(location.trackingPath, 'Should have tracking path');
    assert.strictEqual(typeof location.exists, 'boolean', 'Should have exists flag');
    assert.ok(location.serversKey, 'Should carry the serversKey for the scope');
    assert.ok(location.format, 'Should carry the on-disk format for the scope');
  });
});
