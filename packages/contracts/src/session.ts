import { Context, Schema } from "effect"
import { RpcMiddleware } from "effect/rpc"
import { Forbidden, Unauthorized } from "./errors.ts"
import type { DeviceId, LinkId } from "./ids.ts"

// Sessions and scopes (docs/plan/05-protocol.md). Every RPC states the scope it needs as an annotation; the `Auth`
// middleware resolves the session from the request and fails with `Forbidden` when the scope is missing.

/**
 * What a session may do. `read`: lists, gets, subscriptions, thread pages. `operate`: create and change tasks, send
 * messages, answer prompts, stop runs, attachments. `git`: the Changes tab's writes, worktrees, rewind. `terminal`:
 * terminals and the desktop viewer. `settings`: profiles, projects, configs, automations, workflows, tools, rules,
 * docs. `admin`: linking hosts, restart and update, archives, telemetry, the service, the folder browser. `link`: a
 * host talking to another.
 */
export const Scope = Schema.Literals(["read", "operate", "git", "terminal", "settings", "admin", "link"])
export type Scope = typeof Scope.Type

/** Every scope the board token gives: all but `link`. */
export const boardScopes: ReadonlySet<Scope> = new Set<Scope>(["read", "operate", "git", "terminal", "settings", "admin"])

export interface SessionShape {
  readonly kind: "board" | "device" | "link"
  readonly scopes: ReadonlySet<Scope>
  readonly device_id: DeviceId | null
  /** Set when a hub relays for someone. */
  readonly via_link: LinkId | null
}

/** Who is calling, provided by `Auth` to every handler. */
export class Session extends Context.Service<Session, SessionShape>()("@huntaway/contracts/session") {}

/**
 * The scope an RPC needs: `Rpc.make(…).annotate(RequiredScope, "operate")`. An RPC without one is refused by `Auth`
 * (and a structural test fails on it); `public.*` is the only group without `Auth`.
 */
export const RequiredScope = Context.Reference<Scope | null>("@huntaway/contracts/session/RequiredScope", { defaultValue: () => null })

/** The middleware that turns a request into a `Session`. Declared here; the server implements it, the clients send the token. */
export class Auth extends RpcMiddleware.Service<Auth, { provides: Session }>()("@huntaway/contracts/session/Auth", {
  error: Schema.Union([Unauthorized, Forbidden]),
  requiredForClient: true,
}) {}
