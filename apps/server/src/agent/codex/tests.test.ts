// Port of server/src/agent/codex/tests.rs.
import { test } from "vite-plus/test";
import assert from "node:assert/strict";
import { MCP_SERVER_NAME } from "../runner.ts";
import { REVIEW_PROFILE, Spec_default, is_claude_model, policy, thread_params, type Spec } from "../codex.ts";
import { display_command, mcp_server_config } from "./adapter.ts";
import { tool_output, tool_use } from "./output.ts";
import { limits, title_model, type Model } from "./queries.ts";

test("rate_limit_windows_go_by_their_length", () => {
  const ids = (rl: any) => limits(rl).map((l) => [l.id, l.label]);
  const w = (mins: number | null) => ({ usedPercent: 10, windowDurationMins: mins, resetsAt: 1793521800 });
  assert.deepEqual(ids({ primary: w(300), secondary: w(10080) }), [
    ["session", "Session"],
    ["weekly", "Weekly"],
  ]);
  // A weekly-only plan's primary window is its weekly one.
  assert.deepEqual(ids({ primary: w(10080), secondary: null }), [["weekly", "Weekly"]]);
  assert.deepEqual(ids({ primary: w(null), secondary: w(null) }), [
    ["session", "Session"],
    ["weekly", "Weekly"],
  ]);
  assert.deepEqual(ids({ primary: w(120), secondary: w(43200) }), [
    ["window:120", "2-hour"],
    ["window:43200", "30-day"],
  ]);
});

test("unwraps_shell_commands", () => {
  assert.equal(display_command("/usr/bin/bash -lc 'ls -la && printf hi > hello.txt'"), "ls -la && printf hi > hello.txt");
  assert.equal(display_command("/bin/zsh -lc 'echo '\\''hi'\\'''"), "echo 'hi'");
  assert.equal(display_command('bash -c "make"'), "make");
  assert.equal(
    display_command(String.raw`/usr/bin/bash -lc "printf 'hi\\n' && git commit -m \"Add it\""`),
    String.raw`printf 'hi\n' && git commit -m "Add it"`,
  );
  assert.equal(display_command("git status"), "git status");
  assert.equal(display_command("python -c 'print(1)'"), "python -c 'print(1)'");
  assert.equal(display_command(`/usr/bin/bash -lc "cat <<'EOF'\n#"'!/bin/sh'"\nEOF"`), "cat <<'EOF'\n#!/bin/sh\nEOF");
  assert.equal(display_command("bash -lc 'a' 'b'"), "bash -lc 'a' 'b'");
});

test("maps_permission_modes", () => {
  assert.deepEqual(policy("default", false), ["untrusted", "user", "workspace-write"]);
  assert.deepEqual(policy("bypassPermissions", true), ["never", "user", "danger-full-access"]);
  assert.deepEqual(policy("acceptEdits", true), ["never", "user", "read-only"]);
  assert.equal(policy("plan", false)[2], "read-only");
});

test("a_reviewer_writes_only_its_build_output_and_temp_directories", () => {
  const spec = (sandbox: string, fs: Array<[string, string]>): Spec =>
    Spec_default({ sandbox, approval_policy: "never", writable_roots: ["/repo/.git"], filesystem: Object.fromEntries(fs) });
  let p = thread_params(
    spec("read-only", [
      ["/w", "read"],
      ["/w/target", "write"],
      ["/home/me/.npm", "write"],
    ]),
    "/w",
    {},
  );
  assert.equal(p.sandbox, undefined);
  assert.equal(p.config.sandbox_workspace_write, undefined);
  assert.equal(p.config.default_permissions, REVIEW_PROFILE);
  assert.deepEqual(p.config.permissions[REVIEW_PROFILE], {
    extends: ":read-only",
    filesystem: { ":tmpdir": "write", ":slash_tmp": "write", "/w": "read", "/w/target": "write", "/home/me/.npm": "write" },
    network: { enabled: true },
  });
  // Without anything to write, or in another sandbox, it's the sandbox as given.
  p = thread_params(spec("read-only", []), "/w", {});
  assert.deepEqual([p.sandbox, p.config.permissions], ["read-only", undefined]);
  p = thread_params(spec("workspace-write", [["/w/target", "write"]]), "/w", {});
  assert.equal(p.sandbox, "workspace-write");
  assert.deepEqual(p.config.sandbox_workspace_write, { network_access: true, writable_roots: ["/repo/.git"] });
  assert.equal(p.config.default_permissions, undefined);
});

test("converts_mcp_servers", () => {
  const stdio = { type: "stdio", command: "x", args: ["mcp"], env: { A: "1" } };
  assert.deepEqual(mcp_server_config("s", stdio, false, [], false), { command: "x", args: ["mcp"], env: { A: "1" } });
  assert.equal(mcp_server_config("s", stdio, true, [], false).default_tools_approval_mode, "approve");
  const http = { type: "http", url: "https://h/mcp", headers: { Authorization: "Bearer t" } };
  assert.deepEqual(mcp_server_config("h", http, false, [], false), { url: "https://h/mcp", http_headers: { Authorization: "Bearer t" } });
  assert.equal(mcp_server_config("e", { type: "sse", url: "u" }, false, [], false), null);
  assert.equal(mcp_server_config(MCP_SERVER_NAME, { command: "ia" }, false, [], false).tool_timeout_sec, 3900);
  assert.deepEqual(mcp_server_config("s", stdio, false, ["w"], false).disabled_tools, ["w"]);
  // In auto mode the board's tools stay approved but wait, which Codex's reviewer reviews.
  const board = mcp_server_config(MCP_SERVER_NAME, { command: "ia" }, false, [], true);
  assert.deepEqual([board.default_tools_approval_mode, board.tools], ["approve", { wait: { approval_mode: "prompt" } }]);
  assert.equal(mcp_server_config(MCP_SERVER_NAME, { command: "ia" }, false, [], false).tools, undefined);
  assert.equal(mcp_server_config("s", stdio, true, [], true).tools, undefined);
  // The desktop's read-only tools are approved and its actions ask (HA-273).
  const desktop = mcp_server_config("desktop", http, false, ["act"], false);
  assert.equal(desktop.default_tools_approval_mode, undefined);
  assert.deepEqual([desktop.tools.read, desktop.tools.act, desktop.disabled_tools], [{ approval_mode: "approve" }, undefined, ["act"]]);
});

test("spots_claude_models", () => {
  assert.ok(is_claude_model("opus"));
  assert.ok(is_claude_model("claude-sonnet-5-5"));
  assert.ok(!is_claude_model("gpt-6.1-sol"));
});

test("shows_items_as_tools", () => {
  const cmd = { type: "commandExecution", id: "e1", command: "/usr/bin/bash -lc 'false'", status: "completed", exitCode: 1, aggregatedOutput: "nope\n" };
  assert.equal(tool_use(cmd)![0], "Bash");
  assert.deepEqual(tool_output(cmd), ["nope\n(exit code 1)", true]);
  const mcp_call = {
    type: "mcpToolCall",
    server: "huntaway",
    tool: "get_task",
    arguments: { task_id: "IA-1" },
    status: "completed",
    result: { content: [{ type: "text", text: "ok" }] },
  };
  assert.equal(tool_use(mcp_call)![0], "mcp__huntaway__get_task");
  assert.deepEqual(tool_output(mcp_call), ["ok", false]);
  assert.equal(tool_use({ type: "userMessage" }), null);
});

test("titles_use_a_cheap_model_at_low_effort", () => {
  const m = (id: string, description: string, is_default = false, efforts = ["low", "medium", "high"]): Model => ({
    id,
    name: id,
    description,
    is_default,
    efforts,
    default_effort: "medium",
  });
  // HA-196: the config's default here is its biggest model.
  const list = [
    m("gpt-6.1-sol", "Most capable model for hard work.", true),
    m("gpt-5.6-luna", "Older fast and efficient model."),
    m("gpt-6-luna", "Fast and affordable model for easier tasks."),
    m("gpt-6-codex-mini", "", false, ["medium", "high"]),
  ];
  assert.deepEqual(title_model(list), { model: "gpt-6-luna", effort: "low" });
  // The default when it's a cheap one; by its name when it doesn't say; the least effort when it can't do low.
  assert.deepEqual(title_model([list[3], m("gpt-6-luna", "Fast and affordable model.", true)]), { model: "gpt-6-luna", effort: "low" });
  assert.deepEqual(title_model([list[0], list[3]]), { model: "gpt-6-codex-mini", effort: "medium" });
  // None that's cheap: the config's default.
  assert.deepEqual(title_model([list[0]]), { model: null, effort: "low" });
  assert.deepEqual(title_model([]), { model: null, effort: "low" });
});
