import * as path from 'path';
import * as vscode from 'vscode';

export const JJ_SCHEME = 'jj';

export interface JjUriParams {
  root: string;
  /** Revset naming exactly one revision, e.g. `@-` or a commit id. */
  rev: string;
  /** Path relative to the repo root, forward slashes. */
  path: string;
}

/** A read-only document holding a file's content at a revision. */
export function toJjUri(params: JjUriParams): vscode.Uri {
  return vscode.Uri.from({
    scheme: JJ_SCHEME,
    // Keep the real file path so the editor picks the right language and icon.
    path: vscode.Uri.file(path.join(params.root, params.path)).path,
    query: JSON.stringify(params),
  });
}

export function fromJjUri(uri: vscode.Uri): JjUriParams {
  return JSON.parse(uri.query) as JjUriParams;
}

export function relativeTo(root: string, fsPath: string): string | undefined {
  const rel = path.relative(root, fsPath);
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return undefined;
  return rel.split(path.sep).join('/');
}
