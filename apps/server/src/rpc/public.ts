import { Effect, Redacted } from "effect"
import { NotFound, PublicRpcs } from "@huntaway/contracts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { About } from "../settings/About.ts"

const loopbackHost = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\])(:\d+)?$/i
/** A server bound to this machine only (huntaway's serve.ts `loopback_only`): any 127.x address, localhost or ::1. */
const isLoopbackOnly = (host: string) => host.startsWith("127.") || host === "localhost" || host === "::1"

export const PublicHandlers = PublicRpcs.toLayer(
  Effect.gen(function* () {
    const about = yield* About
    const identity = yield* Identity
    const config = yield* ServerConfig
    return PublicRpcs.of({
      "public.health": () => about.health,
      // A loopback-only server gives it only for a loopback `Host` header, against DNS rebinding.
      "public.openToken": (_, { headers }) =>
        config.openToken && (!isLoopbackOnly(config.host) || loopbackHost.test(headers["host"] ?? ""))
          ? Effect.succeed({ token: Redacted.value(identity.token) })
          : Effect.fail(new NotFound({ what: "route", id: "public.openToken" })),
    })
  }),
)
