import { spawn } from 'child_process';
import { isLockError } from './parse';

export interface RunOptions {
  /**
   * Let jj snapshot the working copy before running. Leave this off for
   * read-only refreshes: snapshotting in a colocated repo can rewrite
   * `.git/HEAD` and the git index, which wakes up the git extension.
   */
  snapshot?: boolean;
  /** Number of retries when a lock is held by someone else (default 3). */
  retries?: number;
}

export interface RunResult {
  stdout: string;
  stderr: string;
}

export class JjError extends Error {
  constructor(
    readonly args: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
  ) {
    super(stderr.trim().split('\n').slice(0, 3).join('\n') || `jj exited with code ${exitCode}`);
  }
}

export type Logger = (line: string) => void;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * Runs jj commands for one repository, one at a time.
 *
 * Commands are serialized so we never race ourselves for jj's working-copy
 * lock, and lock errors (usually the git extension's `index.lock`) are retried
 * with backoff instead of failing the user's action.
 */
export class JjCli {
  private queue: Promise<unknown> = Promise.resolve();
  private _lastRunEnded = 0;

  constructor(
    private readonly jjPath: () => string,
    readonly root: string,
    private readonly log: Logger = () => {},
  ) {}

  /** Time (ms since epoch) the most recent command finished. */
  get lastRunEnded(): number {
    return this._lastRunEnded;
  }

  /** True while a command is queued or running. */
  get busy(): boolean {
    return this.inFlight > 0;
  }
  private inFlight = 0;

  async run(args: string[], opts: RunOptions = {}): Promise<string> {
    return (await this.runFull(args, opts)).stdout;
  }

  /** Like `run`, but also returns stderr, where jj prints most human-readable messages. */
  runFull(args: string[], opts: RunOptions = {}): Promise<RunResult> {
    this.inFlight++;
    const task = this.queue.then(() => this.runWithRetry(args, opts));
    this.queue = task.catch(() => undefined);
    return task.finally(() => this.inFlight--);
  }

  private async runWithRetry(args: string[], opts: RunOptions): Promise<RunResult> {
    const retries = opts.retries ?? 3;
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.exec(args, opts);
      } catch (e) {
        if (e instanceof JjError && isLockError(e.stderr) && attempt < retries) {
          const delay = 150 * 3 ** attempt;
          this.log(`lock held, retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }
        throw e;
      } finally {
        this._lastRunEnded = Date.now();
      }
    }
  }

  private exec(args: string[], opts: RunOptions): Promise<RunResult> {
    const full = ['--no-pager', '--color=never', ...(opts.snapshot ? [] : ['--ignore-working-copy']), ...args];
    this.log(`jj ${full.map((a) => (/\s|"/.test(a) ? JSON.stringify(a) : a)).join(' ')}`);
    return new Promise((resolve, reject) => {
      const child = spawn(this.jjPath(), full, {
        cwd: this.root,
        env: {
          ...process.env,
          // Never let jj open an editor or pager we can't see.
          JJ_EDITOR: 'false',
          EDITOR: 'false',
          PAGER: 'cat',
          // Don't let git block on credential prompts during fetch/push.
          GIT_TERMINAL_PROMPT: '0',
        },
        windowsHide: true,
      });
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      child.stdout.on('data', (d: Buffer) => out.push(d));
      child.stderr.on('data', (d: Buffer) => err.push(d));
      child.on('error', (e) => reject(new JjError(args, null, String(e))));
      child.on('close', (code) => {
        const stdout = Buffer.concat(out).toString('utf8');
        const stderr = Buffer.concat(err).toString('utf8');
        if (stderr.trim()) this.log(stderr.trimEnd());
        if (code === 0) resolve({ stdout, stderr });
        else reject(new JjError(args, code, stderr));
      });
    });
  }
}
