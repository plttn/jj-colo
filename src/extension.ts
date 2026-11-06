import { existsSync, promises as fs } from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { JjCli } from './cli';
import { registerCommands } from './commands';
import { JjContentProvider } from './contentProvider';
import { GitBridge } from './gitBridge';
import { GitGraphController, RESTORE_CONTEXT } from './gitGraph';
import { LogView } from './logView';
import { JjRepository } from './repository';

const repos = new Map<string, JjRepository>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const out = vscode.window.createOutputChannel('Jujutsu', { log: true });
  const git = new GitBridge();
  const graph = new GitGraphController(context.globalState);
  const content = new JjContentProvider((root) => repos.get(root));
  const logView = new LogView(() => [...repos.values()]);
  context.subscriptions.push(out, git, content, logView);

  const all = () => [...repos.values()];
  const forUri = (uri: vscode.Uri) => {
    // Longest root wins, so nested repos resolve to the innermost one.
    let best: JjRepository | undefined;
    for (const r of repos.values()) {
      const rel = path.relative(r.root, uri.fsPath);
      if (!rel.startsWith('..') && !path.isAbsolute(rel) && (!best || r.root.length > best.root.length)) best = r;
    }
    return best;
  };
  context.subscriptions.push(
    ...registerCommands(
      { all, forUri, forSourceControl: (sc) => all().find((r) => r.sourceControl === sc) },
      () => graph.showNow(),
    ),
  );

  await git.init();

  const jjPath = () => vscode.workspace.getConfiguration('jjColo').get<string>('path', '') || 'jj';

  async function open(root: string): Promise<void> {
    if (repos.has(root)) return;
    const cli = new JjCli(jjPath, root, (line) => out.trace(`[${path.basename(root)}] ${line}`));
    const colocated = existsSync(path.join(root, '.git'));
    const repo = new JjRepository(root, cli, git, out, colocated);
    repos.set(root, repo);
    repo.onDidRefresh(() => {
      logView.refresh();
      content.repoChanged(root);
    });
    out.info(`Opened ${colocated ? 'colocated ' : ''}jj repo at ${root}`);
    await repo.refresh(true);
  }

  async function scan(): Promise<void> {
    const wanted = new Set<string>();
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== 'file') continue;
      const root = await findJjRoot(folder.uri.fsPath);
      if (root) wanted.add(root);
    }
    for (const [root, repo] of repos) {
      if (!wanted.has(root)) {
        repo.dispose();
        repos.delete(root);
      }
    }
    await Promise.all([...wanted].map(open));
    await vscode.commands.executeCommand('setContext', 'jjColo.hasRepository', repos.size > 0);
    await vscode.commands.executeCommand('setContext', RESTORE_CONTEXT, repos.size === 0 && graph.needsRestore);
    logView.refresh();
  }

  // Our log view lives in the Source Control container, so its visibility tells
  // us when that container is open: the only time the graph's commands work.
  const onScmVisible = () => {
    if (!logView.view.visible) return;
    if (repos.size > 0) void graph.onScmVisibleInJjWorkspace();
    else void graph.onScmVisibleInGitWorkspace();
  };
  context.subscriptions.push(
    logView.view.onDidChangeVisibility(onScmVisible),
    vscode.workspace.onDidChangeWorkspaceFolders(() => void scan()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('jjColo.path')) {
        for (const r of repos.values()) void r.refresh(true);
      }
    }),
    { dispose: () => repos.forEach((r) => r.dispose()) },
  );

  await scan();
  onScmVisible();
  if (repos.size > 0) await checkVersion(jjPath(), out);
}

export function deactivate(): void {
  repos.forEach((r) => r.dispose());
  repos.clear();
}

/** Walk up from `start` to the nearest directory containing `.jj`. */
async function findJjRoot(start: string): Promise<string | undefined> {
  let dir = start;
  for (;;) {
    try {
      if ((await fs.stat(path.join(dir, '.jj'))).isDirectory()) return dir;
    } catch {
      // keep walking
    }
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

const MIN_VERSION = [0, 25];

async function checkVersion(jj: string, out: vscode.LogOutputChannel): Promise<void> {
  const cli = new JjCli(() => jj, process.cwd());
  try {
    const v = (await cli.run(['--version'])).trim();
    out.info(v);
    const m = /(\d+)\.(\d+)/.exec(v);
    if (m && (+m[1] < MIN_VERSION[0] || (+m[1] === MIN_VERSION[0] && +m[2] < MIN_VERSION[1]))) {
      void vscode.window.showWarningMessage(
        `jj-colo needs jj ${MIN_VERSION.join('.')} or newer (found ${v}). Some views may be empty.`,
      );
    }
  } catch {
    void vscode.window
      .showErrorMessage(`Couldn't run \`${jj}\`. Install Jujutsu or set "jjColo.path".`, 'Open Settings')
      .then((p) => p && vscode.commands.executeCommand('workbench.action.openSettings', 'jjColo.path'));
  }
}
