import { Context, Effect, Layer, Schema } from "effect"
import type { Duration } from "effect"
import { Proc } from "../platform/Proc.ts"
import type { ProcResult } from "../platform/Proc.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { LABEL, parseInspect, parseStatusLines } from "./containers.ts"
import type { Inspected } from "./containers.ts"

// The Docker CLI, for Spaces (HE-35): the server's `HUNTAWAY_DOCKER` (else `docker` on PATH), run through `Proc`. Only
// what Spaces need of it. Tests replace the whole service with a layer of their own.

/** Docker failed, or isn't there: its reason is what the board shows. */
export class DockerError extends Schema.TaggedError<DockerError, { readonly brand: unique symbol }>()("DockerError", { reason: Schema.String }) {}

/** A container with its status line ("Up 3 minutes"). */
export interface Listed {
  readonly container: Inspected
  readonly status: string | null
}

export interface DockerShape {
  /** The engine's version, or why it can't be reached. */
  readonly version: Effect.Effect<{ readonly version: string } | { readonly reason: string }>
  /** The containers labelled as this host's Spaces. */
  readonly list: (hostId: string) => Effect.Effect<ReadonlyArray<Listed>, DockerError>
  /** One container, or null if there's none of that name. */
  readonly inspect: (name: string) => Effect.Effect<Inspected | null, DockerError>
  readonly imageExists: (ref: string) => Effect.Effect<boolean, DockerError>
  readonly pull: (ref: string) => Effect.Effect<void, DockerError>
  /** Build `tag` from a Dockerfile given as text (no context). */
  readonly build: (tag: string, dockerfile: string) => Effect.Effect<void, DockerError>
  /** `docker run` with these arguments; the new container's id. */
  readonly run: (args: ReadonlyArray<string>) => Effect.Effect<string, DockerError>
  readonly start: (name: string) => Effect.Effect<void, DockerError>
  readonly stop: (name: string) => Effect.Effect<void, DockerError>
  /** Remove it, running or not, with its anonymous volumes. */
  readonly remove: (name: string) => Effect.Effect<void, DockerError>
  /** Run `argv` in it as `user`, with `stdin`; its exit code and output (a non-zero exit is a result). */
  readonly exec: (
    name: string,
    user: string,
    argv: ReadonlyArray<string>,
    options?: { readonly stdin?: string; readonly timeout?: Duration.Input },
  ) => Effect.Effect<ProcResult, DockerError>
}

/** The last lines of what a failed command said. */
const said = (r: ProcResult) => {
  const out = (r.stderr.trim() === "" ? r.stdout : r.stderr).trim()
  return out.split("\n").slice(-3).join(" / ").slice(0, 400)
}

export class Docker extends Context.Service<Docker, DockerShape>()("huntaway-server/spaces/Docker") {
  static readonly layer = Layer.effect(
    Docker,
    Effect.gen(function* () {
      const proc = yield* Proc
      const config = yield* ServerConfig
      const bin = config.dockerBin

      const docker = (args: ReadonlyArray<string>, options: { readonly timeout?: Duration.Input; readonly stdin?: string } = {}) =>
        proc
          .run(bin, args, { timeout: options.timeout ?? "60 seconds", ...(options.stdin === undefined ? {} : { stdin: options.stdin }) })
          .pipe(Effect.mapError((e) => new DockerError({ reason: `docker ${args[0] ?? ""}: ${e.reason}` })))

      /** Run it and fail with what it said unless it exits 0. */
      const ok = (args: ReadonlyArray<string>, options: { readonly timeout?: Duration.Input; readonly stdin?: string } = {}) =>
        docker(args, options).pipe(
          Effect.filterOrFail(
            (r) => r.code === 0,
            (r) => new DockerError({ reason: `docker ${args[0] ?? ""}: ${said(r)}` }),
          ),
        )

      const version = docker(["version", "--format", "{{.Server.Version}}"], { timeout: "15 seconds" }).pipe(
        Effect.map((r) => (r.code === 0 && r.stdout.trim() !== "" ? { version: r.stdout.trim() } : { reason: said(r) || "Docker isn't running" })),
        Effect.catch((e) => Effect.succeed({ reason: e.reason })),
      )

      const inspectAll = (names: ReadonlyArray<string>) =>
        names.length === 0 ? Effect.succeed([]) : Effect.map(docker(["inspect", ...names]), (r) => parseInspect(r.stdout))

      const list = Effect.fn("Docker.list")(function* (hostId: string) {
        const r = yield* ok(["ps", "--all", "--no-trunc", "--filter", `label=${LABEL.host}=${hostId}`, "--format", "{{.Names}}\t{{.Status}}"])
        const statuses = parseStatusLines(r.stdout)
        const found = yield* inspectAll([...statuses.keys()])
        return found.map((container): Listed => ({ container, status: statuses.get(container.Name.replace(/^\//u, "")) ?? null }))
      })

      return Docker.of({
        version,
        list,
        inspect: (name) => Effect.map(inspectAll([name]), (found) => found[0] ?? null),
        imageExists: (ref) => Effect.map(docker(["image", "inspect", "--format", "{{.Id}}", ref]), (r) => r.code === 0),
        pull: (ref) => Effect.asVoid(ok(["pull", "--quiet", ref], { timeout: "60 minutes" })),
        build: (tag, dockerfile) => Effect.asVoid(ok(["build", "--quiet", "--tag", tag, "-"], { stdin: dockerfile, timeout: "30 minutes" })),
        run: (args) => Effect.map(ok(args, { timeout: "2 minutes" }), (r) => r.stdout.trim()),
        start: (name) => Effect.asVoid(ok(["start", name])),
        stop: (name) => Effect.asVoid(ok(["stop", "--time", "10", name], { timeout: "45 seconds" })),
        remove: (name) => Effect.asVoid(ok(["rm", "--force", "--volumes", name])),
        exec: (name, user, argv, options = {}) =>
          docker(["exec", ...(options.stdin === undefined ? [] : ["--interactive"]), "--user", user, name, ...argv], {
            timeout: options.timeout ?? "60 seconds",
            ...(options.stdin === undefined ? {} : { stdin: options.stdin }),
          }),
      })
    }),
  )
}
