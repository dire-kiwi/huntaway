// A host's Telemetry section (API 143, HA-284): the ClickHouse its telemetry goes to, what goes, and how sending is
// going. Which profiles' tasks are sent is each profile's choice (its form's "Send this profile's tasks").
import { useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Exit } from "effect"
import { useState } from "react"
import { mutate, query } from "@huntaway/client"
import type { TelemetryPatch, TelemetryStatus } from "@huntaway/contracts"
import { nowMillis } from "../../state/clock"
import { exitError, useAction, useMutation } from "../../state/mutation"
import { Button, Field, Input, millisOf, resultValue, timeAgo, Toggle, useConfirm } from "../ui"

const LOGS: Array<[TelemetryStatus["logs"], string]> = [
  ["off", "None"],
  ["warn", "Warnings and errors"],
  ["info", "All of them"],
]

const STATE: Record<TelemetryStatus["state"], [string, string]> = {
  off: ["bg-line-strong", "Off"],
  ok: ["bg-emerald-400", "Sending"],
  retrying: ["bg-amber-400", "Retrying"],
  error: ["bg-red-400", "Not sending"],
}

interface Form {
  url: string
  database: string
  user: string
  /** Typed here; empty keeps the saved one. */
  password: string
  logs: TelemetryStatus["logs"]
  agents: boolean
}

const form_of = (t: TelemetryStatus): Form => ({
  url: t.url ?? "",
  database: t.database || "huntaway",
  user: t.user ?? "",
  password: "",
  logs: t.logs,
  agents: t.agents,
})

export function HostTelemetry({ hostId }: { hostId: string }) {
  // How sending goes, every 15 s; a read that fails keeps the last status. A change reads it again (the admin group).
  const status = resultValue(useAtomValue(query("admin.telemetry", hostId, undefined, { refresh: "15 seconds" }))) ?? null
  const [form, setForm] = useState<Form | null>(null)
  const [tested, setTested] = useState<{ ok: boolean; error: string | null } | null>(null)
  const [{ busy, error }, run] = useAction()
  // Turning off from the dialog: its error shows there.
  const [, update] = useMutation("admin.updateTelemetry")
  const confirm = useConfirm()
  // What's being typed stays: only the first status read fills the form.
  if (form === null && status !== null) setForm(form_of(status))
  if (!status || !form) return null
  const set = (patch: Partial<Form>) => {
    setForm({ ...form, ...patch })
    setTested(null)
  }
  const saved = form_of(status)
  const dirty =
    form.url.trim() !== saved.url ||
    form.database.trim() !== saved.database ||
    form.user.trim() !== saved.user ||
    form.password !== "" ||
    form.logs !== saved.logs ||
    form.agents !== saved.agents
  const change = (): TelemetryPatch => ({
    url: form.url.trim() || null,
    database: form.database.trim() || null,
    user: form.user.trim() || null,
    ...(form.password ? { password: form.password } : {}),
    logs: form.logs,
    agents: form.agents,
  })
  const save = () =>
    // Clearing the address turns it off, which deletes what's waiting: asked first.
    saved.url && !form.url.trim() && status.from === "settings"
      ? turnOff()
      : void run(mutate("admin.updateTelemetry", hostId, { patch: change() })).then((exit) => {
          if (Exit.isSuccess(exit)) setForm(form_of(exit.value))
        })
  const test = () =>
    void run(mutate("admin.testTelemetry", hostId, { patch: form.url.trim() ? change() : {} })).then((exit) => {
      if (Exit.isSuccess(exit)) setTested(exit.value)
    })
  const turnOff = () =>
    confirm.ask({
      title: "Turn telemetry off",
      body: "Stop sending this host's telemetry? The rows that haven't been sent yet are deleted. What's already in ClickHouse stays there.",
      action: "Turn off",
      danger: true,
      onConfirm: () =>
        update(hostId, { patch: { url: null } }).then((exit) => {
          const failed = exitError(exit)
          if (failed !== null) throw new Error(failed)
          if (Exit.isSuccess(exit)) setForm(form_of(exit.value))
        }),
    })
  const queued = Object.values(status.queued).reduce((a, b) => a + b, 0)
  const [dot, label] = STATE[status.state]
  return (
    <section>
      <h2 className="mb-1 text-[13px] font-semibold">Telemetry</h2>
      <p className="mb-3 text-[12.5px] text-muted">
        Send this host's runs, costs, agents' events and logs to a ClickHouse of your own, to query across hosts and keep for longer. Only the profiles that say
        so send their tasks', and never prompts, messages, tool input or output, or diffs. Create the tables first with{" "}
        <span className="font-mono text-fg">huntaway telemetry init</span>.
      </p>
      <div className="space-y-3 rounded-xl border border-line px-4 py-3">
        <div className="flex items-center gap-2 text-[12.5px]" data-testid="telemetry-state">
          <span className={clsx("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />
          <span className="text-fg">{label}</span>
          <span className="text-muted">
            {status.state !== "off" && `${queued} waiting`}
            {status.last_ok_at && ` · last sent ${timeAgo(status.last_ok_at)}`}
            {status.sent > 0 && ` · ${status.sent} rows since the server started`}
            {status.dropped > 0 && ` · ${status.dropped} dropped`}
            {status.from === "flag" && status.flag_url && ` · to ${status.flag_url}, from --telemetry-url`}
            {status.next_attempt_at && status.state !== "ok" && ` · trying again ${in_time(status.next_attempt_at)}`}
          </span>
        </div>
        {status.last_error && status.state !== "ok" && (
          <div className="rounded bg-red-500/10 p-2 font-mono text-[11.5px] whitespace-pre-wrap text-red-300">{status.last_error}</div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <Field label="ClickHouse URL" hint={status.from === "flag" ? "Set here, it's used instead of --telemetry-url's." : undefined}>
            <Input value={form.url} onChange={(e) => set({ url: e.target.value })} placeholder="http://192.168.1.10:8123" spellCheck={false} />
          </Field>
          <Field label="Database">
            <Input value={form.database} onChange={(e) => set({ database: e.target.value })} placeholder="huntaway" spellCheck={false} />
          </Field>
          <Field label="User" hint="A login that can only insert, one for each host.">
            <Input value={form.user} onChange={(e) => set({ user: e.target.value })} placeholder="huntaway_host" spellCheck={false} autoComplete="off" />
          </Field>
          <Field label="Password">
            <Input
              type="password"
              value={form.password}
              onChange={(e) => set({ password: e.target.value })}
              placeholder={status.has_password ? "Saved (type to change)" : ""}
              autoComplete="new-password"
            />
          </Field>
        </div>
        <Field label="The server's log lines">
          <select
            value={form.logs}
            onChange={(e) => {
              const logs = LOGS.find(([v]) => v === e.target.value)?.[0]
              if (logs) set({ logs })
            }}
            className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
          >
            {LOGS.map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
          </select>
        </Field>
        <div className="space-y-1.5">
          <Toggle checked={form.agents} onChange={(agents) => set({ agents })} label="Include the agents' own events" />
          <span className="block text-xs text-faint">
            Claude Code's and Codex's OpenTelemetry events (API requests, tool calls and their times), for the profiles that send, unless a login already sends
            its own. Without who's logged in, or what tools were given and gave back.
          </span>
        </div>
        {tested && (
          <div className={clsx("rounded p-2 text-[12px] whitespace-pre-wrap", tested.ok ? "bg-emerald-500/10 text-emerald-300" : "bg-red-500/10 text-red-300")}>
            {tested.ok ? "ClickHouse took a test insert." : tested.error}
          </div>
        )}
        {error && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{error}</div>}
        <div className="flex items-center justify-end gap-2">
          {status.url && (
            <Button size="sm" variant="ghost" onClick={turnOff} disabled={busy}>
              Turn off
            </Button>
          )}
          <Button size="sm" onClick={test} disabled={busy || (!form.url.trim() && !status.url && !status.flag_url)}>
            Test
          </Button>
          <Button size="sm" variant="primary" onClick={save} disabled={busy || !dirty}>
            Save
          </Button>
        </div>
      </div>
      {confirm.dialog}
    </section>
  )
}

function in_time(iso: string): string {
  const s = Math.max(0, (millisOf(iso) - nowMillis()) / 1000)
  if (s < 60) return "in under a minute"
  if (s < 3600) return `in ${Math.round(s / 60)}m`
  return `in ${Math.round(s / 3600)}h`
}
