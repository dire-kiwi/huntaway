// Computer use's routes (HA-273, see desktop.ts): the host's page installs Cua Driver and turns computer use on
// (`/desktop`), and a task's viewer shows what its agent looks at (`/desktop/frame`) and did (`/tasks/{id}/desktop`).
// None is for paired devices (devices.ts doesn't list them): they show the host's screen.
import * as db from "../db.ts";
import * as desktop_db from "../db/desktop.ts";
import * as desktop from "../desktop.ts";
import * as driver from "../desktop/driver.ts";
import * as install from "../desktop/install.ts";
import * as devices from "../devices.ts";
import { ApiError, type Req } from "../http.ts";
import type { AppState } from "../state.ts";
import { err_str } from "../util.ts";
import { json_map } from "./extract.ts";

/** `GET /desktop`: whether computer use is on, the driver, and its install. */
export async function status(s: AppState) {
  const d = driver.of(s);
  const found = desktop.find(s);
  const r = desktop.release();
  const h = desktop.current_holder();
  const holder = h ? db.get_task(s.db(), h.task_id) : undefined;
  const env = d.status.state === "running" ? d.env : await driver.session_env();
  return {
    enabled: desktop.enabled(s.db()),
    platform: process.platform,
    /** The release the host's page would install, or null where Cua has none for this platform. */
    release: r ? { version: r.version, bytes: r.bytes } : null,
    installed: found ? { path: found.path, source: found.source, version: found.version } : null,
    install: install.current(),
    driver: { ...d.status, stderr: d.stderr().split("\n").slice(-20).join("\n") },
    session: driver.session_kind(env),
    locked: await driver.locked(env),
    in_use_by: holder ? { task_id: holder.id, title: holder.title } : null,
  };
}

/** `PATCH /desktop` `{enabled}`: turn computer use on or off for this host's agents (from their next run). */
export async function update(s: AppState, r: Req) {
  devices.board_only(r.device, "change computer use");
  const b = json_map(r);
  if (typeof b.enabled !== "boolean") throw ApiError.bad("enabled must be true or false");
  db.set_setting(s.db(), desktop.SETTING, b.enabled ? "true" : null);
  if (!b.enabled) driver.of(s).stop();
  return await status(s);
}

/** `POST /desktop/install`: download and install this platform's release in the background. */
export async function start_install(s: AppState, r: Req) {
  devices.board_only(r.device, "install software");
  const rel = desktop.release();
  if (!rel) throw ApiError.bad(`Cua Driver has no release for ${process.platform} on ${process.arch}`);
  // The new version takes over from the next call.
  install.start(s, rel, () => driver.of(s).stop());
  return await status(s);
}

/** `DELETE /desktop/install`: remove the installed driver (not one from `IA_CUA_DRIVER` or PATH). */
export async function uninstall(s: AppState, r: Req) {
  devices.board_only(r.device, "remove software");
  const j = install.current();
  if (j && j.phase !== "done" && j.phase !== "failed") throw ApiError.conflict("Cua Driver is being installed");
  driver.of(s).stop();
  await install.uninstall(s);
  return await status(s);
}

/** `POST /desktop/stop`: stop the driver (it starts again when an agent needs it). */
export async function stop(s: AppState, r: Req) {
  devices.board_only(r.device, "stop the driver");
  driver.of(s).stop();
  return await status(s);
}

/**
 * `POST /desktop/check`: start the driver and ask it what it may do (its `check_permissions`), as `{check}` (its text,
 * or why it couldn't) with the status.
 */
export async function check(s: AppState, r: Req) {
  devices.board_only(r.device, "start the driver");
  const d = driver.of(s);
  let out: string;
  try {
    await d.start();
    const res = d.has("check_permissions") ? await d.call("check_permissions", {}, 30_000) : null;
    out = res
      ? (res.content ?? [])
          .filter((c: any) => c?.type === "text")
          .map((c: any) => c.text)
          .join("\n")
      : "The driver started.";
  } catch (e) {
    out = err_str(e);
  }
  return { ...(await status(s)), check: out };
}

/** The last frame each task's viewer got, so viewers polling at once don't each make the driver capture. */
const frames = new Map<string, { at: number; frame: any }>();
const FRAME_MS = 400;

/**
 * `GET /desktop/frame?task_id=`: an image of the window task `task_id`'s agent last used (or `pid` and `window_id`),
 * as `{frame: {mime, data (base64), width, height, pid, window_id, at}}`, or `{frame: null, reason}`. Only while
 * computer use is on, and never on a locked screen. It doesn't start the driver: a viewer only watches.
 */
export async function frame(s: AppState, r: Req) {
  devices.board_only(r.device, "see the host's screen");
  if (!desktop.enabled(s.db())) return { frame: null, reason: "Computer use is off on this host." };
  const d = driver.of(s);
  if (d.status.state !== "running") return { frame: null, reason: "The driver isn't running: it starts when an agent uses the desktop." };
  if (await driver.locked(d.env)) return { frame: null, reason: "The screen is locked." };
  const task_id = r.query.task_id ?? "";
  const t = task_id ? desktop.target(task_id) : null;
  const pid = r.query.pid ? Number(r.query.pid) : (t?.pid ?? null);
  const window_id = r.query.window_id ? Number(r.query.window_id) : (t?.window_id ?? null);
  const key = `${pid}:${window_id}`;
  const kept = frames.get(key);
  if (kept && Date.now() - kept.at < FRAME_MS) return { frame: kept.frame };
  let result: any;
  try {
    if (pid !== null && Number.isInteger(pid)) {
      const args: Record<string, any> = { pid, include_screenshot: true };
      if (window_id !== null && Number.isInteger(window_id)) args.window_id = window_id;
      // A look for a live preview, which leaves the agent's snapshot and pixel frame alone, where the driver can.
      if (d.has("get_window_state", "include_accessibility_tree")) args.include_accessibility_tree = false;
      if (d.has("get_window_state", "display_only")) args.display_only = true;
      if (d.has("get_window_state", "max_image_dimension")) args.max_image_dimension = 1280;
      result = await d.call("get_window_state", args, 15_000);
    } else {
      result = await d.call("get_desktop_state", {}, 15_000);
    }
  } catch (e) {
    return { frame: null, reason: err_str(e) };
  }
  const img = (result?.content ?? []).find((c: any) => c?.type === "image" && typeof c.data === "string");
  if (!img) {
    const why = (result?.content ?? []).find((c: any) => c?.type === "text")?.text;
    return { frame: null, reason: result?.isError && why ? String(why).slice(0, 300) : "The driver returned no image." };
  }
  const sc = result.structuredContent ?? {};
  const f = {
    mime: img.mimeType ?? "image/png",
    data: img.data,
    width: sc.screenshot_width ?? null,
    height: sc.screenshot_height ?? null,
    pid,
    window_id,
    at: new Date().toISOString(),
  };
  frames.set(key, { at: Date.now(), frame: f });
  return { frame: f };
}

/** `GET /tasks/{id}/desktop`: what the task's agent did on the desktop (newest first), and the window it last used. */
export async function task_ops(s: AppState, r: Req) {
  devices.board_only(r.device, "see the host's desktop");
  const task = db.get_task(s.db(), r.params.id);
  if (!task) throw ApiError.not_found("task");
  return { ops: desktop_db.task_ops(s.db(), task.id), target: desktop.target(task.id) };
}
