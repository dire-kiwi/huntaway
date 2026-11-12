// The Docs page's list: every document of the profile's, by folder or by label.
import { useAtom, useAtomValue } from "@effect/atom-react"
import { clsx } from "clsx"
import { Exit, Schema } from "effect"
import { Folder, Loader2, Tag } from "lucide-react"
import { ProfileId } from "@huntaway/contracts"
import type { DocsHome, DocsView } from "../docs"
import { href } from "../../../router"
import { useBoard } from "../../../state/board"
import { exitError, useMutation } from "../../../state/mutation"
import { storedBare } from "../../../state/storage"
import { useConfirm } from "../../ui"
import { HostedDocsButton } from "../HostedDocs"
import { Header, NoHomes } from "./chrome"
import { HomeTree } from "./HomeTree"
import type { Row } from "./model"
import { docsListAtom } from "./reads"

/** How the Docs page shows documents (HA-324): the user's choice, kept in this browser. */
const viewAtom = storedBare("ia.docs.view", Schema.Literals(["folders", "labels"]), "folders")

/**
 * Every document of the profile's, on each of its hosts, as a tree of their folders (HA-290): folders first, then
 * documents, each one entry however many pages it has. With several hosts, each has a tree of its own, under its name.
 * Read again on the hosts' `docs` and `docs_site` events, and after a change made here.
 */
export function DocsList({ segment, name, homes }: { segment: string; name: string; homes: DocsHome[] }) {
  const { rows, error } = useAtomValue(docsListAtom(homes))
  const hosts = useBoard((s) => s.hosts)
  const { ask, dialog } = useConfirm()
  // By folder or by label (HA-324): every host has labels (6.3).
  const labelled = homes.length > 0
  const [chosen, pickView] = useAtom(viewAtom)
  const view: DocsView = labelled ? chosen : "folders"
  const [, del] = useMutation("docs.delete")

  // A document's link names its profile by id where the name stands for several hosts' profiles.
  const docLink = (d: Row) => href({ name: "docs", profile: homes.length > 1 ? d.profileId : segment, slug: d.slug, page: "" })
  const remove = (d: Row) =>
    ask({
      title: `Delete “${d.title}”?`,
      body: `Its ${d.latest_version === 1 ? "version" : `${d.latest_version} versions`} and every page in them are deleted. Agents' links to it stop working.`,
      action: "Delete",
      danger: true,
      // The dialog shows why it failed, and stays open.
      onConfirm: () =>
        del(d.hostId, { profile_id: ProfileId.make(d.profileId), slug: d.slug }).then((exit) =>
          Exit.isSuccess(exit) ? undefined : Promise.reject(new Error(exitError(exit) ?? "")),
        ),
    })

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
            {labelled && !!rows?.length && (
              <div
                className="mb-3 flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5"
                role="radiogroup"
                aria-label="Show documents by"
              >
                {(["folders", "labels"] as const).map((v) => (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={view === v}
                    onClick={() => pickView(v)}
                    className={clsx(
                      "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]",
                      view === v ? "bg-raised text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {v === "folders" ? <Folder size={13} /> : <Tag size={13} />}
                    {v === "folders" ? "Folders" : "Labels"}
                  </button>
                ))}
              </div>
            )}
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
                    <th className="w-[34%] py-2 pr-3 font-semibold narrow:w-auto">Document</th>
                    <th className="w-[9%] py-2 pr-3 font-semibold narrow:hidden">Version</th>
                    <th className="w-[13%] py-2 pr-3 font-semibold narrow:w-20">Updated</th>
                    <th className="py-2 pr-3 font-semibold narrow:hidden">Published by</th>
                    <th className="w-24 py-2 narrow:w-28" />
                  </tr>
                </thead>
                {homes.map((h) => {
                  const mine = rows.filter((d) => d.hostId === h.hostId && d.profileId === h.profileId)
                  if (!mine.length && homes.length > 1) return null
                  const host = hosts.find((x) => x.id === h.hostId)
                  return (
                    <HomeTree
                      key={`${h.hostId}\n${h.profileId}`}
                      home={h}
                      rows={mine}
                      view={view}
                      label={homes.length > 1 ? (host?.name ?? h.hostId) : undefined}
                      editable
                      labelsEditable
                      docLink={docLink}
                      onRemove={remove}
                    />
                  )
                })}
              </table>
            )}
          </div>
        </div>
      )}
      {dialog}
    </div>
  )
}

/** A connection button for each of the homes whose host can publish to hosted docs, named by host when there are several. */
function HostedDocsButtons({ homes }: { homes: DocsHome[] }) {
  const hosts = useBoard((s) => s.hosts)
  const able = homes
  return (
    <div className="no-drag ml-auto flex shrink-0 items-center gap-1">
      {able.map((h) => (
        <HostedDocsButton key={`${h.hostId}\n${h.profileId}`} home={h} label={able.length > 1 ? hosts.find((x) => x.id === h.hostId)?.name : undefined} />
      ))}
    </div>
  )
}
