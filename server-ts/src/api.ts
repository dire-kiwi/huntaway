// Port of server/src/api.rs: the HTTP API. `router` and `host_routes` list every route; the handlers are in the
// submodules, by what they act on.
import { readFileSync } from "node:fs";
import type { WebSocket } from "ws";
import * as db from "./db.ts";
import { Router, Reply, call, no_route_error, parseBody, parseQuery, type Answer, type Req } from "./http.ts";
import type { AppState } from "./state.ts";
import { home_dir, path_str, same_secret } from "./util.ts";
import { API_COMPAT, API_VERSION, BUILD_ID, VERSION } from "./hosts/proto.ts";
import * as claude_configs from "./api/claude_configs.ts";
import * as host from "./api/host.ts";
import * as new_task from "./api/new_task.ts";
import * as profiles from "./api/profiles.ts";
import * as projects from "./api/projects.ts";
import * as tasks from "./api/tasks.ts";
import * as thread from "./api/thread.ts";
import * as agent_tools from "./agent/agent_tools.ts";
import * as prompts from "./agent/prompts.ts";
import * as usage from "./agent/usage.ts";
import * as context from "./agent/context.ts";
import * as documents from "./agent/documents.ts";
import * as runs from "./agent/runs.ts";
import * as analytics from "./analytics.ts";
import * as disk from "./disk.ts";
import * as attachments from "./attachments.ts";
import * as git_view from "./git/git_view.ts";
import * as checkpoints from "./git/checkpoints.ts";
import * as fanout from "./review/fanout.ts";
import * as automations from "./integrations/automations.ts";
import * as workflows from "./integrations/workflows.ts";
import * as push from "./integrations/push.ts";
import * as hub from "./hosts/hub.ts";
import * as admin from "./update/admin.ts";

export * from "./api/new_task.ts";
export * from "./api/projects.ts";
export * from "./api/tasks.ts";
export * from "./api/thread.ts";
export * from "./api/claude_configs.ts";
export * from "./api/host.ts";
export * from "./api/profiles.ts";

export { NO_ROUTE, no_route_error } from "./http.ts";

/** This host's API (`/api/...`) plus the hub endpoints that span hosts, all under `/api`. */
export function router(s: AppState): Router {
  const r = new Router();
  r.route("/health", { GET: health }, { auth: false });
  r.ws("/hub/connect", hub.accept, { auth: false, pre: hub.accept_check });
  // Without the board's token: the token in its path reaches only its own automation.
  r.route("/hooks/{id}/{token}", { POST: automations.webhook }, { auth: false, limit: automations.MAX_BODY ?? 1 << 20 });
  host_routes(r);
  r.route("/hosts", { GET: hub.list_hosts, POST: hub.add_host });
  r.route("/hosts/join", { GET: hub.join_info });
  r.route("/hosts/ssh-key", { GET: hub.ssh_key });
  r.route("/hosts/ssh", { POST: hub.add_ssh_host });
  r.route("/hosts/copy-claude-config", { POST: hub.copy_claude_config });
  r.route("/hosts/{id}", { PATCH: hub.rename_host, DELETE: hub.remove_host });
  r.route("/hosts/{id}/update", { POST: hub.update_host });
  r.route("/preview-status", { GET: tasks.preview_status });
  r.route("/push", { GET: push.info });
  r.route("/push/subscriptions", { POST: push.subscribe });
  r.route("/push/subscriptions/{id}", { PATCH: push.update, DELETE: push.unsubscribe });
  r.route("/push/subscriptions/{id}/test", { POST: push.test });
  r.route("/h/{host_id}/{*rest}", { ANY: hub.proxy }, { limit: 300 << 20 });
  r.ws("/ws", hub.ws);
  s.local_router = r;
  return r;
}

/** Everything about this host's own board. */
function host_routes(r: Router) {
  r.route("/info", { GET: info });
  r.route("/default-prompts", { GET: () => prompts.defaults() });
  r.route("/profiles", { GET: profiles.list_profiles, POST: profiles.create_profile });
  r.route("/profiles/{id}", { PATCH: profiles.update_profile, DELETE: claude_configs.delete_profile });
  r.route("/github-accounts", { GET: profiles.github_accounts });
  r.route("/github-repos", { GET: profiles.github_repos });
  r.route("/claude-configs", { GET: claude_configs.list_claude_configs, POST: claude_configs.create_claude_config });
  r.route("/claude-configs/{id}", { PATCH: claude_configs.update_claude_config, DELETE: claude_configs.delete_claude_config });
  r.route("/profiles/{id}/projects", { GET: projects.list_projects, POST: projects.create_project });
  r.route("/profiles/{id}/projects/clone", { POST: projects.clone_project });
  r.route("/profiles/{id}/projects/github", { POST: projects.create_github_project });
  r.route("/profiles/{id}/tasks", { GET: tasks.list_profile_tasks, POST: new_task.create_scratch_task });
  // Scratch chats, of which there are none since they became scratch tasks (for older boards).
  r.route("/profiles/{id}/scratch", { GET: tasks.list_profile_scratch });
  r.route("/profiles/{id}/group-tasks", { GET: tasks.list_group_tasks, POST: new_task.create_group_task });
  r.route("/profiles/{id}/analytics", { GET: analytics.get });
  r.route("/profiles/{id}/context-stats", { GET: analytics.context });
  r.route("/profiles/{id}/token-stats", { GET: analytics.tokens });
  r.route("/profiles/{id}/disk-usage", { GET: disk.get });
  r.route("/profiles/{id}/asana/tasks", { GET: profiles.asana_tasks });
  r.route("/projects/{id}", { GET: projects.get_project, PATCH: projects.update_project, DELETE: projects.delete_project });
  r.route("/projects/{id}/tasks", { GET: tasks.list_project_tasks, POST: new_task.create_task });
  r.route("/projects/{id}/remove-merged-worktrees", { POST: thread.remove_merged_worktrees });
  r.route("/projects/{id}/setup-thread", { POST: thread.start_setup_thread });
  r.route("/projects/{id}/system-prompt", { GET: thread.system_prompt_preview });
  r.route("/projects/{id}/branches", { GET: projects.project_branches });
  r.route("/projects/{id}/automations", { GET: automations.list_handler, POST: automations.create_handler });
  r.route("/automations/{id}", { GET: automations.get_handler, PATCH: automations.update_handler, DELETE: automations.delete_handler });
  r.route("/automations/{id}/run", { POST: automations.run_handler });
  r.route("/automations/{id}/runs", { GET: automations.runs_handler });
  r.route("/projects/{id}/workflows", { GET: workflows.list_handler, POST: workflows.create_handler });
  r.route("/workflows/{id}", { GET: workflows.get_handler, PATCH: workflows.update_handler, DELETE: workflows.delete_handler });
  r.route("/workflows/{id}/run", { POST: workflows.run_handler });
  r.route("/tasks/{id}/workflow-runs", { GET: workflows.task_runs_handler });
  r.route("/workflow-runs/{id}/stop", { POST: workflows.stop_run_handler });
  r.route("/agent-tools", { GET: agent_tools.get_global });
  r.route("/agent-tools/switches", { POST: agent_tools.set_switch });
  r.route("/agent-tools/skill-sources", { POST: agent_tools.add_source });
  r.route("/agent-tools/skill-sources/{source}", { DELETE: agent_tools.delete_source });
  r.route("/agent-tools/skill-sources/{source}/update", { POST: agent_tools.update_source });
  r.route("/agent-tools/skills", { POST: agent_tools.create_global_skill });
  r.route("/agent-tools/skills/{skill}", { PATCH: agent_tools.update_global_skill, DELETE: agent_tools.delete_global_skill });
  r.route("/agent-tools/mcp-servers", { POST: agent_tools.create_global_mcp_server });
  r.route("/agent-tools/mcp-servers/{server}", { PATCH: agent_tools.update_global_mcp_server, DELETE: agent_tools.delete_global_mcp_server });
  r.route("/projects/{id}/agent-tools", { GET: agent_tools.get, PATCH: agent_tools.patch });
  r.route("/projects/{id}/agent-tools/skills", { POST: agent_tools.create_skill });
  r.route("/projects/{id}/agent-tools/skills/{skill}", { PATCH: agent_tools.update_skill, DELETE: agent_tools.delete_skill });
  r.route("/projects/{id}/agent-tools/mcp-servers", { POST: agent_tools.create_mcp_server });
  r.route("/projects/{id}/agent-tools/mcp-servers/{server}", { PATCH: agent_tools.update_mcp_server, DELETE: agent_tools.delete_mcp_server });
  r.route("/tasks/{id}", { GET: tasks.get_task, PATCH: tasks.update_task, DELETE: tasks.delete_task });
  r.route("/tasks/{id}/messages", { GET: thread.list_messages, POST: thread.send_message });
  r.route("/tasks/{id}/questions/{message_id}", { POST: thread.answer_question });
  r.route("/tasks/{id}/stop", { POST: thread.stop_task });
  r.route("/tasks/{id}/queue", { DELETE: thread.unqueue_message });
  r.route("/tasks/{id}/wait-for-limit", { POST: usage.wait_for_reset });
  r.route("/tasks/{id}/review", { POST: thread.review_task });
  r.route("/tasks/{id}/review/extend", { POST: thread.extend_review });
  r.route("/tasks/{id}/summary", { POST: thread.summarise_task });
  r.route("/tasks/{id}/fix_checks", { POST: thread.fix_checks });
  r.route("/tasks/{id}/worktree/setup", { POST: thread.setup_worktree });
  r.route("/tasks/{id}/worktree/teardown", { POST: thread.teardown_worktree });
  r.route("/tasks/{id}/diff", { GET: thread.task_diff });
  r.route("/tasks/{id}/unmerged", { GET: thread.task_unmerged });
  r.route("/tasks/{id}/fanout", { GET: fanout.get });
  r.route("/tasks/{id}/fanout/pick", { POST: fanout.pick });
  r.route("/tasks/{id}/git", { GET: git_view.status });
  r.route("/tasks/{id}/git/diff", { GET: git_view.diff });
  r.route("/tasks/{id}/git/show", { GET: git_view.show });
  r.route("/tasks/{id}/git/stage", { POST: git_view.stage });
  r.route("/tasks/{id}/git/unstage", { POST: git_view.unstage });
  r.route("/tasks/{id}/git/discard", { POST: git_view.discard });
  // A patch of a big file's lines is past the default 2 MB body limit.
  r.route("/tasks/{id}/git/apply", { POST: git_view.apply }, { limit: 32 << 20 });
  r.route("/tasks/{id}/git/commit", { POST: git_view.commit });
  r.route("/tasks/{id}/git/stash", { POST: git_view.stash });
  r.route("/tasks/{id}/git/reset", { POST: git_view.reset });
  r.route("/tasks/{id}/turns", { GET: checkpoints.turns });
  r.route("/tasks/{id}/turns/diff", { GET: checkpoints.diff });
  r.route("/tasks/{id}/rewind", { POST: checkpoints.rewind, DELETE: checkpoints.cancel_rewind });
  r.route("/tasks/{id}/context", { GET: context.get });
  r.route("/tasks/{id}/skills", { GET: agent_tools.for_task });
  r.route("/tasks/{id}/document", { GET: documents.get });
  r.route("/tasks/{id}/terminal", { GET: thread.terminal_status, DELETE: thread.kill_terminal });
  r.ws("/tasks/{id}/terminal/ws", thread.terminal_ws, { pre: thread.terminal_ws_check });
  r.route("/tasks/{id}/terminal/keepalive", { POST: thread.terminal_keepalive });
  r.route("/claude-configs/{id}/models", { GET: claude_configs.claude_config_models });
  // A config with plugins and skills is easily past the default 2 MB body limit.
  r.route("/claude-configs/{id}/archive", { GET: claude_configs.export_claude_config, POST: claude_configs.import_claude_config }, { limit: 256 << 20 });
  r.route("/profiles/{id}/claude-config", { GET: claude_configs.export_profile_config, POST: claude_configs.import_profile_config }, { limit: 256 << 20 });
  r.route("/attachments", { POST: attachments.upload }, { limit: 16 << 20 });
  r.route("/attachments/{id}/{name}", { GET: attachments.download });
  r.route("/permissions", { GET: thread.list_permissions });
  r.route("/permissions/{id}", { POST: thread.resolve_permission });
  r.route("/project-approvals", { GET: thread.project_approvals });
  // Its handler checks the token: a run may use its own (see mcp/http.ts).
  r.route("/internal/mcp", { POST: host.internal_mcp }, { auth: false });
  r.route("/internal/merge-gate/{run_id}", { GET: host.internal_merge_gate });
  r.route("/tools/{tool}", { POST: host.remote_tool });
  r.route("/usage", { GET: usage.list });
  r.route("/settings", { GET: host.get_settings, PATCH: host.update_settings });
  r.route("/fs/dirs", { GET: host.fs_dirs });
  r.route("/admin/server", { GET: host.server_status });
  r.route("/admin/restart", { POST: host.restart_server });
  // A hub's bundle of its branch: older hubs send all of it, several MB.
  r.route("/admin/update", { POST: host.update_from_hub }, { limit: 256 << 20 });
  r.route("/admin/release/check", { POST: host.check_releases });
  r.route("/admin/release/update", { POST: host.update_to_release });
  r.route("/admin/release/rollback", { POST: host.roll_back_release });
  r.ws("/host/ws", ws);
}

/** Whether a request carries the board's token, in its Authorization header or as `?token=`. */
export function authorized(s: AppState, headers: Record<string, any>, query_string: string): boolean {
  const auth = headers["authorization"];
  const header_ok = typeof auth === "string" && auth.startsWith("Bearer ") && same_secret(auth.slice(7), s.token);
  const query_ok = query_string.split("&").some((kv) => kv.startsWith("token=") && same_secret(decodeURIComponentSafe(kv.slice(6)), s.token));
  return header_ok || query_ok;
}

const decodeURIComponentSafe = (v: string) => {
  try {
    return decodeURIComponent(v);
  } catch {
    return v;
  }
};

/** Pick known keys out of a JSON body as (column, value) pairs. */
export function pick(body: Record<string, any>, keys: string[]): Array<[string, any]> {
  return keys.filter((k) => body && Object.hasOwn(body, k)).map((k) => [k, body[k]] as [string, any]);
}

/** Build the request for `method` `url` (a path under `/api`, with its query). */
export function makeReq(method: string, url: string, headers: Record<string, any>, raw: Buffer): Req {
  const q = url.indexOf("?");
  const path = q < 0 ? url : url.slice(0, q);
  const query_string = q < 0 ? "" : url.slice(q + 1);
  return { method, path, params: {}, query: parseQuery(query_string), query_string, headers, body: parseBody(raw), raw };
}

/**
 * Answer a request for `/api/...` (`req.path` includes `/api`). `trusted` skips the token check (in-process requests
 * this host makes of itself).
 */
export async function dispatch(s: AppState, req: Req, trusted = false): Promise<Answer> {
  const r = s.local_router!;
  const sub = req.path.replace(/^\/api/, "");
  const found = r.find(sub);
  if (!found) return { status: 404, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(no_route_error(req.method, req.path))) };
  if (found.route.auth && !trusted && !authorized(s, req.headers, req.query_string)) {
    return { status: 401, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify({ error: "unauthorized" })) };
  }
  const h = found.route.methods.get(req.method) ?? found.route.methods.get("ANY") ?? (req.method === "HEAD" ? found.route.methods.get("GET") : undefined);
  if (!h) return { status: 405, headers: { "content-type": "application/json" }, body: Buffer.from(JSON.stringify(no_route_error(req.method, req.path))) };
  // As axum's Json extractor; the webhook route (no token) takes any body as it is.
  if (req.raw.length && req.body === null && found.route.auth && req.headers["content-type"]?.includes("json")) {
    return { status: 400, headers: { "content-type": "text/plain" }, body: Buffer.from("Failed to parse the request body as JSON") };
  }
  req.params = found.params;
  return call(h, s, req, `${req.method} /${found.route.segs.join("/")}`);
}

/** Run a request against this node's own host API, as an authenticated caller: (status, JSON body or its text). */
export async function local_request(s: AppState, method: string, path: string, body: Buffer | null): Promise<[number, any]> {
  const req = makeReq(method, path, { authorization: `Bearer ${s.token}`, "content-type": "application/json" }, body ?? Buffer.alloc(0));
  const a = await dispatch(s, req, true);
  const text = a.body.toString("utf8");
  try {
    return [a.status, JSON.parse(text)];
  } catch {
    return [a.status, text];
  }
}

/** Unauthenticated: with the commit it runs, for hosts that follow it with `--update-from`. */
function health(s: AppState) {
  return { ok: true, commit: s.meta.running_commit };
}

function info(s: AppState) {
  let hostname = "";
  try {
    hostname = readFileSync("/proc/sys/kernel/hostname", "utf8").trim();
  } catch {}
  const home = home_dir();
  return {
    host_id: s.host_id,
    host_name: s.host_name,
    build_id: BUILD_ID,
    api_version: API_VERSION,
    api_compat: API_COMPAT,
    commit: s.meta.running_commit,
    updates_from: admin.updates_from(s.meta),
    agents: runs.can_run_agents(s),
    agent_clis: db.AGENTS.filter((a: string) => runs.has_agent(a)),
    version: VERSION,
    data_dir: path_str(s.data_dir),
    hostname,
    home: home ? path_str(home) : null,
  };
}

/** This host's events, for a hub that links to it. */
function ws(s: AppState, _r: Req, socket: WebSocket) {
  socket.send(JSON.stringify({ type: "hello" }));
  const off = s.events.subscribe((v) => {
    if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(v));
  });
  socket.on("close", off);
  socket.on("error", off);
}

export { Reply };
