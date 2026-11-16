import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Invalid, NotFound, Unavailable } from "../errors.ts"
import { Auth, RequiredScope } from "../session.ts"
import { BringResult, BringSignIns, BrowserSource, TeleportImport, TeleportSites } from "../teleport.ts"

/**
 * Teleport (HE-49): bring a host browser profile's sign-ins into a Space. Reading what browsers and sites there are is
 * `terminal`; bringing sign-ins in and removing them again are `admin` (they decrypt the host's cookies and change the
 * Space). `Unavailable` where the host has no Docker or the Space isn't running.
 */
export class TeleportRpcs extends RpcGroup.make(
  /** The browsers on the host that runs this server, with their profiles. */
  Rpc.make("teleport.sources", { success: Schema.Array(BrowserSource), error: Unavailable }).annotate(RequiredScope, "terminal"),
  /** The sites a browser profile holds, with cookie counts; nothing is decrypted. */
  Rpc.make("teleport.sites", {
    payload: { browser: Schema.String, profile: Schema.String },
    success: TeleportSites,
    error: Schema.Union([Invalid, NotFound, Unavailable]),
  }).annotate(RequiredScope, "terminal"),
  /** Send the chosen sites into the Space: closes its browser, decrypts and uploads, keeps the import to wipe later. */
  Rpc.make("teleport.bring", { payload: BringSignIns, success: BringResult, error: Schema.Union([Invalid, NotFound, Unavailable]) }).annotate(
    RequiredScope,
    "admin",
  ),
  /** The teleports that landed in a Space and can be removed. */
  Rpc.make("teleport.imports", { payload: { id: Schema.String }, success: Schema.Array(TeleportImport) }).annotate(RequiredScope, "terminal"),
  /** Remove a teleport's sign-ins from its Space (`WipeImport`); gone already counts as removed. */
  Rpc.make("teleport.remove", { payload: { import_id: Schema.String }, error: Schema.Union([NotFound, Unavailable]) }).annotate(RequiredScope, "admin"),
).middleware(Auth) {}
