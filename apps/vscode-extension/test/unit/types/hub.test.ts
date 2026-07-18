import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as yaml from 'js-yaml';
import {
  hasPathTraversal,
  HubConfig,
  HubReference,
  isValidProtocol,
  sanitizeHubId,
  validateHubConfig,
  validateHubReference,
} from '../../../src/types/hub';

suite('Hub Types - TDD Implementation', () => {
  suite('validateHubReference', () => {
    test('should validate valid GitHub reference', () => {
      const ref: HubReference = {
        type: 'github',
        location: 'promptregistry/official-hub',
        ref: 'main'
      };

      assert.doesNotThrow(() => validateHubReference(ref));
    });

    test('should reject path traversal in local paths', () => {
      const ref: HubReference = {
        type: 'local',
        location: '../../etc/passwd'
      };

      assert.throws(
        () => validateHubReference(ref),
        /Path traversal detected/
      );
    });

    test('should reject non-HTTPS URLs', () => {
      const ref: HubReference = {
        type: 'url',
        location: 'http://example.com/hub.yml'
      };

      assert.throws(
        () => validateHubReference(ref),
        /Only HTTPS URLs are allowed/
      );
    });

    test('should reject invalid GitHub format', () => {
      const ref: HubReference = {
        type: 'github',
        location: 'invalid-format'
      };

      assert.throws(
        () => validateHubReference(ref),
        /Invalid GitHub repository format/
      );
    });

    test('should reject empty location', () => {
      const ref: HubReference = {
        type: 'github',
        location: ''
      };

      assert.throws(
        () => validateHubReference(ref),
        /Location cannot be empty/
      );
    });

    test('should reject FTP URLs', () => {
      const ref: HubReference = {
        type: 'url',
        location: 'ftp://malicious.com/hub.yml'
      };

      assert.throws(
        () => validateHubReference(ref),
        /Only HTTPS URLs are allowed/
      );
    });
  });

  suite('validateHubConfig', () => {
    let validConfig: HubConfig;

    setup(() => {
      const fixtureContent = fs.readFileSync(
        path.join(__dirname, '../../fixtures/hubs/valid-hub-config.yml'),
        'utf8'
      );
      validConfig = yaml.load(fixtureContent) as HubConfig;
    });

    test('should validate complete valid hub config', () => {
      const result = validateHubConfig(validConfig);

      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.errors.length, 0);
    });

    test('should reject config without version', () => {
      const config = { ...validConfig };
      delete (config as any).version;

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('version is required'));
    });

    test('should reject config with invalid version format', () => {
      const config = { ...validConfig, version: 'invalid' };

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e: string) => e.includes('semver')));
    });

    test('should reject config without metadata', () => {
      const config = { ...validConfig };
      delete (config as any).metadata;

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('metadata is required'));
    });

    test('should reject config without sources', () => {
      const config = { ...validConfig };
      delete (config as any).sources;

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.includes('sources is required'));
    });

    test('should validate config with empty profiles array', () => {
      const config = { ...validConfig, profiles: [] };

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, true);
    });

    test('should detect bundle referencing non-existent source', () => {
      const config = { ...validConfig };
      config.profiles[0].bundles[0].source = 'non-existent-source';

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e: string) => e.includes('non-existent source')));
    });

    test('should validate checksum format - reject invalid', () => {
      const config = { ...validConfig };
      config.metadata.checksum = 'invalid-checksum';

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e: string) => e.includes('checksum')));
    });

    test('should validate checksum format - accept sha256', () => {
      const config = { ...validConfig };
      config.metadata.checksum = 'sha256:abc123def456';

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, true);
    });

    test('should validate checksum format - accept sha512', () => {
      const config = { ...validConfig };
      config.metadata.checksum = 'sha512:abc123def456789';

      const result = validateHubConfig(config);

      assert.strictEqual(result.valid, true);
    });
  });

  suite('sanitizeHubId', () => {
    test('should accept valid alphanumeric IDs', () => {
      assert.doesNotThrow(() => sanitizeHubId('valid-hub-id'));
      assert.doesNotThrow(() => sanitizeHubId('hub123'));
      assert.doesNotThrow(() => sanitizeHubId('my_hub'));
    });

    test('should reject IDs with path traversal', () => {
      assert.throws(() => sanitizeHubId('../etc'), /Invalid hub ID/);
      assert.throws(() => sanitizeHubId('../../passwd'), /Invalid hub ID/);
    });

    test('should reject IDs with slashes', () => {
      assert.throws(() => sanitizeHubId('hub/id'), /Invalid hub ID/);
      assert.throws(() => sanitizeHubId('hub\\id'), /Invalid hub ID/);
    });

    test('should reject IDs with special characters', () => {
      assert.throws(() => sanitizeHubId('hub@id'), /Invalid hub ID/);
      assert.throws(() => sanitizeHubId('hub#id'), /Invalid hub ID/);
    });

    test('should reject empty IDs', () => {
      assert.throws(() => sanitizeHubId(''), /Invalid hub ID/);
    });

    test('should reject very long IDs', () => {
      const longId = 'a'.repeat(256);
      assert.throws(() => sanitizeHubId(longId), /Invalid hub ID/);
    });
  });

  suite('Security utilities', () => {
    suite('isValidProtocol', () => {
      test('should accept HTTPS protocol', () => {
        assert.strictEqual(isValidProtocol('https:'), true);
      });

      test('should reject HTTP protocol', () => {
        assert.strictEqual(isValidProtocol('http:'), false);
      });

      test('should reject FTP protocol', () => {
        assert.strictEqual(isValidProtocol('ftp:'), false);
      });

      test('should reject file protocol', () => {
        assert.strictEqual(isValidProtocol('file:'), false);
      });
    });

    suite('hasPathTraversal', () => {
      test('should detect .. in path', () => {
        assert.strictEqual(hasPathTraversal('../etc'), true);
        assert.strictEqual(hasPathTraversal('../../passwd'), true);
        assert.strictEqual(hasPathTraversal('/home/../etc'), true);
      });

      test('should not flag valid paths', () => {
        assert.strictEqual(hasPathTraversal('/home/user/config.yml'), false);
        assert.strictEqual(hasPathTraversal('config/hub.yml'), false);
      });

      test('should handle encoded path traversal', () => {
        assert.strictEqual(hasPathTraversal('%2e%2e/etc'), true);
        assert.strictEqual(hasPathTraversal('..%2Fetc'), true);
      });
    });
  });

  suite('Security tests - malicious inputs', () => {
    let maliciousConfig: any;

    setup(() => {
      const fixtureContent = fs.readFileSync(
        path.join(__dirname, '../../fixtures/hubs/malicious-hub-config.yml'),
        'utf8'
      );
      maliciousConfig = yaml.load(fixtureContent);
    });

    test('should reject config with path traversal in source ID', () => {
      const result = validateHubConfig(maliciousConfig);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e: string) =>
        e.includes('path traversal') || e.includes('../')
      ));
    });

    test('should reject config with path traversal in bundle ID', () => {
      const result = validateHubConfig(maliciousConfig);

      assert.strictEqual(result.valid, false);
      assert.ok(result.errors.some((e: string) =>
        e.includes('traversal') || e.includes('../')
      ));
    });
  });
});
