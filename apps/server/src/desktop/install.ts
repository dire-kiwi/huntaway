// Installing Cua Driver on this host (see desktop.ts): a release archive downloaded from GitHub, its size and SHA-256
// checked, unpacked beside the others (into a folder of its own first, then renamed into place), so a failed or
// interrupted install leaves nothing half-written where the driver is looked for.
import { createHash } from "node:crypto";
import { createWriteStream, existsSync, readdirSync, renameSync } from "node:fs";
import { mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { run_cmd } from "../proc.ts";
import type { Shared } from "../state.ts";
import { background, err_str, now } from "../util.ts";
import * as desktop from "../desktop.ts";

export interface InstallJob {
  version: string;
  phase: "downloading" | "verifying" | "unpacking" | "done" | "failed";
  /** Bytes downloaded so far, of `total`. */
  received: number;
  total: number;
  error: string | null;
  started_at: string;
  finished_at: string | null;
}

/** The latest install, which the host's page shows until the next. */
let job: InstallJob | null = null;

export const current = (): InstallJob | null => job;

/** For tests. */
export function reset(): void {
  job = null;
}

/** Start installing `r` in the background (or return the install that's going), and say how it's going. */
export function start(s: Shared, r: desktop.Release, after: () => void = () => {}): InstallJob {
  if (job && job.phase !== "done" && job.phase !== "failed") return job;
  const j: InstallJob = { version: r.version, phase: "downloading", received: 0, total: r.bytes, error: null, started_at: now(), finished_at: null };
  job = j;
  background(
    "installing Cua Driver",
    install(s, r, j).then(
      () => {
        j.phase = "done";
        j.finished_at = now();
        after();
      },
      (e) => {
        j.phase = "failed";
        j.error = err_str(e);
        j.finished_at = now();
        console.error(`installing Cua Driver ${r.version} failed: ${j.error}`);
      },
    ),
  );
  return j;
}

/** Download, check and unpack `r` into `<root>/<version>`, reporting on `j`. */
export async function install(s: Shared, r: desktop.Release, j: InstallJob): Promise<void> {
  const root = desktop.install_root(s);
  const dest = join(root, r.version);
  const work = join(root, `.install-${r.version}-${process.pid}-${Date.now()}`);
  await mkdir(work, { recursive: true });
  try {
    const archive = join(work, "archive.tar.gz");
    const res = await fetch(r.url, { redirect: "follow" });
    if (!res.ok || !res.body) throw new Error(`downloading ${r.url}: HTTP ${res.status}`);
    const hash = createHash("sha256");
    const out = createWriteStream(archive);
    try {
      for await (const chunk of res.body as any as AsyncIterable<Uint8Array>) {
        j.received += chunk.byteLength;
        if (j.received > r.bytes) throw new Error(`the download is bigger than the release's ${r.bytes} bytes`);
        hash.update(chunk);
        if (!out.write(chunk)) await new Promise<void>((ok) => out.once("drain", () => ok()));
      }
    } finally {
      await new Promise<void>((ok) => out.end(() => ok()));
    }
    j.phase = "verifying";
    if (j.received !== r.bytes) throw new Error(`downloaded ${j.received} bytes, but the release is ${r.bytes}`);
    const sum = hash.digest("hex");
    if (sum !== r.sha256) throw new Error(`the download's SHA-256 is ${sum}, not the release's ${r.sha256}`);
    j.phase = "unpacking";
    const files = join(work, "files");
    await mkdir(files);
    // Refuse archives with absolute paths or `..` in them, before tar writes anything.
    const list = await run_cmd("tar", ["-tzf", archive]);
    if (!list.success) throw new Error(`reading the archive: ${list.stderr.trim()}`);
    const bad = list.stdout.split("\n").find((p) => p.startsWith("/") || p.split("/").includes(".."));
    if (bad !== undefined) throw new Error(`the archive has an unsafe path: ${bad}`);
    const x = await run_cmd("tar", ["-xzf", archive, "-C", files, "--no-same-owner"]);
    if (!x.success) throw new Error(`unpacking the archive: ${x.stderr.trim()}`);
    const exe = join(files, "cua-driver");
    if (!existsSync(exe) || !(await stat(exe)).isFile()) throw new Error("the archive has no cua-driver at its top");
    await rm(dest, { recursive: true, force: true });
    renameSync(files, dest);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  // Older versions go once the new one is in place.
  for (const v of readdirSync(root)) {
    if (v !== r.version && !v.startsWith(".")) await rm(join(root, v), { recursive: true, force: true });
  }
}

/** Remove every installed version. */
export async function uninstall(s: Shared): Promise<void> {
  await rm(desktop.install_root(s), { recursive: true, force: true });
  job = null;
}
