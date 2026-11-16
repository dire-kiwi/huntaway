import { parse } from "tldts"

// Grouping a browser profile's cookies and localStorage into "sites" the Bring-sign-ins dialog lists (HE-49), and the
// rules for what it pre-ticks. A site is a registrable domain by the public suffix list (`tldts`, its private section
// too, as browsers use it: `github.com`, `bbc.co.uk`, `amazon.com.mx`, `someone.github.io`). A cookie or a localStorage
// origin belongs to the site `siteOf` names for its host, and to no other: listing, counting and sending all go by that
// one rule, so a site nested under another by the list's private section (`mybucket.s3.amazonaws.com` under
// `amazonaws.com`) is listed, counted and sent on its own. A host with no registrable domain (an IP address,
// `localhost`, a bare suffix) is a site of its own. No I/O here.

/** The public suffix list as browsers read it: its ICANN and private sections. */
const PSL = { allowPrivateDomains: true }

/** A host as a bare, lower-case name: trimmed, its leading cookie dot gone. */
export const normalizeHost = (host: string): string => {
  const t = host.trim()
  return (t.startsWith(".") ? t.slice(1) : t).toLowerCase()
}

/**
 * A host's registrable domain, when it has one under a suffix the list knows (ICANN's or the private section's); null
 * for an IP address, a single label, a bare suffix, or a name under an unknown last label (`0.1`, `foo.local`), which the
 * list's default rule would otherwise treat as a suffix of its own.
 */
const registrable = (host: string): string | null => {
  const p = parse(host, PSL)
  return p.isIp !== true && (p.isIcann === true || p.isPrivate === true) ? p.domain : null
}

/** The site of `host`: its registrable domain (`api.github.com` → `github.com`), or the host itself when it has none. */
export const siteOf = (host: string): string => {
  const h = normalizeHost(host)
  return h === "" ? "" : (registrable(h) ?? h)
}

/** Whether `s` is a public suffix (`com`, `co.kr`, `github.io`): never a site to send, it would hold everyone's cookies. */
export const isPublicSuffix = (s: string): boolean => {
  const p = parse(normalizeHost(s), PSL)
  return p.isIp !== true && p.domain === null && p.publicSuffix === normalizeHost(s) && (p.isIcann === true || p.isPrivate === true)
}

/** The host of an origin (`https://github.com:443` → `github.com`), or "" when it doesn't parse. */
export const originHost = (origin: string): string => {
  try {
    return new URL(origin).hostname.toLowerCase()
  } catch {
    return ""
  }
}

/**
 * Identity providers: a teleport of them hands over the account itself (Google's session cookies are on every
 * `google.<country>` the user visited, not only google.com). Never pre-ticked (the design); the user may still tick
 * one. By the name before the public suffix, for the providers that have country domains (`google.co.nz`, `apple.de`,
 * `microsoft.com.au`), and by whole domain for the rest.
 */
const PROVIDER_NAMES: ReadonlySet<string> = new Set(["google", "gstatic", "microsoft", "microsoftonline", "apple", "okta", "oktapreview", "okta-emea", "auth0"])
const PROVIDER_DOMAINS: ReadonlySet<string> = new Set(["live.com", "office.com", "icloud.com", "oktacdn.com"])

/** Whether `site` is an identity provider's (any of its subdomains or country domains). */
export const isIdentityProvider = (site: string): boolean => {
  const s = siteOf(site)
  const name = parse(s, PSL).domainWithoutSuffix
  return PROVIDER_DOMAINS.has(s) || (name !== null && PROVIDER_NAMES.has(name))
}

const SIGNED_IN_HINTS = ["session", "sess", "sid", "auth", "token", "login", "logged_in", "secure_", "remember", "oauth", "jwt", "account"]

/**
 * Whether a site's cookies look like a sign-in, so the dialog pre-ticks it: a `__Host-`/`__Secure-` prefixed cookie, or
 * a name that reads as a session or auth cookie. A rough guess the user can override; nothing is decrypted to make it.
 */
export const looksSignedIn = (cookieNames: ReadonlyArray<string>): boolean =>
  cookieNames.some((raw) => {
    const name = raw.toLowerCase()
    if (name.startsWith("__host-") || name.startsWith("__secure-")) return true
    return SIGNED_IN_HINTS.some((h) => name.includes(h))
  })
