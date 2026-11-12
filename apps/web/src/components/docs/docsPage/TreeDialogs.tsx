// The dialogs a home's tree has open: moving a document, its labels, renaming a folder.
import { Effect } from "effect"
import { createPortal } from "react-dom"
import { ProfileId } from "@huntaway/contracts"
import { mutate } from "@huntaway/client"
import { labelPaths, renamedFolder, type DocLabel, type DocsHome } from "../docs"
import { FolderDialog } from "./FolderDialog"
import { LabelsDialog } from "./LabelsDialog"
import type { Row } from "./model"
import type { useClosed } from "./useClosed"
import type { useTreeDialogs } from "./useTreeDialogs"

/** The dialogs aren't rows: they go in the page's body, out of the table. */
export function TreeDialogs({
  dialogs: { moving, setMoving, labelling, setLabelling, renaming, setRenaming },
  home,
  folders,
  labels,
  closed,
  remember,
}: {
  dialogs: ReturnType<typeof useTreeDialogs>
  home: DocsHome
  /** Every folder's path, to suggest. */
  folders: string[]
  /** The tree of the documents' labels, to suggest. */
  labels: DocLabel<Row>
  closed: ReturnType<typeof useClosed>["closed"]
  remember: ReturnType<typeof useClosed>["remember"]
}) {
  const profile_id = ProfileId.make(home.profileId)
  return (
    <>
      {moving &&
        createPortal(
          <FolderDialog
            title={`Move “${moving.title}”`}
            initial={moving.folder ?? ""}
            folders={folders}
            action="Move"
            hint="A folder's path, like Huntaway/plans: a new one makes a folder. Empty for the top level. The document's address stays the same."
            onSave={(folder) => mutate("docs.update", home.hostId, { profile_id, slug: moving.slug, patch: { folder } })}
            onClose={() => setMoving(null)}
          />,
          document.body,
        )}
      {labelling &&
        createPortal(
          <LabelsDialog
            title={`Labels of “${labelling.title}”`}
            initial={labelling.labels ?? []}
            suggested={labelPaths(labels)}
            onSave={(next) => mutate("docs.update", home.hostId, { profile_id, slug: labelling.slug, patch: { labels: next } })}
            onClose={() => setLabelling(null)}
          />,
          document.body,
        )}
      {renaming !== null &&
        createPortal(
          <FolderDialog
            title={`Rename “${renaming}”`}
            initial={renaming}
            folders={folders.filter((f) => renamedFolder(f, renaming, "") === null)}
            action="Rename"
            hint="Every document in it, and in the folders inside it, moves with it. A path like Huntaway/docs puts it in another folder; empty moves what's in it to the top level."
            onSave={(to) =>
              mutate("docs.renameFolder", home.hostId, { profile_id, from: renaming, to }).pipe(
                // A closed folder stays closed under its new name.
                Effect.tap(() => Effect.sync(() => remember(new Set([...closed].map((c) => renamedFolder(c, renaming, to) ?? c).filter(Boolean))))),
              )
            }
            onClose={() => setRenaming(null)}
          />,
          document.body,
        )}
    </>
  )
}
