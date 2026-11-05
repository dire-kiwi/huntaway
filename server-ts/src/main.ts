// Port of server/src/main.rs's command line. Each subcommand loads only its own modules: agents start `huntaway mcp`,
// `gh-mcp` and `gh-hook` often, and they shouldn't load the whole server.
import { mkdirSync } from "node:fs";
import { err_str } from "./util.ts";

async function main() {
  // What bin/huntaway was run as, kept from what this server starts (agents, a test server they run from a checkout).
  const exe = process.env.IA_TS_EXE ?? null;
  delete process.env.IA_TS_EXE;
  // bin/huntaway's malloc setting is for node (see there), not for agents, git and the rest this server runs.
  if (process.env.IA_MALLOC_MMAP) {
    delete process.env.MALLOC_MMAP_THRESHOLD_;
    delete process.env.IA_MALLOC_MMAP;
  }
  // Kept where state.ts's default_exe reads it, without loading the server for every subcommand.
  (globalThis as any).huntaway_exe = exe;
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case undefined: {
      const { serve, parse_serve_args } = await import("./serve.ts");
      return serve(parse_serve_args([]));
    }
    case "serve": {
      const { serve, parse_serve_args } = await import("./serve.ts");
      return serve(parse_serve_args(rest));
    }
    case "mcp":
      return (await import("./mcp.ts")).serve_stdio();
    case "gh-mcp":
      return (await import("./mcp/gh_mcp.ts")).serve_stdio();
    case "gh-hook":
      return (await import("./mcp/gh_mcp.ts")).bash_hook();
    case "approval-hook": {
      // bin/huntaway runs approval_rules/hook.ts directly; this is for a server started some other way.
      const code = await (await import("./agent/approval_rules/hook.ts")).hook(rest[0]);
      process.exitCode = code;
      return;
    }
    case "gh-run":
      return process.exit(await (await import("./mcp/gh_mcp.ts")).gh_run(rest));
    case "codex-run":
      return (await import("./agent/codex.ts")).run_adapter(rest[0]);
    case "google-auth":
      // Sign in to Google for the assistant's Google server, on a headless host (see agent/assistant/google/consent.ts).
      return (await import("./agent/assistant/google/consent.ts")).run(rest);
    case "token": {
      const { default_data_dir, load_or_create_token } = await import("./serve.ts");
      let dir = process.env.IA_DATA_DIR || null;
      let hub = false;
      for (let i = 0; i < rest.length; i++) {
        if (rest[i] === "--hub") hub = true;
        else if (rest[i] === "--data-dir") dir = rest[++i];
        else if (rest[i].startsWith("--data-dir=")) dir = rest[i].slice(11);
      }
      dir ??= default_data_dir();
      mkdirSync(dir, { recursive: true });
      console.log(load_or_create_token(dir, hub ? "hub_token" : "auth_token"));
      return;
    }
    case "title-check":
      return (await import("./agent/title.ts")).check_cli(rest);
    case "threads-import": {
      const report = await import("./threads/report.ts");
      report.run(report.parse_args(rest));
      return;
    }
    case "ssh-host":
      return (await import("./hosts/ssh.ts")).ssh_host_cli(rest);
    case "--version":
    case "-V":
      console.log(`huntaway ${(await import("./hosts/proto.ts")).VERSION}`);
      return;
    case "--help":
    case "-h":
    case "help":
      console.log("Usage: huntaway [serve|mcp|gh-mcp|token|google-auth] [OPTIONS]\n\nThe TypeScript port of the huntaway server (see server-ts/PORTING.md).");
      return;
    default:
      console.error(`error: unrecognized subcommand '${cmd}'`);
      process.exit(2);
  }
}

main().catch((e) => {
  console.error(`Error: ${err_str(e)}`);
  process.exit(1);
});
