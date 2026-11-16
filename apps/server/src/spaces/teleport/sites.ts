// Grouping a browser profile's cookies and localStorage into "sites" the Bring-sign-ins dialog lists (HE-49), and the
// rules for what it pre-ticks. A site is a registrable domain (`github.com`): its cookies are every row whose host_key
// is the domain or a subdomain of it, its localStorage every origin under it. Conservative, after Cua's `cua-teleport`
// (`registrable_domain`, `host_key_in_site`): an unknown suffix stays its own site rather than swallowing siblings. No
// I/O here.

const MULTI_LABEL_SUFFIXES = new Set(["co.uk", "org.uk", "gov.uk", "ac.uk", "co.jp", "com.au", "com.br", "co.nz", "co.in", "com.cn"])

/** A host as a bare, lower-case name: trimmed, its leading cookie dot gone. */
export const normalizeHost = (host: string): string => {
  const t = host.trim()
  return (t.startsWith(".") ? t.slice(1) : t).toLowerCase()
}

/** Whether `host` is one of the two-label public suffixes known here (`co.uk`): a site of its own would hold a country's cookies. */
export const isKnownSuffix = (host: string): boolean => MULTI_LABEL_SUFFIXES.has(normalizeHost(host))

/** The registrable domain of `host` (`api.github.com` → `github.com`), a small suffix list aside; its own name when it has one or two labels. */
export const registrableDomain = (host: string): string => {
  const h = normalizeHost(host)
  const labels = h.split(".").filter((l) => l !== "")
  if (labels.length <= 2) return h
  const lastTwo = `${labels[labels.length - 2]}.${labels[labels.length - 1]}`
  if (MULTI_LABEL_SUFFIXES.has(lastTwo) && labels.length >= 3) return `${labels[labels.length - 3]}.${lastTwo}`
  return lastTwo
}

/** Whether a cookie's host_key belongs to the site `apex`: the apex itself or a subdomain, never a look-alike. */
export const hostKeyInSite = (hostKey: string, apex: string): boolean => {
  const h = normalizeHost(hostKey)
  const a = normalizeHost(apex)
  if (a === "" || h === "") return false
  return h === a || h.endsWith(`.${a}`)
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
