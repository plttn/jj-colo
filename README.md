# jj-colo

A [Jujutsu (jj)](https://jj-vcs.github.io/jj/) extension for VS Code built for **colocated repos** (`.jj` and `.git` side by side). It runs alongside VS Code's built-in Git extension instead of fighting it.

## How it coexists with the Git extension

Two source control extensions on one colocated repo can trigger each other forever. jj rewrites `.git/HEAD` and `.git/index`, the Git extension sees that and runs `git status`, and that wakes jj up again. They can also fail on each other's lock files. jj-colo avoids this:

| Problem | What jj-colo does |
| --- | --- |
| Each extension refreshing in response to the other's writes | The file watcher sorts every change (`classifyPath` in `src/parse.ts`). Anything the Git extension writes (`.git/index`, `*.lock`, `FETCH_HEAD`, objects, logs) is ignored, and so are jj's own `refs/jj/*` and `.jj` internals. Only user files, moved git refs/HEAD and new jj operations trigger a refresh. |
| Snapshotting on every refresh | Each refresh runs exactly one jj command that is allowed to snapshot. Everything else uses `--ignore-working-copy`, so a passive refresh never writes to `.git`. |
| Reacting to its own writes | The echo of our own command in `.git/HEAD` is ignored for a short window. New jj operations are matched by id (the file name in `.jj/repo/op_heads/heads`), so ops we already know about are skipped without starting a process. |
| `index.lock` contention | jj commands run one at a time per repo, and lock errors are retried with backoff. |
| Git's view going stale after jj moves HEAD | After each jj change, jj-colo asks Git to refresh through its public API, instead of waiting for Git's watcher to notice. |
| Two sets of gutter diff marks | In a colocated repo git's HEAD *is* `@-`, so Git's gutter already shows the same diff. With `jjColo.quickDiff: auto`, jj-colo only adds its own when Git isn't managing the folder. |
| A misleading git history graph | See below. |
| Changing your git settings | Never. Git keeps its own Source Control provider, settings and commands. jj-colo's menus only appear under `scmProvider == jj`. |

### Source Control Graph is hidden in jj workspaces

VS Code's **Source Control Graph** view comes from the Git extension. In a jj repo it shows a detached HEAD, no working-copy change, and every rewritten change as an unrelated commit. jj-colo hides it in jj workspaces, and the **Jujutsu Log** view takes its place.

VS Code has no setting for this, so jj-colo uses the view's own Hide command. Two quirks:

- That command only works while Source Control is open, so the graph is hidden the first time you open Source Control in a window. If you show it again yourself, it stays visible for that window.
- Hidden views are remembered per profile, not per workspace. jj-colo records that it hid the graph and shows it again the next time you open Source Control in a workspace without jj. For that it activates at startup in every workspace, and does nothing else there.

Turn this off with `"jjColo.hideGitGraph": false`, or run **Jujutsu: Show Source Control Graph Again**.

## Features

- **Source Control panel** "Jujutsu": the files changed in `@`, conflicts in their own group, and the input box filled with `@`'s description.
  - <kbd>Ctrl</kbd>+<kbd>Enter</kbd> / ✓ runs `jj commit -m`.
  - The title bar has New, Refresh, Describe, Squash, Abandon, Undo, Set Bookmark, `jj git fetch` and `jj git push`.
  - Per file: open the diff against `@-`, open the file, or discard changes (`jj restore`).
- **Jujutsu Log** view: recent revisions with bookmarks, author and age, marked as working copy, immutable, conflicted or empty. Expand a revision to see its files and click one for its diff.
  - Right-click actions: new on top, edit, describe, squash `@` into it, set bookmark, copy change id, abandon.
- **Status bar** shows `@`'s change id and bookmarks.
- Multi-root workspaces and nested repos work.

## Settings

| Setting | Default | |
| --- | --- | --- |
| `jjColo.path` | `""` | Path to `jj` (empty = PATH) |
| `jjColo.hideGitGraph` | `true` | Hide the Source Control Graph in jj workspaces |
| `jjColo.quickDiff` | `auto` | `auto` / `always` / `never` |
| `jjColo.prefillDescription` | `true` | Fill the input box with `@`'s description |
| `jjColo.refreshDebounceMs` | `400` | Wait after file changes before refreshing |
| `jjColo.log.revset` | `""` | Revset for the log view (empty = your `revsets.log`) |
| `jjColo.log.limit` | `50` | Max revisions in the log view |

Requires jj 0.25 or newer (tested with 0.45.1).

## Development

The layout follows the [Your First Extension](https://code.visualstudio.com/api/get-started/your-first-extension) TypeScript template, without a bundler.

```sh
npm install
npm run compile      # or: npm run watch
npm test             # unit tests, plus an integration test if `jj` is on PATH
```

Press <kbd>F5</kbd> in VS Code to open an Extension Development Host with the extension loaded, then open a colocated repo (`jj git init --colocate`) in it.

```
src/
  extension.ts       activation, repo discovery, wiring
  repository.ts      one SCM provider per jj repo: watcher, refresh, render, mutations
  cli.ts             serialized jj runner with lock-retry
  parse.ts           templates, output parsers, watcher classification (no vscode import)
  gitBridge.ts       built-in Git extension API: refresh nudges, "does git manage this?"
  gitGraph.ts        hide/restore the Source Control Graph
  logView.ts         Jujutsu Log tree view
  contentProvider.ts jj: URIs (file content at a revision)
  commands.ts        all commands
```
