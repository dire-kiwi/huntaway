import { Schema } from "effect"
import { Timestamp } from "./time.ts"

// Teleport (HE-49, after Cua Spaces' teleport): bring a browser profile's sign-ins from the host that runs the server
// into a Space. The server reads the host's Chrome/Chromium or Firefox profile, groups its cookies and localStorage by
// site, and (once the user picks) decrypts them, closes the Space's browser and sends them to the Space's spacesd
// (`cua.env.v1.TeleportService`). Saved passwords are not moved (Sign-ins, HE-48, cover those).

/** A browser kind, by how its profile is read. */
export const BrowserKind = Schema.Literals(["chromium", "firefox"])
export type BrowserKind = typeof BrowserKind.Type

/** One profile of a browser on the host (`Default`, `Profile 1`, a Firefox profile folder). */
export const BrowserProfile = Schema.Struct({
  /** The profile's key within its browser (its directory name): what `teleport.sites`/`bring` take. */
  id: Schema.String,
  /** What to show it as (its name from the browser, else its directory). */
  label: Schema.String,
})
export interface BrowserProfile extends Schema.Schema.Type<typeof BrowserProfile> {}

/** A browser found on the host, with its profiles. */
export const BrowserSource = Schema.Struct({
  /** A stable key for the browser (`chromium`, `google-chrome`, `firefox`…): what `teleport.sites`/`bring` take. */
  key: Schema.String,
  kind: BrowserKind,
  /** What to show it as ("Chromium", "Google Chrome", "Firefox"). */
  label: Schema.String,
  profiles: Schema.Array(BrowserProfile),
})
export interface BrowserSource extends Schema.Schema.Type<typeof BrowserSource> {}

/** A site in a profile, as the dialog lists it (nothing decrypted to make this). */
export const TeleportSite = Schema.Struct({
  /** The registrable domain (`github.com`). */
  site: Schema.String,
  /** How many cookies the profile holds for it and its subdomains. */
  cookie_count: Schema.Int,
  /** How many localStorage origins it has. */
  storage_count: Schema.Int,
  /** It looks signed in (a session or auth cookie): the dialog pre-ticks it, unless it is an identity provider. */
  signed_in: Schema.Boolean,
  /** An identity provider (Google, Microsoft, Apple, Okta…): never pre-ticked, teleporting it can hand over the account. */
  identity_provider: Schema.Boolean,
})
export interface TeleportSite extends Schema.Schema.Type<typeof TeleportSite> {}

/** The sites of a profile, newest-looking first. */
export const TeleportSites = Schema.Struct({
  browser: Schema.String,
  kind: BrowserKind,
  profile: Schema.String,
  sites: Schema.Array(TeleportSite),
})
export interface TeleportSites extends Schema.Schema.Type<typeof TeleportSites> {}

/** How long after a teleport the Space wipes the sign-ins itself. */
export const WipeAfter = Schema.Literals(["never", "hour", "day"])
export type WipeAfter = typeof WipeAfter.Type

/** What `teleport.bring` takes: a Space, a browser profile, the sites to send, and an optional self-wipe. */
export const BringSignIns = Schema.Struct({
  id: Schema.String,
  browser: Schema.String,
  profile: Schema.String,
  /** The registrable domains to send (from `teleport.sites`). */
  sites: Schema.Array(Schema.String),
  wipe_after: Schema.optional(WipeAfter),
})
export interface BringSignIns extends Schema.Schema.Type<typeof BringSignIns> {}

/** A teleport that landed in a Space, kept so its sign-ins can be removed again (`WipeImport`). */
export const TeleportImport = Schema.Struct({
  import_id: Schema.String,
  /** The Space it went into. */
  space_id: Schema.String,
  /** `chrome` or `firefox` (spacesd's provider id). */
  app: Schema.String,
  /** What was sent, for the UI ("github.com, figma.com and 3 more"). */
  label: Schema.String,
  /** The number of sites sent. */
  site_count: Schema.Int,
  /** When the Space wipes it itself, if a wipe-after was chosen. */
  expires_at: Schema.NullOr(Timestamp),
  created_at: Timestamp,
})
export interface TeleportImport extends Schema.Schema.Type<typeof TeleportImport> {}

/** What `teleport.bring` returns: the import it made, and what spacesd said it imported and skipped. */
export const BringResult = Schema.Struct({
  import: TeleportImport,
  imported: Schema.Array(Schema.String),
  skipped: Schema.Array(Schema.String),
})
export interface BringResult extends Schema.Schema.Type<typeof BringResult> {}
