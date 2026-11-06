import * as vscode from 'vscode';

// Minimal slice of the built-in git extension's public API (extensions/git/src/api/git.d.ts).
interface GitRepository {
  readonly rootUri: vscode.Uri;
  status(): Promise<void>;
}
interface GitAPI {
  readonly repositories: GitRepository[];
  getRepository(uri: vscode.Uri): GitRepository | null;
  readonly onDidOpenRepository: vscode.Event<GitRepository>;
  readonly onDidCloseRepository: vscode.Event<GitRepository>;
}
interface GitExtension {
  readonly enabled: boolean;
  getAPI(version: 1): GitAPI;
}

/**
 * Cooperates with the built-in git extension instead of competing with it.
 *
 * We never change git settings or hide git's provider. We only use its public
 * API to (a) tell it to refresh right after a jj command moved HEAD, so it
 * doesn't have to discover that through its own watcher at a bad moment, and
 * (b) know whether it manages a folder, so we don't draw a second set of
 * gutter decorations on top of its own.
 */
export class GitBridge implements vscode.Disposable {
  private api?: GitAPI;
  private readonly pending = new Map<string, NodeJS.Timeout>();
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;
  private readonly disposables: vscode.Disposable[] = [this._onDidChange];

  async init(): Promise<void> {
    const ext = vscode.extensions.getExtension<GitExtension>('vscode.git');
    if (!ext) return;
    try {
      const exports = ext.isActive ? ext.exports : await ext.activate();
      if (!exports?.enabled) return;
      this.api = exports.getAPI(1);
      this.disposables.push(
        this.api.onDidOpenRepository(() => this._onDidChange.fire()),
        this.api.onDidCloseRepository(() => this._onDidChange.fire()),
      );
    } catch {
      this.api = undefined;
    }
  }

  get available(): boolean {
    return !!this.api;
  }

  /** True when the git extension has an open repository at exactly this root. */
  manages(root: string): boolean {
    const repo = this.api?.getRepository(vscode.Uri.file(root));
    return !!repo && repo.rootUri.fsPath === vscode.Uri.file(root).fsPath;
  }

  /** Ask git to refresh this repository soon. Calls are coalesced per root. */
  refresh(root: string, delayMs = 250): void {
    if (!this.api) return;
    clearTimeout(this.pending.get(root));
    this.pending.set(
      root,
      setTimeout(() => {
        this.pending.delete(root);
        this.api?.getRepository(vscode.Uri.file(root))?.status().catch(() => undefined);
      }, delayMs),
    );
  }

  dispose(): void {
    this.pending.forEach((t) => clearTimeout(t));
    this.disposables.forEach((d) => d.dispose());
  }
}
