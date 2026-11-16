import { Option, Schema } from "effect"
import type { TeleportSite } from "@huntaway/contracts"
import { isKnownSuffix, normalizeHost, registrableDomain } from "./sites.ts"

// What `space_request_sign_ins` asks the user (HE-49), plainly: the sites an agent names are checked (each must be a
// registrable domain the chosen browser profile holds), the profile holding most of them is picked, and the card's input
// lists them, identity providers unticked. What comes back is what the user left ticked, and only sites that were on the
// card: the user can trim the list, or tick an identity provider back, but nothing can be added. No I/O here.

/** The tool's name as its prompt is raised (`McpHooks.askRule`). */
export const REQUEST_TOOL = "mcp__spaces__space_request_sign_ins"

/** A site name an agent gave, checked: a registrable domain (`github.com`), not a suffix (`com`) or a subdomain. */
export const checkSites = (sites: ReadonlyArray<string>): { readonly valid: ReadonlyArray<string>; readonly invalid: ReadonlyArray<string> } => {
  const valid: Array<string> = []
  const invalid: Array<string> = []
  for (const raw of sites) {
    const s = normalizeHost(raw)
    if (s === "") continue
    const ok = /^[a-z0-9-]+(\.[a-z0-9-]+)+$/u.test(s) && registrableDomain(s) === s && !isKnownSuffix(s)
    if (!ok) invalid.push(raw.trim())
    else if (!valid.includes(s)) valid.push(s)
  }
  return { valid, invalid }
}

/** A browser profile on the host, with its sites. */
export interface Candidate {
  readonly browser: string
  readonly browserLabel: string
  readonly profile: string
  readonly profileLabel: string
  readonly sites: ReadonlyArray<TeleportSite>
}

/** The profile holding most of `wanted` (then most of their cookies); null when none holds any. */
export const pickProfile = (candidates: ReadonlyArray<Candidate>, wanted: ReadonlyArray<string>): Candidate | null => {
  let best: { readonly c: Candidate; readonly n: number; readonly cookies: number } | null = null
  for (const c of candidates) {
    const held = c.sites.filter((s) => wanted.includes(s.site))
    const n = held.length
    const cookies = held.reduce((a, s) => a + s.cookie_count, 0)
    if (n > 0 && (best === null || n > best.n || (n === best.n && cookies > best.cookies))) best = { c, n, cookies }
  }
  return best?.c ?? null
}

/** The card's input: the Space, the profile, the sites offered (those the profile holds) and the ones ticked (no identity provider). */
export const askInput = (space: { readonly id: string; readonly name: string }, c: Candidate, wanted: ReadonlyArray<string>) => {
  const offered = c.sites.filter((s) => wanted.includes(s.site))
  return {
    space: space.id,
    space_name: space.name,
    browser: c.browser,
    browser_label: c.browserLabel,
    profile: c.profile,
    profile_label: c.profileLabel,
    sites: offered.filter((s) => !s.identity_provider).map((s) => s.site),
    offered: offered.map((s) => ({ site: s.site, cookie_count: s.cookie_count, storage_count: s.storage_count, identity_provider: s.identity_provider })),
    not_found: wanted.filter((w) => !offered.some((s) => s.site === w)),
  }
}

const Approved = Schema.Struct({ sites: Schema.Array(Schema.String) })
const decodeApproved = Schema.decodeUnknownOption(Approved)

/** The sites the user left ticked on the card, kept to those it offered. */
export const approvedSites = (input: unknown, offered: ReadonlyArray<string>): ReadonlyArray<string> =>
  Option.match(decodeApproved(input), {
    onNone: () => [],
    onSome: (a) => [...new Set(a.sites.map(normalizeHost))].filter((s) => offered.includes(s)),
  })
