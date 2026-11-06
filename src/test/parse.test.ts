import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classifyPath, exactFileset, isLockError, parseFiles, parseLog, parseStatus, revsetId } from '../parse';

const rev = (over: Partial<Record<number, string>> = {}) => {
  const f = ['abcdefghijklmnop', 'abcdefgh', '0123456789abcdef', '01234567', 'summary', 'main feat', '1', '0', '0', '0', 'Ann', '2 hours ago'];
  for (const [i, v] of Object.entries(over)) f[+i] = v!;
  return f;
};

test('parseStatus reads revision, multi-line description and files', () => {
  const out = [...rev(), 'summary\n\nbody\n', 'modified', 'a.txt', 'a.txt', '0', 'renamed', 'old name.txt', 'src/new.txt', '0', 'removed', 'gone.txt', 'gone.txt', '0', 'modified', 'c.txt', 'c.txt', '1', ''].join('\0');
  const s = parseStatus(out);
  assert.equal(s.revision.changeIdShort, 'abcdefgh');
  assert.deepEqual(s.revision.bookmarks, ['main', 'feat']);
  assert.equal(s.revision.isWorkingCopy, true);
  assert.equal(s.description, 'summary\n\nbody');
  assert.deepEqual(s.files, [
    { status: 'modified', path: 'a.txt', conflict: false },
    { status: 'renamed', path: 'src/new.txt', oldPath: 'old name.txt', conflict: false },
    { status: 'removed', path: 'gone.txt', conflict: false },
    { status: 'modified', path: 'c.txt', conflict: true },
  ]);
});

test('parseStatus handles an empty change with no description', () => {
  const s = parseStatus([...rev({ 4: '', 5: '', 7: '1' }), '', ''].join('\0'));
  assert.equal(s.revision.summary, '');
  assert.deepEqual(s.revision.bookmarks, []);
  assert.equal(s.revision.empty, true);
  assert.deepEqual(s.files, []);
});

test('parseStatus rejects garbage', () => {
  assert.throws(() => parseStatus('Error: something'));
});

test('parseLog reads one revision per line', () => {
  const line = (id: string) => [...rev({ 1: id })].join('\0') + '\0';
  const revs = parseLog(`${line('aaaa')}\n${line('bbbb')}\n`);
  assert.deepEqual(revs.map((r) => r.changeIdShort), ['aaaa', 'bbbb']);
});

test('parseFiles normalizes Windows separators', () => {
  assert.deepEqual(parseFiles(['added', 'src\\x.ts', 'src\\x.ts', '0', ''].join('\0')), [
    { status: 'added', path: 'src/x.ts', conflict: false },
  ]);
});

test('exactFileset escapes quotes and backslashes', () => {
  assert.equal(exactFileset('dir/a "b".txt'), 'root-file:"dir/a \\"b\\".txt"');
  assert.equal(exactFileset('*.txt'), 'root-file:"*.txt"');
});

test('revsetId only accepts ids', () => {
  assert.equal(revsetId('abc123'), 'abc123');
  assert.throws(() => revsetId('all()'));
  assert.throws(() => revsetId('a | b'));
});

test('classifyPath ignores what the git extension writes', () => {
  for (const p of ['.git/index', '.git/index.lock', '.git/FETCH_HEAD', '.git/objects/ab/cdef', '.git/logs/HEAD', '.git/config', '.git/refs/heads/main.lock', '.git/refs/jj/keep/abc']) {
    assert.equal(classifyPath(p), 'ignore', p);
  }
});

test('classifyPath ignores jj internals except new operations', () => {
  assert.equal(classifyPath('.jj/working_copy/checkout'), 'ignore');
  assert.equal(classifyPath('.jj/repo/store/extra/abc'), 'ignore');
  assert.equal(classifyPath('.jj/repo/op_heads/heads/0f3a'), 'jjOp');
});

test('classifyPath reports moved git refs and HEAD', () => {
  assert.equal(classifyPath('.git/HEAD'), 'gitRefs');
  assert.equal(classifyPath('.git/refs/heads/main'), 'gitRefs');
  assert.equal(classifyPath('.git/refs/remotes/origin/main'), 'gitRefs');
  assert.equal(classifyPath('.git/packed-refs'), 'gitRefs');
});

test('classifyPath treats user files as working copy changes', () => {
  assert.equal(classifyPath('src/index.ts'), 'workingCopy');
  assert.equal(classifyPath('.github/workflows/ci.yml'), 'workingCopy');
  assert.equal(classifyPath('.gitignore'), 'workingCopy');
  assert.equal(classifyPath('vendor/lib/.git/HEAD'), 'ignore');
  assert.equal(classifyPath('.'), 'ignore');
});

test('isLockError recognizes lock contention', () => {
  assert.ok(isLockError("fatal: Unable to create '/r/.git/index.lock': File exists."));
  assert.ok(isLockError('Error: Failed to lock working copy'));
  assert.ok(!isLockError('Error: Revision "foo" doesn\'t exist'));
});
