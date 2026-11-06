// Pure parsing helpers. No `vscode` import so they can be unit tested with `node --test`.

/** Field separator used in all jj templates. NUL never appears in paths, ids or names. */
const SEP = '"\\0"';

export type FileStatus = 'modified' | 'added' | 'removed' | 'copied' | 'renamed';

export interface FileChange {
  status: FileStatus;
  /** Path relative to the repo root, always with forward slashes. */
  path: string;
  /** Previous path, for renames and copies. */
  oldPath?: string;
  conflict: boolean;
}

export interface Revision {
  changeId: string;
  changeIdShort: string;
  commitId: string;
  commitIdShort: string;
  /** First line of the description ('' when none set). */
  summary: string;
  bookmarks: string[];
  isWorkingCopy: boolean;
  empty: boolean;
  conflict: boolean;
  immutable: boolean;
  author: string;
  ago: string;
}

const REV_FIELDS = [
  'change_id',
  'change_id.shortest(8)',
  'commit_id',
  'commit_id.shortest(8)',
  'description.first_line()',
  'bookmarks.join(" ")',
  'if(current_working_copy, "1", "0")',
  'if(empty, "1", "0")',
  'if(conflict, "1", "0")',
  'if(immutable, "1", "0")',
  'author.name()',
  'author.timestamp().ago()',
];
const REV_FIELD_COUNT = REV_FIELDS.length;

const revFields = REV_FIELDS.map((f) => `${f} ++ ${SEP}`).join(' ++ ');

const filesTemplate =
  'self.diff().files().map(|f| ' +
  `f.status() ++ ${SEP} ++ f.source().path() ++ ${SEP} ++ f.target().path() ++ ${SEP} ++ ` +
  `if(f.target().conflict(), "1", "0") ++ ${SEP}).join("")`;

/** One revision per call: revision fields, full description, then the changed files. */
export const STATUS_TEMPLATE = `${revFields} ++ description ++ ${SEP} ++ ${filesTemplate}`;

/** Revision fields only, one record per line (for `jj log --no-graph`). */
export const LOG_TEMPLATE = `${revFields} ++ "\\n"`;

/** Changed files only (for expanding a revision in the log view). */
export const FILES_TEMPLATE = filesTemplate;

function toRevision(t: string[]): Revision {
  return {
    changeId: t[0],
    changeIdShort: t[1],
    commitId: t[2],
    commitIdShort: t[3],
    summary: t[4],
    bookmarks: t[5] ? t[5].split(' ').filter(Boolean) : [],
    isWorkingCopy: t[6] === '1',
    empty: t[7] === '1',
    conflict: t[8] === '1',
    immutable: t[9] === '1',
    author: t[10],
    ago: t[11],
  };
}

const normalize = (p: string) => p.replace(/\\/g, '/');

function parseFileTokens(t: string[]): FileChange[] {
  const files: FileChange[] = [];
  for (let i = 0; i + 3 < t.length; i += 4) {
    const status = t[i] as FileStatus;
    const source = normalize(t[i + 1]);
    const target = normalize(t[i + 2]);
    const conflict = t[i + 3] === '1';
    if (status === 'removed') {
      files.push({ status, path: source, conflict });
    } else if ((status === 'renamed' || status === 'copied') && source !== target) {
      files.push({ status, path: target, oldPath: source, conflict });
    } else {
      files.push({ status, path: target, conflict });
    }
  }
  return files;
}

function tokens(out: string): string[] {
  const t = out.split('\0');
  if (t.length && t[t.length - 1] === '') t.pop();
  return t;
}

export interface StatusResult {
  revision: Revision;
  description: string;
  files: FileChange[];
}

export function parseStatus(out: string): StatusResult {
  const t = tokens(out);
  if (t.length < REV_FIELD_COUNT + 1) {
    throw new Error(`Unexpected jj status output: ${JSON.stringify(out.slice(0, 200))}`);
  }
  return {
    revision: toRevision(t.slice(0, REV_FIELD_COUNT)),
    description: t[REV_FIELD_COUNT].replace(/\n$/, ''),
    files: parseFileTokens(t.slice(REV_FIELD_COUNT + 1)),
  };
}

export function parseLog(out: string): Revision[] {
  return out
    .split('\n')
    .filter((line) => line.includes('\0'))
    .map((line) => toRevision(tokens(line)));
}

export function parseFiles(out: string): FileChange[] {
  return parseFileTokens(tokens(out));
}

/** Build a fileset that matches exactly one root-relative path, regardless of cwd or glob chars. */
export function exactFileset(relPath: string): string {
  const escaped = normalize(relPath).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return `root-file:"${escaped}"`;
}

/** Quote a revision id for use in a revset. Change and commit ids are plain hex/letters. */
export function revsetId(id: string): string {
  if (!/^[0-9a-z]+$/.test(id)) throw new Error(`Not a revision id: ${id}`);
  return id;
}

// ---------------------------------------------------------------------------
// File watcher classification
// ---------------------------------------------------------------------------

/**
 * What a file change under the repo root means for us.
 *
 * - `ignore`: noise we must not react to. This includes everything the git
 *   extension writes during its own refreshes (`.git/index`, `index.lock`,
 *   `FETCH_HEAD`, objects...). Reacting to those is what makes two SCM
 *   extensions refresh each other forever.
 * - `workingCopy`: a user file changed. jj needs a snapshot.
 * - `jjOp`: a jj operation finished (from us, a terminal or another tool).
 * - `gitRefs`: git refs or HEAD moved, e.g. a `git` command in the terminal.
 */
export type WatchKind = 'ignore' | 'workingCopy' | 'jjOp' | 'gitRefs';

export function classifyPath(relPath: string): WatchKind {
  const p = normalize(relPath).replace(/^\.\//, '');
  if (p === '' || p === '.') return 'ignore';

  if (p === '.jj' || p.startsWith('.jj/')) {
    return p.startsWith('.jj/repo/op_heads/heads/') ? 'jjOp' : 'ignore';
  }
  if (p === '.git' || p.startsWith('.git/')) {
    if (p === '.git/HEAD' || p === '.git/packed-refs') return 'gitRefs';
    // refs/jj/* is jj's own bookkeeping (keep-alive refs), never a user action.
    if (p.startsWith('.git/refs/jj/')) return 'ignore';
    if (p.startsWith('.git/refs/') && !p.endsWith('.lock')) return 'gitRefs';
    return 'ignore';
  }
  // Nested repositories (submodules, vendored checkouts) are not ours to snapshot for.
  if (p.includes('/.git/') || p.includes('/.jj/')) return 'ignore';
  return 'workingCopy';
}

/** Matches jj/git errors caused by another process (often the git extension) holding a lock. */
export function isLockError(stderr: string): boolean {
  return /index\.lock|unable to (create|lock)|could not lock|failed to lock|resource temporarily unavailable/i.test(
    stderr,
  );
}

export function isStaleError(stderr: string): boolean {
  return /working copy is stale/i.test(stderr);
}
