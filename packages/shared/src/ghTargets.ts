import { asciiLower } from "./keys.ts"

// Where a gh command goes: the hosts and repositories its arguments name, read with the help of gh's own help
// (docs/plan/inventory/03-mcp.md 2.10, "Targets on other hosts are refused"). From huntaway's mcp/gh_mcp/targets.ts
// and `url_host` of mcp/gh_mcp/env.ts. Plain TypeScript with no I/O: the board and `gh-run` read gh's help themselves
// (`helpCommand` says which) and keep it.

/** The host of a URL (`https://`, `ssh://`, …), lowercase; null for anything else. */
export const urlHost = (given: string): string | null => {
  const s = asciiLower(given.trim())
  const i = s.indexOf("://")
  if (i < 0) return null
  const scheme = s.slice(0, i)
  const rest = s.slice(i + 3)
  if (scheme === "" || !/^[a-z0-9+.-]+$/i.test(scheme)) return null
  const authority = rest.split(/[/?#]/)[0] ?? ""
  const at = authority.split("@")
  return (at[at.length - 1] ?? "").split(":")[0] ?? ""
}

/** A repository's host, given as `HOST/OWNER/REPO` or a URL (`OWNER/REPO` has none). */
export const repoHost = (r: string): string | null => {
  const parts = r.trim().split("/")
  if (parts.length === 3) return parts[0] ?? null
  return urlHost(r)
}

/** gh options whose value is where a command goes: a host, or a repository (see `repoHost`). */
const TARGET_OPTIONS = new Set(["--hostname", "--repo", "--source", "--branch-repo"])

const startsWithAny = (s: string, cs: string) => s.length > 0 && cs.includes(s[0] ?? "")
const wordsOf = (s: string) => s.split(/\s+/).filter((w) => w.length > 0)

/** An option in gh's help: its short name, its long name, and whether it takes a value. */
export interface HelpOption {
  readonly short: string | null
  readonly long: string
  readonly takesValue: boolean
}

/** What gh's help says about one of its commands. */
export interface CommandHelp {
  /** How many words name it (`pr view` is two). */
  readonly path: number
  readonly options: ReadonlyArray<HelpOption>
  /** Its arguments as its usage has them (`[<number> | <url> | <branch>]`, `<files>...`). */
  readonly arguments: ReadonlyArray<string>
}

/** `gh <command> --help`, read; null when it has no usage. */
export const parseHelp = (help: string): CommandHelp | null => {
  const lines = help.split("\n")
  const at = lines.findIndex((l) => l.trim() === "USAGE")
  if (at < 0 || at + 1 >= lines.length) return null
  const line = (lines[at + 1] ?? "").trim()
  if (!line.startsWith("gh ")) return null
  const words = wordsOf(line.slice(3))
  let path = 0
  while (path < words.length && !startsWithAny(words[path] ?? "", "<[{")) path++
  const rest = words.slice(path).join(" ")
  // Its groups at the top level, `[<number> | <url>]`, `<files>...`, up to `[flags]` and `--`.
  const args: Array<string> = []
  let group = ""
  let depth = 0
  for (const c of `${rest} `) {
    if ("[{<".includes(c)) depth++
    else if ("]}>".includes(c)) depth--
    if (c === " " && depth === 0) {
      const g = group
      group = ""
      if (g === "[flags]" || g.startsWith("[--") || g === "--") break
      if (g !== "") args.push(g)
    } else {
      group += c
    }
  }
  const options: Array<HelpOption> = []
  for (const raw of lines) {
    const l = raw.trimStart()
    if (!l.startsWith("-")) continue
    // `-q, --jq expression   Filter …`: its names, then its value's, before the description.
    const ws = wordsOf(l.split("  ")[0] ?? "")
    const names: Array<string> = []
    for (const w of ws) {
      const n = w.replace(/,+$/, "")
      if (!n.startsWith("-")) break
      names.push(n)
    }
    const long = names.find((n) => n.startsWith("--"))
    if (long === undefined) continue
    const s = names.find((n) => !n.startsWith("--"))
    const short = s === undefined || s.length < 2 ? null : s.charAt(1)
    options.push({ short, long, takesValue: ws.length > names.length })
  }
  return { path, options, arguments: args }
}

/** The hosts `args` (gh's arguments, the command first) name where the command goes, by its help. */
export const helpTargets = (help: CommandHelp, args: ReadonlyArray<string>): Array<string> => {
  const hosts: Array<string> = []
  const targetOption = (long: string, value: string) => {
    if (long === "--hostname") hosts.push(asciiLower(value.trim()))
    else if (TARGET_OPTIONS.has(long)) {
      const h = repoHost(value)
      if (h !== null) hosts.push(h)
    }
  }
  let i = 0
  let words = 0
  let dashes = false
  const positional: Array<string> = []
  while (i < args.length) {
    const a = args[i] ?? ""
    i++
    if (dashes || !a.startsWith("-") || a === "-") {
      positional.push(a)
      continue
    }
    if (a === "--") {
      dashes = true
    } else if (a.startsWith("--")) {
      const long = a.slice(2)
      const eq = long.indexOf("=")
      const [name, attached] = eq >= 0 ? [`--${long.slice(0, eq)}`, long.slice(eq + 1)] : [a, null]
      const takes = help.options.some((o) => o.long === name && o.takesValue)
      const value = attached ?? (takes ? (args[i] ?? null) : null)
      if (takes && attached === null) i++
      if (value !== null) targetOption(name, value)
    } else {
      // A cluster of short options: the first taking a value takes the rest, or the next word.
      let at = 0
      let first = true
      for (const c of a) {
        const here = at
        at += c.length
        if (first) {
          first = false
          continue
        }
        const opt = help.options.find((o) => o.short === c)
        if (opt === undefined || !opt.takesValue) continue
        const rest = a.slice(here + c.length)
        let value: string | null
        if (rest === "") {
          i++
          value = args[i - 1] ?? null
        } else value = rest.startsWith("=") ? rest.slice(1) : rest
        if (value !== null) targetOption(opt.long, value)
        break
      }
    }
  }
  for (const a of positional.slice(help.path)) {
    const last = help.arguments[help.arguments.length - 1]
    const g = help.arguments[words] ?? (last !== undefined && last.endsWith("...") ? last : undefined)
    words++
    if (g === undefined) continue
    const argument = asciiLower(g)
    const repository = argument.includes("repo")
    if (repository || argument.includes("url") || argument.includes("endpoint")) {
      const h = urlHost(a) ?? (repository ? positionalHost(a) : null)
      if (h !== null) hosts.push(h)
    }
  }
  return hosts
}

/**
 * The top-level commands of gh whose help is read (not aliases or extensions, whose `--help` may run something).
 */
const GH_COMMANDS = new Set([
  "agent-task",
  "api",
  "attestation",
  "auth",
  "browse",
  "cache",
  "codespace",
  "cs",
  "discussion",
  "extension",
  "ext",
  "gist",
  "gpg-key",
  "issue",
  "label",
  "org",
  "pr",
  "project",
  "release",
  "repo",
  "ruleset",
  "run",
  "search",
  "secret",
  "ssh-key",
  "status",
  "variable",
  "workflow",
])

/** The gh command whose help `args` needs (`gh pr view --help`): its key for a cache, and gh's arguments for it. */
export const helpCommand = (args: ReadonlyArray<string>): { readonly key: string; readonly argv: ReadonlyArray<string> } | null => {
  const command = args[0]
  if (command === undefined || !GH_COMMANDS.has(command)) return null
  const second = args[1]
  const sub = second !== undefined && /^[a-z-]+$/.test(second) ? second : null
  return { key: `${command} ${sub ?? ""}`, argv: [command, ...(sub === null ? [] : [sub]), "--help"] }
}

/** The variables gh's help is read with. */
export const HELP_ENV: Readonly<Record<string, string>> = { GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }

/**
 * gh's options whose values are content (texts, fields, headers, output formats), not where the command goes: long
 * ones, short ones in any command, and short ones in `gh api`'s (where `-f` is `--raw-field`; elsewhere it may be a
 * flag without a value, such as `--force`).
 */
const CONTENT_OPTIONS = new Set([
  "--body",
  "--body-file",
  "--title",
  "--field",
  "--raw-field",
  "--header",
  "--jq",
  "--template",
  "--input",
  "--notes",
  "--notes-file",
  "--subject",
  "--search",
  "--label",
  "--add-label",
  "--remove-label",
])
const CONTENT_SHORT = "btqF"
const API_CONTENT_SHORT = "fH"

/** How many code points `s` has. */
const codePoints = (s: string): number => {
  let n = 0
  for (const _ of s) n++
  return n
}

/** How many arguments a content option at `arg` takes up (two when its value is the next one), if it is one. */
const contentOption = (arg: string, api: boolean): number | null => {
  if (arg.startsWith("--")) {
    const long = arg.slice(2)
    const eq = long.indexOf("=")
    const name = eq >= 0 ? long.slice(0, eq) : long
    return CONTENT_OPTIONS.has(`--${name}`) ? (eq >= 0 ? 1 : 2) : null
  }
  if (!arg.startsWith("-")) return null
  const letter = arg.slice(1)[0]
  if (letter === undefined) return null
  const short = CONTENT_SHORT.includes(letter) || (api && API_CONTENT_SHORT.includes(letter))
  return short ? (codePoints(arg) === 2 ? 2 : 1) : null
}

/**
 * The hosts a gh command's arguments name, read without its help: `--hostname`, `--repo`'s host, and every other
 * argument's that's a URL or a repository on a host of its own, but the values of content options.
 */
export const fallbackTargets = (args: ReadonlyArray<string>): Array<string> => {
  const hosts: Array<string> = []
  const api = args[0] === "api"
  let i = 0
  while (i < args.length) {
    const a = args[i] ?? ""
    // Texts, fields and the like aren't where the command goes, whatever is in them.
    const taken = contentOption(a, api)
    if (taken !== null) {
      i += taken
      continue
    }
    const value = (flag: string): string | null => {
      if (!a.startsWith(flag)) return null
      const v = a.slice(flag.length)
      if (v === "") return args[i + 1] ?? null
      if (v.startsWith("=")) return v.slice(1)
      return flag.startsWith("--") ? null : v
    }
    const h = value("--hostname")
    if (h !== null) hosts.push(h)
    else {
      const r = value("--repo") ?? value("-R")
      if (r !== null) {
        const rh = repoHost(r)
        if (rh !== null) hosts.push(rh)
      } else {
        const x = urlHost(a) ?? positionalHost(a)
        if (x !== null) hosts.push(x)
      }
    }
    i++
  }
  return hosts
}

/**
 * The host an argument of a gh command (or a push URL) names when it's a repository on a host of its own:
 * `HOST/OWNER/REPO[/…]` (a host has a `.` or a port in it, so `OWNER/REPO` and API paths don't count), or
 * `[USER@]HOST:PATH` as git has it. Without a user, the host needs a `.`, so search qualifiers (`repo:o/r`, `is:open`)
 * and SSH aliases (`github-work:o/r`, the host's own way to pick an SSH identity) don't count.
 */
export const positionalHost = (arg: string): string | null => {
  if (startsWithAny(arg, "-./~") || /\s/.test(arg)) return null
  const colon = arg.indexOf(":")
  if (colon >= 0 && !arg.slice(0, colon).includes("/")) {
    const userHost = arg.slice(0, colon)
    const at = userHost.lastIndexOf("@")
    const [user, host] = at >= 0 ? [userHost.slice(0, at), userHost.slice(at + 1)] : [null, userHost]
    const hostname = host.length > 0 && /^[A-Za-z0-9.-]+$/.test(host)
    return hostname && (user !== null || host.includes(".")) ? asciiLower(host) : null
  }
  const parts = arg.split("/")
  const host = parts[0] ?? ""
  const hostname = /^[A-Za-z0-9.\-:]*$/.test(host)
  return hostname && parts.length >= 3 && parts[1] !== "" && parts[2] !== "" && (host.includes(".") || host.includes(":"))
    ? asciiLower(host.split(":")[0] ?? "")
    : null
}
