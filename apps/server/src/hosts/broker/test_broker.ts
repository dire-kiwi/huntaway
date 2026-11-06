// For tests: the Rust broker, run as a process. Rust's tests run the `huntaway-broker` crate in-process with the limits
// they need (`Config { max_streams, stall }`); these run `rust/broker/examples/test_broker.rs`, the crate's router
// behind those flags, built with `cargo build -p huntaway-broker --example test_broker` at the repository's root (done here if it's
// missing; `$IA_TEST_BROKER` names another). Without cargo, tests that need it are skipped and say why.
import { execFileSync, spawn } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const ROOT = new URL("../../../../../", import.meta.url).pathname;

let found: string | { skip: string } | null = null;

/** The test broker's path, built if it isn't yet; or why there's none. */
export function test_broker_bin(): string | { skip: string } {
  if (found) return found;
  const find = () =>
    ["debug", "release"]
      .map((p) => join(ROOT, "target", p, "examples", "test_broker"))
      .filter((p) => existsSync(p))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)[0];
  if (process.env.IA_TEST_BROKER) return (found = process.env.IA_TEST_BROKER);
  if (!find()) {
    try {
      execFileSync("cargo", ["build", "-q", "-p", "huntaway-broker", "--example", "test_broker"], { cwd: ROOT, stdio: "ignore", timeout: 900_000 });
    } catch (e) {
      return (found = { skip: `no test broker (cargo build -p huntaway-broker --example test_broker failed: ${(e as Error).message})` });
    }
  }
  return (found = find() ?? { skip: "no test broker" });
}

/** node:test options for a test that runs the broker: skipped, saying why, when there's none. */
export function needs_broker(): { skip?: string } {
  const b = test_broker_bin();
  return typeof b === "string" ? {} : b;
}

/** `huntaway_broker::Config`'s fields tests set (`stall` in ms). */
export interface Config {
  max_streams?: number;
  stall?: number;
}

/** A broker with `token` on a free port of 127.0.0.1; returns its URL. `cleanups` gets what stops it. */
export async function start_test_broker(token: string, cfg: Config, cleanups: Array<() => void>): Promise<string> {
  const bin = test_broker_bin();
  if (typeof bin !== "string") throw new Error(bin.skip);
  const args = ["--token", token];
  if (cfg.max_streams !== undefined) args.push("--max-streams", String(cfg.max_streams));
  if (cfg.stall !== undefined) args.push("--stall-ms", String(cfg.stall));
  const child = spawn(bin, args, { stdio: ["ignore", "pipe", "inherit"], env: { ...process.env, RUST_LOG: "off" } });
  cleanups.push(() => child.kill("SIGKILL"));
  return new Promise<string>((resolve, reject) => {
    const rl = createInterface({ input: child.stdout! });
    rl.once("line", (l) => {
      rl.close();
      resolve(l.trim());
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`the test broker exited (${code})`)));
  });
}
