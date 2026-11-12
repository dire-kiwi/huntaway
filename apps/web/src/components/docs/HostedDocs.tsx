// Hosted docs (HA-282): a profile connects to a hosted docs site (dire-kiwi/docs) from the Docs page, and publishes its
// local documents there. The host keeps the sign-in (apps/server/src/integrations/docs_site.ts); the board only sees
// whether it's connected, as whom, and the code of a device sign-in under way.
import { useAtomValue } from "@effect/atom-react"
import { Exit, type Effect } from "effect"
import type { AtomRegistry } from "effect/reactivity"
import { ExternalLink, Globe, Loader2, Upload } from "lucide-react"
import { useState } from "react"
import { ProfileId, type DocDetail, type DocPublished, type DocPublishExists, type DocPublishResult, type HostedDocsStatus } from "@huntaway/contracts"
import { type CallError, mutate, query } from "@huntaway/client"
import type { DocsHome } from "./docs"
import { useAction, useMutation } from "../../state/mutation"
import { Button, ErrorBox, Field, Input, Modal, ModalFooter, resultError, resultValue } from "../ui"

/** A site's name for showing: its host. */
export const siteName = (url: string) => {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/** Opens one of the site's pages in a tab of its own (its host checked that they're http(s)). */
const openLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer")
}

/** Whether the home's host can publish to hosted docs: every host can (6.3), once the document's is known. */
export const useCanPublish = (home: DocsHome | undefined) => home !== undefined

/**
 * The home's connection to its docs site, read again on its `docs_site` events and after a change to its documents
 * (a sign-in that expired while publishing shows as not connected).
 */
export function useHostedDocs(home: DocsHome) {
  const result = useAtomValue(query("docs.hostedStatus", home.hostId, { profile_id: ProfileId.make(home.profileId) }))
  const read = resultValue(result)
  // An answer to an action is the latest state too, until the status is read again (an event may come before or after it).
  const [answer, setAnswer] = useState<{ readonly status: HostedDocsStatus; readonly over: HostedDocsStatus | undefined } | null>(null)
  const status = answer !== null && answer.over === read ? answer.status : (read ?? null)
  const set = (s: HostedDocsStatus) => setAnswer({ status: s, over: read })
  return { status, error: resultError(result), set }
}

/** Who the profile is connected as, in a few words. */
export function connectedAs(s: HostedDocsStatus) {
  return s.login ? `${s.login} on ${siteName(s.site_url)}` : siteName(s.site_url)
}

/** What a change to the connection fails with. */
type ConnectionError = CallError<"docs.hostedDisconnect" | "docs.hostedDeviceCancel" | "docs.hostedDeviceStart" | "docs.hostedToken">

/** Connect to a docs site (the device sign-in, or a pasted token), or see who's connected and disconnect. */
export function HostedDocsConnection({ home, hosted }: { home: DocsHome; hosted: ReturnType<typeof useHostedDocs> }) {
  const { status, error: loadError, set } = hosted
  const [site, setSite] = useState<string | null>(null)
  const [token, setToken] = useState("")
  const [action, run] = useAction()
  const siteUrl = site ?? status?.site_url ?? ""
  /** Runs a change to the connection, whose answer is its state now: whether it was made. */
  const act = (change: Effect.Effect<HostedDocsStatus, ConnectionError, AtomRegistry.AtomRegistry>) =>
    run(change).then((exit) => {
      if (Exit.isSuccess(exit)) set(exit.value)
      return Exit.isSuccess(exit)
    })

  if (!status) return loadError ? <ErrorBox>{loadError}</ErrorBox> : <Loader2 size={14} className="animate-spin text-muted" />
  if (status.connected) {
    return (
      <div className="space-y-3 text-[13px]">
        <div className="flex items-center gap-2" aria-label="Hosted docs connection">
          <span className="h-2 w-2 shrink-0 rounded-full bg-emerald-400" />
          <span>
            Connected{status.login ? " as " : " to "}
            <span className="font-medium text-fg">{connectedAs(status)}</span>
            {status.kind === "token" ? " with an access token" : ""}.
          </span>
        </div>
        {!status.login && <p className="text-[12px] text-faint">The username shows once something is published.</p>}
        <p className="text-[12px] text-faint">
          Disconnecting forgets the sign-in on this host. To end it on the site too, revoke it under <span className="text-muted">Access</span> there.
        </p>
        {action.error && <ErrorBox>{action.error}</ErrorBox>}
        <div className="flex justify-end">
          <Button
            variant="danger"
            size="sm"
            disabled={action.busy}
            onClick={() => void act(mutate("docs.hostedDisconnect", home.hostId, { profile_id: ProfileId.make(home.profileId) }))}
          >
            Disconnect
          </Button>
        </div>
      </div>
    )
  }
  const p = status.pending
  if (p) {
    const link = p.verification_uri_complete ?? p.verification_uri
    return (
      <div className="space-y-3 text-[13px]" aria-label="Sign-in under way">
        {p.error ? (
          <ErrorBox>{p.error}</ErrorBox>
        ) : (
          <>
            <p className="text-muted">
              Open {siteName(p.site_url)}, check that it shows this code, and choose <span className="text-fg">Allow</span>:
            </p>
            <div className="text-center font-mono text-[22px] font-semibold tracking-[0.2em] text-fg" aria-label="Sign-in code">
              {p.user_code}
            </div>
            <div className="flex justify-center">
              <Button variant="primary" type="button" onClick={() => openLink(link)}>
                <ExternalLink size={13} /> Open {siteName(p.site_url)}
              </Button>
            </div>
            <p className="flex items-center justify-center gap-2 text-[12px] text-faint">
              <Loader2 size={12} className="animate-spin" /> Waiting for you to allow it there…
            </p>
          </>
        )}
        {action.error && <ErrorBox>{action.error}</ErrorBox>}
        <div className="flex justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={action.busy}
            onClick={() => void act(mutate("docs.hostedDeviceCancel", home.hostId, { profile_id: ProfileId.make(home.profileId) }))}
          >
            Cancel
          </Button>
          {p.error && (
            <Button
              size="sm"
              disabled={action.busy}
              onClick={() => void act(mutate("docs.hostedDeviceStart", home.hostId, { profile_id: ProfileId.make(home.profileId), site_url: p.site_url }))}
            >
              Start again
            </Button>
          )}
        </div>
      </div>
    )
  }
  return (
    <div className="space-y-4 text-[13px]">
      <Field label="Docs site">
        <Input value={siteUrl} onChange={(e) => setSite(e.target.value)} placeholder={status.default_site_url} aria-label="Docs site" />
      </Field>
      <div className="flex items-center gap-3">
        <Button
          variant="primary"
          disabled={action.busy || !siteUrl.trim()}
          onClick={() => void act(mutate("docs.hostedDeviceStart", home.hostId, { profile_id: ProfileId.make(home.profileId), site_url: siteUrl }))}
        >
          {action.busy && <Loader2 size={13} className="animate-spin" />}
          Sign in
        </Button>
        <span className="text-[12px] text-faint">You approve it on the site, signed in there.</span>
      </div>
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault()
          void act(mutate("docs.hostedToken", home.hostId, { profile_id: ProfileId.make(home.profileId), site_url: siteUrl, token })).then(
            (ok) => ok && setToken(""),
          )
        }}
      >
        <span className="block text-xs font-medium text-muted">Or a personal access token (from the site's Access page)</span>
        <div className="flex gap-2">
          <Input type="password" autoComplete="off" value={token} onChange={(e) => setToken(e.target.value)} aria-label="Access token" />
          <Button type="submit" disabled={action.busy || !token.trim() || !siteUrl.trim()}>
            Connect
          </Button>
        </div>
      </form>
      {action.error && <ErrorBox>{action.error}</ErrorBox>}
    </div>
  )
}

/** The Docs page's button for each home's connection: who it's connected as, or an offer to connect. */
export function HostedDocsButton({ home, label }: { home: DocsHome; label?: string | undefined }) {
  const hosted = useHostedDocs(home)
  const [open, setOpen] = useState(false)
  const s = hosted.status
  return (
    <>
      <Button size="sm" variant="ghost" className="shrink-0" onClick={() => setOpen(true)} title="Hosted docs">
        <Globe size={13} />
        {label && <span className="text-faint">{label}:</span>}
        {s?.connected ? connectedAs(s) : "Connect to hosted docs"}
      </Button>
      {open && (
        <Modal title="Hosted docs" onClose={() => setOpen(false)} width="max-w-md">
          <p className="mb-4 text-[12.5px] text-muted">
            Publish this profile's documents to a docs site, to read them there and share them. Documents stay here too.
          </p>
          <HostedDocsConnection home={home} hosted={hosted} />
        </Modal>
      )}
    </>
  )
}

/** A document's state on the site: the version published there and whether it's changed here since. */
export function PublishedState({ published, latest }: { published: DocPublished | null | undefined; latest: number }) {
  if (!published) return null
  const changed = published.local_version !== latest
  return (
    <span className="flex items-center gap-1.5 text-faint" aria-label="Published state">
      <a href={published.url} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg hover:underline" title={published.url}>
        Published v{published.remote_version} · open
      </a>
      {changed && <span className="text-amber-200">· local changes since last publish (v{published.local_version} was published)</span>}
    </span>
  )
}

/** Publish a version of the document (the one shown) to the profile's docs site, connecting first if need be. */
export function PublishDialog({
  home,
  detail,
  version,
  onClose,
}: {
  home: DocsHome
  detail: DocDetail
  /** The version to publish. */
  version: number
  onClose: () => void
}) {
  const hosted = useHostedDocs(home)
  const [slug, setSlug] = useState(detail.slug)
  // Publishing it to another slug than the one it went to (HA-286: that one was deleted and taken, say).
  const [elsewhere, setElsewhere] = useState(false)
  // The site's document at the slug, which publishing would add a version to: the user says whether to.
  const [exists, setExists] = useState<DocPublishExists | null>(null)
  const [done, setDone] = useState<DocPublishResult | null>(null)
  // A sign-in that expired while publishing shows as not connected: the status is read again after it (useHostedDocs).
  const [action, publishVersion] = useMutation("docs.publish")
  const s = hosted.status
  const v = detail.versions.find((x) => x.number === version)
  // Where it was published on the site it's connected to now (the document's `published` is for that site and account).
  const before = detail.published && s && detail.published.site_url === s.site_url ? detail.published : null
  const choosing = !before || elsewhere
  /** Publish, asking first (`ask`) if the site has a document at a slug it wasn't published to. */
  const publish = (ask: boolean) =>
    void publishVersion(home.hostId, {
      profile_id: ProfileId.make(home.profileId),
      slug: detail.slug,
      version,
      ...(choosing ? { remote_slug: slug.trim() || detail.slug } : {}),
      ask,
    }).then((exit) => {
      if (!Exit.isSuccess(exit)) return
      const out = exit.value
      if ("exists" in out) setExists(out.exists)
      else setDone(out)
    })
  const another = () => {
    setExists(null)
    setElsewhere(true)
    if (before) setSlug(before.remote_slug)
  }

  return (
    <Modal
      title={`Publish “${detail.title}” to docs`}
      onClose={onClose}
      onSubmit={s?.connected && !done && !exists ? () => publish(true) : undefined}
      width="max-w-md"
    >
      {!s ? (
        hosted.error ? (
          <ErrorBox>{hosted.error}</ErrorBox>
        ) : (
          <Loader2 size={14} className="animate-spin text-muted" />
        )
      ) : !s.connected ? (
        <div className="space-y-4">
          <p className="text-[12.5px] text-muted">Connect this profile to a docs site to publish it.</p>
          {action.error && <ErrorBox>{action.error}</ErrorBox>}
          <HostedDocsConnection home={home} hosted={hosted} />
        </div>
      ) : done ? (
        <div className="space-y-3 text-[13px]" aria-label="Published">
          <p>
            Published as <span className="font-medium text-fg">v{done.published.remote_version}</span> of{" "}
            <span className="font-mono text-[12px]">{done.published.remote_slug}</span> on {siteName(done.published.site_url)}.
          </p>
          {done.warnings.length > 0 && (
            <div className="rounded bg-amber-500/10 p-2 text-[12px] text-amber-200" aria-label="Warnings">
              <div className="mb-1 font-medium">The site warned about:</div>
              <ul className="list-disc space-y-0.5 pl-4">
                {done.warnings.map((w) => (
                  <li key={`${w.page}\n${w.warning}`}>
                    <span className="font-mono">{w.page}</span>: {w.warning}
                  </li>
                ))}
              </ul>
            </div>
          )}
          <ModalFooter className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button variant="primary" type="button" onClick={() => openLink(done.published.url)}>
              <ExternalLink size={13} /> Open
            </Button>
          </ModalFooter>
        </div>
      ) : exists ? (
        <div className="space-y-4 text-[13px]" aria-label="Already on the site">
          <p className="text-muted">
            {siteName(s.site_url)} has a document at <span className="font-mono text-[12px] text-fg">{exists.slug}</span> already:{" "}
            {exists.url ? (
              <a href={exists.url} target="_blank" rel="noopener noreferrer" className="text-accent hover:underline">
                “{exists.title}”
              </a>
            ) : (
              <span className="text-fg">“{exists.title}”</span>
            )}
            {exists.latest_version !== null ? ` (v${exists.latest_version})` : ""}
            {exists.owner ? `, ${exists.owner}'s` : ""}. Publishing v{version} there adds it as a new version of that document.
          </p>
          <ModalFooter className="space-y-3">
            {action.error && <ErrorBox>{action.error}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" disabled={action.busy} onClick={another}>
                Choose another slug
              </Button>
              <Button variant="primary" disabled={action.busy} onClick={() => publish(false)}>
                {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Publish over it
              </Button>
            </div>
          </ModalFooter>
        </div>
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-muted">
            Publishes <span className="text-fg">v{version}</span>
            {v?.message ? <> (“{v.message}”)</> : null} with all its pages to <span className="text-fg">{connectedAs(s)}</span>
            {before && !elsewhere ? (
              <>
                , as a new version of{" "}
                <a href={before.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-accent hover:underline">
                  {before.remote_slug}
                </a>{" "}
                (v{before.remote_version} there now).{" "}
                <button type="button" className="text-[12px] text-faint underline hover:text-fg" onClick={another}>
                  Change the slug
                </button>
              </>
            ) : (
              "."
            )}
          </p>
          {choosing && detail.folder ? (
            <p className="text-[12px] text-faint" aria-label="Folder there">
              A new document there goes in the folder <span className="font-mono text-fg">{detail.folder}</span>, as it's filed here. After that, moving it on
              either side leaves the other where it is.
            </p>
          ) : null}
          {choosing && (
            <Field
              label={`Its slug on ${siteName(s.site_url)}`}
              hint={
                before
                  ? `A slug other than ${before.remote_slug} publishes it there instead, and later publishes add versions to that one.`
                  : "Its address there: /d/<slug>/. Publishing again adds versions to it."
              }
            >
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Remote slug" />
            </Field>
          )}
          <ModalFooter className="space-y-3">
            {action.error && <ErrorBox>{action.error}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={action.busy} onClick={() => publish(true)}>
                {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Publish
              </Button>
            </div>
          </ModalFooter>
        </div>
      )}
    </Modal>
  )
}
