import * as vscode from 'vscode';
import { exactFileset } from './parse';
import { JjRepository } from './repository';
import { fromJjUri, JJ_SCHEME } from './uri';

/** Serves `jj:` URIs: a file's content at a revision, for diffs and quick diff. */
export class JjContentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this._onDidChange.event;
  private readonly registration: vscode.Disposable;

  constructor(private readonly findRepo: (root: string) => JjRepository | undefined) {
    this.registration = vscode.workspace.registerTextDocumentContentProvider(JJ_SCHEME, this);
  }

  /** Revsets like `@-` move after every operation, so re-read open documents of that repo. */
  repoChanged(root: string): void {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri.scheme === JJ_SCHEME && fromJjUri(doc.uri).root === root) this._onDidChange.fire(doc.uri);
    }
  }

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const { root, rev, path } = fromJjUri(uri);
    const repo = this.findRepo(root);
    if (!repo) return '';
    try {
      return await repo.cli.run(['file', 'show', '-r', rev, '--', exactFileset(path)]);
    } catch {
      // Not present at that revision (added file), or the revset has several parents.
      return '';
    }
  }

  dispose(): void {
    this.registration.dispose();
    this._onDidChange.dispose();
  }
}
