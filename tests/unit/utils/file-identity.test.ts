import { expect, it } from 'vitest';
import { fileIdentity, matchesFileIdentity } from '../../../src/utils/file-identity.js';

it('keeps Linux identity stable when libuv substitutes changing ctime for birthtime', () => {
  const before = { dev: 1, ino: 2, birthtimeMs: 100, ctimeMs: 100 };
  const appended = { ...before, birthtimeMs: 200, ctimeMs: 200 };
  expect(fileIdentity(before, 'linux')).toBe(fileIdentity(appended, 'linux'));
  expect(matchesFileIdentity(fileIdentity(before, 'linux'), appended, 'linux')).toBe(true);
  expect(matchesFileIdentity('1:2:100', appended, 'linux')).toBe(true);
  expect(matchesFileIdentity('1:3:100', appended, 'linux')).toBe(false);
});

it('does not switch Linux identity when real birthtime initially equals ctime', () => {
  const initial = { dev: 1, ino: 2, birthtimeMs: 100, ctimeMs: 100 };
  const appended = { ...initial, ctimeMs: 200 };
  expect(fileIdentity(initial, 'linux')).toBe(fileIdentity(appended, 'linux'));
  expect(fileIdentity({ dev: 1, ino: 2, birthtimeMs: 100 }, 'darwin'))
    .not.toBe(fileIdentity({ dev: 1, ino: 2, birthtimeMs: 200 }, 'darwin'));
});
