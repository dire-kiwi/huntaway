// HE-60: which host answers a plugin's page. A plugin keeps its data per host, keyed by profile, and its paths name the
// profile first (`/docs/<profile id>/d/<slug>/…`, `/notes/<profile id>`): such a page is that profile's host's. Through
// a hub the page's own host is the hub, which has no such profile, so the docs plugin there said "no profile …".

/**
 * The host for the plugin page at `path`: the host of the profile its first segment names (the page's own host first,
 * where two have one id), else the page's own. null while it can't be told yet: the board isn't loaded and no host has
 * shown a profile of that id.
 */
export function pluginHost(
  b: { readonly loaded: boolean; readonly localHostId: string | null; readonly profiles: ReadonlyArray<{ readonly id: string; readonly host_id: string }> },
  path: string,
): string | null {
  const first = path.split("/")[0] ?? ""
  if (first !== "") {
    const of = b.profiles.filter((p) => p.id === first)
    const at = of.find((p) => p.host_id === b.localHostId) ?? of[0]
    if (at !== undefined) return at.host_id
    if (!b.loaded) return null
  }
  return b.localHostId
}
