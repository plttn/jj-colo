import * as vscode from 'vscode';

/**
 * Hides VS Code's "Source Control Graph" view (fed by the git extension) in
 * jj workspaces, and puts it back in plain git workspaces.
 *
 * In a colocated repo that graph is misleading: HEAD is always detached, the
 * working-copy commit is missing, and every rewritten jj change shows up as
 * unrelated git commits. The Jujutsu Log view replaces it.
 *
 * VS Code has no setting for this, only the view's own hide/toggle commands,
 * and those have two quirks we work around:
 *  - they do nothing unless the Source Control container is open, so we run
 *    them when one of our views in that container becomes visible;
 *  - hidden state is stored per profile, not per workspace, so hiding it here
 *    hides it everywhere. We remember that we did it and undo it the next time
 *    Source Control opens in a workspace without jj.
 */
const GRAPH_VIEW = 'workbench.scm.history';
const HIDDEN_BY_US = 'jjColo.gitGraphHiddenByUs';
export const RESTORE_CONTEXT = 'jjColo.restoreGitGraph';

export class GitGraphController {
  private hiddenThisSession = false;

  constructor(private readonly state: vscode.Memento) {}

  private get enabled(): boolean {
    return vscode.workspace.getConfiguration('jjColo').get<boolean>('hideGitGraph', true);
  }

  get needsRestore(): boolean {
    return this.state.get<boolean>(HIDDEN_BY_US, false);
  }

  /** Call when the Source Control container becomes visible in a jj workspace. */
  async onScmVisibleInJjWorkspace(): Promise<void> {
    // Only once per window: if the user shows the graph again, respect that.
    if (!this.enabled || this.hiddenThisSession) return;
    this.hiddenThisSession = true;
    await this.hide();
    await this.state.update(HIDDEN_BY_US, true);
  }

  /** Call when the Source Control container becomes visible in a workspace without jj. */
  async onScmVisibleInGitWorkspace(): Promise<void> {
    if (!this.needsRestore) return;
    await this.show();
    await this.state.update(HIDDEN_BY_US, false);
    await vscode.commands.executeCommand('setContext', RESTORE_CONTEXT, false);
  }

  /** Command: put the graph back right now, in any workspace. */
  async showNow(): Promise<void> {
    await vscode.commands.executeCommand('workbench.view.scm');
    await this.show();
    await this.state.update(HIDDEN_BY_US, false);
  }

  private async hide(): Promise<void> {
    // `removeView` only hides when visible, so it is safe to call repeatedly.
    await run(`${GRAPH_VIEW}.removeView`);
  }

  private async show(): Promise<void> {
    // There is no "show" command, only a toggle. Hiding first makes the toggle always show.
    await run(`${GRAPH_VIEW}.removeView`);
    await run(`${GRAPH_VIEW}.toggleVisibility`);
  }
}

async function run(command: string): Promise<void> {
  try {
    await vscode.commands.executeCommand(command);
  } catch {
    // Command missing on older VS Code builds: nothing to hide.
  }
}
