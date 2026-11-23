import { spawnSync } from "node:child_process";

/**
 * Opt-in bridge for the W2 Web → Python → Web recovery qualification.
 *
 * The Python leg is deliberately not discovered from PATH or from .env files:
 * the operator must point MC_QUALIFICATION_PYTHON at an interpreter
 * that has this checkout's package (and `cryptography`) installed. Without that
 * variable the recovery spec is reported as skipped, so a Web-only run cannot
 * silently claim a cross-interface pass.
 *
 * The child environment is built from scratch rather than inherited. In
 * particular it contains no TURSO_*, proxy, or other endpoint configuration, so
 * the only network destination available to the CLI is the loopback test server
 * passed explicitly with `--server`.
 */

export const QUALIFICATION_PYTHON_ENV = "MC_QUALIFICATION_PYTHON";

export const SYNTHETIC_PASSPHRASE_ENV = "MC_LEDGER_SYNC_PASSPHRASE";

export interface QualificationPythonRun {
  stdout: string;
  stderr: string;
  status: number | null;
}

export interface QualificationPythonEnvironment {
  /** Repository root that contains `monte_carlo_ledger/`. */
  repoRoot: string;
  /** Isolated working directory (also the location of `.ledger-sync.json`). */
  workingDirectory: string;
  /** Fresh, disposable SQLite file; never a user's ledger. */
  ledgerDbPath: string;
  /** One-time synthetic credential. Never written to the sync config. */
  passphrase: string;
}

/**
 * Minimal controlled environment for the Python CLI.
 *
 * Everything that could select a live vault backend or an outbound proxy is
 * absent. Only the loopback server URL is supplied, and it is supplied as an
 * explicit CLI argument rather than through ambient configuration.
 */
export function qualificationPythonEnv(
  input: QualificationPythonEnvironment
): NodeJS.ProcessEnv {
  return {
    // NODE_ENV is a harmless typing/runtime sentinel for Next's global
    // ProcessEnv augmentation. The Python child ignores it.
    NODE_ENV: "test",
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: input.workingDirectory,
    TMPDIR: input.workingDirectory,
    PYTHONPATH: input.repoRoot,
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONUNBUFFERED: "1",
    LANG: "C",
    LC_ALL: "C",
    MC_LEDGER_DB: input.ledgerDbPath,
    [SYNTHETIC_PASSPHRASE_ENV]: input.passphrase,
  };
}

/**
 * Run the explicit interpreter in an isolated cwd. Arguments are passed as an
 * array (no shell), and the passphrase is only ever delivered through the
 * child environment, never argv.
 *
 * The error message includes the command and captured output but never the
 * environment, so a failed run cannot print the synthetic credential.
 */
export function runQualificationPython(
  python: string,
  args: string[],
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    allowFailure?: boolean;
    timeoutMs?: number;
  }
): QualificationPythonRun {
  const result = spawnSync(python, args, {
    cwd: options.cwd,
    env: options.env,
    encoding: "utf8",
    timeout: options.timeoutMs ?? 15_000,
  });

  if (result.error) {
    throw result.error;
  }

  const status = result.status;
  if (!options.allowFailure && status !== 0) {
    throw new Error(
      `Qualification Python command failed (${status ?? result.signal ?? "no status"}): ` +
        `${python} ${args.join(" ")}\n` +
        `stdout:\n${result.stdout}\n` +
        `stderr:\n${result.stderr}`
    );
  }

  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status,
  };
}
