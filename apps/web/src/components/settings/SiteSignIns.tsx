import { useAtomValue } from "@effect/atom-react"
import { type HostProfile, mutate, query } from "@huntaway/client"
import type { SignedIn, SignIn, Space } from "@huntaway/contracts"
import { Exit, Redacted } from "effect"
import { KeyRound, Loader2, Pencil, Plus, Trash2 } from "lucide-react"
import { useState } from "react"
import { useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { Button, Field, Input, Modal, ModalFooter, resultError, resultValue, timeAgo, useConfirm } from "../ui"

// Site sign-ins (HE-48): a profile's saved logins on a host, which the host's server types into a Space's browser, on
// the site's own address only, when the user allows it (an agent's `space_sign_in` asks first) or asks for it here. A
// password goes to the server and never comes back: the list shows sites and usernames, and a password can only be
// replaced.

/** A profile's site sign-ins on its host: add, change, delete. Settings → Profiles mounts it. */
export function SiteSignInsModal({ profile, hostName, onClose }: { profile: HostProfile; hostName: string; onClose: () => void }) {
  const hostId = profile.host_id
  const result = useAtomValue(query("signIns.list", hostId, { profile_id: profile.id }))
  const list = resultValue(result) ?? null
  const [editing, setEditing] = useState<SignIn | "new" | null>(null)
  const [action, run] = useAction()
  const confirm = useConfirm()
  const err = action.error ?? resultError(result)
  return (
    <Modal title={`Site sign-ins for ${profile.name} on ${hostName}`} onClose={onClose} width="max-w-xl">
      <p className="mb-3 text-[12.5px] text-muted">
        Usernames and passwords for websites. When an agent in a Space asks to sign in to one, you approve it and the board types it in: the agent never sees
        the password. Anything you sign in to in a Space can be used by whatever runs there.
      </p>
      {list === null ? (
        <div className="text-[12.5px] text-faint">Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-[12.5px] text-faint">None saved yet.</div>
      ) : (
        <div className="divide-y divide-line rounded-xl border border-line">
          {list.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-4 py-2.5 text-[12.5px]">
              <KeyRound size={13} className="shrink-0 text-muted" />
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium text-fg">
                  {s.login_url}
                  {s.label ? <span className="font-normal text-muted"> · {s.label}</span> : null}
                </div>
                <div className="truncate text-muted">
                  {s.username}
                  {s.last_used_at ? ` · used ${timeAgo(s.last_used_at)}` : " · not used yet"}
                </div>
              </div>
              <Button size="sm" variant="ghost" title="Change" aria-label={`Change ${s.origin}`} onClick={() => setEditing(s)}>
                <Pencil size={12} />
              </Button>
              <Button
                size="sm"
                variant="ghost"
                title="Delete"
                aria-label={`Delete ${s.origin}`}
                disabled={action.busy}
                onClick={() =>
                  confirm.ask({
                    title: `Delete the sign-in for ${s.origin}`,
                    body: `Delete ${s.username}'s sign-in for ${s.origin}? Agents can no longer sign in with it.`,
                    action: "Delete",
                    danger: true,
                    onConfirm: () => run(mutate("signIns.delete", hostId, { id: s.id })),
                  })
                }
              >
                <Trash2 size={12} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {err && <div className="mt-2 rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{err}</div>}
      <ModalFooter className="mt-5 flex justify-between gap-2">
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> Add sign-in
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </ModalFooter>
      {editing && <SignInForm profile={profile} initial={editing === "new" ? null : editing} onClose={() => setEditing(null)} />}
      {confirm.dialog}
    </Modal>
  )
}

/** A new sign-in, or a change to one (its address stays; a password left empty stays as it is). */
function SignInForm({ profile, initial, onClose }: { profile: HostProfile; initial: SignIn | null; onClose: () => void }) {
  const [url, setUrl] = useState(initial?.login_url ?? "")
  const [username, setUsername] = useState(initial?.username ?? "")
  const [password, setPassword] = useState("")
  const [label, setLabel] = useState(initial?.label ?? "")
  const [action, run] = useAction()
  const ready = username.trim() !== "" && url.trim() !== "" && (initial !== null || password !== "")
  const submit = () => {
    if (!ready || action.busy) return
    const change =
      initial === null
        ? mutate("signIns.create", profile.host_id, { profile_id: profile.id, url: url.trim(), username, password: Redacted.make(password), label })
        : mutate("signIns.update", profile.host_id, {
            id: initial.id,
            ...(url.trim() === initial.login_url ? {} : { url: url.trim() }),
            username,
            label,
            ...(password === "" ? {} : { password: Redacted.make(password) }),
          })
    void run(change).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title={initial ? `Change the sign-in for ${initial.origin}` : "Add a site sign-in"} onClose={onClose} onSubmit={submit}>
      <div className="space-y-4">
        <Field
          label="Sign-in page"
          help="The site's sign-in page, e.g. https://github.com/login: the board opens it to sign in. The password is typed only on that page's site (its origin)."
        >
          <Input autoFocus={initial === null} value={url} placeholder="https://example.com/login" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Username">
          <Input autoFocus={initial !== null} value={username} autoComplete="off" onChange={(e) => setUsername(e.target.value)} />
        </Field>
        <Field
          label="Password"
          help={initial ? "Leave it empty to keep the saved one. A saved password is never shown again." : "Never shown again once saved."}
        >
          <Input type="password" value={password} autoComplete="new-password" onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <Field label="Label">
          <Input value={label} placeholder="Optional, e.g. Test account" onChange={(e) => setLabel(e.target.value)} />
        </Field>
        {action.error && <div className="rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{action.error}</div>}
      </div>
      <ModalFooter className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button disabled={!ready || action.busy} onClick={submit}>
          {action.busy && <Loader2 size={12} className="animate-spin" />} {initial ? "Save" : "Add"}
        </Button>
      </ModalFooter>
    </Modal>
  )
}

/** Sign in to a site in a running Space with one of the host's saved sign-ins: the server opens the site and types it. */
export function SpaceSignInModal({ hostId, space, onClose }: { hostId: string; space: Space; onClose: () => void }) {
  const result = useAtomValue(query("signIns.list", hostId, {}))
  const list = resultValue(result) ?? null
  const profiles = useBoard((s) => s.profiles)
  const profileName = (id: string) => profiles.find((p) => p.host_id === hostId && p.id === id)?.name ?? "?"
  const [picked, setPicked] = useState("")
  const [done, setDone] = useState<SignedIn | null>(null)
  const [action, run] = useAction()
  const chosen = picked || list?.[0]?.id || ""
  const submit = () => {
    if (chosen === "" || action.busy) return
    setDone(null)
    void run(mutate("spaces.signIn", hostId, { id: space.id, sign_in_id: chosen })).then((exit) => {
      if (Exit.isSuccess(exit)) setDone(exit.value)
    })
  }
  return (
    <Modal title={`Sign in to a site in ${space.name}`} onClose={onClose} onSubmit={submit}>
      {list === null ? (
        <div className="text-[12.5px] text-faint">Loading…</div>
      ) : list.length === 0 ? (
        <div className="text-[12.5px] text-muted">No site sign-ins are saved on this host: add them in Settings → Profiles → Site sign-ins.</div>
      ) : (
        <div className="space-y-4">
          <Field label="Sign-in" help="The board opens the site in a new Chromium window in the Space and fills in the form there.">
            <select
              className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] text-fg outline-none focus:border-accent/60"
              value={chosen}
              onChange={(e) => setPicked(e.target.value)}
            >
              {list.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.origin} · {s.username}
                  {s.label ? ` (${s.label})` : ""} · {profileName(s.profile_id)}
                </option>
              ))}
            </select>
          </Field>
          {done && (
            <div className="rounded bg-emerald-500/10 p-2 text-[12px] text-emerald-300">
              {done.submitted ? "Signed in" : "Filled in (no submit button found)"} as {done.username_hint}
              {done.page_url ? `: the tab is at ${done.page_url}` : ""}. Open the Space to carry on, or to enter a code the site asks for.
              {done.password_in_address && " The site sent the password in the page's address (a form sent by GET), so it may be in the site's logs."}
            </div>
          )}
        </div>
      )}
      {(action.error ?? resultError(result)) && (
        <div className="mt-2 rounded bg-red-500/10 p-2 text-[12px] whitespace-pre-wrap text-red-300">{action.error ?? resultError(result)}</div>
      )}
      <ModalFooter className="mt-5 flex justify-end gap-2">
        <Button variant="ghost" onClick={onClose}>
          {done ? "Done" : "Cancel"}
        </Button>
        <Button disabled={chosen === "" || action.busy} onClick={submit}>
          {action.busy && <Loader2 size={12} className="animate-spin" />} Sign in
        </Button>
      </ModalFooter>
    </Modal>
  )
}
