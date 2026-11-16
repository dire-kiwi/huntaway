import { parse } from "tldts"

// Grouping a browser profile's cookies and localStorage into "sites" the Bring-sign-ins dialog lists (HE-49), and the
// rules for what it pre-ticks. A site is a registrable domain by the public suffix list (`tldts`, its private section
// too, as browsers use it: `github.com`, `bbc.co.uk`, `amazon.com.mx`, `someone.github.io`): its cookies are every row
// whose host_key is the domain or a subdomain of it, its localStorage every origin under it. A host with no registrable
// domain (an IP address, `localhost`, a bare suffix) is a site of its own that matches only itself, so no site ever
// takes in its siblings. No I/O here.

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

/** Whether `site` is a host of its own (an IP address, `localhost`, `foo.local`, a bare suffix): it matches only itself. */
const exact = (site: string): boolean => registrable(site) !== site

/** Whether `s` is a public suffix (`com`, `co.kr`, `github.io`): never a site to send, it would hold everyone's cookies. */
export const isPublicSuffix = (s: string): boolean => {
  const p = parse(normalizeHost(s), PSL)
  return p.isIp !== true && p.domain === null && p.publicSuffix === normalizeHost(s) && (p.isIcann === true || p.isPrivate === true)
}

/** Whether a cookie's host_key belongs to `site`: the site itself or, for a registrable domain, a subdomain of it. */
export const hostKeyInSite = (hostKey: string, site: string): boolean => {
  const h = normalizeHost(hostKey)
  const a = normalizeHost(site)
  if (a === "" || h === "") return false
  return h === a || (!exact(a) && h.endsWith(`.${a}`))
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
 * Identity providers, by registrable domain: a teleport of these alone signs the Space into nothing of the user's, and
 * a teleport of them with a site they sign in to would hand over the account itself. Never pre-ticked (the design);
 * the user may still tick one.
 */
export const IDENTITY_PROVIDERS = new Set([
  "google.com",
  "accounts.google.com",
  "gstatic.com",
  "microsoft.com",
  "microsoftonline.com",
  "live.com",
  "office.com",
  "apple.com",
  "icloud.com",
  "okta.com",
  "oktacdn.com",
  "auth0.com",
])

/** Whether `site` is an identity provider (its registrable domain is one, or it is an Okta/Auth0 tenant). */
export const isIdentityProvider = (site: string): boolean => {
  const s = normalizeHost(site)
  return IDENTITY_PROVIDERS.has(s) || s.endsWith(".okta.com") || s.endsWith(".okta-emea.com") || s.endsWith(".auth0.com")
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
