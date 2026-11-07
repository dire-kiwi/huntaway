// Hosted docs (HA-282): a profile connects to a hosted docs site (dire-kiwi/docs) from the Docs page, and publishes its
// local documents there. The host keeps the sign-in (apps/server/src/integrations/docs_site.ts); the board only sees
// whether it's connected, as whom, and the code of a device sign-in under way.
import { ExternalLink, Globe, Loader2, Upload } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { api, hasHostedDocs, type DocDetail, type DocPublished, type DocPublishResult, type HostedDocsStatus } from "../../api";
import type { DocsHome } from "../../docs";
import { onDocsSite, useStore } from "../../store";
import { Button, ErrorBox, errorText, Field, Input, Modal, ModalFooter, useAsyncAction } from "../ui";

/** A site's name for showing: its host. */
export const siteName = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/** Opens one of the site's pages in a tab of its own (its host checked that they're http(s)). */
const openLink = (url: string) => {
  if (/^https?:\/\//i.test(url)) window.open(url, "_blank", "noopener,noreferrer");
};

/** Whether the home's host can publish to hosted docs (API 125). */
export const useCanPublish = (home: DocsHome | undefined) => useStore((s) => !!home && hasHostedDocs(s.hosts.find((h) => h.id === home.hostId)));

/** The home's connection to its docs site, kept up to date by `docs_site` events. */
export function useHostedDocs(home: DocsHome | undefined) {
  const [status, setStatus] = useState<HostedDocsStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const hostId = home?.hostId;
  const profileId = home?.profileId;
  const reload = useCallback(() => {
    if (!hostId || !profileId) return;
    const n = ++seq.current;
    api.hostedDocs(hostId, profileId).then(
      (s) => {
        if (n !== seq.current) return;
        setStatus(s);
        setError(null);
      },
      (e) => n === seq.current && setError(errorText(e)),
    );
  }, [hostId, profileId]);
  useEffect(reload, [reload]);
  useEffect(() => onDocsSite((h, p) => h === hostId && p === profileId && reload()), [hostId, profileId, reload]);
  // An answer to an action is the latest state too (an event may come before or after it).
  const set = useCallback((s: HostedDocsStatus) => {
    seq.current++;
    setStatus(s);
  }, []);
  return { status, error, reload, set };
}

/** Who the profile is connected as, in a few words. */
export function connectedAs(s: HostedDocsStatus) {
  return s.login ? `${s.login} on ${siteName(s.site_url)}` : siteName(s.site_url);
}

/** Connect to a docs site (the device sign-in, or a pasted token), or see who's connected and disconnect. */
export function HostedDocsConnection({ home, hosted }: { home: DocsHome; hosted: ReturnType<typeof useHostedDocs> }) {
  const { status, error: loadError, set } = hosted;
  const [site, setSite] = useState<string | null>(null);
  const [token, setToken] = useState("");
  const action = useAsyncAction();
  const siteUrl = site ?? status?.site_url ?? "";
  const act = (fn: () => Promise<HostedDocsStatus>) => action.run(async () => set(await fn()));

  if (!status) return loadError ? <ErrorBox>{loadError}</ErrorBox> : <Loader2 size={14} className="animate-spin text-muted" />;
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
          <Button variant="danger" size="sm" disabled={action.busy} onClick={() => act(() => api.hostedDocsDisconnect(home.hostId, home.profileId))}>
            Disconnect
          </Button>
        </div>
      </div>
    );
  }
  const p = status.pending;
  if (p) {
    const link = p.verification_uri_complete ?? p.verification_uri;
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
          <Button variant="ghost" size="sm" disabled={action.busy} onClick={() => act(() => api.hostedDocsCancelSignIn(home.hostId, home.profileId))}>
            Cancel
          </Button>
          {p.error && (
            <Button size="sm" disabled={action.busy} onClick={() => act(() => api.hostedDocsSignIn(home.hostId, home.profileId, p.site_url))}>
              Start again
            </Button>
          )}
        </div>
      </div>
    );
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
          onClick={() => act(() => api.hostedDocsSignIn(home.hostId, home.profileId, siteUrl))}
        >
          {action.busy && <Loader2 size={13} className="animate-spin" />}
          Sign in
        </Button>
        <span className="text-[12px] text-faint">You approve it on the site, signed in there.</span>
      </div>
      <form
        className="space-y-1.5"
        onSubmit={(e) => {
          e.preventDefault();
          void act(() => api.hostedDocsToken(home.hostId, home.profileId, siteUrl, token)).then((ok) => ok && setToken(""));
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
  );
}

/** The Docs page's button for each home's connection: who it's connected as, or an offer to connect. */
export function HostedDocsButton({ home, label }: { home: DocsHome; label?: string }) {
  const hosted = useHostedDocs(home);
  const [open, setOpen] = useState(false);
  const s = hosted.status;
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
  );
}

/** A document's state on the site: the version published there and whether it's changed here since. */
export function PublishedState({ published, latest }: { published: DocPublished | null | undefined; latest: number }) {
  if (!published) return null;
  const changed = published.local_version !== latest;
  return (
    <span className="flex items-center gap-1.5 text-faint" aria-label="Published state">
      <a href={published.url} target="_blank" rel="noopener noreferrer" className="text-muted hover:text-fg hover:underline" title={published.url}>
        Published v{published.remote_version} · open
      </a>
      {changed && <span className="text-amber-200">· local changes since last publish (v{published.local_version} was published)</span>}
    </span>
  );
}

/** Publish a version of the document (the one shown) to the profile's docs site, connecting first if need be. */
export function PublishDialog({
  home,
  detail,
  version,
  onClose,
}: {
  home: DocsHome;
  detail: DocDetail;
  /** The version to publish. */
  version: number;
  onClose: () => void;
}) {
  const hosted = useHostedDocs(home);
  const [slug, setSlug] = useState(detail.slug);
  const [done, setDone] = useState<DocPublishResult | null>(null);
  const action = useAsyncAction();
  const s = hosted.status;
  const v = detail.versions.find((x) => x.number === version);
  // Where it was published on the site it's connected to now (the document's `published` is for that site).
  const before = detail.published && s && detail.published.site_url === s.site_url ? detail.published : null;
  const publish = () =>
    void action.run(async () => {
      const out = await api.publishDoc(home.hostId, home.profileId, detail.slug, { version, ...(before ? {} : { slug: slug.trim() || detail.slug }) });
      setDone(out);
    });
  // A sign-in that expired while publishing shows as not connected.
  useEffect(() => {
    if (action.error) hosted.reload();
  }, [action.error, hosted.reload]);

  return (
    <Modal title={`Publish “${detail.title}” to docs`} onClose={onClose} onSubmit={s?.connected && !done ? publish : undefined} width="max-w-md">
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
                {done.warnings.map((w, i) => (
                  <li key={i}>
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
      ) : (
        <div className="space-y-4 text-[13px]">
          <p className="text-muted">
            Publishes <span className="text-fg">v{version}</span>
            {v?.message ? <> (“{v.message}”)</> : null} with all its pages to <span className="text-fg">{connectedAs(s)}</span>
            {before ? (
              <>
                , as a new version of{" "}
                <a href={before.url} target="_blank" rel="noopener noreferrer" className="font-mono text-[12px] text-accent hover:underline">
                  {before.remote_slug}
                </a>{" "}
                (v{before.remote_version} there now).
              </>
            ) : (
              "."
            )}
          </p>
          {!before && (
            <Field label={`Its slug on ${siteName(s.site_url)}`} hint="Its address there: /d/<slug>/. Publishing again adds versions to it.">
              <Input value={slug} onChange={(e) => setSlug(e.target.value)} aria-label="Remote slug" />
            </Field>
          )}
          <ModalFooter className="space-y-3">
            {action.error && <ErrorBox>{action.error}</ErrorBox>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={onClose}>
                Cancel
              </Button>
              <Button variant="primary" disabled={action.busy} onClick={publish}>
                {action.busy ? <Loader2 size={13} className="animate-spin" /> : <Upload size={13} />} Publish
              </Button>
            </div>
          </ModalFooter>
        </div>
      )}
    </Modal>
  );
}
