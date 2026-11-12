// Asana links (6.11, docs/plan/09-frontend.md "Step 1 as done for 6.11"): a task's links are its `external_links`
// (`tasks.update`), the search is `profiles.asanaTasks`, and connecting is `profiles.update`'s `asana_token`, which the
// host checks with Asana. The profile changes with the `profiles_changed` event that follows.
import { useAtomValue } from "@effect/atom-react"
import { query, type HostProfile as Profile, type HostTask as Task } from "@huntaway/client"
import type { AsanaTask, ExternalLink } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Exit } from "effect"
import { CheckCircle2, Circle, Link2, Loader2, X } from "lucide-react"
import { useEffect, useEffectEvent, useRef, useState } from "react"
import { useBoard } from "../../state/board"
import { failureOf, isTagged, useMutation } from "../../state/mutation"
import { after } from "../../state/timers"
import { Button, errorText, IconButton, Input, Modal, resultError, resultValue } from "../ui"

/** Whether a profile uses Asana. */
export const usesAsana = (p: Profile | undefined) => p?.asana_enabled !== false

/** The link to an Asana task, as a task keeps it. */
export const asanaLink = (t: AsanaTask): ExternalLink => ({ provider: "asana", id: t.gid, url: t.url, title: t.name })

const NONE: ReadonlyArray<ExternalLink> = []

/** Where Asana makes personal access tokens. */
const ASANA_TOKENS_URL = "https://app.asana.com/0/my-apps"

/** Asana's mark: three dots. */
export function AsanaIcon({ size = 12, className }: { size?: number | undefined; className?: string | undefined }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" className={clsx("shrink-0", className)} aria-hidden>
      <circle cx="12" cy="7" r="4.6" fill="#f06a6a" />
      <circle cx="5.4" cy="16.6" r="4.6" fill="#f06a6a" />
      <circle cx="18.6" cy="16.6" r="4.6" fill="#f06a6a" />
    </svg>
  )
}

/** A task's link to a task elsewhere, as an icon (with `label`, also its title) that opens it. */
export function ExternalLinkIcon({ link, label, className }: { link: ExternalLink; label?: boolean | undefined; className?: string | undefined }) {
  return (
    <a
      href={link.url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Asana: ${link.title || link.url}`}
      className={clsx("inline-flex min-w-0 items-center gap-1 hover:text-fg", className)}
    >
      <AsanaIcon size={11} />
      {label && <span className="truncate">{link.title || link.url}</span>}
    </a>
  )
}

/** Links, each removable, as a list (the task's sidebar) or chips (the new task form). */
export function LinkList({ links, onRemove, chips }: { links: ReadonlyArray<ExternalLink>; onRemove: (l: ExternalLink) => void; chips?: boolean | undefined }) {
  return (
    <div className={chips ? "flex flex-wrap gap-1.5" : "space-y-1"}>
      {links.map((l) => (
        <div
          key={`${l.provider}:${l.id}`}
          className={clsx(
            "group flex min-w-0 items-center gap-1.5 text-[12.5px] text-muted",
            chips ? "max-w-full rounded-md border border-line bg-raised py-0.5 pr-0.5 pl-2" : "py-0.5",
          )}
        >
          <ExternalLinkIcon link={l} label className="flex-1" />
          <button
            type="button"
            onClick={() => onRemove(l)}
            title="Unlink"
            aria-label={`Unlink ${l.title}`}
            className={clsx(
              "flex h-5 w-5 shrink-0 items-center justify-center rounded text-faint hover:bg-white/5 hover:text-fg",
              !chips && "opacity-0 group-hover:opacity-100 focus:opacity-100",
            )}
          >
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  )
}

/**
 * The task sidebar's Asana section: the Asana tasks it's for, and a button that links another,
 * unless its profile has Asana turned off (`canLink`).
 */
export function LinkedTasks({ task, canLink = true }: { task: Task; canLink?: boolean | undefined }) {
  const links = task.external_links
  const [picking, setPicking] = useState(false)
  const [{ error: err }, update] = useMutation("tasks.update")
  const save = (next: ReadonlyArray<ExternalLink>) => void update(task.host_id, { id: task.id, patch: { external_links: next } })
  return (
    <div className="space-y-2">
      {links.length > 0 ? (
        <LinkList links={links} onRemove={(l) => save(links.filter((x) => x !== l))} />
      ) : (
        <div className="text-[12.5px] text-faint">Not linked to an Asana task.</div>
      )}
      {canLink && (
        <Button size="sm" onClick={() => setPicking(true)}>
          <Link2 size={12} /> Link Asana task…
        </Button>
      )}
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      {picking && (
        <AsanaPicker
          hostId={task.host_id}
          profileId={task.profile_id}
          linked={links}
          onClose={() => setPicking(false)}
          onPick={(t) => {
            setPicking(false)
            save([...links, asanaLink(t)])
          }}
        />
      )}
    </div>
  )
}

/**
 * A dialog that finds an Asana task with the profile's Asana token (on the host), by its name or
 * a pasted link, and picks it. A profile that isn't connected to Asana yet connects here first.
 */
export function AsanaPicker({
  hostId,
  profileId,
  linked = NONE,
  onPick,
  onClose,
}: {
  hostId: string
  profileId: string
  /** Already linked: shown, but not picked again. */
  linked?: ReadonlyArray<ExternalLink> | undefined
  onPick: (t: AsanaTask) => void
  onClose: () => void
}) {
  const profile = useBoard((s) => s.profiles.find((p) => p.host_id === hostId && p.id === profileId))
  // Asana turned the token down since it was saved (it was revoked, say): connect again.
  const [reconnect, setReconnect] = useState(false)
  const connected = !!profile?.asana_user && !reconnect
  return (
    <Modal
      title={
        <span className="flex items-center gap-2">
          <AsanaIcon size={15} /> Link an Asana task
        </span>
      }
      onClose={onClose}
      width="max-w-xl"
    >
      {!profile ? (
        <div className="text-[12.5px] text-muted">This task's profile isn't on this host.</div>
      ) : connected ? (
        <AsanaSearch hostId={hostId} profile={profile} linked={linked} onPick={onPick} onUnauthorized={() => setReconnect(true)} />
      ) : (
        <ConnectAsana hostId={hostId} profile={profile} expired={reconnect} onConnected={() => setReconnect(false)} />
      )}
    </Modal>
  )
}

/** Saves a profile's Asana personal access token, which the host checks with Asana. */
export function ConnectAsana({
  hostId,
  profile,
  expired,
  onConnected,
}: {
  hostId: string
  profile: Profile
  expired?: boolean | undefined
  onConnected?: (() => void) | undefined
}) {
  const [token, setToken] = useState("")
  const [{ busy, error: err }, update] = useMutation("profiles.update")
  const connect = () => {
    if (!token.trim() || busy) return
    void update(hostId, { id: profile.id, patch: { asana_token: token.trim() } }).then((exit) => {
      if (Exit.isSuccess(exit)) onConnected?.()
    })
  }
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault()
        connect()
      }}
    >
      <p className="text-[12.5px] leading-relaxed text-muted">
        {expired ? "Asana no longer accepts this profile's token. " : ""}Connect the <span className="text-fg">{profile.name}</span> profile to Asana with a
        personal access token, which you can create in{" "}
        <a className="text-accent hover:underline" href={ASANA_TOKENS_URL} target="_blank" rel="noreferrer">
          Asana's developer console
        </a>
        . It's kept on this host, and used to find the tasks you link.
      </p>
      <Input type="password" autoFocus value={token} placeholder="Asana personal access token" onChange={(e) => setToken(e.target.value)} spellCheck={false} />
      {err && <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>}
      <div className="flex justify-end">
        <Button type="submit" variant="primary" disabled={!token.trim() || busy}>
          {busy && <Loader2 size={12} className="animate-spin" />} Connect
        </Button>
      </div>
    </form>
  )
}

function AsanaSearch({
  hostId,
  profile,
  linked,
  onPick,
  onUnauthorized,
}: {
  hostId: string
  profile: Profile
  linked: ReadonlyArray<ExternalLink>
  onPick: (t: AsanaTask) => void
  onUnauthorized: () => void
}) {
  const [q, setQ] = useState("")
  // What's searched for: what's typed, once typing pauses.
  const [searched, setSearched] = useState(q)
  useEffect(() => after(q ? 250 : 0, () => setSearched(q)), [q])
  const result = useAtomValue(query("profiles.asanaTasks", hostId, { profile_id: profile.id, q: searched }))
  const answer = resultValue(result)
  // The search for what's typed now is under way until it has answered.
  const loading = searched !== q || result.waiting || (answer === undefined && resultError(result) === null)
  const [active, setActive] = useState(0)
  const isLinked = (t: AsanaTask) => linked.some((l) => l.provider === "asana" && l.id === t.gid)
  // What the last search found, and what it was for. Shown (greyed out) while the next one runs, but
  // only what was found for what's typed now can be picked. Each answer starts on its first task not linked yet.
  const [found, setFound] = useState<{ q: string; tasks: ReadonlyArray<AsanaTask> } | null>(null)
  if (answer !== undefined && found?.tasks !== answer) {
    setFound({ q: searched, tasks: answer })
    setActive(
      Math.max(
        0,
        answer.findIndex((t) => !isLinked(t)),
      ),
    )
  }
  const tasks = found?.tasks ?? null
  const current = found?.q === q
  const err = resultError(result)
  const list = useRef<HTMLDivElement>(null)
  // The token was refused, or is gone since the board loaded the profile: connect again.
  const failure = result.waiting ? undefined : failureOf(result)
  const refused = isTagged(failure, "Unavailable") || (isTagged(failure, "External") && /didn't accept the token/.test(errorText(failure)))
  const unauthorized = useEffectEvent(onUnauthorized)
  useEffect(() => {
    if (refused) unauthorized()
  }, [refused])
  // In braces: scrollIntoView returns a promise in newer browsers, which React would take for the effect's cleanup.
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" })
  }, [active])
  const pick = (t: AsanaTask | undefined) => current && t && !isLinked(t) && onPick(t)
  const move = (by: number) => tasks?.length && setActive((i) => (i + by + tasks.length) % tasks.length)
  return (
    <div className="space-y-3">
      <div className="relative">
        <Input
          autoFocus
          value={q}
          placeholder="Search Asana tasks, or paste a task's link"
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault()
              move(e.key === "ArrowDown" ? 1 : -1)
            } else if (e.key === "Enter") {
              // Picking closes the dialog, after which the form under it (New task) would take the same keydown, with Ctrl
              // or Cmd, as its own submit shortcut: it's this dialog's alone.
              e.preventDefault()
              e.stopPropagation()
              pick(tasks?.[active])
            }
          }}
          spellCheck={false}
          className="pr-8"
        />
        {loading && <Loader2 size={13} className="absolute top-2.5 right-2.5 animate-spin text-faint" />}
      </div>
      {err ? (
        <div className="rounded bg-red-500/10 p-2 text-[11.5px] whitespace-pre-wrap text-red-300">{err}</div>
      ) : tasks && tasks.length === 0 && current ? (
        <div className="py-6 text-center text-[12.5px] text-faint">{q.trim() ? "No Asana tasks found." : "No recent Asana tasks."}</div>
      ) : (
        tasks && (
          <div
            ref={list}
            role="listbox"
            aria-label="Asana tasks"
            aria-busy={!current}
            className={clsx("-mx-1 max-h-[50vh] space-y-0.5 overflow-y-auto", !current && "opacity-50")}
          >
            {tasks.map((t, i) => {
              const done = isLinked(t)
              const where = [t.projects.join(", "), t.workspace, t.assignee].filter(Boolean).join(" · ")
              return (
                <button
                  key={t.gid}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-index={i}
                  disabled={done || !current}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(t)}
                  className={clsx(
                    "flex w-full items-start gap-2 rounded-md px-2 py-1.5 text-left",
                    i === active && !done ? "bg-raised" : "",
                    done && "opacity-60",
                  )}
                >
                  {t.completed ? (
                    <CheckCircle2 size={13} className="mt-0.5 shrink-0 text-st-done" />
                  ) : (
                    <Circle size={13} className="mt-0.5 shrink-0 text-faint" />
                  )}
                  <span className="min-w-0 flex-1">
                    <span className={clsx("block truncate text-[13px]", t.completed ? "text-muted" : "text-fg")}>{t.name || "(untitled)"}</span>
                    {where && <span className="block truncate text-[11.5px] text-faint">{where}</span>}
                  </span>
                  {done && <span className="shrink-0 text-[11px] text-faint">Linked</span>}
                </button>
              )
            })}
          </div>
        )
      )}
      <div className="flex items-center gap-2 border-t border-line pt-2.5 text-[11.5px] text-faint">
        <span className="min-w-0 flex-1 truncate" title={`The ${profile.name} profile's Asana account`}>
          Searching as {profile.asana_user ?? ""}
        </span>
        <span className="shrink-0">↑↓ to move, Enter to link</span>
      </div>
    </div>
  )
}

/** Disconnects a profile from Asana, for its settings. */
export function AsanaAccount({ hostId, profile }: { hostId: string; profile: Profile }) {
  const [connecting, setConnecting] = useState(false)
  const [{ error: err }, update] = useMutation("profiles.update")
  if (!profile.asana_user)
    return connecting ? (
      <ConnectAsana hostId={hostId} profile={profile} onConnected={() => setConnecting(false)} />
    ) : (
      <div className="flex items-center gap-2 text-[12.5px] text-muted">
        Not connected.
        <Button size="sm" onClick={() => setConnecting(true)}>
          Connect…
        </Button>
      </div>
    )
  return (
    <div className="flex items-center gap-2 text-[12.5px] text-muted">
      <AsanaIcon />
      <span className="min-w-0 flex-1 truncate">Connected as {profile.asana_user}</span>
      <IconButton title="Disconnect from Asana" onClick={() => void update(hostId, { id: profile.id, patch: { asana_token: null } })}>
        <X size={13} />
      </IconButton>
      {err && <span className="text-red-400">{err}</span>}
    </div>
  )
}
