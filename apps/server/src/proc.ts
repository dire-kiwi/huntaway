// Running other programs (std::process::Command / tokio::process::Command).
import { execFile, type ExecFileOptions } from "node:child_process";

export interface Output {
  /** The exit code, or null if it was killed by a signal (Rust's `status.code()`). */
  code: number | null;
  success: boolean;
  stdout: string;
  stderr: string;
}

export interface CmdOpts {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  /** Written to its stdin (else stdin is empty). */
  input?: string | Buffer;
  /** Milliseconds before it's killed. */
  timeout?: number;
}

/** Run `cmd` with `args` and collect its output, as `Command::output()`. Rejects only if it couldn't be started. */
export function run_cmd(cmd: string, args: string[], opts: CmdOpts = {}): Promise<Output> {
  return new Promise((resolve, reject) => {
    const o: ExecFileOptions = { cwd: opts.cwd, env: opts.env, maxBuffer: 256 << 20, timeout: opts.timeout, encoding: "utf8" as any };
    const child = execFile(cmd, args, o, (err: any, stdout: any, stderr: any) => {
      if (err && typeof err.code === "string") return reject(err); // ENOENT, EACCES…: it didn't start
      const code = err ? (typeof err.code === "number" ? err.code : null) : 0;
      resolve({ code, success: code === 0, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
    if (opts.input !== undefined) child.stdin?.end(opts.input);
    else child.stdin?.end();
  });
}

/** Run `cmd` and return its stdout, throwing with its stderr if it fails. */
export async function run_ok(cmd: string, args: string[], opts: CmdOpts = {}): Promise<string> {
  const out = await run_cmd(cmd, args, opts);
  if (!out.success) throw new Error(`${cmd} ${args.join(" ")}: ${out.stderr.trim() || out.stdout.trim() || `exit ${out.code}`}`);
  return out.stdout;
}
