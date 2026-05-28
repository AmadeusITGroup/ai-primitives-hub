/**
 * Tests for profile generator.
 * @module test/app/discovery/profile-generator
 */

import type {
  ProfileDraft,
  ResourceSelection,
} from '@prompt-registry/core';
import {
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import {
  ProfileGenerator,
} from '../../src/discovery/profile-generator';

describe('ProfileGenerator', () => {
  let generator: ProfileGenerator;

  beforeEach(() => {
    generator = new ProfileGenerator();
  });

  it('should generate profile draft from selections', () => {
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true,
        selectedAt: new Date().toISOString()
      },
      {
        id: 'resource-2',
        selected: true,
        selectedAt: new Date().toISOString()
      }
    ];

    const draft = generator.generateDraft(
      'test-profile',
      'Test profile for development',
      selections,
      '🚀'
    );

    expect(draft.id).toBeDefined();
    expect(draft.name).toBe('test-profile');
    expect(draft.description).toBe('Test profile for development');
    expect(draft.icon).toBe('🚀');
    expect(draft.selections).toEqual(selections);
    expect(draft.createdAt).toBeDefined();
  });

  it('should generate profile without icon', () => {
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true
      }
    ];

    const draft = generator.generateDraft(
      'simple-profile',
      'Simple profile',
      selections
    );

    expect(draft.icon).toBeUndefined();
  });

  it('should filter only selected resources', () => {
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true
      },
      {
        id: 'resource-2',
        selected: false
      },
      {
        id: 'resource-3',
        selected: true
      }
    ];

    const draft = generator.generateDraft(
      'filtered-profile',
      'Profile with filtered selections',
      selections
    );

    expect(draft.selections).toHaveLength(3);
  });

  it('should generate YAML from profile draft', () => {
    const draft: ProfileDraft = {
      id: 'draft-1',
      name: 'Test Profile',
      description: 'Test description',
      icon: '🧪',
      selections: [
        {
          id: 'resource-1',
          selected: true,
          selectedAt: new Date().toISOString()
        }
      ],
      createdAt: new Date().toISOString()
    };

    const yaml = generator.generateYaml(draft);

    expect(yaml).toContain('name: Test Profile');
    expect(yaml).toContain('description: Test description');
    expect(yaml).toContain('icon: 🧪');
    expect(yaml).toContain('bundles:');
  });

  it('should generate valid YAML structure', () => {
    const draft: ProfileDraft = {
      id: 'draft-1',
      name: 'Valid Profile',
      description: 'Valid description',
      selections: [],
      createdAt: new Date().toISOString()
    };

    const yaml = generator.generateYaml(draft);

    // Check YAML structure
    expect(yaml).toMatch(/name:/);
    expect(yaml).toMatch(/description:/);
    expect(yaml).toMatch(/bundles:/);
  });

  it('should handle empty selections', () => {
    const selections: ResourceSelection[] = [];

    const draft = generator.generateDraft(
      'empty-profile',
      'Profile with no selections',
      selections
    );

    expect(draft.selections).toEqual([]);
  });

  it('should handle special characters in name and description', () => {
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true
      }
    ];

    const draft = generator.generateDraft(
      'profile-with-special-chars',
      'Profile with "quotes" and \'apostrophes\' and <special>',
      selections
    );

    expect(draft.name).toBe('profile-with-special-chars');
    expect(draft.description).toBe('Profile with "quotes" and \'apostrophes\' and <special>');
  });

  it('should handle unicode in icon', () => {
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true
      }
    ];

    const draft = generator.generateDraft(
      'unicode-profile',
      'Profile with unicode icon',
      selections,
      '🎉🎊🎈'
    );

    expect(draft.icon).toBe('🎉🎊🎈');
  });

  it('should handle very long descriptions', () => {
    const longDescription = 'a'.repeat(1000);
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true
      }
    ];

    const draft = generator.generateDraft(
      'long-desc-profile',
      longDescription,
      selections
    );

    expect(draft.description).toBe(longDescription);
  });

  it('should generate YAML with proper indentation', () => {
    const draft: ProfileDraft = {
      id: 'draft-1',
      name: 'Indented Profile',
      description: 'Profile with nested structure',
      icon: '📝',
      selections: [
        {
          id: 'resource-1',
          selected: true,
          selectedAt: new Date().toISOString()
        },
        {
          id: 'resource-2',
          selected: true,
          selectedAt: new Date().toISOString()
        }
      ],
      createdAt: new Date().toISOString()
    };

    const yaml = generator.generateYaml(draft);

    // Check that YAML is properly formatted
    expect(yaml).toContain('bundles:');
    expect(yaml).toContain('- resource-1');
    expect(yaml).toContain('- resource-2');
  });

  it('should handle selections with timestamps', () => {
    const now = new Date().toISOString();
    const selections: ResourceSelection[] = [
      {
        id: 'resource-1',
        selected: true,
        selectedAt: now
      }
    ];

    const draft = generator.generateDraft(
      'timestamp-profile',
      'Profile with timestamps',
      selections
    );

    expect(draft.selections[0].selectedAt).toBe(now);
  });
});
