import { Context, Effect, FileSystem, Layer, Option, Redacted, Result, Schema } from "effect"
import { SecureRandom } from "effect/crypto"
import { Invalid, LinkId, ProfileId } from "@huntaway/contracts"
import type { AgentConfigId, AsanaTask, Conflict, NewProfile, Profile, ProfilePatch } from "@huntaway/contracts"
import { DataDir } from "../platform/DataDir.ts"
import { Db } from "../platform/Db.ts"
import { Events } from "../platform/Events.ts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { AgentConfigRepo } from "./AgentConfigRepo.ts"
import { AgentConfigs } from "./AgentConfigs.ts"
// 6.11: connecting Asana, and a profile's Asana search.
import { Asana, AsanaOff, asanaLabel, taskGid } from "./Asana.ts"
import type { AsanaFailed } from "./Asana.ts"
import {
  asciiLower,
  blank,
  checkAgentAccess,
  checkCloneDir,
  checkConfigIds,
  checkGithubAccount,
  checkProfileName,
  checkThreadConfig,
  checkTint,
  ifGiven,
  refuseWhileRunning,
  reviewersValue,
} from "./checks.ts"
import { removeUnusedDir } from "./dataFolders.ts"
import { SettingsRepo } from "../settings/SettingsRepo.ts"
import { ProfileRepo } from "./ProfileRepo.ts"
import type { ProfileColumns } from "./ProfileRepo.ts"

export class ProfileNotFound extends Schema.TaggedError<ProfileNotFound, { readonly brand: unique symbol }>()("ProfileNotFound", { id: Schema.String }) {}

export interface ProfilesShape {
  readonly list: Effect.Effect<ReadonlyArray<Profile>>
  readonly get: (id: ProfileId) => Effect.Effect<Profile, ProfileNotFound>
  /** Emits `profiles_changed`. */
  readonly create: (input: NewProfile) => Effect.Effect<Profile, Invalid | Conflict>
  /** Emits `profiles_changed`. */
  readonly update: (id: ProfileId, patch: ProfilePatch) => Effect.Effect<Profile, ProfileNotFound | Invalid | Conflict>
  /**
   * Deletes the profile with its projects, its tasks and their threads, then its and its projects' folders in the data
   * folder (unless something still in use is inside). Refused while one of its agents runs. Emits `project_deleted`
   * for each project, `task_deleted` for each task in no project, then `profiles_changed`.
   */
  readonly delete: (id: ProfileId) => Effect.Effect<void, ProfileNotFound | Conflict>
  /**
   * A profile named `name` on the Claude Code config in `dir` (shared with one on that folder already), unless a profile
   * has that name in any case, which is left as it is (the old `ensure_profile`). The profile it made, if it made one.
   */
  readonly ensure: (name: string, dir: string) => Effect.Effect<Option.Option<Profile>>
  /**
   * 6.11: the Asana tasks the profile's token finds for `q` (a search, or a task's URL: none for one the token can't
   * see). Refused while Asana is off for it or it isn't connected.
   */
  readonly asanaTasks: (id: ProfileId, q: string) => Effect.Effect<ReadonlyArray<AsanaTask>, ProfileNotFound | AsanaOff | AsanaFailed>
}

/** Profiles: one person's board on this host, with the agent configs its threads can use. */
export class Profiles extends Context.Service<Profiles, ProfilesShape>()("huntaway-server/profiles/Profiles") {
  static readonly layer = Layer.effect(
    Profiles,
    Effect.gen(function* () {
      const repo = yield* ProfileRepo
      const configRepo = yield* AgentConfigRepo
      const settingsRepo = yield* SettingsRepo
      const configs = yield* AgentConfigs
      const db = yield* Db
      const events = yield* Events
      const dataDir = yield* DataDir
      const identity = yield* Identity
      const config = yield* ServerConfig
      const asana = yield* Asana
      const fs = yield* FileSystem.FileSystem
      const random = yield* SecureRandom.SecureRandom

      const getProfile = (id: ProfileId) =>
        Effect.flatMap(repo.get(id), Option.match({ onNone: () => Effect.fail(new ProfileNotFound({ id })), onSome: Effect.succeed }))
      const configIds = Effect.map(configRepo.list, (list) => new Set<string>(list.map((c) => c.id)))
      /** Its folder for scratch tasks, made when it is (the old `profile_scratch_dir`). */
      const makeScratch = (id: ProfileId) => fs.makeDirectory(`${dataDir.profileDir(id)}/scratch`, { recursive: true }).pipe(Effect.ignore)
      // The linked host its assistant runs on (a `links` row), or this host (null).
      const checkAssistantHost = (v: string | null | undefined) => {
        const id = blank(v)
        if (id === null || id === identity.hostId) return Effect.succeed(null)
        return Effect.flatMap(settingsRepo.linkExists(id), (linked) =>
          linked ? Effect.succeed(LinkId.make(id)) : Effect.fail(new Invalid({ field: "assistant_host", reason: "assistant_host must be a linked host" })),
        )
      }
      const newId = Effect.map(random.uuidV4(), (id) => ProfileId.make(id)).pipe(Effect.orDie)

      const insert = (id: ProfileId, columns: ProfileColumns) => Effect.flatMap(nowTimestamp, (now) => repo.insert(id, now, columns))

      const create = Effect.fn("Profiles.create")(function* (input: NewProfile) {
        const githubAccount = yield* checkGithubAccount(input.github_account)
        const cloneDir = yield* checkCloneDir(input.clone_dir, config.home)
        const tint = yield* checkTint(input.tint)
        const assistantHost = yield* checkAssistantHost(input.assistant_host)
        yield* configs.refresh()
        const id = yield* newId
        const profile = yield* db.tx(
          Effect.gen(function* () {
            const name = yield* checkProfileName(input.name, null, yield* repo.list)
            const known = yield* configIds
            const ids = yield* checkConfigIds(input.claude_config_ids ?? [], known)
            const list = { saved: [], configs: known, defaultsToo: true }
            yield* insert(id, {
              name,
              claude_config_ids: ids,
              default_model: blank(input.default_model),
              agent_access: checkAgentAccess(name, input.agent_access ?? []),
              github_account: githubAccount,
              clone_dir: cloneDir,
              asana_enabled: input.asana_enabled ?? true,
              limit_wait: input.limit_wait ?? false,
              limit_switch: input.limit_switch ?? false,
              reviewers: yield* reviewersValue(input.reviewers ?? null, { ...list, summarizers: false }),
              summarizers: yield* reviewersValue(input.summarizers ?? null, { ...list, summarizers: true }),
              merge_approval: input.merge_approval ?? false,
              require_pr_approval: input.require_pr_approval ?? false,
              assistant_host: assistantHost,
              assistant_config_id: yield* checkThreadConfig("assistant_config_id", input.assistant_config_id, ids),
              threads_config_id: yield* checkThreadConfig("threads_config_id", input.threads_config_id, ids),
              tint,
            })
            yield* configs.emitChanged
            return yield* getProfile(id).pipe(Effect.orDie)
          }),
        )
        yield* makeScratch(id)
        return profile
      })

      const update = Effect.fn("Profiles.update")(function* (id: ProfileId, patch: ProfilePatch) {
        // A token is checked with Asana first, which names who it's for; null or blank disconnects.
        const asanaToken = blank(patch.asana_token)
        const asanaUser =
          asanaToken === null
            ? null
            : asanaLabel(yield* asana.me(asanaToken).pipe(Effect.mapError((e) => new Invalid({ field: "asana_token", reason: e.message }))))
        const assistantHost = patch.assistant_host === undefined ? undefined : yield* checkAssistantHost(patch.assistant_host)
        const githubAccount = yield* ifGiven(patch.github_account, checkGithubAccount)
        const cloneDir = yield* ifGiven(patch.clone_dir, (v) => checkCloneDir(v, config.home))
        const tint = yield* ifGiven(patch.tint, checkTint)
        yield* configs.refresh()
        return yield* db.tx(
          Effect.gen(function* () {
            const current = yield* getProfile(id)
            const known = yield* configIds
            // Its name unchanged passes even if another profile has it in another case (allowed before HA-37), as the
            // profile form sends it with every save.
            const name =
              patch.name === undefined
                ? undefined
                : patch.name.trim() === current.name
                  ? current.name
                  : yield* checkProfileName(patch.name, id, yield* repo.list)
            // A config deleted since it was saved may still be named, as the forms send them unchanged with every save.
            const list = { saved: [...current.reviewers, ...current.summarizers], configs: known, defaultsToo: true }
            const ids = patch.claude_config_ids === undefined ? undefined : yield* checkConfigIds(patch.claude_config_ids, known)
            const has: ReadonlyArray<AgentConfigId> = ids ?? current.claude_config_ids
            // The configs its assistant and threads start with are among those it has: one it no longer has goes back to the default.
            const threadConfig = (key: "assistant_config_id" | "threads_config_id") =>
              patch[key] !== undefined
                ? checkThreadConfig(key, patch[key], has)
                : Effect.succeed(current[key] !== null && !has.includes(current[key]) ? null : undefined)
            const columns: ProfileColumns = {
              name,
              default_model: patch.default_model === undefined ? undefined : blank(patch.default_model),
              agent_access: patch.agent_access === undefined ? undefined : checkAgentAccess(name ?? current.name, patch.agent_access),
              github_account: githubAccount,
              clone_dir: cloneDir,
              ...(patch.asana_token === undefined ? {} : { asana_token: asanaToken, asana_user: asanaUser }),
              asana_enabled: patch.asana_enabled,
              limit_wait: patch.limit_wait,
              limit_switch: patch.limit_switch,
              merge_approval: patch.merge_approval,
              require_pr_approval: patch.require_pr_approval,
              telemetry: patch.telemetry,
              telemetry_titles: patch.telemetry_titles,
              reviewers: patch.reviewers === undefined ? undefined : yield* reviewersValue(patch.reviewers, { ...list, summarizers: false }),
              summarizers: patch.summarizers === undefined ? undefined : yield* reviewersValue(patch.summarizers, { ...list, summarizers: true }),
              claude_config_ids: ids,
              assistant_host: assistantHost,
              assistant_config_id: yield* threadConfig("assistant_config_id"),
              threads_config_id: yield* threadConfig("threads_config_id"),
              tint,
            }
            yield* repo.update(id, columns)
            yield* configs.emitChanged
            return yield* getProfile(id)
          }),
        )
      })

      const remove = Effect.fn("Profiles.delete")(function* (id: ProfileId) {
        yield* configs.refresh()
        const deleted = yield* db.tx(
          Effect.gen(function* () {
            yield* getProfile(id)
            yield* refuseWhileRunning(yield* repo.running(id), (n) => `${n} of the profile's agents ${n === 1 ? "is" : "are"} running; stop them first`)
            const gone = yield* repo.delete(id)
            for (const project of gone.projects) yield* events.emit({ type: "project_deleted", id: project })
            for (const task of gone.tasks) yield* events.emit({ type: "task_deleted", id: task, project_id: null })
            yield* configs.emitChanged
            return gone
          }),
        )
        const used = yield* repo.usedPaths
        for (const project of deleted.projects) yield* removeUnusedDir(fs, dataDir.projectDir(project), used, "project")
        yield* removeUnusedDir(fs, dataDir.profileDir(id), used, "profile")
      })

      const ensure = Effect.fn("Profiles.ensure")(function* (name: string, dir: string) {
        yield* configs.refresh([dir])
        const made = yield* db.tx(
          Effect.gen(function* () {
            if ((yield* repo.list).some((p) => asciiLower(p.name) === asciiLower(name))) return Option.none<Profile>()
            const configId = yield* configs.forDir(name, dir)
            const id = yield* newId
            yield* insert(id, { name, claude_config_ids: [configId] })
            yield* configs.emitChanged
            return Option.some(yield* getProfile(id).pipe(Effect.orDie))
          }),
        )
        if (Option.isSome(made)) yield* makeScratch(made.value.id)
        return made
      })

      const asanaTasks = Effect.fn("Profiles.asanaTasks")(function* (id: ProfileId, q: string) {
        const profile = yield* getProfile(id)
        if (!profile.asana_enabled) return yield* new AsanaOff({ reason: `Asana is turned off for the ${profile.name} profile (Settings → Profiles)` })
        const token = yield* repo.asanaToken(id)
        if (token === null) return yield* new AsanaOff({ reason: `the ${profile.name} profile isn't connected to Asana` })
        const found = yield* Effect.result(asana.search(Redacted.value(token), q))
        if (Result.isSuccess(found)) return found.success
        // A task's URL that the token can't see finds nothing.
        if (found.failure.kind === "NotFound" && taskGid(q.trim()) !== null) return []
        return yield* found.failure
      })

      return Profiles.of({ list: repo.list, get: getProfile, create, update, delete: remove, ensure, asanaTasks })
    }),
  )

  /** Startup (the old serve.ts, after the demo): the profiles `--profile NAME=DIR` asks for, made if missing. */
  static readonly ensureFromConfig = Layer.effectDiscard(
    Effect.gen(function* () {
      const profiles = yield* Profiles
      const config = yield* ServerConfig
      const fs = yield* FileSystem.FileSystem
      for (const { name, dir } of config.profiles) {
        const made = yield* profiles.ensure(name, dir)
        if (Option.isNone(made)) continue
        yield* Effect.logInfo(`made profile ${name} with the Claude config in ${dir}`)
        const isDir = yield* fs.stat(dir).pipe(
          Effect.map((info) => info.type === "Directory"),
          Effect.orElseSucceed(() => false),
        )
        if (!isDir) yield* Effect.logWarning(`profile ${name}'s Claude config ${dir} isn't a directory here`)
      }
    }),
  )
}
