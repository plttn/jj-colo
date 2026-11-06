import * as path from 'path';
import * as vscode from 'vscode';
import { exactFileset, revsetId } from './parse';
import { JjRepository } from './repository';
import { LogNode } from './logView';
import { toJjUri } from './uri';

type RepoLookup = {
  all(): JjRepository[];
  forSourceControl(sc: vscode.SourceControl): JjRepository | undefined;
  forUri(uri: vscode.Uri): JjRepository | undefined;
};

export function registerCommands(repos: RepoLookup, showGitGraph: () => Promise<void>): vscode.Disposable[] {
  /** Resolve which repo a command is about from whatever VS Code passed us. */
  async function pick(arg?: unknown): Promise<JjRepository | undefined> {
    if (arg && typeof arg === 'object') {
      if ('repo' in arg && (arg as LogNode & { repo?: JjRepository }).repo) return (arg as { repo: JjRepository }).repo;
      if ('inputBox' in arg) return repos.forSourceControl(arg as vscode.SourceControl);
      if (arg instanceof vscode.Uri) return repos.forUri(arg);
      if ('resourceUri' in arg) return repos.forUri((arg as vscode.SourceControlResourceState).resourceUri);
    }
    const all = repos.all();
    if (all.length <= 1) return all[0];
    const active = vscode.window.activeTextEditor?.document.uri;
    const fromEditor = active && repos.forUri(active);
    if (fromEditor) return fromEditor;
    const choice = await vscode.window.showQuickPick(
      all.map((r) => ({ label: path.basename(r.root), description: r.root, repo: r })),
      { placeHolder: 'Choose a jj repository' },
    );
    return choice?.repo;
  }

  function uriOf(arg: unknown): vscode.Uri | undefined {
    if (arg instanceof vscode.Uri) return arg;
    if (arg && typeof arg === 'object' && 'resourceUri' in arg) return (arg as vscode.SourceControlResourceState).resourceUri;
    return vscode.window.activeTextEditor?.document.uri;
  }

  async function message(repo: JjRepository, prompt: string): Promise<string | undefined> {
    const typed = repo.sourceControl.inputBox.value.trim();
    if (typed) return typed;
    return vscode.window.showInputBox({ prompt, value: repo.status?.description ?? '' });
  }

  const ignore = () => undefined;
  const cmd = (id: string, fn: (...args: any[]) => unknown) => vscode.commands.registerCommand(id, fn);

  return [
    cmd('jjColo.refresh', async (arg) => (await pick(arg))?.refresh(true)),

    cmd('jjColo.commit', async (arg) => {
      const repo = await pick(arg);
      if (!repo) return;
      const msg = await message(repo, 'Commit message for @');
      if (msg === undefined) return;
      await repo.mutate(['commit', '-m', msg], 'jj commit').catch(ignore);
      repo.sourceControl.inputBox.value = '';
    }),

    cmd('jjColo.describe', async (arg) => {
      const repo = await pick(arg);
      if (!repo) return;
      const msg = await message(repo, 'Description for @');
      if (msg === undefined) return;
      await repo.mutate(['describe', '-m', msg], 'jj describe').catch(ignore);
    }),

    cmd('jjColo.new', async (arg) => {
      const repo = await pick(arg);
      await repo?.mutate(['new'], 'jj new').catch(ignore);
    }),

    cmd('jjColo.squash', async (arg) => {
      const repo = await pick(arg);
      await repo?.mutate(['squash'], 'jj squash').catch(ignore);
    }),

    cmd('jjColo.abandon', async (arg) => {
      const repo = await pick(arg);
      if (!repo) return;
      const ok = await vscode.window.showWarningMessage(
        'Abandon the working-copy change (@)? `jj undo` can bring it back.',
        { modal: true },
        'Abandon',
      );
      if (ok) await repo.mutate(['abandon', '@'], 'jj abandon').catch(ignore);
    }),

    cmd('jjColo.undo', async (arg) => {
      const repo = await pick(arg);
      await repo?.mutate(['undo'], 'jj undo').catch(ignore);
    }),

    cmd('jjColo.gitFetch', async (arg) => {
      const repo = await pick(arg);
      const out = await repo?.mutate(['git', 'fetch'], 'jj git fetch').catch(ignore);
      if (out) void vscode.window.showInformationMessage(out.split('\n').slice(-3).join('\n'));
    }),

    cmd('jjColo.gitPush', async (arg) => {
      const repo = await pick(arg);
      const out = await repo?.mutate(['git', 'push'], 'jj git push').catch(ignore);
      if (out) void vscode.window.showInformationMessage(out.split('\n').slice(-3).join('\n'));
    }),

    cmd('jjColo.bookmarkSet', async (arg) => {
      const repo = await pick(arg);
      if (!repo) return;
      const target = isRevNode(arg) ? revsetId(arg.rev.commitId) : await revisionChoice();
      if (!target) return;
      const names = (await repo.cli.run(['bookmark', 'list', '-T', 'name ++ "\\n"']).catch(() => ''))
        .split('\n')
        .filter(Boolean);
      const unique = [...new Set(names)];
      const name = await pickOrType(unique, 'Bookmark to set (pick or type a new name)');
      if (!name) return;
      await repo.mutate(['bookmark', 'set', name, '-r', target, '--allow-backwards'], 'jj bookmark set').catch(ignore);
    }),

    cmd('jjColo.openChange', async (arg) => {
      const uri = uriOf(arg);
      const repo = uri && repos.forUri(uri);
      if (!uri || !repo) return;
      const change = repo.findFile(uri);
      const rel = path.relative(repo.root, uri.fsPath).split(path.sep).join('/');
      const left = toJjUri({ root: repo.root, rev: '@-', path: change?.oldPath ?? rel });
      const right = change?.status === 'removed' ? toJjUri({ root: repo.root, rev: '@', path: rel }) : uri;
      await vscode.commands.executeCommand('vscode.diff', left, right, `${path.basename(rel)} (@- ↔ @)`);
    }),

    cmd('jjColo.openFile', async (arg) => {
      const uri = uriOf(arg);
      if (uri) await vscode.commands.executeCommand('vscode.open', uri);
    }),

    cmd('jjColo.restore', async (...args: unknown[]) => {
      // Multi-select in the SCM view passes every selected resource state.
      const states = args.flat().filter((a): a is vscode.SourceControlResourceState => !!a && typeof a === 'object' && 'resourceUri' in a);
      const uris = states.length ? states.map((s) => s.resourceUri) : [uriOf(args[0])].filter((u): u is vscode.Uri => !!u);
      const repo = uris[0] && repos.forUri(uris[0]);
      if (!repo) return;
      const names = uris.map((u) => path.basename(u.fsPath)).join(', ');
      const ok = await vscode.window.showWarningMessage(
        `Discard changes to ${names}? \`jj undo\` can bring them back.`,
        { modal: true },
        'Discard',
      );
      if (!ok) return;
      const filesets = uris.map((u) => exactFileset(path.relative(repo.root, u.fsPath)));
      await repo.mutate(['restore', '--', ...filesets], 'jj restore').catch(ignore);
    }),

    // --- Log view items -----------------------------------------------------

    cmd('jjColo.log.edit', async (node: LogNode) => {
      if (isRevNode(node)) await node.repo.mutate(['edit', revsetId(node.rev.commitId)], 'jj edit').catch(ignore);
    }),

    cmd('jjColo.log.new', async (node: LogNode) => {
      if (isRevNode(node)) await node.repo.mutate(['new', revsetId(node.rev.commitId)], 'jj new').catch(ignore);
    }),

    cmd('jjColo.log.describe', async (node: LogNode) => {
      if (!isRevNode(node)) return;
      const current = (await node.repo.cli
        .run(['log', '-r', revsetId(node.rev.commitId), '--no-graph', '-T', 'description'])
        .catch(() => node.rev.summary)).replace(/\n$/, '');
      const msg = await vscode.window.showInputBox({ prompt: `Description for ${node.rev.changeIdShort}`, value: current });
      if (msg !== undefined) {
        await node.repo.mutate(['describe', revsetId(node.rev.commitId), '-m', msg], 'jj describe').catch(ignore);
      }
    }),

    cmd('jjColo.log.abandon', async (node: LogNode) => {
      if (!isRevNode(node)) return;
      const ok = await vscode.window.showWarningMessage(
        `Abandon ${node.rev.changeIdShort} "${node.rev.summary || '(no description set)'}"?`,
        { modal: true },
        'Abandon',
      );
      if (ok) await node.repo.mutate(['abandon', revsetId(node.rev.commitId)], 'jj abandon').catch(ignore);
    }),

    cmd('jjColo.log.squashInto', async (node: LogNode) => {
      if (isRevNode(node)) {
        await node.repo.mutate(['squash', '--into', revsetId(node.rev.commitId)], 'jj squash').catch(ignore);
      }
    }),

    cmd('jjColo.log.copyChangeId', async (node: LogNode) => {
      if (isRevNode(node)) await vscode.env.clipboard.writeText(node.rev.changeId);
    }),

    cmd('jjColo.showGitGraph', () => showGitGraph()),
  ];
}

function isRevNode(n: unknown): n is Extract<LogNode, { kind: 'rev' }> {
  return !!n && typeof n === 'object' && (n as LogNode).kind === 'rev';
}

async function revisionChoice(): Promise<string | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: '@-', description: 'Parent of the working copy (what you just committed)' },
      { label: '@', description: 'The working-copy change' },
    ],
    { placeHolder: 'Which revision should the bookmark point to?' },
  );
  return pick?.label;
}

function pickOrType(items: string[], placeHolder: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const qp = vscode.window.createQuickPick();
    qp.placeholder = placeHolder;
    qp.items = items.map((label) => ({ label }));
    let done = false;
    qp.onDidChangeValue((v) => {
      const typed = v.trim();
      qp.items = [
        ...(typed && !items.includes(typed) ? [{ label: typed, description: 'new bookmark' }] : []),
        ...items.map((label) => ({ label })),
      ];
    });
    qp.onDidAccept(() => {
      done = true;
      resolve(qp.selectedItems[0]?.label ?? (qp.value.trim() || undefined));
      qp.hide();
    });
    qp.onDidHide(() => {
      if (!done) resolve(undefined);
      qp.dispose();
    });
    qp.show();
  });
}
