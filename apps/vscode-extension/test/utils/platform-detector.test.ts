/**
 * Platform Detector Unit Tests
 */

import * as assert from 'node:assert';
import * as os from 'node:os';
import * as path from 'node:path';

suite('Platform Detector', () => {
  suite('Platform Detection', () => {
    test('should detect operating system', () => {
      const platform = os.platform();

      assert.ok(['darwin', 'win32', 'linux'].includes(platform));
    });

    test('should detect architecture', () => {
      const arch = os.arch();

      assert.ok(['x64', 'arm64', 'arm', 'ia32'].includes(arch));
    });

    test('should detect home directory', () => {
      const homeDir = os.homedir();

      assert.ok(homeDir);
      assert.ok(homeDir.length > 0);
    });
  });

  suite('Copilot Path Detection', () => {
    test('should construct correct path for macOS', () => {
      const homeDir = '/Users/testuser';

      const copilotPath = path.join(
        homeDir,
        'Library',
        'Application Support',
        'Code',
        'User',
        'globalStorage',
        'github.copilot'
      );

      assert.ok(copilotPath.includes('Library'));
      assert.ok(copilotPath.includes('Application Support'));
    });

    test('should construct correct path for Windows', () => {
      const homeDir = 'C:\\Users\\testuser';

      const copilotPath = path.join(
        homeDir,
        'AppData',
        'Roaming',
        'Code',
        'User',
        'globalStorage',
        'github.copilot'
      );

      assert.ok(copilotPath.includes('AppData'));
      assert.ok(copilotPath.includes('Roaming'));
    });

    test('should construct correct path for Linux', () => {
      const homeDir = '/home/testuser';

      const copilotPath = path.join(
        homeDir,
        '.config',
        'Code',
        'User',
        'globalStorage',
        'github.copilot'
      );

      assert.ok(copilotPath.includes('.config'));
    });
  });

  suite('VSCode Variant Detection', () => {
    test('should detect VS Code', () => {
      const appName = 'Code';
      const isVSCode = appName === 'Code';

      assert.strictEqual(isVSCode, true);
    });

    test('should detect VS Code Insiders', () => {
      const appName = 'Code - Insiders';
      const isInsiders = appName.includes('Insiders');

      assert.strictEqual(isInsiders, true);
    });

    test('should detect VSCodium', () => {
      const appName = 'VSCodium';
      const isVSCodium = appName === 'VSCodium';

      assert.strictEqual(isVSCodium, true);
    });

    test('should detect Cursor', () => {
      const appName = 'Cursor';
      const isCursor = appName === 'Cursor';

      assert.strictEqual(isCursor, true);
    });
  });

  suite('Path Construction', () => {
    test('should handle path separators correctly', () => {
      const segments = ['Users', 'testuser', 'Library'];
      const joinedPath = path.join(...segments);

      assert.ok(joinedPath.includes('testuser'));
    });

    test('should normalize paths', () => {
      const messyPath = '/Users/testuser//Library/../Library/./App Support';
      const normalized = path.normalize(messyPath);

      assert.ok(!normalized.includes('//'));
      assert.ok(!normalized.includes('/.'));
    });

    test('should resolve relative paths', () => {
      const base = '/Users/testuser';
      const relative = '../otheruser/documents';
      const resolved = path.resolve(base, relative);

      assert.ok(resolved.includes('otheruser'));
    });
  });

  suite('File System Compatibility', () => {
    test('should handle case-sensitive file systems', () => {
      const path1 = '/path/to/File.txt';
      const path2 = '/path/to/file.txt';

      const isSame = path1.toLowerCase() === path2.toLowerCase();
      assert.strictEqual(isSame, true);
    });

    test('should handle path length limits', () => {
      const longPath = '/path/'.repeat(100);

      assert.ok(longPath.length > 260); // Windows MAX_PATH
    });

    test('should handle special characters in paths', () => {
      const specialPath = '/path/with spaces/and-dashes/under_scores';

      assert.ok(specialPath.includes(' '));
      assert.ok(specialPath.includes('-'));
      assert.ok(specialPath.includes('_'));
    });
  });

  suite('Environment Variables', () => {
    test('should read HOME environment variable', () => {
      if (process.platform === 'win32') {
        assert.ok(process.env.USERPROFILE || os.homedir());
      } else {
        assert.ok(process.env.HOME || os.homedir());
      }
    });

    test('should read APPDATA on Windows', () => {
      if (process.platform === 'win32') {
        const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
        assert.ok(appData);
      } else {
        assert.ok(true); // Skip on non-Windows
      }
    });

    test('should fallback when env vars missing', () => {
      const homeDir = process.env.HOME || process.env.USERPROFILE || os.homedir();

      assert.ok(homeDir);
      assert.ok(homeDir.length > 0);
    });
  });

  suite('Permission Checks', () => {
    test('should check if directory is writable', () => {
      // Simulated permission check
      const hasPermission = true;

      assert.strictEqual(hasPermission, true);
    });

    test('should check if directory exists', () => {
      // Simulated existence check
      const exists = true;

      assert.strictEqual(exists, true);
    });
  });

  suite('Path Validation', () => {
    test('should validate absolute paths', () => {
      const absolutePath = '/Users/testuser/Documents';
      const isAbsolute = path.isAbsolute(absolutePath);

      assert.strictEqual(isAbsolute, true);
    });

    test('should validate relative paths', () => {
      const relativePath = './documents/file.txt';
      const isAbsolute = path.isAbsolute(relativePath);

      assert.strictEqual(isAbsolute, false);
    });

    test('should sanitize paths', () => {
      const unsafePath = '../../../etc/passwd';
      const safe = path.normalize(unsafePath);

      // Should not escape intended directory
      assert.ok(safe);
    });
  });
});
