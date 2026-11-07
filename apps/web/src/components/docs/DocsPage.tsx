// `/docs/<profile>` (HA-281): the profile's documents, which its agents publish through the `docs` MCP server (HA-280),
// and each document's pages, with its menu and versions. See docs.ts for where they're kept.
import clsx from "clsx";
import { BookOpen, ChevronRight, FileText, Folder, Loader2, Trash2, Upload, X } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { api, ApiError, hasHostedDocs, type DocDetail, type DocNavNode, type DocPublisher, type DocSummary, type RenderedDocVersion } from "../../api";
import { docsHomes, pageSuffix, type DocsHome } from "../../docs";
import { docBase, href, navigate, type Route } from "../../router";
import { onDocs, useStore } from "../../store";
import { followsFrameInput, fromFrame, openable, trackBoardInput } from "../task/htmlFrame";
import { Ago, Button, errorText, IconButton, MenuButton, useConfirm } from "../ui";
import { boardTheme, docFrame } from "./docFrame";
import { HostedDocsButton, PublishDialog, PublishedState, useCanPublish } from "./HostedDocs";

type DocsRoute = Extract<Route, { name: "docs" }>;

/** The hosts' profiles the route's profile stands for, kept as long as they don't change. */
function useHomes(segment: string): { name: string; homes: DocsHome[] } {
  const key = useStore(
    useShallow((s) => {
      const { name, homes } = docsHomes(s.profiles, s.hosts, segment);
      return [name, ...homes.map((h) => `${h.hostId}\n${h.profileId}`)];
    }),
  );
  return useMemo(() => {
    const [name, ...homes] = key;
    return {
      name,
      homes: homes.map((h) => {
        const [hostId, profileId] = h.split("\n");
        return { hostId, profileId };
      }),
    };
  }, [key]);
}

/** Calls `fn` when a document of one of `homes` (or document `slug` of them) is published or deleted. */
function useDocsChanged(homes: DocsHome[], fn: () => void, slug?: string) {
  const call = useRef(fn);
  call.current = fn;
  useEffect(
    () =>
      onDocs((hostId, profileId, changed) => {
        if (slug !== undefined && changed !== slug) return;
        if (homes.some((h) => h.hostId === hostId && h.profileId === profileId)) call.current();
      }),
    [homes, slug],
  );
}

/** A link within the board: navigates here on a plain click, and opens in a new tab as links do otherwise. */
function BoardLink({ to, className, title, children }: { to: string; className?: string; title?: string; children: ReactNode }) {
  const onClick = (e: MouseEvent) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(to);
  };
  return (
    <a href={to} onClick={onClick} className={className} title={title}>
      {children}
    </a>
  );
}

/** The task that published a version, linked. */
function Publisher({ task }: { task: DocPublisher | null | undefined }) {
  if (!task) return <span className="text-faint">—</span>;
  return (
    <BoardLink to={href({ name: "task", taskId: task.id })} className="min-w-0 truncate text-muted hover:text-fg hover:underline" title={task.title}>
      {task.key && <span className="mr-1.5 font-mono text-[12px] text-faint">{task.key}</span>}
      {task.title}
    </BoardLink>
  );
}

function Header({ children }: { children: ReactNode }) {
  return (
    <header className="drag flex h-12 shrink-0 items-center gap-3 border-b border-line px-5 narrow:px-3">
      <MenuButton />
      {children}
    </header>
  );
}

function Notice({ children }: { children: ReactNode }) {
  return <div className="p-8 text-[13px] text-muted">{children}</div>;
}

/** Why there's nothing to show yet: the board is still loading, or no host with the profile's documents is connected. */
function NoHomes({ name }: { name: string }) {
  const loaded = useStore((s) => s.loaded);
  return (
    <Notice>
      {loaded ? `${name}'s documents are kept on its hosts: none of them is connected, or runs a build with Docs. Update it in Settings → Hosts.` : "Loading…"}
    </Notice>
  );
}

export function DocsPage({ route }: { route: DocsRoute }) {
  const { name, homes } = useHomes(route.profile);
  if (route.slug === undefined) return <DocsList segment={route.profile} name={name} homes={homes} />;
  return <DocView key={route.slug} route={route as DocsRoute & { slug: string }} name={name} homes={homes} />;
}

type Row = DocSummary & DocsHome;

/** Every document of the profile's, on each of its hosts, most recently updated first. */
function DocsList({ segment, name, homes }: { segment: string; name: string; homes: DocsHome[] }) {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { ask, dialog } = useConfirm();
  const seq = useRef(0);
  const load = useCallback(() => {
    const n = ++seq.current;
    void Promise.allSettled(homes.map((h) => api.docs(h.hostId, h.profileId).then((list) => list.map((d): Row => ({ ...d, ...h }))))).then((got) => {
      if (n !== seq.current) return;
      const failed = got.find((g) => g.status === "rejected");
      setError(failed ? errorText((failed as PromiseRejectedResult).reason) : null);
      setRows(
        got.flatMap((g) => (g.status === "fulfilled" ? g.value : [])).sort((a, b) => b.updated_at.localeCompare(a.updated_at) || a.slug.localeCompare(b.slug)),
      );
    });
  }, [homes]);
  useEffect(load, [load]);
  useDocsChanged(homes, load);

  // A document's link names its profile by id where the name stands for several hosts' profiles.
  const docLink = (d: Row) => href({ name: "docs", profile: homes.length > 1 ? d.profileId : segment, slug: d.slug, page: "" });
  const remove = (d: Row) =>
    ask({
      title: `Delete “${d.title}”?`,
      body: `Its ${d.latest_version === 1 ? "version" : `${d.latest_version} versions`} and every page in them are deleted. Agents' links to it stop working.`,
      action: "Delete",
      danger: true,
      onConfirm: async () => {
        await api.deleteDoc(d.hostId, d.profileId, d.slug);
        load();
      },
    });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header>
        <h1 className="text-[14px] font-semibold">Docs</h1>
        <span className="truncate text-[12px] text-faint">{name}'s documents</span>
        <HostedDocsButtons homes={homes} />
      </Header>
      {!homes.length ? (
        <NoHomes name={name} />
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-5xl p-6 narrow:p-3">
            {error && <div className="mb-4 rounded bg-red-500/10 p-2 text-[12px] text-red-300">Couldn't load every host's documents: {error}</div>}
            {rows === null ? (
              <Loader2 size={16} className="animate-spin text-muted" />
            ) : !rows.length ? (
              <div className="rounded-xl border border-dashed border-line p-6 text-center text-[13px] text-muted">
                No documents yet. Agents publish reports, plans and write-ups here with their <code className="font-mono text-[12px]">docs</code> server's{" "}
                <code className="font-mono text-[12px]">publish_document</code>, and every version is kept.
              </div>
            ) : (
              <table className="w-full table-fixed text-left text-[13px]" aria-label="Documents">
                <thead className="text-[11px] font-semibold tracking-wide text-faint uppercase">
                  <tr className="border-b border-line">
                    <th className="w-[34%] py-2 pr-3 font-semibold">Document</th>
                    <th className="w-[9%] py-2 pr-3 font-semibold narrow:hidden">Version</th>
                    <th className="w-[13%] py-2 pr-3 font-semibold">Updated</th>
                    <th className="py-2 pr-3 font-semibold narrow:hidden">Published by</th>
                    <th className="w-10 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {rows.map((d) => (
                    <tr key={`${d.hostId}\n${d.profileId}\n${d.slug}`} className="group border-b border-line/60 hover:bg-white/[0.02]">
                      <td className="py-2 pr-3">
                        <BoardLink to={docLink(d)} className="flex min-w-0 items-center gap-2 text-fg hover:underline">
                          <FileText size={14} className="shrink-0 text-muted" />
                          <span className="truncate">{d.title}</span>
                        </BoardLink>
                        <div className="truncate pl-[22px] font-mono text-[11.5px] text-faint">
                          {d.slug} · {d.page_count} page{d.page_count === 1 ? "" : "s"}
                          {d.published && (
                            <span className={d.published.local_version === d.latest_version ? "" : "text-amber-200/80"} aria-label="Published state">
                              {" "}
                              · {d.published.local_version === d.latest_version ? `published v${d.published.remote_version}` : "changed since published"}
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="py-2 pr-3 text-muted narrow:hidden">v{d.latest_version}</td>
                      <td className="py-2 pr-3 text-muted">
                        <Ago at={d.updated_at} />
                      </td>
                      <td className="py-2 pr-3 narrow:hidden">
                        <div className="flex min-w-0">
                          <Publisher task={d.task} />
                        </div>
                      </td>
                      <td className="py-2 text-right">
                        <IconButton title={`Delete ${d.title}`} onClick={() => remove(d)} className="opacity-60 group-hover:opacity-100">
                          <Trash2 size={14} />
                        </IconButton>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}
      {dialog}
    </div>
  );
}

/** A connection button for each of the homes whose host can publish to hosted docs, named by host when there are several. */
function HostedDocsButtons({ homes }: { homes: DocsHome[] }) {
  const hosts = useStore((s) => s.hosts);
  const able = homes.filter((h) => hasHostedDocs(hosts.find((x) => x.id === h.hostId)));
  return (
    <div className="no-drag ml-auto flex shrink-0 items-center gap-1">
      {able.map((h) => (
        <HostedDocsButton key={`${h.hostId}\n${h.profileId}`} home={h} label={able.length > 1 ? hosts.find((x) => x.id === h.hostId)?.name : undefined} />
      ))}
    </div>
  );
}

/** The document's host, of those the route's profile stands for: the first that has it. */
function useDocHome(homes: DocsHome[], slug: string): { home?: DocsHome; detail?: DocDetail; missing: boolean; error?: string; reload: () => void } {
  const [state, setState] = useState<{ home?: DocsHome; detail?: DocDetail; missing: boolean; error?: string }>({ missing: false });
  const seq = useRef(0);
  const reload = useCallback(() => {
    const n = ++seq.current;
    void Promise.allSettled(homes.map((h) => api.doc(h.hostId, h.profileId, slug))).then((got) => {
      if (n !== seq.current) return;
      const i = got.findIndex((g) => g.status === "fulfilled");
      if (i >= 0) return setState({ home: homes[i], detail: (got[i] as PromiseFulfilledResult<DocDetail>).value, missing: false });
      const other = got.find((g) => g.status === "rejected" && !(g.reason instanceof ApiError && g.reason.status === 404));
      setState({ missing: !other, error: other ? errorText((other as PromiseRejectedResult).reason) : undefined });
    });
  }, [homes, slug]);
  useEffect(reload, [reload]);
  return { ...state, reload };
}

/** One of the document's pages, its menu, and its versions. */
function DocView({ route, name, homes }: { route: DocsRoute & { slug: string }; name: string; homes: DocsHome[] }) {
  const { slug, version } = route;
  const page = route.page ?? "";
  const { home, detail, missing, error: homeError, reload } = useDocHome(homes, slug);
  const [shown, setShown] = useState<RenderedDocVersion | null>(null);
  const [error, setError] = useState<{ text: string; missingPage?: boolean } | null>(null);
  const [asked, setAsked] = useState<string | null>(null);
  const [publishing, setPublishing] = useState(false);
  const canPublish = useCanPublish(home);
  const frame = useRef<HTMLIFrameElement>(null);
  const base = docBase(route.profile, slug, version);
  const seq = useRef(0);
  const hostId = home?.hostId;
  const profileId = home?.profileId;

  const loadPage = useCallback(() => {
    if (!hostId || !profileId) return;
    const n = ++seq.current;
    const v = version ?? "latest";
    api
      .docVersion(hostId, profileId, slug, v, { path: page, baseUrl: base })
      .catch((e) => {
        // A document without an index page opens at its first page.
        if (page === "" && e instanceof ApiError && e.status === 404) return api.docVersion(hostId, profileId, slug, v, { baseUrl: base });
        throw e;
      })
      .then(
        (r) => {
          if (n !== seq.current) return;
          setShown({ ...r, pages: r.pages.slice(0, 1) });
          setError(null);
        },
        (e) => {
          if (n !== seq.current) return;
          const status = e instanceof ApiError ? e.status : 0;
          const which = version === undefined ? "This document" : `Version ${version} of this document`;
          setError({ text: status === 404 ? `${which} has no page “${page || "index"}”.` : errorText(e), missingPage: status === 404 && page !== "" });
        },
      );
  }, [hostId, profileId, slug, version, page, base]);
  useEffect(loadPage, [loadPage]);
  // A new version: the menu's versions change, and so does the latest's page.
  useDocsChanged(
    homes,
    () => {
      reload();
      if (version === undefined) loadPage();
    },
    slug,
  );

  const theme = useMemo(() => boardTheme(), []);
  const current = shown?.pages[0];
  // Where the reader is in the page (the frame reports it), to stay there when it's shown again with a new version.
  const place = useRef<{ key: string; y: number }>({ key: "", y: 0 });
  const doc = useMemo(() => {
    if (current?.html == null) return null;
    const again = place.current.key === current.path;
    if (!again) place.current = { key: current.path, y: 0 };
    return docFrame(current.html, theme, again ? "" : window.location.hash.slice(1), place.current.y);
  }, [current, theme]);

  // The frame's links: those to the board's own pages open here, others in a new tab, after the user's own click.
  useEffect(() => {
    trackBoardInput();
    const onMessage = (e: MessageEvent) => {
      if (e.source === frame.current?.contentWindow && typeof e.data?.iaScroll === "number") place.current.y = e.data.iaScroll;
      if (typeof e.data?.iaOpen !== "string" || !fromFrame(frame.current, e.source)) return;
      let url: URL;
      try {
        url = new URL(e.data.iaOpen);
      } catch {
        return;
      }
      if (url.origin === window.location.origin) {
        if (navigator.userActivation?.isActive !== false) navigate(url.pathname + url.search + url.hash);
        return;
      }
      if (!openable(url.href)) return;
      if (followsFrameInput(frame.current)) window.open(url.href, "_blank", "noopener,noreferrer");
      else if (navigator.userActivation?.isActive !== false) setAsked(url.href);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  const go = (to: { version?: number; page?: string }) => navigate(href({ name: "docs", profile: route.profile, slug, ...to }));
  const latest = detail?.latest_version ?? shown?.latest_version;
  const selected = version ?? latest;
  const title = shown?.title ?? detail?.title ?? slug;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Header>
        <BoardLink
          to={href({ name: "docs", profile: route.profile })}
          className="no-drag flex shrink-0 items-center gap-1.5 text-[13px] text-muted hover:text-fg"
        >
          <BookOpen size={14} />
          Docs
        </BoardLink>
        <ChevronRight size={13} className="shrink-0 text-faint" />
        <h1 className="min-w-0 truncate text-[14px] font-semibold">{title}</h1>
        {detail && selected !== undefined && (
          <select
            aria-label="Version"
            className="no-drag ml-auto h-7 max-w-[45%] shrink-0 rounded-md border border-line bg-raised px-2 text-[12px] text-fg"
            value={selected}
            onChange={(e) => {
              const n = Number(e.target.value);
              go({ version: n === detail.latest_version ? undefined : n, page });
            }}
          >
            {detail.versions.map((v) => (
              <option key={v.number} value={v.number}>
                v{v.number}
                {v.number === detail.latest_version ? " (latest)" : ""} — {v.message ?? "No message"}
              </option>
            ))}
          </select>
        )}
        {detail && selected !== undefined && canPublish && (
          <Button size="sm" className="no-drag shrink-0" onClick={() => setPublishing(true)} title={`Publish v${selected} to hosted docs`}>
            <Upload size={13} /> Publish
          </Button>
        )}
      </Header>
      {publishing && home && detail && selected !== undefined && (
        <PublishDialog home={home} detail={detail} version={selected} onClose={() => setPublishing(false)} />
      )}
      {!homes.length ? (
        <NoHomes name={name} />
      ) : missing ? (
        <Notice>
          {name} has no document “{slug}”: it may have been deleted.{" "}
          <BoardLink to={href({ name: "docs", profile: route.profile })} className="text-accent hover:underline">
            See its documents
          </BoardLink>
        </Notice>
      ) : homeError ? (
        <Notice>Couldn't load the document: {homeError}</Notice>
      ) : (
        <>
          {shown && (
            <div
              className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2 text-[12.5px] narrow:px-3"
              aria-label="This version"
            >
              <span className="font-medium text-fg">{shown.message ?? "No message"}</span>
              <span className="text-faint">
                v{shown.number} · <Ago at={shown.created_at} />
              </span>
              {shown.task && (
                <span className="flex min-w-0 items-center gap-1 text-faint">
                  by <Publisher task={shown.task} />
                </span>
              )}
              {detail && <PublishedState published={detail.published} latest={detail.latest_version} />}
              {version !== undefined && latest !== undefined && version !== latest && (
                <span className="ml-auto flex items-center gap-2 text-amber-200">
                  An older version: the latest is v{latest}.
                  <Button size="sm" onClick={() => go({ page })}>
                    Read the latest
                  </Button>
                </span>
              )}
            </div>
          )}
          {asked && (
            <div role="alert" className="flex shrink-0 items-center gap-2 bg-amber-500/10 px-3 py-1.5 text-[12px] text-amber-200">
              <span className="shrink-0">The page opens a link:</span>
              <code className="min-w-0 flex-1 truncate font-mono text-[11.5px]" title={asked}>
                {asked}
              </code>
              <Button
                size="sm"
                onClick={() => {
                  window.open(asked, "_blank", "noopener,noreferrer");
                  setAsked(null);
                }}
              >
                Open
              </Button>
              <IconButton title="Don't open it" onClick={() => setAsked(null)}>
                <X size={13} />
              </IconButton>
            </div>
          )}
          <div className="flex min-h-0 flex-1 narrow:flex-col">
            <nav
              aria-label="Pages"
              className="w-60 shrink-0 overflow-y-auto border-r border-line p-2 narrow:max-h-40 narrow:w-full narrow:border-r-0 narrow:border-b"
            >
              {shown && <NavTree nodes={shown.nav} current={current?.path} onOpen={(p) => go({ version, page: pageSuffix(p) })} />}
            </nav>
            <div className="relative min-h-0 min-w-0 flex-1">
              {error ? (
                <Notice>
                  {error.text}{" "}
                  {error.missingPage && (
                    <BoardLink to={href({ name: "docs", profile: route.profile, slug, version, page: "" })} className="text-accent hover:underline">
                      Open its first page
                    </BoardLink>
                  )}
                </Notice>
              ) : current?.error ? (
                <Notice>This page couldn't be rendered: {current.error}</Notice>
              ) : doc ? (
                <iframe
                  ref={frame}
                  title={current?.title ?? title}
                  srcDoc={doc}
                  sandbox="allow-scripts"
                  referrerPolicy="no-referrer"
                  className="block h-full w-full bg-bg"
                />
              ) : (
                <div className="flex h-full items-center justify-center text-muted">
                  <Loader2 size={16} className="animate-spin" />
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}

/** The document's menu (docs-render's navTree): pages, and folders of them, the open one marked. */
function NavTree({ nodes, current, onOpen, depth = 0 }: { nodes: DocNavNode[]; current?: string; onOpen: (path: string) => void; depth?: number }) {
  return (
    <ul className="space-y-0.5">
      {nodes.map((n) => (
        <li key={n.segment}>
          <button
            type="button"
            disabled={n.page === null}
            aria-current={n.page !== null && n.page === current ? "page" : undefined}
            onClick={() => n.page !== null && onOpen(n.page)}
            style={{ paddingLeft: 8 + depth * 14 }}
            className={clsx(
              "flex w-full items-center gap-1.5 rounded-md py-1 pr-2 text-left text-[13px]",
              n.page !== null && n.page === current ? "bg-raised text-fg" : "text-muted enabled:hover:bg-white/[0.04] enabled:hover:text-fg",
              n.page === null && "cursor-default",
            )}
          >
            {n.children.length > 0 && <Folder size={13} className="shrink-0 text-faint" />}
            <span className="truncate">{n.title}</span>
          </button>
          {n.children.length > 0 && <NavTree nodes={n.children} current={current} onOpen={onOpen} depth={depth + 1} />}
        </li>
      ))}
    </ul>
  );
}
