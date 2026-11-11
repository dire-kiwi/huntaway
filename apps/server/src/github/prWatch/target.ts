import { Result } from "effect"
import type { WaitPr } from "@huntaway/contracts"
import { isGithubCom } from "../../git/worktree/remote.ts"

// A pull request on a GitHub host, as a wait names it or a task's `pr_url` has it (huntaway's mcp/pr_watch.ts
// `Target`): its forms, and the key what an agent has been told of it is kept under.

/** A pull request on a GitHub host. */
export interface Target {
  /** Lowercase; `github.com` for any of its names. */
  readonly host: string
  readonly owner: string
  readonly name: string
  readonly number: number
}

/** `OWNER/REPO`, or `HOST/OWNER/REPO` off github.com. */
export const targetRepo = (t: Target): string => (t.host === "github.com" ? `${t.owner}/${t.name}` : `${t.host}/${t.owner}/${t.name}`)

export const targetUrl = (t: Target): string => `https://${t.host}/${t.owner}/${t.name}/pull/${t.number}`

/** `OWNER/REPO#N` (with the host off github.com). */
export const targetLabel = (t: Target): string => `${targetRepo(t)}#${t.number}`

/** What the agent's been told about it is kept under (`pr_watches.pr`). */
export const targetKey = (t: Target): string => `${t.host}/${t.owner}/${t.name}#${t.number}`.toLowerCase()

/** The pull request a stored wait watches. */
export const targetOf = (w: Pick<WaitPr, "repo" | "number">): Target | null => {
  const parts = w.repo.split("/")
  const [a, b, c] = parts
  if (parts.length === 2 && a !== undefined && b !== undefined) return { host: "github.com", owner: a, name: b, number: w.number }
  if (parts.length === 3 && a !== undefined && b !== undefined && c !== undefined) return { host: a, owner: b, name: c, number: w.number }
  return null
}

/** An owner's or repository's name as GitHub has them. */
const okName = (s: string): boolean => /^[A-Za-z0-9\-_.]+$/.test(s)

/** A whole number written as one (`12`, `+12`, or `7.0`, as agents send numbers sometimes), or null. */
const wholeNumber = (given: string): number | null => {
  let n = given
  const dot = n.indexOf(".")
  if (dot >= 0) {
    const zeros = n.slice(dot + 1)
    if (zeros !== "" && /^0+$/.test(zeros)) n = n.slice(0, dot)
  }
  if (!/^\+?[0-9]+$/.test(n)) return null
  const v = Number(n.replace(/^\+/, ""))
  return Number.isSafeInteger(v) && v > 0 ? v : null
}

const inRepo = (host: string, repo: string, n: number): Target | null => {
  const i = repo.indexOf("/")
  if (i < 0) return null
  const owner = repo.slice(0, i)
  const name = repo.slice(i + 1)
  if (!okName(owner) || !okName(name)) return null
  return { host: host.toLowerCase(), owner, name, number: n }
}

/**
 * The pull request a wait was given: its number (`12`, `#12`), `OWNER/REPO#12` or URL. A number is in `def` (the
 * task's repository: its host and `OWNER/REPO`), and `OWNER/REPO` on its host. Fails with why it isn't one.
 */
export const parseTarget = (given: string, def: readonly [string, string] | null): Result.Result<Target, string> => {
  const g = given.trim()
  const rest = g.startsWith("https://") ? g.slice(8) : g.startsWith("http://") ? g.slice(7) : null
  if (rest !== null) {
    // Its page or one of its tabs (`/files`), with or without an anchor.
    const parts = (rest.split(/[#?]/)[0] ?? "").split("/")
    const [host, owner, name, pull, number] = parts
    if (parts.length >= 5 && pull === "pull" && host !== undefined && owner !== undefined && name !== undefined && number !== undefined) {
      const n = wholeNumber(number)
      if (n !== null) {
        const t = inRepo(isGithubCom(host.toLowerCase()) ? "github.com" : host, `${owner}/${name}`, n)
        return t === null ? Result.fail(`${g} isn't a pull request's URL`) : Result.succeed(t)
      }
    }
    return Result.fail(`${g} isn't a pull request's URL (https://github.com/OWNER/REPO/pull/NUMBER)`)
  }
  const noRepo = "this task's repository has no remote on GitHub to find the pull request in: give its URL (https://github.com/OWNER/REPO/pull/NUMBER)"
  const hash = g.indexOf("#")
  if (hash > 0) {
    const n = wholeNumber(g.slice(hash + 1))
    if (n !== null) {
      const t = inRepo(def === null ? "github.com" : def[0], g.slice(0, hash), n)
      return t === null ? Result.fail(`${g} isn't a pull request (OWNER/REPO#NUMBER)`) : Result.succeed(t)
    }
  }
  const n = wholeNumber(g.replace(/^#+/, ""))
  if (n === null) return Result.fail(`${g} isn't a pull request: give its number, OWNER/REPO#NUMBER or its URL`)
  if (def === null) return Result.fail(noRepo)
  const t = inRepo(def[0], def[1], n)
  return t === null ? Result.fail(noRepo) : Result.succeed(t)
}

/** The pull request at `url` (a task's `pr_url`), or null when it isn't one's URL. */
export const targetOfUrl = (url: string | null): Target | null => {
  if (url === null) return null
  const t = parseTarget(url, null)
  return Result.isSuccess(t) ? t.success : null
}

/** Where pull request `prUrl` is previewed by the project's template (`{pr}` → its number): null without either. */
export const previewFor = (template: string | null, prUrl: string | null): string | null => {
  const t = targetOfUrl(prUrl)
  return template === null || t === null ? null : template.replaceAll("{pr}", String(t.number))
}
