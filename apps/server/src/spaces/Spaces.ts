import { Clock, Context, DateTime, Effect, Fiber, FiberMap, FileSystem, Layer, Option, Redacted, Ref, Schedule } from "effect"
import { SecureRandom } from "effect/crypto"
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http"
import { Invalid, NotFound, Timestamp, Unavailable } from "@huntaway/contracts"
import type { AgentConfigId, NewSpace, Space, SpacesStatus, SpaceView } from "@huntaway/contracts"
import { apiEnv, configDir } from "../agents/configEnv.ts"
import { nowTimestamp } from "../platform/columns.ts"
import { Identity } from "../platform/Identity.ts"
import { ServerConfig } from "../platform/ServerConfig.ts"
import { AgentConfigRepo } from "../profiles/AgentConfigRepo.ts"
import { CLAUDE_STATE, claudeFiles, codexFiles } from "./agentFiles.ts"
import type { HomeFile } from "./agentFiles.ts"
import { Docker } from "./Docker.ts"
import { DESKTOP_USER, dockerfile, imageTag, isSpaceId, NAME_PREFIX, nameProblem, portOf, runArgs, tokenOf, toSpace } from "./containers.ts"
import type { Inspected } from "./containers.ts"
import { CREATE_VIEWER_TICKET, headerStatus, parseViewerTicket, POLICY_ALLOW_ACTIVATION, POLICY_VIEW_ONLY, viewerTicketRequest } from "./spacesd.ts"

// Spaces (HE-35; docs/plan/06-server.md, Spaces): Linux desktops in Docker, after Cua Spaces. Each is a container of
// Huntaway's image (Cua's, which runs spacesd and Cua Driver on an XFCE desktop, with Claude Code and Codex added),
// labelled as this host's. Making one pulls and builds the image when it isn't there, starts the container, waits for
// spacesd and copies the chosen configs' sign-ins in: that runs in the background, and the Space shows as `preparing`
// meanwhile (kept here, as the container may not exist yet) and as `failed`, with why, if it fails.
//
// The board sees a Space's desktop in spacesd's own viewer. `view` asks spacesd for a viewer ticket (which only
// authorises a viewer's calls, and is never sent to a server: it goes in the URL's fragment) and gives a relay ticket
// for this server's `/api/spaces/v/<ticket>/` (http/spaces.ts), which passes the viewer's requests and its media
// WebSocket to the container. spacesd's own token stays here.

/** How long a viewer's tickets last. */
const VIEW_SECONDS = 3600
/** How long spacesd has to answer its health check once the container starts. */
const HEALTHY_TRIES = 120

/** What the relay route reaches for a ticket. */
export interface RelayTarget {
  readonly id: string
  readonly port: number
}

export interface SpacesShape {
  readonly status: Effect.Effect<SpacesStatus>
  readonly create: (input: NewSpace) => Effect.Effect<Space, Invalid | NotFound | Unavailable>
  readonly start: (id: string) => Effect.Effect<Space, NotFound | Unavailable>
  readonly stop: (id: string) => Effect.Effect<Space, NotFound | Unavailable>
  readonly remove: (id: string) => Effect.Effect<void, NotFound | Unavailable>
  /** Copy its configs' sign-ins in again. */
  readonly syncAgents: (id: string) => Effect.Effect<Space, NotFound | Unavailable>
  readonly view: (id: string, interactive: boolean) => Effect.Effect<SpaceView, NotFound | Unavailable>
  /** Waits for what is being done to the Space in the background (making or starting it) to end; the Space then. */
  readonly settled: (id: string) => Effect.Effect<Space, NotFound | Unavailable>
  /** The Space a relay ticket opens, while it lasts. */
  readonly relayTarget: (ticket: string) => Effect.Effect<RelayTarget | null>
}

/** What answers on a Space's port is the Space's to choose: the server never follows it somewhere else. */
const NO_REDIRECTS: RequestInit = { redirect: "error" }

const unavailable = (reason: string) => new Unavailable({ what: "spaces", reason })
const dockerFailed = (e: { readonly reason: string }) => unavailable(e.reason)

/** The Space a container of ours is. */
const spaceOf = (c: Inspected, detail: string | null) => {
  const s = toSpace(c, detail)
  return s === null ? Effect.die(`not a Space: ${c.Name}`) : Effect.succeed(s)
}

/** `space` with some of its fields changed. */
const changed = (space: Space, patch: Partial<Space>): Space => Object.assign({}, space, patch)

export class Spaces extends Context.Service<Spaces, SpacesShape>()("huntaway-server/spaces/Spaces") {
  static readonly layer = Layer.effect(
    Spaces,
    Effect.gen(function* () {
      const docker = yield* Docker
      const config = yield* ServerConfig
      const identity = yield* Identity
      const configs = yield* AgentConfigRepo
      const fs = yield* FileSystem.FileSystem
      const http = yield* HttpClient.HttpClient
      const random = yield* SecureRandom.SecureRandom
      const hostId = identity.hostId
      const base = config.spacesImage
      const image = imageTag(base)
      /** Spaces being made or started, or that failed to be, by id: shown over what Docker says of them. */
      const pending = yield* Ref.make<ReadonlyMap<string, Space>>(new Map())
      const work = yield* FiberMap.make<string>()
      const relays = yield* Ref.make<ReadonlyMap<string, RelayTarget & { readonly expires: number }>>(new Map())

      const hex = (bytes: number) => Effect.map(random.randomBytes(bytes), (b) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join(""))
      const setPending = (space: Space | null, id: string) =>
        Ref.update(pending, (m) => {
          const next = new Map(m)
          if (space === null) next.delete(id)
          else next.set(id, space)
          return next
        })

      const ready = Effect.gen(function* () {
        const v = yield* docker.version
        if ("reason" in v) return yield* unavailable(`Docker isn't available: ${v.reason}`)
        return yield* Effect.void
      })

      /** The Space's container, running or not; NotFound if it has none and isn't being made. */
      const container = Effect.fnUntraced(function* (id: string) {
        if (!isSpaceId(id)) return yield* new NotFound({ what: "space", id })
        const c = yield* docker.inspect(`${NAME_PREFIX}${id}`).pipe(Effect.mapError(dockerFailed))
        if (c === null) return yield* new NotFound({ what: "space", id })
        return c
      })

      const list = Effect.gen(function* () {
        const listed = yield* docker.list(hostId).pipe(Effect.orElseSucceed(() => []))
        const fromDocker = listed.flatMap((l) => {
          const s = toSpace(l.container, l.status)
          return s === null ? [] : [s]
        })
        const held = yield* Ref.get(pending)
        const ids = new Set(fromDocker.map((s) => s.id))
        return [...fromDocker.map((s) => held.get(s.id) ?? s), ...[...held.values()].filter((s) => !ids.has(s.id))].toSorted((a, b) =>
          a.created_at.localeCompare(b.created_at),
        )
      })

      const status = Effect.gen(function* () {
        const v = yield* docker.version
        const out: SpacesStatus = {
          docker: "reason" in v ? { available: false, version: null, reason: v.reason } : { available: true, version: v.version, reason: null },
          base_image: base,
          spaces: "reason" in v ? [] : yield* list,
        }
        return out
      }).pipe(Effect.withSpan("Spaces.status"))

      /** A config the Space is given, checked to be the agent's. */
      const configFor = Effect.fnUntraced(function* (id: AgentConfigId | null | undefined, agent: "claude" | "codex", field: string) {
        if (id === null || id === undefined) return null
        const cfg = Option.getOrNull(yield* configs.get(id))
        if (cfg === null) return yield* new NotFound({ what: "agent config", id })
        if (cfg.agent !== agent) return yield* new Invalid({ field, reason: `${cfg.name} is a ${cfg.agent === "codex" ? "Codex" : "Claude Code"} config` })
        return cfg
      })

      const readText = (path: string) => fs.readFileString(path).pipe(Effect.orElseSucceed(() => null))

      /** The files a Space's configs give it. A proxy on the host's loopback is reached through Docker's host gateway. */
      const homeFiles = Effect.fnUntraced(function* (claudeId: AgentConfigId | null, codexId: AgentConfigId | null) {
        const out: Array<HomeFile> = []
        const claude = claudeId === null ? null : Option.getOrNull(yield* configs.get(claudeId))
        if (claude !== null) {
          const dir = configDir(claude, config.home)
          const key = claude.api_url === null ? null : (yield* configs.keys(claude.id)).api_key
          const proxyEnv = apiEnv(claude, key === null ? null : Redacted.value(key)).map(
            ([k, v]) => [k, k === "ANTHROPIC_BASE_URL" ? v.replace(/\/\/(127\.0\.0\.1|localhost)(?=[:/]|$)/u, "//host.docker.internal") : v] as const,
          )
          out.push(
            ...claudeFiles({
              credentials: yield* readText(`${dir}/.credentials.json`),
              settings: yield* readText(`${dir}/settings.json`),
              memory: yield* readText(`${dir}/CLAUDE.md`),
              proxyEnv,
            }),
          )
        }
        const codex = codexId === null ? null : Option.getOrNull(yield* configs.get(codexId))
        if (codex !== null) {
          const dir = configDir(codex, config.home)
          out.push(...codexFiles({ auth: yield* readText(`${dir}/auth.json`), config: yield* readText(`${dir}/config.toml`) }))
        }
        return out
      })

      /** Write `files` in the desktop user's home in the container (`onlyNew`: unless it is there already). */
      const writeHome = Effect.fnUntraced(function* (name: string, files: ReadonlyArray<HomeFile>, onlyNew = false) {
        for (const f of files) {
          const script = `set -e; h=$(getent passwd "$(id -un)" | cut -d: -f6); f="\${h:-$HOME}/$1"; ${onlyNew ? '[ -e "$f" ] && exit 0; ' : ""}mkdir -p "$(dirname "$f")"; ${f.secret ? "umask 077; " : ""}cat > "$f.tmp"; mv "$f.tmp" "$f"`
          const r = yield* docker.exec(name, DESKTOP_USER, ["sh", "-c", script, "sh", f.path], { stdin: f.contents }).pipe(Effect.mapError(dockerFailed))
          if (r.code !== 0) return yield* unavailable(`couldn't write ~/${f.path} in the Space: ${r.stderr.trim().slice(0, 200)}`)
        }
        return yield* Effect.void
      })

      const copyAgents = Effect.fnUntraced(function* (space: Space) {
        const name = `${NAME_PREFIX}${space.id}`
        yield* writeHome(name, yield* homeFiles(space.claude_config_id, space.codex_config_id))
        if (space.claude_config_id !== null) yield* writeHome(name, [{ path: ".claude.json", contents: CLAUDE_STATE, secret: false }], true)
      })

      /** Waits for the container's spacesd to answer its health check; its port. */
      const healthy = Effect.fnUntraced(function* (id: string) {
        const check = Effect.gen(function* () {
          const c = yield* container(id)
          if (c.State.Status !== "running") return yield* unavailable(`the container is ${c.State.Status}`)
          const port = portOf(c)
          if (port === null) return yield* unavailable("spacesd's port isn't published")
          const r = yield* http.execute(HttpClientRequest.get(`http://127.0.0.1:${port}/health`)).pipe(
            Effect.mapError(() => unavailable("spacesd isn't answering")),
            Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECTS),
          )
          if (r.status !== 204 && r.status !== 200) return yield* unavailable(`spacesd answered its health check with ${r.status}`)
          return port
        })
        return yield* check.pipe(Effect.retry({ schedule: Schedule.spaced("1 second"), times: HEALTHY_TRIES }))
      })

      /** Run `body` for the Space in the background, showing it as preparing (`detail`) until it's done, failed if it fails. */
      const inBackground = (space: Space, body: (step: (detail: string) => Effect.Effect<void>) => Effect.Effect<void, NotFound | Unavailable>) =>
        Effect.gen(function* () {
          const step = (detail: string) => setPending(changed(space, { state: "preparing", detail }), space.id)
          yield* step("Starting")
          const run = body(step).pipe(
            Effect.andThen(setPending(null, space.id)),
            Effect.catch((e) =>
              Effect.andThen(
                Effect.logWarning(`space ${space.id}: ${e._tag === "NotFound" ? "its container went" : e.reason}`),
                setPending(changed(space, { state: "failed", detail: e._tag === "NotFound" ? "Its container went." : e.reason }), space.id),
              ),
            ),
            Effect.annotateLogs({ module: "spaces" }),
          )
          yield* FiberMap.run(work, space.id, run)
        })

      const create = Effect.fn("Spaces.create")(function* (input: NewSpace) {
        const problem = nameProblem(input.name)
        if (problem !== null) return yield* new Invalid({ field: "name", reason: problem })
        const claude = yield* configFor(input.claude_config_id, "claude", "claude_config_id")
        const codex = yield* configFor(input.codex_config_id, "codex", "codex_config_id")
        yield* ready
        const id = (yield* hex(5)).toLowerCase()
        const space: Space = {
          id,
          name: input.name.trim(),
          image,
          state: "preparing",
          detail: "Starting",
          direct: input.direct === true,
          claude_config_id: claude?.id ?? null,
          codex_config_id: codex?.id ?? null,
          created_at: yield* nowTimestamp,
        }
        const token = yield* hex(24)
        yield* inBackground(space, (step) =>
          Effect.gen(function* () {
            if (!(yield* docker.imageExists(image))) {
              if (!(yield* docker.imageExists(base))) {
                yield* step(`Pulling ${base}`)
                yield* docker.pull(base)
              }
              yield* step("Building Huntaway's image (Claude Code and Codex)")
              yield* docker.build(image, dockerfile(base))
            }
            yield* step("Starting the container")
            yield* docker.run(
              runArgs({
                id,
                name: space.name,
                image,
                hostId,
                token,
                direct: space.direct,
                claude: space.claude_config_id,
                codex: space.codex_config_id,
                createdAt: space.created_at,
              }),
            )
            yield* step("Waiting for its desktop")
            yield* healthy(id)
            yield* step("Copying sign-ins")
            yield* copyAgents(space)
          }).pipe(Effect.mapError((e) => (e._tag === "DockerError" ? dockerFailed(e) : e))),
        )
        return space
      })

      const start = Effect.fn("Spaces.start")(function* (id: string) {
        const c = yield* container(id)
        const space = yield* spaceOf(c, null)
        // A running Space is started again only if getting it ready failed (its sign-ins weren't copied, say).
        const held = (yield* Ref.get(pending)).get(id)
        if (c.State.Status === "running" && held?.state !== "failed") return held ?? space
        if (c.State.Status !== "running") yield* docker.start(c.Name.replace(/^\//u, "")).pipe(Effect.mapError(dockerFailed))
        yield* inBackground(space, (step) =>
          Effect.gen(function* () {
            yield* step("Waiting for its desktop")
            yield* healthy(id)
            yield* step("Copying sign-ins")
            yield* copyAgents(space)
          }),
        )
        return changed(space, { state: "preparing", detail: "Starting" })
      })

      const stop = Effect.fn("Spaces.stop")(function* (id: string) {
        const c = yield* container(id)
        yield* FiberMap.remove(work, id)
        yield* setPending(null, id)
        yield* docker.stop(c.Name.replace(/^\//u, "")).pipe(Effect.mapError(dockerFailed))
        return yield* spaceOf(yield* container(id), null)
      })

      const remove = Effect.fn("Spaces.remove")(function* (id: string) {
        if (!isSpaceId(id)) return yield* new NotFound({ what: "space", id })
        const held = (yield* Ref.get(pending)).has(id)
        yield* FiberMap.remove(work, id)
        yield* setPending(null, id)
        yield* Ref.update(relays, (m) => new Map([...m].filter(([, r]) => r.id !== id)))
        const c = yield* docker.inspect(`${NAME_PREFIX}${id}`).pipe(Effect.mapError(dockerFailed))
        if (c === null) return held ? undefined : yield* new NotFound({ what: "space", id })
        return yield* docker.remove(c.Name.replace(/^\//u, "")).pipe(Effect.mapError(dockerFailed))
      })

      const running = Effect.fnUntraced(function* (id: string) {
        const c = yield* container(id)
        if (c.State.Status !== "running") return yield* unavailable("The Space isn't running.")
        return c
      })

      const syncAgents = Effect.fn("Spaces.syncAgents")(function* (id: string) {
        const c = yield* running(id)
        const space = yield* spaceOf(c, null)
        yield* copyAgents(space)
        // Its sign-ins are in now, whatever failed before.
        if ((yield* Ref.get(pending)).get(id)?.state === "failed") yield* setPending(null, id)
        return space
      })

      const view = Effect.fn("Spaces.view")(function* (id: string, interactive: boolean) {
        const c = yield* running(id)
        const port = portOf(c)
        const token = tokenOf(c)
        if (port === null || token === null) return yield* unavailable("The Space's spacesd isn't reachable.")
        const request = HttpClientRequest.post(`http://127.0.0.1:${port}${CREATE_VIEWER_TICKET}`).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${token}`, "x-grpc-web": "1", accept: "application/grpc-web+proto" }),
          HttpClientRequest.bodyUint8Array(
            viewerTicketRequest({
              ttlSeconds: VIEW_SECONDS,
              policy: interactive ? POLICY_ALLOW_ACTIVATION : POLICY_VIEW_ONLY,
              clipboard: interactive,
              filesRoot: interactive ? "~" : "",
            }),
            "application/grpc-web+proto",
          ),
        )
        const answer = yield* http.execute(request).pipe(
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECTS),
          Effect.flatMap((r) =>
            Effect.map(r.arrayBuffer, (body) => {
              const refused = headerStatus(r.headers)
              if (refused !== null) return refused
              return r.status === 200 ? parseViewerTicket(new Uint8Array(body)) : `spacesd answered ${r.status}`
            }),
          ),
          Effect.mapError(() => unavailable("spacesd isn't answering")),
        )
        if (typeof answer === "string") return yield* unavailable(answer)
        const relay = yield* hex(24)
        const now = yield* Clock.currentTimeMillis
        const expires = now + VIEW_SECONDS * 1000
        yield* Ref.update(relays, (m) => new Map([...[...m].filter(([, r]) => r.expires > now), [relay, { id, port, expires }]]))
        const out: SpaceView = {
          relay_path: `/api/spaces/v/${relay}/viewer/`,
          direct_port: (yield* spaceOf(c, null)).direct ? port : null,
          fragment: `#ticket=${encodeURIComponent(answer.ticket)}`,
          expires_at: Timestamp.make(DateTime.formatIso(DateTime.makeUnsafe(expires))),
        }
        return out
      })

      const settled = Effect.fn("Spaces.settled")(function* (id: string) {
        const fiber = yield* FiberMap.get(work, id)
        if (Option.isSome(fiber)) yield* Fiber.await(fiber.value)
        const held = (yield* Ref.get(pending)).get(id)
        return held ?? (yield* spaceOf(yield* container(id), null))
      })

      const relayTarget = (ticket: string) =>
        Effect.gen(function* () {
          const now = yield* Clock.currentTimeMillis
          const r = (yield* Ref.get(relays)).get(ticket)
          return r === undefined || r.expires <= now ? null : { id: r.id, port: r.port }
        })

      return Spaces.of({ status, create, start, stop, remove, syncAgents, view, settled, relayTarget })
    }),
  )
}
