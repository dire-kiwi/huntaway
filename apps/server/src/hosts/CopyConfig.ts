import { Context, Effect, Layer } from "effect"
import { Invalid, LinkId, NotFound, Unavailable } from "@huntaway/contracts"
import type { AgentConfig, AgentConfigId, CopyConfig as CopyConfigPayload, HostOffline, NewAgentConfig } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import { LinkConnections } from "./LinkConnections.ts"

// Copying an agent config's login and settings from one host to another (`hub.hosts.copyConfig`; inventory 05 §2.2,
// the old `copy_claude_config`), through each host's own RPCs: this host's directly, a linked host's through its
// connection. The config is matched by name and made on the target when it has none of that name, in the source's
// folder unless another is given.
//
// The login itself travels as the config's archive (`configs.exportArchive` and `configs.importArchive`), which comes
// with plan task 6.11: until then the copy stops at the export, before anything is made on the target.
// Copying a profile's login (`profile`, the old hosts' before API 20) is gone with `/profiles/{id}/claude-config`
// (docs/plan/14-dropped-and-open.md).

/** What a copy needs of a host. */
interface ConfigHost {
  readonly name: string
  readonly configs: Effect.Effect<ReadonlyArray<AgentConfig>, Unavailable>
  readonly create: (config: NewAgentConfig) => Effect.Effect<AgentConfig, Invalid | Unavailable>
  /** The config's login and settings as an archive, and how many files it holds. */
  readonly exportArchive: (id: AgentConfigId) => Effect.Effect<{ readonly archive: string; readonly files: number }, Unavailable>
  readonly importArchive: (id: AgentConfigId, archive: string, overwrite: boolean) => Effect.Effect<void, Unavailable>
}

/** What `hub.hosts.copyConfig` takes. */
type CopyConfigInput = typeof CopyConfigPayload.Type

/** Config archives come with plan task 6.11. */
const noArchives = Effect.fail(new Unavailable({ what: "copying a config's login", reason: "hosts can't export a config's login yet (config archives)" }))

/** A failed call to a linked host, as what the copy fails with. */
const unavailable = (host: string) => (e: { readonly message: string; readonly _tag: string }) =>
  new Unavailable({ what: `the agent configs on ${host}`, reason: e.message === "" ? e._tag : e.message })

export interface CopyConfigShape {
  readonly copy: (
    input: CopyConfigInput,
  ) => Effect.Effect<{ readonly ok: boolean; readonly files: number | null }, Invalid | NotFound | HostOffline | Unavailable>
}

export class CopyConfig extends Context.Service<CopyConfig, CopyConfigShape>()("huntaway-server/hosts/CopyConfig") {
  static readonly layer = Layer.effect(
    CopyConfig,
    Effect.gen(function* () {
      const identity = yield* Identity
      const configs = yield* AgentConfigs
      const connections = yield* LinkConnections

      const local: ConfigHost = {
        name: identity.hostName,
        configs: configs.list,
        create: configs.create,
        exportArchive: () => noArchives,
        importArchive: () => noArchives,
      }

      const hostOf = (id: string): Effect.Effect<ConfigHost, HostOffline> =>
        id === identity.hostId
          ? Effect.succeed(local)
          : Effect.map(connections.live(LinkId.make(id)), (live) => {
              const name = live.hello.name
              return {
                name,
                configs: live.client("configs.list", undefined).pipe(Effect.mapError(unavailable(name))),
                create: (config) =>
                  live.client("configs.create", { config }).pipe(
                    Effect.catchTags({
                      Invalid: (e) => Effect.fail(e),
                      Conflict: (e) => Effect.fail(new Invalid({ field: "config", reason: e.detail })),
                    }),
                    Effect.mapError((e) => (e._tag === "Invalid" ? e : unavailable(name)(e))),
                  ),
                exportArchive: () => noArchives,
                importArchive: () => noArchives,
              } satisfies ConfigHost
            })

      const copy = Effect.fn("CopyConfig.copy")(function* (input: CopyConfigInput) {
        if (input.from_host === input.to_host) return yield* new Invalid({ field: "to_host", reason: "pick two different hosts" })
        const name = input.config
        if (name === undefined) {
          return yield* new Invalid({
            field: "config",
            reason: input.profile === undefined ? "config is required" : "copy the profile's agent config instead: profiles keep no login of their own",
          })
        }
        const from = yield* hostOf(input.from_host)
        const to = yield* hostOf(input.to_host)
        const source = (yield* from.configs).find((c) => c.name === name)
        if (source === undefined) return yield* new NotFound({ what: `agent config on ${from.name}`, id: name })
        const exported = yield* from.exportArchive(source.id)
        const existing = (yield* to.configs).find((c) => c.name === name)
        const dir = input.config_dir?.trim() ? input.config_dir : source.config_dir
        const target = existing ?? (yield* to.create({ name, config_dir: dir, agent: source.agent }))
        yield* to.importArchive(target.id, exported.archive, input.overwrite === true)
        return { ok: true, files: exported.files }
      })

      return CopyConfig.of({ copy })
    }),
  )
}
