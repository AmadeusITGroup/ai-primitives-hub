/**
 * Contract tests for the hub's `info/exclude` section text
 * (`addExcludeEntries`, `removeExcludeEntries`), shared by the
 * repository-scope writer and the install record store. The exact bytes of
 * the writer's cases are pinned in infra's git-info-exclude tests.
 */
import {
  describe,
  expect,
  it,
} from 'vitest';
import {
  addExcludeEntries,
  GIT_EXCLUDE_SECTION_HEADER as HEADER,
  removeExcludeEntries,
} from '../../../src/domain/install/git-exclude';

const RECORD = 'ai-primitives-hub.local.lock.json';

describe('addExcludeEntries', () => {
  it.each([
    ['a missing or empty file', '', [RECORD], `${HEADER}\n${RECORD}`],
    ['a file without the header', 'node_modules\n', [RECORD], `node_modules\n\n${HEADER}\n${RECORD}`],
    ['a CRLF header', `${HEADER}\r\nold\r\n`, [RECORD], `${HEADER}\r\n${RECORD}\nold\r\n`]
  ])('adds the entry below the header in %s', (_case, text, entries, expected) => {
    expect(addExcludeEntries(text, entries)).toBe(expected);
  });

  it.each([
    ['as is', `${HEADER}\n${RECORD}\n`],
    ['with a leading slash', `/${RECORD}\n`],
    ['with surrounding spaces', `  ${RECORD}  \r\n`]
  ])('changes nothing when the entry is already listed %s', (_case, text) => {
    expect(addExcludeEntries(text, [RECORD])).toBeUndefined();
  });
});

describe('removeExcludeEntries', () => {
  it('removes the entry from below the header and keeps the header', () => {
    expect(removeExcludeEntries(`node_modules\n${HEADER}\n/${RECORD}\nother\n`, [RECORD])).toBe(`node_modules\n${HEADER}\nother\n`);
  });

  it.each([
    ['no header', `${RECORD}\n`],
    ['the entry only above the header', `${RECORD}\n${HEADER}\nother\n`],
    ['no matching entry', `${HEADER}\nother\n`]
  ])('changes nothing with %s', (_case, text) => {
    expect(removeExcludeEntries(text, [RECORD])).toBeUndefined();
  });
});
