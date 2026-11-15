import { Effect } from "effect"
import { PluginRpcs, Session } from "@huntaway/contracts"
import { Plugins } from "../plugins/Plugins.ts"

// HE-34: a host's plugins over RPC (docs/plan/15-plugins.md). The method's scope is checked by `Plugins.call`.
export const PluginHandlers = PluginRpcs.toLayer(
  Effect.gen(function* () {
    const plugins = yield* Plugins
    return PluginRpcs.of({
      "plugins.list": () => plugins.list,
      "plugins.page": (request) =>
        Effect.gen(function* () {
          return yield* plugins.page(request, yield* Session)
        }),
      "plugins.call": ({ plugin, method, payload }) =>
        Effect.gen(function* () {
          return yield* plugins.call(plugin, method, payload, yield* Session)
        }),
    })
  }),
)
