// The bar under a document's header: the version that's shown.
import type { DocDetail, RenderedDocVersion } from "@huntaway/contracts"
import { Ago, Button } from "../../ui"
import { PublishedState } from "../HostedDocs"
import { Publisher } from "./chrome"

/** The version that's shown: its message, who published it, and whether there's a later one. */
export function VersionBar({
  shown,
  detail,
  version,
  latest,
  onLatest,
}: {
  shown: RenderedDocVersion
  detail: DocDetail | undefined
  /** The version the route names, if it names one. */
  version: number | undefined
  latest: number | undefined
  onLatest: () => void
}) {
  return (
    <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-1 border-b border-line px-5 py-2 text-[12.5px] narrow:px-3" aria-label="This version">
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
          <Button size="sm" onClick={onLatest}>
            Read the latest
          </Button>
        </span>
      )}
    </div>
  )
}
