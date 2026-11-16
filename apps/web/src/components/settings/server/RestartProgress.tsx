import type { RestartState } from "@huntaway/client"
import { clsx } from "clsx"
import { Check } from "lucide-react"
import { useEffect, useState } from "react"
import { mb } from "./parts"

// How far a restart of this host has got (HE-44): its steps (downloading, checking, installing, building, restarting,
// waiting for the server), a bar across them that fills where a step's share is known (a download's bytes, the new
// server's backup and migrations as the desktop app relays them) and moves otherwise, and what to do meanwhile.

/** What kind of restart it is, which says its steps. */
export type RestartKind = "release" | "update" | "rebuild" | "restart"

/** A step of the new server's start, as the desktop app relays it (its preload's `onServerProgress`). */
export interface ServerStartStep {
  readonly step: string
  readonly detail: string | null
  readonly share: number | null
}

interface Step {
  /** The job's phase it stands for; `waiting` is the part of `restarting` after the server has gone down. */
  readonly key: string
  readonly label: string
}

const RESTART: ReadonlyArray<Step> = [
  { key: "restarting", label: "Stop" },
  { key: "waiting", label: "Start again" },
]

const stepsOf = (kind: RestartKind): ReadonlyArray<Step> =>
  kind === "release"
    ? [{ key: "downloading", label: "Download" }, { key: "verifying", label: "Check" }, { key: "installing", label: "Install" }, ...RESTART]
    : kind === "update"
      ? [{ key: "starting", label: "Fetch" }, { key: "building_ui", label: "Build the UI" }, { key: "building_server", label: "Build the server" }, ...RESTART]
      : kind === "rebuild"
        ? [{ key: "building_ui", label: "Build the UI" }, { key: "building_server", label: "Build the server" }, ...RESTART]
        : RESTART

const stepFrom = (u: unknown): ServerStartStep | null => {
  if (typeof u !== "object" || u === null) return null
  const step: unknown = Reflect.get(u, "step")
  const detail: unknown = Reflect.get(u, "detail")
  const share: unknown = Reflect.get(u, "share")
  if (typeof step !== "string") return null
  return { step, detail: typeof detail === "string" ? detail : null, share: typeof share === "number" && Number.isFinite(share) ? share : null }
}

/**
 * While `active`, each step of the server's start that the desktop app relays (a server it started, starting again in
 * place); null in a browser, and until the first.
 */
export function useServerStartProgress(active: boolean): ServerStartStep | null {
  const [step, setStep] = useState<ServerStartStep | null>(null)
  useEffect(() => {
    if (!active) return undefined
    const bridge: unknown = Reflect.get(window, "huntawayDesktop")
    const on: unknown = typeof bridge === "object" && bridge !== null ? Reflect.get(bridge, "onServerProgress") : undefined
    if (typeof on !== "function") return undefined
    const stop: unknown = Reflect.apply(on, bridge, [(p: unknown) => setStep(stepFrom(p))])
    return () => {
      if (typeof stop === "function") Reflect.apply(stop, undefined, [])
    }
  }, [active])
  return active ? step : null
}

/** The step now, said in full: what, more about it, and its share when known. */
function describe(
  key: string,
  kind: RestartKind,
  job: RestartState,
  version: string | null,
  server: ServerStartStep | null,
  back: boolean,
): { what: string; detail: string | null; share: number | null } {
  const v = version ? `v${version}` : "the release"
  const download = job.download ?? null
  switch (key) {
    case "starting":
      return { what: kind === "update" ? "Fetching the update…" : "Starting…", detail: null, share: null }
    case "downloading":
      return {
        what: `Downloading ${v}…`,
        detail: download ? `${mb(download.bytes)}${download.total ? ` of ${mb(download.total)}` : ""}` : null,
        share: download?.total ? Math.min(1, download.bytes / download.total) : null,
      }
    case "verifying":
      return { what: "Checking the download…", detail: "Its sha256, and what it holds", share: null }
    case "installing":
      return { what: `Installing ${v}…`, detail: "Unpacking it, and checking that it runs", share: null }
    case "building_ui":
      return { what: "Building the UI…", detail: null, share: null }
    case "building_server":
      return { what: "Building the server…", detail: null, share: null }
    case "restarting":
      return { what: "Stopping the server…", detail: "Agents keep running, and the new server picks them back up.", share: null }
    default:
      if (back) return { what: "The server is back. Reloading the board…", detail: null, share: 1 }
      if (server) return { what: `${server.step}…`, detail: server.detail, share: server.share }
      return { what: kind === "release" ? `Starting ${v}…` : "Waiting for the server to come back…", detail: null, share: null }
  }
}

/**
 * A running restart's progress. `down`: the server doesn't answer (it has gone down for the restart); `back`: the new
 * one answers, and the board reloads.
 */
export function RestartProgress({
  kind,
  job,
  version,
  server,
  down,
  back,
}: {
  kind: RestartKind
  job: RestartState
  version: string | null
  server: ServerStartStep | null
  down: boolean
  back: boolean
}) {
  const steps = stepsOf(kind)
  const restarting = job.phase === "restarting"
  const key = restarting ? (down || back || server ? "waiting" : "restarting") : job.phase
  const at = Math.max(
    0,
    steps.findIndex((s) => s.key === key),
  )
  const now = describe(key, kind, job, version, server, back)
  const overall = Math.round(((at + (now.share ?? 0)) / steps.length) * 100)
  return (
    <div className="space-y-3">
      <div>
        <div className="font-medium text-fg" role="status" aria-live="polite">
          {now.what}
        </div>
        <div className="min-h-[1.5em] text-[12.5px] text-muted">{now.detail}</div>
      </div>
      <div className="flex gap-1" role="progressbar" aria-label="Restart progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={overall}>
        {steps.map((s, i) => (
          <div key={s.key} className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-line">
            {i < at && <div className="absolute inset-0 rounded-full bg-accent" />}
            {i === at &&
              (now.share !== null ? (
                <div className="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width] duration-300" style={{ width: `${now.share * 100}%` }} />
              ) : (
                <div className="animate-progress-slide absolute inset-y-0 w-2/5 rounded-full bg-accent" />
              ))}
          </div>
        ))}
      </div>
      <ol className="flex gap-1 text-[11.5px]">
        {steps.map((s, i) => (
          <li key={s.key} className={clsx("flex flex-1 items-center gap-1", i < at ? "text-muted" : i === at ? "text-fg" : "text-faint")}>
            {i < at && <Check size={11} className="text-accent" />}
            {s.label}
          </li>
        ))}
      </ol>
      {restarting && (
        <p className="text-[12.5px] text-muted">
          This can take a minute, longer on a big board, whose database is backed up before a new version changes it. Please wait, and don&apos;t reload or
          close this window: the board reloads by itself once the server is back.
        </p>
      )}
    </div>
  )
}
