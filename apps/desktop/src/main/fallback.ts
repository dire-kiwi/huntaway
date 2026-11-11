import { Effect, Ref, Schema } from "effect"

/** Why the server couldn't back up its database, as it says on stdout (`HUNTAWAY_BACKUP_FAILED {reason, why, dir}`). */
export const BackupFailure = Schema.Struct({
  reason: Schema.String,
  why: Schema.String,
  dir: Schema.String,
})
export type BackupFailure = typeof BackupFailure.Type

/**
 * A server did not start. `early` is whether it exited (or could not be run) before it said it was ready, rather than
 * taking too long; `backup` is set when it exited because it couldn't back up the database.
 */
export class StartFailed extends Schema.TaggedError<StartFailed, { readonly brand: unique symbol }>()("StartFailed", {
  message: Schema.String,
  early: Schema.Boolean,
  backup: Schema.NullOr(BackupFailure),
}) {}

/** No server is left to start: none installed, bundled or in the checkout. */
export class NoServer extends Schema.TaggedError<NoServer, { readonly brand: unique symbol }>()("NoServer", { message: Schema.String }) {}

/** A server to start: an installed release (`version`), or the bundled, overridden or checkout one (null). */
export interface Choice {
  readonly version: string | null
}

export interface FallbackOptions<C extends Choice, R> {
  /** The server to start next, passing over the versions in `skip`. */
  readonly choose: (skip: ReadonlyArray<string>) => Effect.Effect<C, NoServer, R>
  /**
   * Start it, succeeding with its token once it is ready. On a timeout (a failure that is not `early`) the server is
   * still starting: if it comes up after all, `start` runs `lateReady` (while it is the latest start and the app is not
   * quitting).
   */
  readonly start: (choice: C, lateReady: Effect.Effect<void, never, R>) => Effect.Effect<string | null, StartFailed, R>
  /** Whether something answers on the port now: another launch's server took it. */
  readonly portTaken: Effect.Effect<boolean, never, R>
  /**
   * Versions that failed to start: skipped, and saved with `saveBad` once a server has come up. The caller keeps it
   * across starts, adding `trying` and any version that exits after `start` stopped waiting for it.
   */
  readonly failed: Ref.Ref<ReadonlyArray<string>>
  readonly saveBad: (version: string) => Effect.Effect<void, never, R>
  /** Whether the app is quitting. */
  readonly stopping: Effect.Effect<boolean>
}

/**
 * Start a server: the one `choose` picks, and if that is an installed version that exits before it is ready (an
 * `early` failure), the next one, at once. Succeeds with its token and the choice.
 *
 * A failed version is blamed (saved with `saveBad`) only once another server has come up, which shows the failure was
 * its own. `failed` is cleared without saving when it can't be told whose the failure was:
 *   - no server is left to try (`choose` fails), or the bundled or an override server fails too: every server fails
 *     the same way, a wrong host say;
 *   - something answers on the port after a failure (`portTaken`): another launch's server took it;
 *   - the app is quitting (`stopping`);
 *   - the server couldn't back up the database (`backup`): the next would need the backup too.
 *
 * A timeout keeps `failed`, as that server is only slow, which is not held against it: if it exits, the caller adds it
 * and starts again; if it comes up, the failures are saved then (`lateReady`).
 */
export const startWithFallback = Effect.fn("startWithFallback")(function* <C extends Choice, R>(options: FallbackOptions<C, R>) {
  const forget = Ref.set(options.failed, [])
  const save = Effect.gen(function* () {
    const versions = yield* Ref.getAndSet(options.failed, [])
    yield* Effect.forEach(versions, options.saveBad, { concurrency: 1, discard: true })
  })
  const saveUnlessStopping = Effect.gen(function* () {
    if (!(yield* options.stopping)) yield* save
  })
  for (;;) {
    const skip = yield* Ref.get(options.failed)
    const choice = yield* options.choose(skip).pipe(Effect.tapError(() => forget))
    const result = yield* Effect.result(options.start(choice, saveUnlessStopping))
    if (result._tag === "Success") {
      yield* save
      return { token: result.success, choice }
    }
    const error = result.failure
    if (!error.early) return yield* error
    if (choice.version === null || error.backup !== null || (yield* options.stopping) || (yield* options.portTaken)) {
      yield* forget
      return yield* error
    }
    const version = choice.version
    yield* Ref.update(options.failed, (failed) => (failed.includes(version) ? failed : [...failed, version]))
  }
})
