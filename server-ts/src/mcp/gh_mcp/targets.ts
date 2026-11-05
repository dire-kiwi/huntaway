// Port of server/src/mcp/gh_mcp/targets.rs: where a gh command goes, the hosts and repositories its arguments name,
// read with the help of gh's own help.
import { execFile, spawnSync } from "node:child_process";
import { ascii_lower, gh_program, url_host } from "./env.ts";

/** A repository's host, given as `HOST/OWNER/REPO` or a URL (`OWNER/REPO` has none). */
export function repo_host(r: string): string | null {
  const parts = r.trim().split("/");
  if (parts.length === 3) return parts[0];
  return url_host(r);
}

/** gh options whose value is where a command goes: a host, or a repository (see `repo_host`). */
const TARGET_OPTIONS = ["--hostname", "--repo", "--source", "--branch-repo"];

const starts_with_any = (s: string, cs: string) => s.length > 0 && cs.includes(s[0]);
const words_of = (s: string) => s.split(/\s+/).filter((w) => w);

/** An option in gh's help: short name, long name, and whether it takes a value. */
export type HelpOption = [string | null, string, boolean];

/** What gh's help says about one of its commands. */
export class CommandHelp {
  /** How many words name it (`pr view` is two). */
  path: number;
  /** Its options: short name, long name, and whether it takes a value. */
  options: HelpOption[];
  /** Its arguments as its usage has them (`[<number> | <url> | <branch>]`, `<files>...`). */
  arguments: string[];
  constructor(path: number, options: HelpOption[], args: string[]) {
    this.path = path;
    this.options = options;
    this.arguments = args;
  }

  /** Parse `gh <command> --help`. */
  static parse(help: string): CommandHelp | null {
    const lines = help.split("\n");
    const at = lines.findIndex((l) => l.trim() === "USAGE");
    if (at < 0 || at + 1 >= lines.length) return null;
    const line = lines[at + 1].trim();
    if (!line.startsWith("gh ")) return null;
    const usage = line.slice(3);
    const words = words_of(usage);
    let path = 0;
    while (path < words.length && !starts_with_any(words[path], "<[{")) path++;
    const rest = words.slice(path).join(" ");
    // Its groups at the top level, `[<number> | <url>]`, `<files>...`, up to `[flags]` and `--`.
    const args: string[] = [];
    let group = "", depth = 0;
    for (const c of [...rest, " "]) {
      if ("[{<".includes(c)) depth++;
      else if ("]}>".includes(c)) depth--;
      if (c === " " && depth === 0) {
        const g = group;
        group = "";
        if (g === "[flags]" || g.startsWith("[--") || g === "--") break;
        if (g) args.push(g);
      } else {
        group += c;
      }
    }
    const options: HelpOption[] = [];
    for (let l of lines) {
      l = l.trimStart();
      if (!l.startsWith("-")) continue;
      // `-q, --jq expression   Filter …`: its names, then its value's, before the description.
      const ws = words_of(l.split("  ")[0]);
      const names: string[] = [];
      for (const w of ws) {
        const n = w.replace(/,+$/, "");
        if (!n.startsWith("-")) break;
        names.push(n);
      }
      const long = names.find((n) => n.startsWith("--"));
      if (long === undefined) continue;
      const s = names.find((n) => !n.startsWith("--"));
      const short = s !== undefined ? ([...s][1] ?? null) : null;
      options.push([short, long, ws.length > names.length]);
    }
    return new CommandHelp(path, options, args);
  }

  /** The hosts `args` (gh's arguments, the command first) name where the command goes (see `Account.check_targets`). */
  targets(args: string[]): string[] {
    const hosts: string[] = [];
    const target_option = (long: string, value: string) => {
      if (long === "--hostname") hosts.push(ascii_lower(value.trim()));
      else if (TARGET_OPTIONS.includes(long)) {
        const h = repo_host(value);
        if (h !== null) hosts.push(h);
      }
    };
    let i = 0, words = 0, dashes = false;
    const positional: string[] = [];
    while (i < args.length) {
      const a = args[i];
      i++;
      if (dashes || !a.startsWith("-") || a === "-") {
        positional.push(a);
        continue;
      }
      if (a === "--") {
        dashes = true;
      } else if (a.startsWith("--")) {
        const long = a.slice(2);
        const eq = long.indexOf("=");
        const [name, attached] = eq >= 0 ? [`--${long.slice(0, eq)}`, long.slice(eq + 1)] : [a, null];
        const takes = this.options.some(([, l, v]) => l === name && v);
        const value = attached ?? (takes ? (args[i] ?? null) : null);
        if (takes && attached === null) i++;
        if (value !== null) target_option(name, value);
      } else {
        // A cluster of short options: the first taking a value takes the rest, or the next word.
        let at = 0;
        let first = true;
        for (const c of a) {
          const here = at;
          at += c.length;
          if (first) {
            first = false;
            continue;
          }
          const opt = this.options.find(([s]) => s === c);
          if (!opt || !opt[2]) continue;
          const rest = a.slice(here + c.length);
          let value: string | null;
          if (!rest) {
            i++;
            value = args[i - 1] ?? null;
          } else value = rest.startsWith("=") ? rest.slice(1) : rest;
          if (value !== null) target_option(opt[1], value);
          break;
        }
      }
    }
    for (const a of positional.slice(this.path)) {
      const last = this.arguments[this.arguments.length - 1];
      const g = this.arguments[words] ?? (last !== undefined && last.endsWith("...") ? last : undefined);
      words++;
      if (g === undefined) continue;
      const argument = ascii_lower(g);
      const repository = argument.includes("repo");
      if (repository || argument.includes("url") || argument.includes("endpoint")) {
        const h = url_host(a) ?? (repository ? positional_host(a) : null);
        if (h !== null) hosts.push(h);
      }
    }
    return hosts;
  }
}

/** `CommandHelp::parse`. */
export function CommandHelp_parse(help: string): CommandHelp | null {
  return CommandHelp.parse(help);
}

/**
 * The top-level commands of gh whose help `command_help` reads (not aliases or extensions, whose `--help` may run
 * something).
 */
const GH_COMMANDS = [
  "agent-task", "api", "attestation", "auth", "browse", "cache", "codespace", "cs", "discussion", "extension", "ext", "gist", "gpg-key",
  "issue", "label", "org", "pr", "project", "release", "repo", "ruleset", "run", "search", "secret", "ssh-key", "status", "variable",
  "workflow",
];

const HELP_CACHE = new Map<string, CommandHelp | null>();

/** The gh command whose help `args` needs (`gh pr view --help`), and its key in `HELP_CACHE`. */
function help_command(args: string[]): { key: string; argv: string[] } | null {
  const command = args[0];
  if (command === undefined || !GH_COMMANDS.includes(command)) return null;
  const sub = args[1] !== undefined && /^[a-z-]+$/.test(args[1]) ? args[1] : null;
  return { key: `${command} ${sub ?? ""}`, argv: [command, ...(sub !== null ? [sub] : []), "--help"] };
}

const HELP_ENV = () => ({ ...process.env, GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" });

/** The help of the gh command `args` run (`gh pr view --help`), kept for the next time. */
export function command_help(args: string[]): CommandHelp | null {
  const c = help_command(args);
  if (c === null) return null;
  if (HELP_CACHE.has(c.key)) return HELP_CACHE.get(c.key)!;
  const out = spawnSync(gh_program(), c.argv, { env: HELP_ENV(), stdio: ["ignore", "pipe", "ignore"], maxBuffer: 16 << 20 });
  const help = !out.error && out.status === 0 ? CommandHelp.parse(out.stdout.toString()) : null;
  HELP_CACHE.set(c.key, help);
  return help;
}

/**
 * Read the help `command_help(args)` needs into its cache without blocking: the board serves the gh tools in its own
 * process (see mcp/http.ts), where a synchronous gh would hold up everything else.
 */
export async function load_command_help(args: string[]): Promise<void> {
  const c = help_command(args);
  if (c === null || HELP_CACHE.has(c.key)) return;
  const help = await new Promise<CommandHelp | null>((resolve) => {
    execFile(gh_program(), c.argv, { env: HELP_ENV(), maxBuffer: 16 << 20 }, (e, stdout) => resolve(e ? null : CommandHelp.parse(String(stdout))));
  });
  HELP_CACHE.set(c.key, help);
}

/**
 * The hosts a gh command's arguments name, read without its help: `--hostname`, `--repo`'s host, and every other
 * argument's that's a URL or a repository on a host of its own, but the values of `CONTENT_OPTIONS`.
 */
export function fallback_targets(args: string[]): string[] {
  const hosts: string[] = [];
  const api = args[0] === "api";
  let i = 0;
  while (i < args.length) {
    const a = args[i];
    // Texts, fields and the like aren't where the command goes, whatever is in them.
    const taken = content_option(a, api);
    if (taken !== null) {
      i += taken;
      continue;
    }
    const value = (flag: string): string | null => {
      if (!a.startsWith(flag)) return null;
      const v = a.slice(flag.length);
      if (v === "") return args[i + 1] ?? null;
      if (v.startsWith("=")) return v.slice(1);
      return flag.startsWith("--") ? null : v;
    };
    const h = value("--hostname");
    if (h !== null) hosts.push(h);
    else {
      const r = value("--repo") ?? value("-R");
      if (r !== null) {
        const rh = repo_host(r);
        if (rh !== null) hosts.push(rh);
      } else {
        const x = url_host(a) ?? positional_host(a);
        if (x !== null) hosts.push(x);
      }
    }
    i++;
  }
  return hosts;
}

/**
 * gh's options whose values are content (texts, fields, headers, output formats), not where the command goes: long
 * ones, short ones in any command, and short ones in `gh api`'s (where `-f` is `--raw-field`; elsewhere it may be a
 * flag without a value, such as `--force`).
 */
const CONTENT_OPTIONS = [
  "--body", "--body-file", "--title", "--field", "--raw-field", "--header", "--jq", "--template", "--input", "--notes", "--notes-file",
  "--subject", "--search", "--label", "--add-label", "--remove-label",
];
const CONTENT_SHORT = "btqF";
const API_CONTENT_SHORT = "fH";

/** How many arguments a content option at `arg` takes up (two when its value is the next one), if it is one. */
function content_option(arg: string, api: boolean): number | null {
  if (arg.startsWith("--")) {
    const long = arg.slice(2);
    const eq = long.indexOf("=");
    const name = eq >= 0 ? long.slice(0, eq) : long;
    return CONTENT_OPTIONS.includes(`--${name}`) ? (eq >= 0 ? 1 : 2) : null;
  }
  if (!arg.startsWith("-")) return null;
  const letter = [...arg.slice(1)][0];
  if (letter === undefined) return null;
  const short = CONTENT_SHORT.includes(letter) || (api && API_CONTENT_SHORT.includes(letter));
  return short ? ([...arg].length === 2 ? 2 : 1) : null;
}

/**
 * The host an argument of a gh command (or a push URL) names when it's a repository on a host of its own:
 * `HOST/OWNER/REPO[/…]` (a host has a `.` or a port in it, so `OWNER/REPO` and API paths don't count), or
 * `[USER@]HOST:PATH` as git has it. Without a user, the host needs a `.`, so search qualifiers (`repo:o/r`, `is:open`)
 * and SSH aliases (`github-work:o/r`, the host's own way to pick an SSH identity) don't count.
 */
export function positional_host(arg: string): string | null {
  if (starts_with_any(arg, "-./~") || /\s/.test(arg)) return null;
  const colon = arg.indexOf(":");
  if (colon >= 0 && !arg.slice(0, colon).includes("/")) {
    const user_host = arg.slice(0, colon);
    const at = user_host.lastIndexOf("@");
    const [user, host] = at >= 0 ? [user_host.slice(0, at), user_host.slice(at + 1)] : [null, user_host];
    const hostname = host.length > 0 && /^[A-Za-z0-9.\-]+$/.test(host);
    return hostname && (user !== null || host.includes(".")) ? ascii_lower(host) : null;
  }
  const parts = arg.split("/");
  const host = parts[0];
  const hostname = /^[A-Za-z0-9.\-:]*$/.test(host);
  return hostname && parts.length >= 3 && parts[1] !== "" && parts[2] !== "" && (host.includes(".") || host.includes(":"))
    ? ascii_lower(host.split(":")[0])
    : null;
}
