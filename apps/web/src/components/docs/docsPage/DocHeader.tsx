// A document's header: where it is, its labels, its versions, and the comments and Publish buttons.
import { clsx } from "clsx"
import { BookOpen, ChevronRight, MessageSquare, Tag, Upload } from "lucide-react"
import type { DocDetail } from "@huntaway/contracts"
import { href } from "../../../router"
import { Button, IconButton } from "../../ui"
import { BackLink } from "./BackLink"
import { BoardLink, Header, LabelChips } from "./chrome"

export function DocHeader({
  from,
  profile,
  detail,
  title,
  page,
  selected,
  go,
  canLabel,
  onLabel,
  commenting,
  commentsShown,
  showComments,
  canPublish,
  onPublish,
}: {
  /** The page the document was opened from, if it was from one (cameFrom). */
  from: string | null
  /** The route's profile. */
  profile: string
  detail: DocDetail | undefined
  title: string
  page: string
  /** The version the menu shows as chosen. */
  selected: number | undefined
  go: (to: { version?: number | undefined; page?: string | undefined }) => void
  canLabel: boolean
  onLabel: () => void
  commenting: boolean
  commentsShown: boolean
  showComments: (on: boolean) => void
  canPublish: boolean
  onPublish: () => void
}) {
  return (
    <Header>
      {from && <BackLink from={from} />}
      <BoardLink to={href({ name: "docs", profile })} className="no-drag flex shrink-0 items-center gap-1.5 text-[13px] text-muted hover:text-fg">
        <BookOpen size={14} />
        Docs
      </BoardLink>
      <ChevronRight size={13} className="shrink-0 text-faint" />
      {detail?.folder && (
        <>
          <span className="max-w-[30%] shrink truncate text-[13px] text-muted" title={detail.folder} aria-label="Folder">
            {detail.folder}
          </span>
          <ChevronRight size={13} className="shrink-0 text-faint" />
        </>
      )}
      <h1 className="min-w-0 truncate text-[14px] font-semibold">{title}</h1>
      {!!detail?.labels?.length && <LabelChips labels={detail.labels} className="no-drag max-h-5 max-w-[30%] shrink overflow-hidden narrow:hidden" />}
      {detail && canLabel && (
        <IconButton className="no-drag shrink-0" title="Labels" onClick={onLabel}>
          <Tag size={14} />
        </IconButton>
      )}
      {detail && selected !== undefined && (
        <select
          aria-label="Version"
          className="no-drag ml-auto h-7 max-w-[45%] shrink-0 rounded-md border border-line bg-raised px-2 text-[12px] text-fg"
          value={selected}
          onChange={(e) => {
            const n = Number(e.target.value)
            go({ version: n === detail.latest_version ? undefined : n, page })
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
      {commenting && detail && (
        <IconButton
          className={clsx("no-drag shrink-0", commentsShown && "text-fg", !(detail && selected !== undefined) && "ml-auto")}
          title={commentsShown ? "Hide comments" : "Show comments"}
          aria-pressed={commentsShown}
          onClick={() => showComments(!commentsShown)}
        >
          <MessageSquare size={14} />
        </IconButton>
      )}
      {detail && selected !== undefined && canPublish && (
        <Button size="sm" className="no-drag shrink-0" onClick={onPublish} title={`Publish v${selected} to hosted docs`}>
          <Upload size={13} /> Publish
        </Button>
      )}
    </Header>
  )
}
