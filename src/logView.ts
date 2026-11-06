import * as path from 'path';
import * as vscode from 'vscode';
import { FILES_TEMPLATE, FileChange, parseFiles, Revision, revsetId } from './parse';
import { JjRepository } from './repository';
import { toJjUri } from './uri';

export type LogNode =
  | { kind: 'repo'; repo: JjRepository }
  | { kind: 'rev'; repo: JjRepository; rev: Revision }
  | { kind: 'file'; repo: JjRepository; rev: Revision; file: FileChange }
  | { kind: 'placeholder'; message: string };

/** The "Jujutsu Log" view: recent revisions, expandable to their changed files. */
export class LogView implements vscode.TreeDataProvider<LogNode>, vscode.Disposable {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<LogNode | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  readonly view: vscode.TreeView<LogNode>;

  constructor(private readonly repos: () => JjRepository[]) {
    this.view = vscode.window.createTreeView('jjColo.log', { treeDataProvider: this, showCollapseAll: true });
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  getChildren(node?: LogNode): vscode.ProviderResult<LogNode[]> {
    if (!node) {
      const repos = this.repos();
      if (repos.length === 0) return [];
      if (repos.length === 1) return this.revisions(repos[0]);
      return repos.map((repo) => ({ kind: 'repo', repo }));
    }
    if (node.kind === 'repo') return this.revisions(node.repo);
    if (node.kind === 'rev') return this.files(node.repo, node.rev);
    return [];
  }

  private revisions(repo: JjRepository): LogNode[] {
    return repo.log.map((rev) => ({ kind: 'rev', repo, rev }));
  }

  private async files(repo: JjRepository, rev: Revision): Promise<LogNode[]> {
    try {
      const out = await repo.cli.run(['log', '-r', revsetId(rev.commitId), '--no-graph', '-T', FILES_TEMPLATE]);
      const files = parseFiles(out);
      if (!files.length) return [{ kind: 'placeholder', message: '(no changes)' }];
      return files.map((file) => ({ kind: 'file', repo, rev, file }));
    } catch (e) {
      return [{ kind: 'placeholder', message: e instanceof Error ? e.message : String(e) }];
    }
  }

  getTreeItem(node: LogNode): vscode.TreeItem {
    switch (node.kind) {
      case 'placeholder':
        return new vscode.TreeItem(node.message);
      case 'repo': {
        const item = new vscode.TreeItem(path.basename(node.repo.root), vscode.TreeItemCollapsibleState.Expanded);
        item.description = node.repo.root;
        item.iconPath = new vscode.ThemeIcon('repo');
        return item;
      }
      case 'rev':
        return revisionItem(node.rev);
      case 'file': {
        const { repo, rev, file } = node;
        const item = new vscode.TreeItem(vscode.Uri.file(path.join(repo.root, file.path)));
        item.label = path.basename(file.path);
        item.description = [path.dirname(file.path) === '.' ? '' : path.dirname(file.path), file.status]
          .filter(Boolean)
          .join(' · ');
        const parent = toJjUri({ root: repo.root, rev: `${rev.commitId}-`, path: file.oldPath ?? file.path });
        const self = toJjUri({ root: repo.root, rev: rev.commitId, path: file.path });
        item.command = {
          command: 'vscode.diff',
          title: 'Open Diff',
          arguments: [parent, self, `${path.basename(file.path)} (${rev.changeIdShort})`],
        };
        item.contextValue = 'jjFile';
        return item;
      }
    }
  }

  dispose(): void {
    this.view.dispose();
    this._onDidChangeTreeData.dispose();
  }
}

function revisionItem(rev: Revision): vscode.TreeItem {
  const item = new vscode.TreeItem(
    `${rev.changeIdShort}  ${rev.summary || '(no description set)'}`,
    rev.empty ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed,
  );
  item.id = rev.commitId;
  item.description = [rev.bookmarks.join(' '), rev.author, rev.ago].filter(Boolean).join(' · ');
  item.tooltip = new vscode.MarkdownString(
    [
      `**${rev.changeIdShort}** \`${rev.commitIdShort}\`${rev.isWorkingCopy ? ' (@)' : ''}`,
      rev.summary || '_(no description set)_',
      rev.bookmarks.length ? `Bookmarks: ${rev.bookmarks.join(', ')}` : '',
      `${rev.author}, ${rev.ago}`,
      [rev.empty && 'empty', rev.conflict && 'conflict', rev.immutable && 'immutable'].filter(Boolean).join(', '),
    ]
      .filter(Boolean)
      .join('\n\n'),
  );
  item.iconPath = rev.isWorkingCopy
    ? new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor('charts.green'))
    : rev.conflict
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('problemsWarningIcon.foreground'))
      : rev.immutable
        ? new vscode.ThemeIcon('lock')
        : new vscode.ThemeIcon(rev.empty ? 'circle-outline' : 'circle');
  item.contextValue = `jjRevision${rev.immutable ? ':immutable' : ':mutable'}${rev.isWorkingCopy ? ':wc' : ''}`;
  return item;
}
