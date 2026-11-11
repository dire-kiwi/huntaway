import { Context, Effect, Layer, Option, Redacted, Stream } from "effect"
import { Headers, HttpClient } from "effect/http"
import { RpcClient, RpcMiddleware, RpcSerialization } from "effect/rpc"
import { Auth, HostId, HostRpcGroup, Invalid, LinkId, LinkRefused, NotFound } from "@huntaway/contracts"
import type { Unavailable } from "@huntaway/contracts"
import type { Host, HostInfo, JoinInfo, LinkHello } from "@huntaway/contracts"
import { Db } from "../platform/Db.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { About } from "../settings/About.ts"
import { helloOf, LinkConnections } from "./LinkConnections.ts"
import type { LinkView } from "./LinkConnections.ts"
import { LinkRepo } from "./LinkRepo.ts"
import type { LinkRow } from "./LinkRepo.ts"
import { checkTarget, Ssh } from "./Ssh.ts"

// The hub's directory of hosts and the links it keeps (docs/plan/08-hosts.md; inventory 05 §2.2): this host and every
// linked one with its live state, linking by URL and token, renaming, the uplink switch, forgetting, and what a host
// needs to dial in. Nothing about a linked host is stored but its `links` row.

/** How long the hub waits for a host it is asked to link to say who it is. */
const PROBE_TIMEOUT = "10 seconds"

const validPort = (port: number) => Number.isInteger(port) && port > 0 && port <= 65535

/** This host as the directory shows it. */
const localEntry = (info: HostInfo): Host => ({
  id: info.host_id,
  name: info.host_name,
  local: true,
  connected: true,
  mode: "local",
  agents: info.agents,
  url: null,
  version: info.version,
  protocol: info.protocol,
  capabilities: info.capabilities,
  commit: info.commit,
  updates_from: info.updates_from,
  last_seen: null,
  last_message_at: null,
  uplink: false,
})

/** A link as the directory shows it: its row, and what the live connection says (never its token or SSH details). */
export const linkEntry = (row: LinkRow, view: LinkView | undefined): Host => {
  const hello = view?.hello ?? null
  const live = view?.status === "connected" || view?.status === "needs_update"
  return {
    id: HostId.make(row.id),
    name: row.name,
    local: false,
    connected: view?.status === "connected",
    mode: live && view?.via === "dial-in" ? "inbound" : row.mode,
    agents: live ? (hello?.agents ?? null) : null,
    url: row.ssh === null ? row.url : `ssh://${row.ssh.target}`,
    version: live ? (hello?.version ?? null) : null,
    protocol: live ? (hello?.protocol ?? null) : null,
    capabilities: live ? (hello?.capabilities ?? []) : [],
    commit: live ? (hello?.commit ?? null) : null,
    updates_from: live ? (hello?.updates_from ?? null) : null,
    last_seen: row.last_seen,
    last_message_at: live ? (view?.last_message_at ?? null) : null,
    uplink: row.uplink,
    status: view?.status ?? (row.mode === "inbound" ? "offline" : "connecting"),
    status_reason: view?.reason ?? null,
  }
}

export class Links extends Context.Service<
  Links,
  {
    /** This host and every link, with their live state. */
    readonly list: Effect.Effect<ReadonlyArray<Host>>
    /** The list now, then again on every change. */
    readonly watch: Stream.Stream<ReadonlyArray<Host>>
    /** Links a host this one can reach at `url` with its board token: it must say who it is first. */
    readonly add: (url: string, token: string) => Effect.Effect<Host, Invalid>
    readonly update: (id: LinkId, change: { readonly name?: string | undefined; readonly uplink?: boolean | undefined }) => Effect.Effect<void, NotFound>
    /** Forgets a link; profiles whose assistant ran there have it here again. Its data stays on that host. */
    readonly remove: (id: LinkId) => Effect.Effect<void>
    /** Links a host over SSH: its forced command says who it is and gives its token. */
    readonly addSsh: (
      target: string,
      sshPort: number,
      remotePort: number,
    ) => Effect.Effect<{ readonly id: HostId; readonly name: string; readonly started: boolean | null }, Invalid | Unavailable>
    /** The hub's SSH public key, for the target's `authorized_keys`. */
    readonly sshKey: Effect.Effect<string, Unavailable>
    /** What a host needs to dial in to this hub, which the browser reaches at `url`. */
    readonly join: (url: string) => Effect.Effect<JoinInfo>
    /** Answers a peer's `link.hello` with this host's. */
    readonly hello: (theirs: LinkHello) => Effect.Effect<LinkHello, LinkRefused>
  }
>()("huntaway-server/hosts/Links") {
  static readonly layer = Layer.effect(
    Links,
    Effect.gen(function* () {
      const db = yield* Db
      const repo = yield* LinkRepo
      const connections = yield* LinkConnections
      const about = yield* About
      const identity = yield* Identity
      const configs = yield* AgentConfigs
      const http = yield* HttpClient.HttpClient
      const ssh = yield* Ssh

      const list = Effect.gen(function* () {
        const views = yield* connections.views
        const rows = yield* repo.list
        return [localEntry(yield* about.info), ...rows.map((row) => linkEntry(row, views.get(row.id)))]
      })

      /** Asks `url` who it is, with `token`: its `host.info`. */
      const probe = (url: string, token: string) =>
        Effect.gen(function* () {
          const context = yield* Layer.build(
            Layer.mergeAll(
              RpcClient.layerProtocolHttp({ url: `${url}/api/rpc` }).pipe(Layer.provide(RpcSerialization.layerNdjson)),
              RpcMiddleware.layerClient(Auth, ({ next, request }) =>
                next({ ...request, headers: Headers.set(request.headers, "authorization", `Bearer ${token}`) }),
              ),
            ),
          )
          const client = yield* RpcClient.make(HostRpcGroup, { flatten: true }).pipe(Effect.provideContext(context))
          return yield* client("host.info", undefined)
        }).pipe(
          Effect.scoped,
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.timeoutOption(PROBE_TIMEOUT),
          Effect.mapError((error) =>
            error._tag === "Unauthorized" || error._tag === "Forbidden"
              ? new Invalid({ field: "token", reason: `${url} refused the token` })
              : new Invalid({ field: "url", reason: `can't reach ${url}: ${error.message}` }),
          ),
          Effect.flatMap(
            Option.match({ onNone: () => Effect.fail(new Invalid({ field: "url", reason: `${url} didn't answer in time` })), onSome: Effect.succeed }),
          ),
        )

      const add = Effect.fn("Links.add")(function* (given: string, tokenGiven: string) {
        const url = given.trim().replace(/\/+$/, "")
        const token = tokenGiven.trim()
        if (!/^https?:\/\/[^/\s]+/.test(url)) return yield* new Invalid({ field: "url", reason: "enter the host's URL, as http(s)://host:port" })
        if (token === "") return yield* new Invalid({ field: "token", reason: "enter the host's board token" })
        const info = yield* probe(url, token)
        if (info.host_id === identity.hostId) return yield* new Invalid({ field: "url", reason: "that's this host" })
        const id = LinkId.make(info.host_id)
        const now = yield* nowTimestamp
        yield* repo.upsert({ id, name: info.host_name, mode: "outbound", url, token, ssh: null, now })
        const row = yield* repo.get(id)
        if (row !== null) yield* connections.start(row)
        yield* connections.touch
        return linkEntry(
          row ?? { id, name: info.host_name, mode: "outbound", url, token, ssh: null, uplink: false, last_seen: null, created_at: now },
          undefined,
        )
      })

      const update = Effect.fn("Links.update")(function* (id: LinkId, change: { readonly name?: string | undefined; readonly uplink?: boolean | undefined }) {
        const row = yield* repo.get(id)
        if (row === null) return yield* new NotFound({ what: "host", id })
        const name = change.name?.trim() ?? ""
        if (name !== "") yield* repo.rename(id, name)
        if (change.uplink !== undefined) yield* repo.setUplink(id, change.uplink)
        return yield* connections.touch
      })

      const remove = Effect.fn("Links.remove")(function* (id: LinkId) {
        // A host that dials in has no loop of the hub's: its connection is ended here too, or it would go on.
        yield* connections.stop(id)
        yield* db.tx(
          Effect.gen(function* () {
            if ((yield* repo.delete(id)) > 0) yield* configs.emitChanged
          }),
        )
        yield* connections.touch
      })

      const addSsh = Effect.fn("Links.addSsh")(function* (given: string, sshPort: number, remotePort: number) {
        const target = checkTarget(given)
        if (typeof target !== "string") return yield* target
        if (!validPort(sshPort) || !validPort(remotePort)) return yield* new Invalid({ field: "ssh_port", reason: "ports are 1 to 65535" })
        const t = { target, ssh_port: sshPort, remote_port: remotePort }
        const details = yield* ssh.details(t, true)
        if (details.info.host_id === identity.hostId) return yield* new Invalid({ field: "target", reason: "that's this host" })
        const id = LinkId.make(details.info.host_id)
        yield* repo.upsert({ id, name: details.info.host_name, mode: "ssh", url: null, token: details.token, ssh: t, now: yield* nowTimestamp })
        const row = yield* repo.get(id)
        if (row !== null) yield* connections.start(row)
        yield* connections.touch
        return { id: details.info.host_id, name: details.info.host_name, started: details.started }
      })

      const join = (url: string) =>
        Effect.succeed({
          hub_token: Redacted.value(identity.hubToken),
          host_token: Redacted.value(identity.token),
          command: `huntaway serve --hub ${url.trim().replace(/\/+$/, "")} --hub-token ${Redacted.value(identity.hubToken)}`,
        })

      const hello = Effect.fn("Links.hello")(function* (theirs: LinkHello) {
        if (theirs.host_id === identity.hostId) return yield* new LinkRefused({ reason: "that's this host" })
        return helloOf(yield* about.info)
      })

      return Links.of({
        list,
        watch: Stream.concat(
          Stream.fromEffect(list),
          Stream.mapEffect(connections.changes, () => list, { concurrency: 1 }),
        ),
        add,
        addSsh,
        sshKey: ssh.publicKey,
        update,
        remove,
        join,
        hello,
      })
    }),
  )
}
