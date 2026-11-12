// A document's view: one of its pages in a frame, with its menu, versions and comments.
import { Loader2 } from "lucide-react"
import { useMemo, useRef, useState } from "react"
import { ProfileId } from "@huntaway/contracts"
import { pageSuffix, type DocsHome } from "../docs"
import { docBase, href } from "../../../router"
import { cameFrom, navigate } from "../../../state/route"
import { rpc } from "../../../state/rpc"
import { boardTheme } from "../docFrame"
import { PublishDialog, useCanPublish } from "../HostedDocs"
import { OpenLinkBar } from "../../ui"
import { DocCommentsPanel, useDocComments } from "../DocComments"
import { VersionBar } from "./bars"
import { BoardLink, NoHomes, Notice } from "./chrome"
import { DocHeader } from "./DocHeader"
import { useDocsChanged, useDocsSiteChanged } from "./hooks"
import { LabelsDialog } from "./LabelsDialog"
import type { DocsRoute } from "./model"
import { NavTree } from "./NavTree"
import { useCommentMarks } from "./useCommentMarks"
import { useDocFrame } from "./useDocFrame"
import { useDocHome } from "./useDocHome"
import { useDocPage } from "./useDocPage"

/** One of the document's pages, its menu, and its versions. */
export function DocView({ route, name, homes }: { route: DocsRoute & { slug: string }; name: string; homes: DocsHome[] }) {
  const { slug, version } = route
  const page = route.page ?? ""
  const { home, detail, missing, error: homeError, reload } = useDocHome(homes, slug)
  const [publishing, setPublishing] = useState(false)
  const [labelling, setLabelling] = useState(false)
  // 6.3: every host has labels and comments.
  const canLabel = true
  const canPublish = useCanPublish(home)
  const frame = useRef<HTMLIFrameElement>(null)
  const base = docBase(route.profile, slug, version)
  const hostId = home?.hostId
  const profileId = home?.profileId
  const commenting = true
  const comments = useDocComments(home, slug, commenting)

  const { shown, error, loadPage } = useDocPage({ hostId, profileId, slug, version, page, base })
  // A new version: the menu's versions change, and so does the latest's page.
  useDocsChanged(homes, () => {
    reload()
    if (version === undefined) loadPage()
  })
  // Connecting or disconnecting changes its published state.
  useDocsSiteChanged(homes, reload)

  const theme = useMemo(() => boardTheme(), [])
  const current = shown?.pages[0]
  const shownVersion = shown?.number
  const marks = useCommentMarks(frame, { data: comments.data, commenting, shownVersion, path: current?.path })
  const { commentsShown, showComments, draft, setDraft, found, setFound, active, setActive, toFrame } = marks
  const { doc, asked, setAsked } = useDocFrame(frame, { current, theme, shownVersion, setDraft, showComments, setFound, setActive })

  const go = (to: { version?: number | undefined; page?: string | undefined }) =>
    navigate(
      href({
        name: "docs",
        profile: route.profile,
        slug,
        ...(to.version !== undefined && { version: to.version }),
        ...(to.page !== undefined && { page: to.page }),
      }),
    )
  const latest = detail?.latest_version ?? shown?.latest_version
  const selected = version ?? latest
  const title = shown?.title ?? detail?.title ?? slug
  const from = cameFrom()

  return (
    <div className="flex h-full min-h-0 flex-col">
      <DocHeader
        from={from}
        profile={route.profile}
        detail={detail}
        title={title}
        page={page}
        selected={selected}
        go={go}
        canLabel={canLabel}
        onLabel={() => setLabelling(true)}
        commenting={commenting}
        commentsShown={commentsShown}
        showComments={showComments}
        canPublish={canPublish}
        onPublish={() => setPublishing(true)}
      />
      {labelling && home && detail && (
        <LabelsDialog
          title={`Labels of “${detail.title}”`}
          initial={detail.labels ?? []}
          home={home}
          onSave={(next) => rpc(home.hostId, "docs.update", { profile_id: ProfileId.make(home.profileId), slug, patch: { labels: next } })}
          onDone={reload}
          onClose={() => setLabelling(false)}
        />
      )}
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
          {shown && <VersionBar shown={shown} detail={detail} version={version} latest={latest} onLatest={() => go({ page })} />}
          {asked && <OpenLinkBar what="page" url={asked} onDone={() => setAsked(null)} />}
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
                    <BoardLink
                      to={href({ name: "docs", profile: route.profile, slug, ...(version !== undefined && { version }), page: "" })}
                      className="text-accent hover:underline"
                    >
                      Open its first page
                    </BoardLink>
                  )}
                  {error.missingVersion && (
                    <BoardLink to={href({ name: "docs", profile: route.profile, slug, page })} className="text-accent hover:underline">
                      Read the latest
                    </BoardLink>
                  )}
                </Notice>
              ) : current?.error ? (
                <Notice>This page couldn't be rendered: {current.error}</Notice>
              ) : doc ? (
                <iframe
                  ref={frame}
                  title={current?.title ?? title}
                  onLoad={() => {
                    setFound(null)
                    toFrame.current()
                  }}
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
            {commenting && commentsShown && home && (
              <DocCommentsPanel
                home={home}
                slug={slug}
                data={comments.data}
                loadError={comments.error}
                version={shownVersion}
                page={current?.path}
                draft={draft}
                onDraftDone={() => setDraft(null)}
                found={found}
                active={active}
                onFocus={(id) => {
                  setActive(id)
                  frame.current?.contentWindow?.postMessage({ iaScrollTo: id }, "*")
                }}
                onGo={(v, p) => go({ version: v === latest ? undefined : v, page: pageSuffix(p) })}
              />
            )}
          </div>
        </>
      )}
    </div>
  )
}
