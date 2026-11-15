import { Option, Schema } from "effect"
import { AgentConfigId, Timestamp } from "@huntaway/contracts"
import type { Space, SpaceState } from "@huntaway/contracts"

// Spaces' plain parts (HE-35): the containers' names and labels, the `docker run` that makes one, the image Huntaway
// builds on Cua's, and a Space as `docker inspect` describes it. No I/O here.
//
// A Space is a container named `huntaway-space-<id>`, labelled with the host it belongs to (so test servers and other
// data folders on the same Docker never see each other's), its name, the configs it was given and when it was made.
// The container is the record: there is no table, and a Space deleted with `docker rm` is gone from the board too.

/** Bumped when `dockerfile` changes, so hosts build the new image. */
export const IMAGE_REVISION = 2

/** The user the desktop runs as in Cua's image, whose home the sign-ins go in. */
export const DESKTOP_USER = "cua"

/** spacesd's port in the container: gRPC, gRPC-Web, the viewer and the media WebSocket. */
export const SPACESD_PORT = 3211

export const NAME_PREFIX = "huntaway-space-"

export const LABEL = {
  host: "huntaway.host",
  name: "huntaway.space",
  claude: "huntaway.claude-config",
  codex: "huntaway.codex-config",
  direct: "huntaway.direct",
  created: "huntaway.created",
} as const

/** Huntaway's image on `base`: Cua's, with Claude Code and Codex. */
export const dockerfile = (base: string): string =>
  [
    `FROM ${base}`,
    "USER root",
    // npm's global bin folder in Cua's image isn't on PATH: the two are linked into one that is.
    'RUN npm install -g @anthropic-ai/claude-code @openai/codex && npm cache clean --force && ln -sf "$(npm prefix -g)/bin/claude" "$(npm prefix -g)/bin/codex" /usr/local/bin/',
    `LABEL huntaway.space-image="${IMAGE_REVISION}"`,
    "",
  ].join("\n")

/** The tag of Huntaway's image on `base`. */
export const imageTag = (base: string): string =>
  `huntaway-space:${IMAGE_REVISION}-${base.replace(/[^A-Za-z0-9_.-]+/gu, "_").replace(/^[._-]+/u, "")}`.slice(0, 128)

/** A name a Space may have: what the board shows, so anything printable up to 60 characters. */
export const nameProblem = (name: string): string | null => {
  const n = name.trim()
  if (n === "") return "a Space needs a name"
  if (n.length > 60) return "at most 60 characters"
  return Array.from({ length: n.length }, (_, i) => n.charCodeAt(i)).some((c) => c < 32) ? "no control characters" : null
}

/** An id as `spaces.*` take it: lowercase letters and digits, as the server makes them. */
export const isSpaceId = (id: string): boolean => /^[a-z0-9]{4,32}$/u.test(id)

export interface RunSpec {
  readonly id: string
  readonly name: string
  readonly image: string
  readonly hostId: string
  /** spacesd's token, which the container is given in its environment. */
  readonly token: string
  readonly direct: boolean
  readonly claude: AgentConfigId | null
  readonly codex: AgentConfigId | null
  readonly createdAt: string
}

/**
 * `docker run`'s arguments for a Space. spacesd's port is published on a port Docker picks, on 127.0.0.1 unless
 * `direct`. Its token is what lets the host's server (and nobody else) drive it. Shared memory is raised for the
 * browsers in it, as Cua's own instructions do.
 */
export const runArgs = (s: RunSpec): ReadonlyArray<string> => [
  "run",
  "--detach",
  "--name",
  `${NAME_PREFIX}${s.id}`,
  "--hostname",
  `space-${s.id}`,
  "--shm-size=1g",
  "--restart=unless-stopped",
  // A proxy on the host's loopback is reached as host.docker.internal (`Spaces` rewrites its address).
  "--add-host=host.docker.internal:host-gateway",
  "--env",
  `CUA_ENV_TOKEN=${s.token}`,
  "--publish",
  `${s.direct ? "" : "127.0.0.1:"}:${SPACESD_PORT}`,
  "--label",
  `${LABEL.host}=${s.hostId}`,
  "--label",
  `${LABEL.name}=${s.name.trim()}`,
  "--label",
  `${LABEL.direct}=${s.direct ? "1" : "0"}`,
  "--label",
  `${LABEL.created}=${s.createdAt}`,
  ...(s.claude === null ? [] : ["--label", `${LABEL.claude}=${s.claude}`]),
  ...(s.codex === null ? [] : ["--label", `${LABEL.codex}=${s.codex}`]),
  s.image,
]

const PortBinding = Schema.Struct({ HostIp: Schema.optional(Schema.String), HostPort: Schema.optional(Schema.String) })

/** What is read of one container in `docker inspect`'s output. */
export const Inspected = Schema.Struct({
  Name: Schema.String,
  Created: Schema.optional(Schema.String),
  State: Schema.Struct({
    Status: Schema.String,
    Running: Schema.optional(Schema.Boolean),
    StartedAt: Schema.optional(Schema.String),
    Error: Schema.optional(Schema.String),
  }),
  Config: Schema.Struct({
    Image: Schema.String,
    Env: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
    Labels: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.String))),
  }),
  NetworkSettings: Schema.optional(
    Schema.Struct({ Ports: Schema.optional(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(Schema.Array(PortBinding))))) }),
  ),
})
export type Inspected = typeof Inspected.Type

const decodeInspect = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Inspected)))

/** `docker inspect`'s output, the containers it could read. */
export const parseInspect = (stdout: string): ReadonlyArray<Inspected> => Option.getOrElse(decodeInspect(stdout.trim() === "" ? "[]" : stdout), () => [])

/** The id of a Space's container, from its name; null for a container that isn't one. */
export const spaceIdOf = (c: Inspected): string | null => {
  const name = c.Name.replace(/^\//u, "")
  return name.startsWith(NAME_PREFIX) ? name.slice(NAME_PREFIX.length) : null
}

const labelOf = (c: Inspected, key: string): string | null => c.Config.Labels?.[key] ?? null

/** spacesd's token, from the container's environment. */
export const tokenOf = (c: Inspected): string | null => {
  const e = (c.Config.Env ?? []).find((v) => v.startsWith("CUA_ENV_TOKEN="))
  return e === undefined ? null : e.slice("CUA_ENV_TOKEN=".length)
}

/** The host port spacesd is published on, while the container runs. */
export const portOf = (c: Inspected): number | null => {
  const bindings = c.NetworkSettings?.Ports?.[`${SPACESD_PORT}/tcp`] ?? null
  const port = Number(bindings?.find((b) => b.HostPort !== undefined && b.HostPort !== "")?.HostPort ?? Number.NaN)
  return Number.isInteger(port) && port > 0 ? port : null
}

/** Docker's state as a Space's. A container that was made but never ran, or is restarting, is still being prepared. */
const stateOf = (status: string): SpaceState => {
  switch (status) {
    case "running":
      return "running"
    case "created":
    case "restarting":
      return "preparing"
    case "dead":
      return "failed"
    default:
      return "stopped"
  }
}

/** A Space as its container says, with `detail` (Docker's own status line) when there is one. */
export const toSpace = (c: Inspected, detail: string | null): Space | null => {
  const id = spaceIdOf(c)
  if (id === null) return null
  const state = stateOf(c.State.Status)
  const error = c.State.Error !== undefined && c.State.Error !== "" ? c.State.Error : null
  return {
    id,
    name: labelOf(c, LABEL.name) ?? id,
    image: c.Config.Image,
    state,
    detail: error ?? detail,
    direct: labelOf(c, LABEL.direct) === "1",
    claude_config_id: asConfig(labelOf(c, LABEL.claude)),
    codex_config_id: asConfig(labelOf(c, LABEL.codex)),
    created_at: Timestamp.make(labelOf(c, LABEL.created) ?? c.Created ?? ""),
  }
}

const asConfig = (v: string | null): AgentConfigId | null => (v === null || v === "" ? null : AgentConfigId.make(v))

/** `docker ps --format '{{.Names}}\t{{.Status}}'`'s lines: each container's name and its status line ("Up 3 minutes"). */
export const parseStatusLines = (stdout: string): ReadonlyMap<string, string> =>
  new Map(
    stdout
      .split("\n")
      .map((l) => l.split("\t"))
      .flatMap(([name, status]) => (name === undefined || name === "" || status === undefined ? [] : [[name, status] as const])),
  )
