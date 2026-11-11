import { Effect } from "effect"
import { Atom } from "effect/reactivity"
import type { AsyncResult } from "effect/reactivity"
import { AgentConfigId, type AgentModel } from "@huntaway/contracts"
import { callRpc } from "../rpc.ts"

// The models agent configs offer (`configs.models`, 5.3): a Codex config's, asked of its host when a component mounts
// them (the host keeps them for 10 minutes); a Claude config lists none (the pickers offer Claude's aliases). Kept for as
// long as something shows them.

/** What each of several configs offers, by config id: its models, or why they couldn't be listed. */
export interface ConfigModels {
  readonly models: Readonly<Record<string, ReadonlyArray<AgentModel>>>
  readonly failed: Readonly<Record<string, string>>
}

const byKey = Atom.family((key: string) => {
  const [host = "", ...ids] = key.split("\u0000")
  return Atom.make(
    Effect.gen(function* () {
      const models: Record<string, ReadonlyArray<AgentModel>> = {}
      const failed: Record<string, string> = {}
      for (const id of ids) {
        const listed = yield* Effect.result(callRpc(host, "configs.models", { id: AgentConfigId.make(id) }))
        if (listed._tag === "Success") models[id] = listed.success
        else failed[id] = "reason" in listed.failure && typeof listed.failure.reason === "string" ? listed.failure.reason : listed.failure._tag
      }
      const out: ConfigModels = { models, failed }
      return out
    }),
  )
})

/** The models of the Codex configs `configIds` of `host` (give only Codex configs' ids: a Claude config lists none). */
export const configModelsAtom = (host: string, configIds: ReadonlyArray<string>): Atom.Atom<AsyncResult.AsyncResult<ConfigModels>> =>
  byKey([host, ...[...configIds].toSorted()].join("\u0000"))
