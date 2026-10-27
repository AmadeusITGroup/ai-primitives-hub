import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  categoryOf,
  INSTALL_CATEGORIES,
  KIND_INSTALL_CATEGORIES,
  PRIMITIVE_KINDS,
} from '../../../src';

describe('install categories', () => {
  it('lists the three ADR-0009 categories', () => {
    expect(INSTALL_CATEGORIES).toEqual(['file', 'directory', 'config']);
  });

  it('assigns a category to every primitive kind and nothing else', () => {
    expect(Object.keys(KIND_INSTALL_CATEGORIES).toSorted()).toEqual([...PRIMITIVE_KINDS].toSorted());
  });

  it('reflects today\'s mapping: skill and plugin are directories, mcp-server is config, the rest are files', () => {
    expect(KIND_INSTALL_CATEGORIES).toEqual({
      prompt: 'file',
      instruction: 'file',
      'chat-mode': 'file',
      agent: 'file',
      skill: 'directory',
      plugin: 'directory',
      hook: 'file',
      'mcp-server': 'config',
      steering: 'file',
      spec: 'file',
      command: 'file',
      rule: 'file',
      'output-style': 'file',
      tool: 'file',
      power: 'file',
      knowledge: 'file',
      playbook: 'file'
    });
  });

  it('returns the table value from categoryOf', () => {
    for (const kind of PRIMITIVE_KINDS) {
      expect(categoryOf(kind)).toBe(KIND_INSTALL_CATEGORIES[kind]);
    }
  });
});
