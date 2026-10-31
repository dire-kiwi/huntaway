// Shared setup for the browser checks in this folder: a scratch test server (scripts/test-server.sh --demo,
// with agents switched off) and a browser on it (scripts/ui-check.mjs). They test the built UI, so run
// `npm run build` (and `cargo build` in server/) first; `npm run test:ui` does the UI build.
import { execFileSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { open } from "../../../scripts/ui-check.mjs";

const script = fileURLToPath(new URL("../../../scripts/test-server.sh", import.meta.url));

/** Start a demo test server that can't run agents. Returns { url, token, dataDir, api, stop }. */
export function startServer(...args) {
  const out = execFileSync(script, ["start", "--demo", ...args], {
    encoding: "utf8",
    env: { ...process.env, IA_CLAUDE_BIN: "/bin/false", IA_CODEX_BIN: "/bin/false" },
  });
  const vars = Object.fromEntries([...out.matchAll(/^(?:export )?(IA_TEST_\w+)=(.*)$/gm)].map((m) => [m[1], m[2]]));
  const url = vars.IA_TEST_URL;
  const token = vars.IA_TEST_TOKEN;
  const api = async (method, path, body) => {
    const res = await fetch(`${url}/api${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  const stop = () => execFileSync(script, ["stop", vars.IA_TEST_DATA_DIR], { stdio: "ignore" });
  return { url, token, dataDir: vars.IA_TEST_DATA_DIR, api, stop };
}

/** A git repository at `dir` with a commit, so a project on it can have worktrees (HA-20: else its board is its setup thread). */
export function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  execFileSync("git", ["init", "-q", dir]);
  execFileSync("git", ["-C", dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "first"]);
}

/** The demo project that `--demo` seeds. */
export async function demoProject(server) {
  const [profile] = await server.api("GET", "/profiles");
  const projects = await server.api("GET", `/profiles/${profile.id}/projects`);
  return projects.find((p) => p.name === "Demo");
}

let failures = 0;

/**
 * Run `fn` with a browser on the server (see `open` in scripts/ui-check.mjs), then close it. Page and console
 * errors that weren't allowed fail the check; if `fn` failed as well, they're added to its error, and a screenshot
 * of the page is saved to <tmp>/ui-check-<pid>-<n>-failed.png.
 */
export async function withBrowser(server, opts, fn) {
  const ui = await open({ url: server.url, token: server.token, log: () => {}, ...opts });
  try {
    await fn(ui);
  } catch (e) {
    if (ui.errors.length) e.message += `\npage or console errors:\n${ui.errors.join("\n")}`;
    // As scripts/ui-check.mjs does for a failed step (CI keeps these).
    const shot = join(tmpdir(), `ui-check-${process.pid}-${++failures}-failed.png`);
    if (await ui.page.screenshot({ path: shot }).then(() => true, () => false)) e.message += `\nthe page at the time: ${shot} (${ui.page.url()})`;
    throw e;
  } finally {
    await ui.close();
  }
  if (ui.errors.length) throw new Error(`page or console errors:\n${ui.errors.join("\n")}`);
}

/**
 * Serves `messages` (an array, or a function of the query giving it) as task `taskId`'s thread, as a host does: all of it,
 * or with ?before=&after=&limit= a page counting the main conversation's messages (db::message_page), the
 * latest one with the earlier subagents' calls, results and task_* messages uncut (db::subagent_messages). Returns the
 * queries asked for.
 */
export async function routeThread(page, taskId, messages) {
  const asked = [];
  const isCall = (m) => m.data?.type === "assistant" && m.data.message?.content?.some?.((b) => b.type === "tool_use" && ["Agent", "Task"].includes(b.name));
  await page.route(new RegExp(`/tasks/${taskId}/messages(\\?.*)?$`), (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const q = new URL(route.request().url()).searchParams;
    const all = typeof messages === "function" ? messages(q) : messages;
    asked.push(q.toString());
    if (![...q.keys()].length) return route.fulfill({ json: all });
    const before = Number(q.get("before") ?? Infinity);
    const after = Number(q.get("after") ?? -Infinity);
    const limit = q.has("limit") ? Math.max(1, Number(q.get("limit"))) : Infinity;
    const range = all.filter((m) => m.id > after && m.id < before);
    let start = range.length;
    for (let main = 0; start > 0 && main < limit; ) if (!range[--start].data?.parent_tool_use_id) main++;
    const shown = range.slice(start);
    const first = shown[0]?.id ?? 0;
    const calls = new Set(all.filter((m) => m.id < first && isCall(m)).flatMap((m) => m.data.message.content.map((b) => b.id)));
    const ofCall = (m) =>
      isCall(m) || m.data?.message?.content?.some?.((b) => b.type === "tool_result" && calls.has(b.tool_use_id)) || (m.data?.subtype?.startsWith("task_") && calls.has(m.data.tool_use_id));
    const subagents = q.has("before") || q.has("after") ? [] : all.filter((m) => m.id < first && ofCall(m));
    return route.fulfill({ json: { messages: shown, more: start > 0, subagents } });
  });
  return asked;
}
