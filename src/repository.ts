import { promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JjCli, JjError } from './cli';
import { GitBridge } from './gitBridge';
import {
  classifyPath,
  FileChange,
  isStaleError,
  LOG_TEMPLATE,
  parseLog,
  parseStatus,
  Revision,
  STATUS_TEMPLATE,
  StatusResult,
} from './parse';
import { relativeTo, toJjUri } from './uri';

const config = () => vscode.workspace.getConfiguration('jjColo');

/** One jj repository (workspace root) shown as its own Source Control provider. */
export class JjRepository implements vscode.Disposable, vscode.QuickDiffProvider {
  readonly sourceControl: vscode.SourceControl;
  private readonly changes: vscode.SourceControlResourceGroup;
  private readonly conflicts: vscode.SourceControlResourceGroup;

  status?: StatusResult;
  log: Revision[] = [];
  readonly colocated: boolean;

  private readonly _onDidRefresh = new vscode.EventEmitter<void>();
  readonly onDidRefresh = this._onDidRefresh.event;

  private readonly disposables: vscode.Disposable[] = [];
  private debounce?: NodeJS.Timeout;
  private pendingSnapshot = false;
  private refreshing?: Promise<void>;
  private again?: { snapshot: boolean };
  private knownOpHeads = '';
  private lastPrefill = '';
  private warnedStale = false;

  constructor(
    readonly root: string,
    readonly cli: JjCli,
    private readonly git: GitBridge,
    private readonly out: vscode.LogOutputChannel,
    colocated: boolean,
  ) {
    this.colocated = colocated;
    const sc = vscode.scm.createSourceControl('jj', 'Jujutsu', vscode.Uri.file(root));
    this.sourceControl = sc;
    sc.inputBox.placeholder = 'Describe @ (Ctrl+Enter to commit, i.e. describe + new)';
    sc.acceptInputCommand = { command: 'jjColo.commit', title: 'Commit', arguments: [sc] };
    this.changes = sc.createResourceGroup('changes', 'Working Copy (@)');
    this.conflicts = sc.createResourceGroup('conflicts', 'Conflicts');
    this.conflicts.hideWhenEmpty = true;
    this.disposables.push(sc, this.changes, this.conflicts, this._onDidRefresh);

    this.updateQuickDiff();
    this.disposables.push(
      git.onDidChange(() => this.updateQuickDiff()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('jjColo.quickDiff')) this.updateQuickDiff();
        if (e.affectsConfiguration('jjColo.log')) this.scheduleRefresh(false);
      }),
    );

    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(root, '**'));
    const onFs = (uri: vscode.Uri) => this.onFileEvent(uri);
    this.disposables.push(watcher, watcher.onDidChange(onFs), watcher.onDidCreate(onFs), watcher.onDidDelete(onFs));
  }

  // -------------------------------------------------------------------------
  // Refresh scheduling
  // -------------------------------------------------------------------------

  private onFileEvent(uri: vscode.Uri): void {
    const rel = relativeTo(this.root, uri.fsPath);
    if (!rel) return;
    switch (classifyPath(rel)) {
      case 'ignore':
        return;
      case 'workingCopy':
        this.scheduleRefresh(true);
        return;
      case 'gitRefs':
        // Our own commands rewrite HEAD/refs in a colocated repo. Ignore the echo.
        if (this.cli.busy || Date.now() - this.cli.lastRunEnded < 1500) return;
        // Something ran git directly: snapshot so jj imports the moved refs.
        this.scheduleRefresh(true);
        return;
      case 'jjOp':
        // The file name in op_heads/heads is the operation id. Skip ops we already know.
        void this.readOpHeads().then((heads) => {
          if (heads !== this.knownOpHeads) this.scheduleRefresh(false);
        });
        return;
    }
  }

  scheduleRefresh(snapshot: boolean): void {
    this.pendingSnapshot ||= snapshot;
    clearTimeout(this.debounce);
    this.debounce = setTimeout(() => {
      const s = this.pendingSnapshot;
      this.pendingSnapshot = false;
      void this.refresh(s);
    }, config().get<number>('refreshDebounceMs', 400));
  }

  async refresh(snapshot = false): Promise<void> {
    if (this.refreshing) {
      this.again = { snapshot: (this.again?.snapshot ?? false) || snapshot };
      return this.refreshing;
    }
    this.refreshing = this.doRefresh(snapshot).finally(() => (this.refreshing = undefined));
    await this.refreshing;
    if (this.again) {
      const next = this.again;
      this.again = undefined;
      await this.refresh(next.snapshot);
    }
  }

  private async doRefresh(snapshot: boolean): Promise<void> {
    try {
      // The only command that may snapshot. Everything after it reuses that state.
      const statusOut = await this.cli.run(['log', '-r', '@', '--no-graph', '-T', STATUS_TEMPLATE], { snapshot });
      this.status = parseStatus(statusOut);

      const logArgs = ['log', '--no-graph', '-n', String(config().get<number>('log.limit', 50)), '-T', LOG_TEMPLATE];
      const revset = config().get<string>('log.revset', '').trim();
      if (revset) logArgs.push('-r', revset);
      this.log = parseLog(await this.cli.run(logArgs));

      this.knownOpHeads = await this.readOpHeads();
      this.warnedStale = false;
      this.render();
    } catch (e) {
      this.handleError(e, false);
    }
    this._onDidRefresh.fire();
  }

  private async readOpHeads(): Promise<string> {
    try {
      const dir = path.join(this.root, '.jj', 'repo', 'op_heads', 'heads');
      return (await fs.readdir(dir)).sort().join(',');
    } catch {
      return '';
    }
  }

  // -------------------------------------------------------------------------
  // Rendering
  // -------------------------------------------------------------------------

  private render(): void {
    const s = this.status;
    if (!s) return;
    const conflicted = s.files.filter((f) => f.conflict);
    this.changes.resourceStates = s.files.filter((f) => !f.conflict).map((f) => this.toResource(f));
    this.conflicts.resourceStates = conflicted.map((f) => this.toResource(f));
    this.sourceControl.count = s.files.length;

    const rev = s.revision;
    const marks = rev.bookmarks.length ? ` ${rev.bookmarks.join(' ')}` : '';
    this.changes.label = `Working Copy (@ ${rev.changeIdShort})`;
    this.sourceControl.statusBarCommands = [
      {
        command: 'jjColo.log.focus',
        title: `$(git-commit) ${rev.changeIdShort}${marks}${rev.conflict ? ' $(warning)' : ''}`,
        tooltip: `jj working copy @ ${rev.changeIdShort} (commit ${rev.commitIdShort})\n${s.description || '(no description set)'}`,
      },
    ];

    // Show @'s description in the input box, unless the user is typing something else.
    if (config().get<boolean>('prefillDescription', true)) {
      const box = this.sourceControl.inputBox;
      if (box.value === '' || box.value === this.lastPrefill) {
        box.value = s.description;
        this.lastPrefill = s.description;
      }
    }
  }

  private toResource(f: FileChange): vscode.SourceControlResourceState {
    const uri = vscode.Uri.file(path.join(this.root, f.path));
    const look = DECORATIONS[f.conflict ? 'conflict' : f.status];
    const tooltip = f.oldPath ? `${look.label} from ${f.oldPath}` : look.label;
    return {
      resourceUri: uri,
      contextValue: f.conflict ? 'conflict' : f.status,
      command: { command: 'jjColo.openChange', title: 'Open Changes', arguments: [uri] },
      decorations: {
        tooltip,
        strikeThrough: f.status === 'removed',
        iconPath: new vscode.ThemeIcon(look.icon, new vscode.ThemeColor(look.color)),
      },
    };
  }

  findFile(uri: vscode.Uri): FileChange | undefined {
    const rel = relativeTo(this.root, uri.fsPath);
    return rel ? this.status?.files.find((f) => f.path === rel) : undefined;
  }

  // -------------------------------------------------------------------------
  // Quick diff (gutter decorations)
  // -------------------------------------------------------------------------

  /**
   * In a colocated repo git's HEAD is @-, so git's own gutter already shows the
   * same diff we would. Two providers means two sets of gutter marks, so in
   * `auto` we only provide one when git isn't handling this folder.
   */
  private updateQuickDiff(): void {
    const mode = config().get<string>('quickDiff', 'auto');
    const on = mode === 'always' || (mode === 'auto' && !this.git.manages(this.root));
    this.sourceControl.quickDiffProvider = on ? this : undefined;
  }

  provideOriginalResource(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') return undefined;
    const rel = relativeTo(this.root, uri.fsPath);
    if (!rel || rel.startsWith('.jj/') || rel.startsWith('.git/')) return undefined;
    const change = this.findFile(uri);
    return toJjUri({ root: this.root, rev: '@-', path: change?.oldPath ?? rel });
  }

  // -------------------------------------------------------------------------
  // Mutations
  // -------------------------------------------------------------------------

  /** Run a jj command that changes the repo, then refresh jj and nudge git. */
  async mutate(args: string[], title = `jj ${args[0]}`): Promise<string> {
    try {
      const { stdout, stderr } = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.SourceControl, title },
        () => this.cli.runFull(args, { snapshot: true }),
      );
      return (stdout + stderr).trim();
    } catch (e) {
      this.handleError(e, true);
      throw e;
    } finally {
      await this.refresh(false);
      if (this.colocated) this.git.refresh(this.root);
    }
  }

  handleError(e: unknown, userInitiated: boolean): void {
    const msg = e instanceof Error ? e.message : String(e);
    this.out.error(msg);
    if (e instanceof JjError && isStaleError(e.stderr)) {
      if (this.warnedStale) return;
      this.warnedStale = true;
      void vscode.window
        .showWarningMessage('The jj working copy is stale.', 'Update Working Copy')
        .then(async (pick) => {
          if (pick) await this.mutate(['workspace', 'update-stale']).catch(() => undefined);
        });
      return;
    }
    if (userInitiated) {
      void vscode.window.showErrorMessage(msg, 'Show Output').then((pick) => pick && this.out.show());
    }
  }

  dispose(): void {
    clearTimeout(this.debounce);
    this.disposables.forEach((d) => d.dispose());
  }
}

const DECORATIONS: Record<string, { icon: string; color: string; label: string }> = {
  modified: { icon: 'diff-modified', color: 'gitDecoration.modifiedResourceForeground', label: 'Modified' },
  added: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground', label: 'Added' },
  removed: { icon: 'diff-removed', color: 'gitDecoration.deletedResourceForeground', label: 'Removed' },
  renamed: { icon: 'diff-renamed', color: 'gitDecoration.renamedResourceForeground', label: 'Renamed' },
  copied: { icon: 'diff-added', color: 'gitDecoration.addedResourceForeground', label: 'Copied' },
  conflict: { icon: 'warning', color: 'gitDecoration.conflictingResourceForeground', label: 'Conflicted' },
};
