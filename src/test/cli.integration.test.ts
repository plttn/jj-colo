import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { JjCli } from '../cli';
import { exactFileset, LOG_TEMPLATE, parseLog, parseStatus, STATUS_TEMPLATE } from '../parse';

const jj = process.env.JJ_PATH || 'jj';
let hasJj = true;
try {
  execFileSync(jj, ['--version']);
} catch {
  hasJj = false;
}

test('round trip against a real colocated repo', { skip: !hasJj && 'jj not installed' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'jj-colo-'));
  try {
    execFileSync(jj, ['git', 'init', '--colocate'], { cwd: root, stdio: 'ignore' });
    const cli = new JjCli(() => jj, root);
    const cfg = ['--config', 'user.name=Test', '--config', 'user.email=test@example.com'];

    writeFileSync(join(root, 'a "q".txt'), 'one\n');
    const s1 = parseStatus(await cli.run(['log', '-r', '@', '--no-graph', '-T', STATUS_TEMPLATE], { snapshot: true }));
    assert.deepEqual(s1.files.map((f) => [f.status, f.path]), [['added', 'a "q".txt']]);

    await cli.run([...cfg, 'commit', '-m', 'first\n\nbody'], { snapshot: true });
    writeFileSync(join(root, 'a "q".txt'), 'two\n');
    const s2 = parseStatus(await cli.run(['log', '-r', '@', '--no-graph', '-T', STATUS_TEMPLATE], { snapshot: true }));
    assert.deepEqual(s2.files.map((f) => f.status), ['modified']);

    // Content of the parent is what diffs and quick diff compare against.
    assert.equal(await cli.run(['file', 'show', '-r', '@-', '--', exactFileset('a "q".txt')]), 'one\n');

    const log = parseLog(await cli.run(['log', '--no-graph', '-r', '::@', '-T', LOG_TEMPLATE]));
    assert.equal(log[0].isWorkingCopy, true);
    assert.equal(log[1].summary, 'first');
    assert.equal(log.at(-1)!.immutable, true);

    // Colocated: jj moved git's HEAD to @-.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root }).toString().trim();
    assert.equal(head, log[1].commitId);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
