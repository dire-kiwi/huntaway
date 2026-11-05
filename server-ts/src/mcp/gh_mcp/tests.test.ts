// Port of server/src/mcp/gh_mcp/tests.rs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createServer as createTcpServer, type AddressInfo } from "node:net";
import { join } from "node:path";
import * as testing from "../../testing.ts";
import {
  Account, READ_ONLY, WRITES, ACCOUNT_ENV, MAX_OUTPUT, TOKEN_VARS, TEST_BOARD, TEST_GH_PROGRAM, accounts_from_status, authenticate_fetch, clip,
  command, extra_header_resets, gh_program, handle, hook_denial, merges, pr_from_url, push_urls, run, tools, url_host,
} from "../gh_mcp.ts";
import { CommandHelp } from "./targets.ts";

const args = (tool: string, a: any) => command(tool, a).args;
const ok = (f: () => unknown) => {
  try {
    f();
    return true;
  } catch {
    return false;
  }
};
const err = (f: () => unknown): string => {
  try {
    f();
  } catch (e: any) {
    return e.message;
  }
  throw new Error("no error");
};

test("every_tool_builds_and_read_only_ones_exist", () => {
  const names = tools().map((t) => t.name as string);
  assert.deepEqual([...READ_ONLY, ...WRITES].sort(), [...names].sort(), "every tool is in READ_ONLY or WRITES");
  for (const t of tools()) assert.equal(t.annotations.readOnlyHint, READ_ONLY.includes(t.name), t.name);
  const full = { pr: "3", repo: "o/r", issue: "4", body: "b", title: "t", run_id: "5", endpoint: "user", args: ["status"] };
  for (const n of names) assert.ok(ok(() => command(n, full)), n);
});

test("builds_commands", () => {
  assert.deepEqual(args("pr_create", {}), ["pr", "create", "--fill"]);
  const create = command("pr_create", { title: "Fix it", body: "- one\n", base: "master", draft: true, repo: "o/r" });
  assert.deepEqual(create.args, ["pr", "create", "--title=Fix it", "--body=- one\n", "--base=master", "--draft"]);
  assert.equal(create.repo, "o/r");
  // gh api has no --repo: the repository goes in GH_REPO, as for every gh command.
  const api = command("api", { endpoint: "repos/{owner}/{repo}/pulls", repo: "cli/cli" });
  assert.deepEqual([api.args, api.repo], [["api", "repos/{owner}/{repo}/pulls"], "cli/cli"]);
  assert.ok(!ok(() => command("pr_create", { body: "x" })));
  // pr_merge always passes --repo (resolved by `run`), so gh leaves local branches alone.
  assert.deepEqual(args("pr_merge", { pr: "12", repo: "o/r", delete_branch: true }), ["pr", "merge", "12", "--repo=o/r", "--merge", "--delete-branch"]);
  assert.ok(!ok(() => command("pr_merge", { pr: "12" })));
  assert.ok(!ok(() => command("pr_merge", { pr: "feature", repo: "o/r" })));
  assert.ok(!ok(() => command("pr_edit", { pr: "1" })));
  assert.deepEqual(args("pr_edit", { body: "" }), ["pr", "edit", "--body="]);
  assert.deepEqual(args("pr_edit", { pr: "1", title: "T" }), ["pr", "edit", "1", "--title=T"]);
  assert.deepEqual(command("pr_checks", {}).ok_codes, [0, 8]);
  assert.deepEqual(args("api", { endpoint: "repos/{owner}/{repo}/issues", fields: { title: "@x" }, paginate: true }), [
    "api", "repos/{owner}/{repo}/issues", "--raw-field", "title=@x", "--paginate",
  ]);
  assert.deepEqual(args("api", { endpoint: "graphql", fields: { n: 2 } }), ["api", "graphql", "--field", "n=2"]);
  assert.ok(!ok(() => command("api", { endpoint: "x", fields: { a: [1] } })));
  assert.ok(!ok(() => command("run_view", { run_id: "1; rm" })));
  assert.ok(!ok(() => command("gh", { args: [] })));
  // Nor what would show the account's token, or change what later gh commands run.
  for (const refused of [
    ["auth", "token"],
    ["auth", "status", "--show-token"],
    ["--help", "auth", "token"],
    ["extension", "install", "o/gh-x"],
    ["ext", "install", "o/gh-x"],
    ["alias", "set", "co", "!sh -c x"],
    ["config", "set", "editor", "x"],
    ["-R", "o/r", "auth", "token"],
    ["config", "get", "-h", "github.com", "oauth_token"],
    ["config", "get", "oauth_token", "--host=github.com"],
    ["config", "get", "-hgithub.com", "user"],
    ["config", "get", "oauth_token"],
    ["config", "--host=github.com", "get", "oauth_token"],
    ["config", "-hgithub.com", "get", "oauth_token"],
    ["config", "--host", "github.com", "get", "oauth_token"],
    ["config", "--help", "get", "-h", "github.com", "user"],
    ["alias", "--help", "set", "co", "!sh"],
  ]) {
    const e = err(() => command("gh", { args: refused }));
    assert.ok(e.includes("isn't available to agents") || e.includes("put gh's command first") || e.includes("put the subcommand"), `${refused}: ${e}`);
  }
  for (const allowed of [["release", "list"], ["--version"], ["alias", "list"], ["config", "get", "editor"], ["issue", "create", "--title", "auth"]]) {
    assert.ok(ok(() => command("gh", { args: allowed })), String(allowed));
  }
  const push = command("git_push", { repo: "ignored" });
  assert.deepEqual([push.program, push.args], ["git", ["push", "-u", "origin", "HEAD"]]);
  assert.deepEqual(command("git_push", { branch: "ia/x-1_fix.it" }).args, ["push", "-u", "origin", "ia/x-1_fix.it"]);
  // A branch name, not a refspec that would push (or force-push) another ref.
  for (const bad of ["+HEAD:refs/heads/master", "HEAD:master", ":master", "-f", "a b", "a..b", "x^", "*", "+master", "a[b", "@", "a@{1}", "a/.b", "a.lock", "a/", "a.", "a//b", "a\tb"]) {
    assert.ok(!ok(() => command("git_push", { branch: bad })), JSON.stringify(bad));
  }
  for (const good of ["feature/c++", "HEAD", "v1.2", "a@b", "x+"]) assert.deepEqual(command("git_push", { branch: good }).args, ["push", "-u", "origin", good]);
});

test("reads_accounts", () => {
  const a = (s: string) => {
    const x = Account.parse(s);
    return x ? [x.host, x.login] : null;
  };
  assert.deepEqual(a(" octocat "), ["github.com", "octocat"]);
  assert.deepEqual(a("GHE.example.com/me_corp"), ["ghe.example.com", "me_corp"]);
  assert.equal(Account.parse("ghe.example.com/me")!.toString(), "ghe.example.com/me");
  assert.equal(Account.parse("github.com/octocat")!.toString(), "octocat");
  for (const bad of ["", "-x", "a b", "a/b/c", "/x", "x/", "o;rm", "--user=x"]) assert.equal(a(bad), null, bad);
  const status = {
    hosts: {
      "github.com": [{ login: "me", active: true, state: "success" }, { login: "work-me", active: false, state: "error" }],
      "ghe.example.com": [{ login: "me", active: true, state: "success" }],
    },
  };
  const names = accounts_from_status(status).map((x) => [x.account, x.active === true, x.ok === true]);
  assert.deepEqual(names, [["ghe.example.com/me", true, true], ["me", true, true], ["work-me", false, false]]);
});

test("gh_acts_as_the_account_and_no_other", () => {
  for (const [account, host] of [["me", "github.com"], ["acme.ghe.com/me", "acme.ghe.com"], ["ghe.example.com/me", "ghe.example.com"]]) {
    const vars: NodeJS.ProcessEnv = { GH_TOKEN: "ambient", GITHUB_TOKEN: "ambient", GH_ENTERPRISE_TOKEN: "ambient", GH_HOST: "elsewhere", GH_REPO: "evil.example.com/o/r" };
    const env = Account.parse(account)!.env("tok_123");
    env.apply(vars);
    assert.equal(vars.GH_HOST, host, account);
    // No token in the environment, nor an inherited repository.
    for (const v of [...TOKEN_VARS, "GH_REPO"]) assert.ok(v in vars && vars[v] === undefined, `${account} ${v}`);
    // Nor the keyring's logins.
    if (process.platform === "linux") assert.equal(vars.DBUS_SESSION_BUS_ADDRESS, "disabled:");
    // A login for the account's host only, readable by this user only.
    const dir = vars.GH_CONFIG_DIR!;
    const hosts = readFileSync(join(dir, "hosts.yml"), "utf8");
    assert.ok(
      hosts.startsWith(`"${host}":\n`) && hosts.split("tok_123").length - 1 === 2 && hosts.split("\n").filter((l) => l && !l.startsWith(" ")).length === 1,
      hosts,
    );
    assert.equal(statSync(dir).mode & 0o777, 0o700);
    assert.equal(statSync(join(dir, "hosts.yml")).mode & 0o777, 0o600);
    env.drop();
    assert.ok(!existsSync(dir), account);
  }
});

const has_gh = () => !spawnSync("gh", ["--version"], { stdio: "ignore" }).error;

test("gh_sends_the_token_to_the_accounts_host_only", { timeout: 120_000 }, async () => {
  // Where real gh sends requests, and with what Authorization header (gh's debug output shows whether there's a
  // token). `.invalid` names never resolve, so nothing leaves.
  const requests = async (args: string[]): Promise<Array<[string, boolean]> | null> => {
    const env = Account.parse("ghe.invalid/me")!.env("tok_123");
    try {
      const vars: NodeJS.ProcessEnv = { ...process.env, GH_DEBUG: "api", GH_PROMPT_DISABLED: "1" };
      env.apply(vars);
      const log = await new Promise<string | null>((resolve) => {
        const child = spawn("gh", args, { env: vars, cwd: env.dir, stdio: ["ignore", "ignore", "pipe"] });
        let err = "";
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve(null);
        }, 20_000);
        child.stderr!.on("data", (b) => (err += b));
        child.on("error", () => {
          clearTimeout(timer);
          resolve(null);
        });
        child.on("close", () => {
          clearTimeout(timer);
          resolve(err);
        });
      });
      if (log === null) return null;
      const lines = log.split("\n");
      const found: Array<[string, boolean]> = [];
      lines.forEach((line, i) => {
        if (line.startsWith("* Request to ")) {
          const url = line.slice("* Request to ".length);
          let token = false;
          for (const l of lines.slice(i + 1)) {
            if (l.startsWith("* ")) break;
            if (l.startsWith("> Authorization: token")) token = true;
          }
          found.push([url_host(url) ?? "", token]);
        }
      });
      return found;
    } finally {
      env.drop();
    }
  };
  // Without gh, there's nothing to check.
  if (!has_gh()) return;
  const own = await requests(["api", "user"]);
  if (own === null) return;
  assert.deepEqual(own, [["ghe.invalid", true]]);
  for (const a of [["api", "https://evil.invalid/user"], ["repo", "clone", "evil.invalid:o/r"], ["repo", "view", "evil.invalid/o/r"], ["api", "--hostname", "evil.invalid", "user"]]) {
    const sent = (await requests(a))!;
    assert.ok(sent.length > 0 && sent.every(([host, token]) => host === "evil.invalid" && !token), `${a}: ${JSON.stringify(sent)}`);
  }
});

/** Parts of gh 2.102's help for some of its commands. */
const HELP: Array<[string, string]> = [
  ["pr view", `USAGE
  gh pr view [<number> | <url> | <branch>] [flags]

FLAGS
  -c, --comments          View pull request comments
  -q, --jq expression     Filter JSON output using a jq expression
      --json fields       Output JSON with the specified fields
  -w, --web               Open a pull request in the browser

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
`],
  ["issue comment", `USAGE
  gh issue comment {<number> | <url>} [flags]

FLAGS
  -b, --body text        The comment body text
  -F, --body-file file   Read body text from file
  -e, --editor           Skip prompts and open the text editor to write the body in

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
`],
  ["issue transfer", `USAGE
  gh issue transfer {<number> | <url>} <destination-repo> [flags]

INHERITED FLAGS
  -R, --repo [HOST/]OWNER/REPO   Select another repository using the [HOST/]OWNER/REPO format
`],
  ["repo edit", `USAGE
  gh repo edit [<repository>] [flags]

FLAGS
      --add-topic strings                        Add repository topic
  -d, --description string                       Description of the repository
      --enable-wiki                              Enable wiki in the repository
  -h, --homepage URL                             Repository home page URL
      --template                                 Make the repository available as a template repository
`],
  ["search code", `USAGE
  gh search code <query> [flags]

FLAGS
  -q, --jq expression      Filter JSON output using a jq expression
  -R, --repo OWNER/REPO    Filter on repository, in OWNER/REPO format
  -w, --web                Open the search query in the web browser
`],
  ["api", `USAGE
  gh api <endpoint> [flags]

FLAGS
  -F, --field key=value          Add a typed parameter in key=value format
  -H, --header key:value         Add a HTTP request header in key:value format
      --hostname string          The GitHub hostname for the request (default "github.com")
  -i, --include                  Include HTTP response status line and headers in the output
  -X, --method string            The HTTP method for the request (default "GET")
      --paginate                 Make additional HTTP requests to fetch all pages of results
  -f, --raw-field key=value      Add a string parameter in key=value format
`],
  ["repo clone", `USAGE
  gh repo clone <repository> [<directory>] [-- <gitflags>...]

FLAGS
  -u, --upstream-remote-name string   Upstream remote name when cloning a fork (default "upstream")
`],
  ["repo sync", `USAGE
  gh repo sync [<destination-repository>] [flags]

FLAGS
  -b, --branch string   Branch to sync (default [default branch])
      --force           Hard reset the branch of the destination repository to match the source repository
  -s, --source string   Source repository
`],
  ["release upload", `USAGE
  gh release upload <tag> <files>... [flags]

FLAGS
      --clobber   Delete and re-upload existing assets of the same name
`],
];

const has = (opts: CommandHelp["options"], o: [string | null, string, boolean]) => opts.some((x) => x[0] === o[0] && x[1] === o[1] && x[2] === o[2]);

test("reads_gh_help", () => {
  const help = (c: string) => CommandHelp.parse(HELP.find(([k]) => k === c)![1])!;
  const pr_view = help("pr view");
  assert.deepEqual([pr_view.path, pr_view.arguments], [2, ["[<number> | <url> | <branch>]"]]);
  assert.ok(has(pr_view.options, ["q", "--jq", true]) && has(pr_view.options, ["c", "--comments", false]));
  assert.ok(has(pr_view.options, ["R", "--repo", true]) && has(pr_view.options, [null, "--json", true]));
  assert.deepEqual(help("repo clone").arguments, ["<repository>", "[<directory>]"]);
  assert.deepEqual(help("release upload").arguments, ["<tag>", "<files>..."]);
  assert.deepEqual([help("api").path, help("api").arguments], [1, ["<endpoint>"]]);
  assert.equal(CommandHelp.parse("no usage here"), null);
});

test("gh_checks_where_a_command_goes_and_not_what_it_says", () => {
  const check = (account: string, a: string[], repo: string | null) => {
    const help = CommandHelp.parse(HELP.find(([c]) => a.join(" ").startsWith(c))![1])!;
    return ok(() => Account.parse(account)!.check_targets_with(a, repo, help));
  };
  const ghe = "ghe.example.com/me";
  // A repository's homepage and description, search queries, comments, fields and headers.
  for (const a of [
    ["repo", "edit", "o/r", "--homepage", "https://example.com"],
    ["repo", "edit", "o/r", "-h", "https://example.com", "-d", "Mirror of https://example.com/a/b"],
    ["repo", "edit", "--description=see example.com/a/b", "ghe.example.com/o/r"],
    ["search", "code", "https://example.com", "--repo", "o/r"],
    ["search", "code", "example.com/a/b", "evil.example.com:o/r"],
    ["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"],
    ["issue", "comment", "-b", "github.com/o/r", "https://ghe.example.com/o/r/issues/1"],
    ["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "-f", "body=.github/workflows/test.yml"],
    ["api", "-H", "Referer: https://example.com", "-F", "url=https://example.com", "repos/o/r/hooks"],
    ["api", "evil.example.com/o/r"],
    ["pr", "view", "--json", "url", "https://ghe.example.com/o/r/pull/1"],
    ["repo", "clone", "ghe.example.com/o/r", "build.d/a/b", "--", "--depth", "https://example.com/x/y"],
    ["release", "upload", "v1", "dist.d/o/r", "https://example.com"],
  ]) {
    assert.ok(check(ghe, a, null), String(a));
  }
  // Where the command goes: its endpoint, pull request, issue or repository, and target options.
  for (const a of [
    ["repo", "edit", "github.com/o/r", "--homepage", "https://ghe.example.com"],
    ["repo", "edit", "--enable-wiki", "https://github.com/o/r"],
    ["repo", "edit", "--template", "github.com/o/r"],
    ["search", "code", "x", "--repo", "github.com/o/r"],
    ["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"],
    ["issue", "comment", "-e", "https://github.com/o/r/issues/1"],
    ["issue", "comment", "1", "-Rgithub.com/o/r"],
    ["issue", "transfer", "1", "github.com/o/r"],
    ["issue", "transfer", "1", "git@github.com:o/r.git"],
    ["api", "-f", "x=1", "https://evil.example.com/user"],
    ["api", "--hostname=github.com", "user"],
    ["api", "--paginate", "https://api.github.com/user"],
    ["pr", "view", "-c", "https://github.com/o/r/pull/1"],
    ["pr", "view", "--web", "--", "https://github.com/o/r/pull/1"],
    ["repo", "clone", "evil.example.com:o/r"],
    ["repo", "sync", "--force", "github.com/o/r"],
    ["repo", "sync", "-s", "github.com/o/r"],
    ["repo", "sync", "--source=https://github.com/o/r"],
  ]) {
    assert.ok(!check(ghe, a, null), String(a));
  }
  assert.ok(!check(ghe, ["pr", "view", "1"], "github.com/o/r"));
  assert.ok(check("me", ["api", "https://gist.github.com/x", "-f", "a=https://ghe.example.com"], null));
});

test("gh_reads_its_own_help_for_the_check", () => {
  // With gh's real help, where there's a gh.
  if (spawnSync(gh_program(), ["--version"], { stdio: "ignore" }).error) return;
  const account = Account.parse("me")!;
  for (const a of [["repo", "edit", "o/r", "--homepage", "https://example.com"], ["search", "code", "https://example.com", "--repo", "o/r"]]) {
    account.check_targets(a, null);
  }
  assert.ok(!ok(() => account.check_targets(["pr", "view", "https://evil.example.com/o/r/pull/1"], null)));
  assert.ok(!ok(() => account.check_targets(["repo", "edit", "evil.example.com/o/r", "--homepage", "https://github.com"], null)));
});

test("gh_only_reaches_the_accounts_host", () => {
  // Without gh's help, as when there's no gh (see gh_checks_where_a_command_goes_and_not_what_it_says).
  const check = (account: string, a: string[], repo: string | null) => ok(() => Account.parse(account)!.check_targets_with(a, repo, null));
  const ghe = "ghe.example.com/me";
  assert.ok(check(ghe, ["api", "user"], "o/r"));
  assert.ok(check(ghe, ["api", "https://ghe.example.com/api/v3/user"], null));
  assert.ok(check(ghe, ["pr", "view", "https://ghe.example.com/o/r/pull/3"], "ghe.example.com/o/r"));
  // Another host's login (from the keyring), or this token sent to another host.
  assert.ok(!check(ghe, ["api", "https://api.github.com/user"], null));
  assert.ok(!check(ghe, ["api", "https://evil.example.com/user"], null));
  assert.ok(!check(ghe, ["api", "HTTPS://user@Evil.example.com:443/x"], null));
  assert.ok(!check(ghe, ["api", "--hostname", "github.com", "user"], null));
  assert.ok(!check(ghe, ["api", "--hostname=github.com", "user"], null));
  assert.ok(!check(ghe, ["pr", "list", "-R", "github.com/o/r"], null));
  assert.ok(!check(ghe, ["pr", "list", "-Rgithub.com/o/r"], null));
  assert.ok(!check(ghe, ["pr", "list", "--repo=github.com/o/r"], null));
  assert.ok(!check(ghe, ["pr", "view", "1"], "github.com/o/r"));
  assert.ok(!check(ghe, ["pr", "view", "https://github.com/o/r/pull/3"], null));
  // github.com accounts reach github.com and its API; text that isn't a target is left alone.
  assert.ok(check("me", ["api", "https://api.github.com/user", "--raw-field", "body=see https://evil.example.com"], "o/r"));
  assert.ok(check("me", ["pr", "list", "-R", "o/r"], null));
  assert.ok(!check("me", ["api", "https://api.acme.ghe.com/user"], null));
  assert.ok(check("acme.ghe.com/me", ["api", "https://api.acme.ghe.com/user"], null));
  // Repositories as arguments of their own (gh repo view, clone, fork, extension install, …).
  assert.ok(!check(ghe, ["repo", "view", "evil.example.com/o/r", "--json", "name"], null));
  assert.ok(!check(ghe, ["repo", "clone", "github.com/o/r"], null));
  assert.ok(!check(ghe, ["repo", "clone", "git@github.com:o/r.git"], null));
  assert.ok(!check(ghe, ["extension", "install", "evil.example.com:8443/o/gh-x"], null));
  assert.ok(!check(ghe, ["repo", "clone", "evil.invalid:o/r"], null));
  assert.ok(check(ghe, ["search", "issues", "repo:o/r", "is:open", "author:me"], null));
  assert.ok(check(ghe, ["api", "graphql", "-f", 'query=query { repository(owner: "o") { id } }', "-f", "q=repo:o/r"], null));
  assert.ok(check(ghe, ["repo", "clone", "ghe.example.com:o/r"], null));
  assert.ok(check(ghe, ["repo", "view", "o/r", "--json", "name,url"], null));
  assert.ok(check(ghe, ["repo", "view", "o/r"], null));
  // What issues, comments and fields say isn't where they go.
  assert.ok(check(ghe, ["api", "repos/o/r/issues", "--raw-field", "title=CI failure", "--raw-field", "body=.github/workflows/test.yml"], null));
  assert.ok(check(ghe, ["issue", "comment", "1", "--repo", "o/r", "--body", "https://example.com"], null));
  assert.ok(check(ghe, ["issue", "create", "-t", "github.com/o/r is down", "-b", "see https://github.com/o/r", "--label=github.com/x/y"], null));
  assert.ok(check(ghe, ["api", "-f", "url=https://example.com", "-H", "Referer: https://example.com", "repos/o/r/hooks", "-q", ".url"], null));
  assert.ok(check(ghe, ["pr", "create", "--body=https://example.com", "-bhttps://example.com", "--title", "evil.example.com/o/r"], null));
  assert.ok(check(ghe, ["api", "repos/o/r/contents/x", "--field", "path=docs.d/a/b"], null));
  // But the destination is still checked after them.
  assert.ok(!check(ghe, ["api", "-f", "x=1", "https://evil.example.com/user"], null));
  assert.ok(!check(ghe, ["issue", "comment", "--body", "hi", "https://github.com/o/r/issues/1"], null));
  assert.ok(!check(ghe, ["issue", "comment", "1", "--body=hi", "--repo", "github.com/o/r"], null));
  assert.ok(!check(ghe, ["repo", "sync", "-f", "github.com/o/r"], null));
  assert.ok(check(ghe, ["repo", "clone", "ghe.example.com/o/r", "./dir/a.b/c"], null));
  assert.ok(check(ghe, ["api", "repos/o/r/contents/docs.d/a/b"], null));
  // Pushes: remotes on the account's host, over HTTPS or SSH (the host's SSH keys).
  assert.ok(check("me", ["https://github.com/o/r.git"], null));
  assert.ok(check("me", ["git@github.com:o/r.git"], null));
  assert.ok(check("me", ["ssh://git@github.com/o/r.git"], null));
  assert.ok(check("me", ["../local/repo.git"], null));
  assert.ok(!check("me", ["https://gitlab.com/o/r.git"], null));
  assert.ok(!check("me", ["git@gitlab.com:o/r.git"], null));
  assert.ok(!check("me", ["ssh://git@gitlab.com/o/r.git"], null));
  assert.ok(!check("me", ["gitlab.com:o/r.git"], null));
  assert.ok(check("me", ["github.com:o/r.git"], null));
  assert.ok(check("me", ["github-work:o/r.git"], null));
});

test("a_waits_shell_gets_gh_through_gh_run_and_no_token", () => {
  const shim_dir = join(testing.temp_dir(), "shim");
  const env = Account.parse("ghe.example.com/me")!.env("tok");
  let vars: Array<[string, string]>;
  try {
    vars = env.shell_env("/opt/it's/huntaway", shim_dir);
  } catch (e: any) {
    // Without gh there's nothing to put in front of it.
    assert.ok(e.message.includes("gh isn't installed"), e.message);
    return;
  } finally {
    env.drop();
  }
  const get = (k: string) => vars.find(([n]) => n === k)?.[1];
  assert.ok(get("PATH")!.startsWith(`${shim_dir}:`));
  assert.equal(get(ACCOUNT_ENV), "ghe.example.com/me");
  const real = get("IA_GH_BIN")!;
  assert.ok(!real.startsWith(shim_dir) && real.endsWith("/gh"), real);
  // The token stays with gh-run.
  assert.ok(vars.every(([k, v]) => !TOKEN_VARS.includes(k) && v !== "tok"));
  assert.equal(readFileSync(join(shim_dir, "gh"), "utf8"), "#!/bin/sh\nexec '/opt/it'\\''s/huntaway' gh-run \"$@\"\n");
  assert.equal(statSync(join(shim_dir, "gh")).mode & 0o777, 0o755);
  rmSync(shim_dir, { recursive: true, force: true });
});

function git_in(dir: string, a: string[], env: NodeJS.ProcessEnv = process.env) {
  const r = spawnSync("git", a, { cwd: dir, env, stdio: "ignore" });
  assert.equal(r.status, 0, `git ${a.join(" ")}`);
}

test("pushes_are_checked_at_every_url_git_would_push_to", async () => {
  const dir = testing.temp_dir();
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1" };
  const git = (a: string[]) => git_in(dir, a, env);
  git(["init", "-q"]);
  git(["remote", "add", "origin", "https://github.com/o/r.git"]);
  git(["remote", "add", "two", "git@github.com:o/r.git"]);
  git(["config", "--add", "remote.two.pushurl", "git@github.com:o/r.git"]);
  git(["config", "--add", "remote.two.pushurl", "https://evil.example.com/o/r.git"]);
  git(["remote", "add", "rewritten", "https://ghe.example.com/o/r.git"]);
  git(["config", "url.https://evil.example.com/.pushInsteadOf", "https://ghe.example.com/"]);
  // Logins in a URL, which git would use instead of the account's token.
  git(["remote", "add", "login", "https://other:other-token@github.com/o/r.git"]);
  git(["remote", "add", "user", "https://other@github.com/o/r.git"]);
  git(["remote", "add", "ssh-user", "ssh://git@github.com/o/r.git"]);
  const me = Account.parse("me")!;
  const checked = async (remote: string): Promise<string | null> => {
    const urls = await push_urls(dir, remote);
    if (!urls) return "no remote";
    try {
      me.check_git_urls(urls);
      return null;
    } catch (e: any) {
      return e.message;
    }
  };
  assert.equal(await checked("origin"), null);
  // Every push URL, and as git rewrites it.
  assert.ok((await checked("two"))!.includes("not evil.example.com"));
  assert.ok((await checked("rewritten"))!.includes("not evil.example.com"));
  assert.ok((await checked("login"))!.includes("has a login in it"));
  assert.ok((await checked("user"))!.includes("has a login in it"));
  assert.equal(await checked("ssh-user"), null);
  // A URL isn't a remote's name: git would rewrite it too.
  assert.equal(await checked("https://github.com/o/r.git"), "no remote");
  assert.equal(await checked("--all"), "no remote");
});

test("pushes_send_no_configured_authorization_header", async () => {
  // A server that records the Authorization headers git sends, and asks for a login.
  const seen: string[] = [];
  const server = createTcpServer((conn) => {
    let request = "";
    conn.on("data", (b) => {
      request += b.toString("latin1");
      if (!request.includes("\r\n\r\n")) return;
      seen.push(...request.split("\r\n").filter((l) => l.toLowerCase().startsWith("authorization:")));
      conn.end('HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm="x"\r\nContent-Length: 0\r\nConnection: close\r\n\r\n');
    });
    conn.on("error", () => {});
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  try {
    const dir = testing.temp_dir();
    const url = `http://127.0.0.1:${port}/o/r.git`;
    const other = "Authorization: Basic b3RoZXI6b3RoZXItdG9rZW4="; // other:other-token
    git_in(dir, ["init", "-q"]);
    // Set for every URL, for the server, and for the repository's path.
    for (const key of ["http.extraHeader", `http.http://127.0.0.1:${port}/.extraHeader`, `http.${url}.extraHeader`]) git_in(dir, ["config", key, other]);
    const send = async (resets: string[]) => {
      seen.length = 0;
      await new Promise<void>((resolve) => {
        const child = spawn("git", [...resets, "-c", "credential.helper=", "ls-remote", url], {
          cwd: dir,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "/bin/false" },
          stdio: "ignore",
        });
        const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
        child.on("close", () => {
          clearTimeout(timer);
          resolve();
        });
      });
      return [...seen];
    };
    // The test sees configured headers...
    assert.ok((await send([])).some((h) => h.includes("b3RoZXI6")));
    // ...and git_push's resets leave none.
    const resets = await extra_header_resets(dir);
    const sent = await send(resets);
    assert.ok(sent.every((h) => !h.includes("b3RoZXI6")), `${sent} with ${resets}`);
  } finally {
    server.close();
  }
});

test("fetches_use_only_the_selected_accounts_https_credentials", async () => {
  const dir = testing.temp_dir();
  const gh = join(dir, "gh");
  writeFileSync(gh, "#!/bin/sh\n[ \"$*\" = 'auth token --hostname=ghe.example.com --user=chosen' ] || exit 1\nprintf test-token\n");
  chmodSync(gh, 0o755);
  TEST_GH_PROGRAM.set(gh);
  try {
    const git = (a: string[]) => git_in(dir, a);
    git(["init", "-q"]);
    git(["remote", "add", "origin", "https://alias/o/r.git"]);
    git(["config", "url.https://ghe.example.com/.insteadOf", "https://alias/"]);
    git(["config", "credential.helper", "!f() { echo username=wrong; echo password=wrong; }; f"]);
    git(["config", "http.extraHeader", "Authorization: wrong"]);
    const cmd = { args: [] as string[], env: {} as NodeJS.ProcessEnv };
    await authenticate_fetch(cmd, dir, "origin", "ghe.example.com/chosen");
    assert.ok(cmd.args.includes("http.extraheader="));
    const credentials = await new Promise<string>((resolve, reject) => {
      const child = spawn("git", [...cmd.args, "credential", "fill"], { cwd: dir, env: { ...process.env, ...cmd.env }, stdio: ["pipe", "pipe", "ignore"] });
      let out = "";
      child.stdout!.on("data", (b) => (out += b));
      child.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`git exited with ${code}`))));
      child.stdin!.end("protocol=https\nhost=ghe.example.com\n\n");
    });
    assert.ok(credentials.includes("username=x-access-token\npassword=test-token"), credentials);
    // No account selected leaves git's own authentication alone.
    const none = { args: [] as string[], env: {} as NodeJS.ProcessEnv };
    await authenticate_fetch(none, dir, "origin", null);
    assert.equal(none.args.length, 0);
    // A missing login is an error, never the active account or the configured helper.
    await assert.rejects(authenticate_fetch({ args: [], env: {} }, dir, "origin", "ghe.example.com/missing"));
    // SSH, local remotes and unrelated HTTPS hosts don't need gh at all.
    for (const url of ["git@github-work:o/r.git", "/tmp/local.git", "https://elsewhere.example/o/r.git"]) {
      git(["remote", "set-url", "origin", url]);
      const c = { args: [] as string[], env: {} as NodeJS.ProcessEnv };
      await authenticate_fetch(c, dir, "origin", "ghe.example.com/missing");
      assert.equal(c.args.length, 0);
      assert.equal(Object.keys(c.env).length, 0);
    }
  } finally {
    TEST_GH_PROGRAM.set(null);
  }
});

test("pushes_with_the_accounts_token_over_https", async () => {
  // What credentials git would use: only ours for the account's host, whatever helper the user has (here a global one,
  // as `gh auth setup-git` adds), and theirs elsewhere.
  const home = testing.temp_dir();
  const fill = (host: string, extra: string[]) =>
    new Promise<string>((resolve) => {
      const child = spawn("git", ["-c", "credential.helper=!f() { echo username=theirs; echo password=other; }; f", ...extra, "credential", "fill"], {
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, GIT_CONFIG_NOSYSTEM: "1", IA_GH_GIT_TOKEN: "tok123" },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let out = "";
      child.stdout!.on("data", (b) => (out += b));
      child.on("close", () => resolve(out));
      child.stdin!.end(`protocol=https\nhost=${host}\n\n`);
    });
  const config = Account.parse("octocat")!.git_config();
  const ours = await fill("github.com", config);
  assert.ok(ours.includes("username=x-access-token\n") && ours.includes("password=tok123\n"), ours);
  assert.ok((await fill("gitlab.com", config)).includes("password=other\n"));
});

test("the_hook_turns_away_gh_in_bash", async () => {
  const { runs_program } = await import("../../git/changes.ts");
  const call = (tool: string, command: string) => hook_denial({ tool_name: tool, tool_input: { command } }, runs_program);
  for (const c of [
    "gh pr view 3", "cd /x && gh pr create --fill", "GH_TOKEN=x /usr/bin/gh api user", "echo $(gh pr list)", "timeout 60 gh run watch", "bash -c 'gh pr checks'",
    "env -u; gh api user", "$'g\\x68' api user", "builtin command gh api user", "eval 'gh api user'",
  ]) {
    assert.ok(call("Bash", c)?.includes("mcp__gh__pr_view"), c);
  }
  for (const c of ["git push -u origin x", "grep -r gh src", "echo gh", "ls ~/.config/gh", "cargo test gh_mcp"]) assert.equal(call("Bash", c), null, c);
  assert.equal(call("Read", "gh pr view"), null);
  assert.equal(hook_denial({}, runs_program), null);
});

// HA-86: a merge waiting for approval could go through the gh tool or the API instead.
test("knows_which_calls_merge", () => {
  const gh = (a: string[]) => merges("gh", { args: a });
  assert.ok(merges("pr_merge", { pr: "1" }));
  assert.ok(gh(["pr", "merge", "1", "--squash"]) && gh(["--help", "pr", "merge"]));
  // With flags between the command and its subcommand.
  assert.ok(gh(["pr", "--repo=o/r", "merge", "1", "--merge"]) && gh(["pr", "-R", "o/r", "merge", "1"]));
  assert.ok(gh(["api", "--method", "PUT", "repos/o/r/pulls/1/merge"]));
  assert.ok(gh(["api", "-X", "PUT", "repos/o/r/pulls/1/merge"]));
  assert.ok(gh(["api", "graphql", "-f", "query=mutation { mergePullRequest(input: {}) { clientMutationId } }"]));
  assert.ok(merges("api", { endpoint: "repos/o/r/pulls/1/merge", method: "PUT" }));
  assert.ok(merges("api", { endpoint: "graphql", fields: { query: "mutation { enablePullRequestAutoMerge(input: {}) { clientMutationId } }" } }));
  // A request read from a file could be anything (HA-86 review).
  assert.ok(gh(["api", "graphql", "--method", "POST", "--input", "/x/payload.json"]) && gh(["api", "graphql", "--input=/x/p.json"]));
  assert.ok(gh(["api", "graphql", "-F", "query=@/x/query.graphql"]) && gh(["api", "graphql", "--field=query=@q"]));
  // As could one that mentions merging, so it waits too, even if it only reads.
  assert.ok(merges("api", { endpoint: "repos/o/r/pulls/1/merge" }));
  // Anything else doesn't.
  assert.ok(!gh(["api", "repos/o/r/pulls/1"]) && !gh(["api", "graphql", "-f", "query={ viewer { login } }", "-F", "n=1"]));
  assert.ok(!merges("api", { endpoint: "repos/o/r/issues", fields: { body: "@someone" } }));
  assert.ok(!gh(["pr", "view", "1"]) && !merges("pr_view", { pr: "1" }) && !merges("pr_checks", { pr: "merge" }));
});

// HA-86 review: `pr --repo=o/r merge` got past the check and merged while approval was pending.
test("a_merge_the_board_hasnt_approved_never_runs_gh", async () => {
  const dir = testing.temp_dir();
  const gh = join(dir, "gh"), ran = join(dir, "ran");
  writeFileSync(gh, `#!/bin/sh\necho "$*" >> '${ran}'\n`);
  chmodSync(gh, 0o755);
  TEST_GH_PROGRAM.set(gh);
  const board = createServer((req, res) => {
    if (req.url?.startsWith("/api/internal/merge-gate/")) {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ blocked: "Merging is disabled: not approved" }));
    } else {
      res.statusCode = 404;
      res.end();
    }
  });
  await new Promise<void>((r) => board.listen(0, "127.0.0.1", r));
  TEST_BOARD.set([`http://127.0.0.1:${(board.address() as AddressInfo).port}`, "t", "r"]);
  try {
    const calls: Array<[string, any]> = [
      ["gh", { args: ["pr", "--repo=o/r", "merge", "1", "--merge"] }],
      ["gh", { args: ["pr", "-R", "o/r", "merge", "1"] }],
      ["gh", { args: ["pr", "merge", "1", "--repo", "o/r"] }],
      ["api", { endpoint: "repos/o/r/pulls/1/merge", method: "PUT" }],
      ["gh", { args: ["api", "graphql", "--method", "POST", "--input", "/x/payload.json"] }],
      ["gh", { args: ["api", "graphql", "-F", "query=@/x/query.graphql"] }],
      ["pr_merge", { pr: "https://github.com/o/r/pull/1" }],
    ];
    for (const [tool, a] of calls) {
      const [text, failed] = await run(tool, a);
      assert.ok(failed && text.includes("not approved"), `${tool} ${JSON.stringify(a)}: ${text}`);
    }
    assert.ok(!existsSync(ran), "gh ran");
    // What doesn't merge runs.
    assert.ok(!(await run("gh", { args: ["pr", "view", "1", "--repo", "o/r"] }))[1]);
    assert.ok(existsSync(ran));
  } finally {
    TEST_BOARD.set(null);
    TEST_GH_PROGRAM.set(null);
    board.close();
  }
});

test("reads_pr_urls", () => {
  assert.deepEqual(pr_from_url("https://github.com/o/r/pull/12\n"), ["12", "o/r"]);
  assert.deepEqual(pr_from_url("https://ghe.example.com/o/r/pull/3"), ["3", "ghe.example.com/o/r"]);
  assert.equal(pr_from_url("https://github.com/o/r/issues/3"), null);
  assert.equal(pr_from_url("no pull request"), null);
});

test("clips_long_output", () => {
  assert.equal(clip("short"), "short");
  const long = "é".repeat(MAX_OUTPUT);
  const c = clip(long);
  assert.ok(Buffer.byteLength(c) < Buffer.byteLength(long) && c.includes("bytes cut"));
  assert.ok(!c.includes("\ufffd"));
});

test("runs_gh_and_reports_failures", async () => {
  // An unknown command fails without touching GitHub (if gh is installed at all).
  try {
    const [text, failed] = await run("gh", { args: ["no-such-command"] });
    assert.ok(failed, text);
  } catch {}
  const resp = await handle({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.ok(resp.result.tools.length > 10);
  assert.equal(await handle({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
});
