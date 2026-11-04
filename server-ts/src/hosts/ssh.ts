// Port of server/src/hosts/ssh.rs, thin: hosts reached over SSH aren't in the TypeScript server. The hub's SSH key is
// made as in Rust (Settings shows it), but linking a host over SSH, and the `ssh-host` command a target runs, answer
// with an error.
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Link } from "../db.ts";
import type { AppState } from "../state.ts";
import { run_cmd } from "../proc.ts";

export const UNSUPPORTED = "hosts over SSH aren't supported by the TypeScript server";

/** How to reach an SSH host; stored as JSON in `links.ssh`. */
export interface Target {
  /** `user@host` */
  target: string;
  ssh_port: number;
  /** The host's port on that machine. */
  remote_port: number;
}

/** A link's `ssh` column as a target, if it is one. */
export function parse_target(json: string | null | undefined): Target | null {
  if (!json) return null;
  try {
    const t = JSON.parse(json);
    if (typeof t?.target !== "string") return null;
    return { target: t.target, ssh_port: t.ssh_port ?? 22, remote_port: t.remote_port ?? 7878 };
  } catch {
    return null;
  }
}

function ssh_dir(s: AppState): string {
  return join(s.data_dir, "ssh");
}

/** The hub's SSH key, created on first use. Returns the public key line. */
export async function public_key(s: AppState): Promise<string> {
  const dir = ssh_dir(s);
  const key = join(dir, "id_ed25519");
  if (!existsSync(key)) {
    mkdirSync(dir, { recursive: true });
    const comment = `huntaway-hub@${s.host_name}`;
    let out;
    try {
      out = await run_cmd("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", comment, "-f", key]);
    } catch (e) {
      throw new Error("ssh-keygen not found (the hub needs openssh-client)", { cause: e });
    }
    if (!out.success) throw new Error(`ssh-keygen failed: ${out.stderr.trim()}`);
  }
  return readFileSync(`${key}.pub`, "utf8").trim();
}

/** Run the target's forced command: not in the TypeScript server. */
export async function ensure(_s: AppState, _t: Target): Promise<any> {
  throw new Error(UNSUPPORTED);
}

/** Keep a tunnel to an SSH host: it stays offline here. Returns the function that stops it. */
export function run(_s: AppState, link: Link): () => void {
  console.error(`link ${link.name}: ${UNSUPPORTED}`);
  return () => {};
}

/** `huntaway ssh-host`, the forced command on an SSH target. */
export async function ssh_host_cli(_argv: string[]): Promise<void> {
  console.error(`Error: ${UNSUPPORTED}; run the Rust huntaway on SSH targets`);
  process.exit(1);
}
