import { Effect } from "effect"
import { ConfigRpcs, NotFound, ProfileRpcs, Unavailable } from "@huntaway/contracts"
import { CodexQueries } from "../agents/CodexQueries.ts"
import { Worktrees } from "../git/Worktrees.ts"
import { AgentConfigs } from "../profiles/AgentConfigs.ts"
import type { AgentConfigNotFound } from "../profiles/AgentConfigs.ts"
import { Profiles } from "../profiles/Profiles.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"

const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))
const configNotFound = (e: AgentConfigNotFound) => Effect.fail(new NotFound({ what: "agent config", id: e.id }))

export const ProfileHandlers = ProfileRpcs.toLayer(
  Effect.gen(function* () {
    const profiles = yield* Profiles
    const worktrees = yield* Worktrees
    return ProfileRpcs.of({
      "profiles.list": () => profiles.list,
      "profiles.create": ({ profile }) => profiles.create(profile),
      "profiles.update": ({ id, patch }) => profiles.update(id, patch).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
      // Its projects' worktrees go first (`Worktrees.deleteProfile`).
      "profiles.delete": ({ id }) => worktrees.deleteProfile(id).pipe(Effect.catchTag("ProfileNotFound", profileNotFound)),
    })
  }),
)

export const ConfigHandlers = ConfigRpcs.toLayer(
  Effect.gen(function* () {
    const configs = yield* AgentConfigs
    const codex = yield* CodexQueries
    return ConfigRpcs.of({
      "configs.list": () => configs.list,
      "configs.create": ({ config }) => configs.create(config),
      "configs.update": ({ id, patch }) => configs.update(id, patch).pipe(Effect.catchTag("AgentConfigNotFound", configNotFound)),
      "configs.delete": ({ id }) => configs.delete(id).pipe(Effect.catchTag("AgentConfigNotFound", configNotFound)),
      "configs.models": ({ id }) =>
        codex.configModels(id).pipe(
          Effect.catchTags({
            AgentConfigNotFound: configNotFound,
            CodexUnavailable: (e) => Effect.fail(new Unavailable({ what: "Codex", reason: `couldn't list Codex models: ${e.reason}` })),
          }),
        ),
    })
  }),
)
