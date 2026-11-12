import { toJson } from "../../ui/json"
import { useEffect, useState } from "react"
import { type AttachmentRef } from "@huntaway/client"
import type { ExternalLink } from "@huntaway/contracts"
import { usesAsana } from "../../task/ExternalLinks"
import type { Draft } from "./draft"
import type { AgentChoice } from "./useAgentChoice"
import type { EditorText } from "./useEditorText"
import type { Tokens } from "./useTokens"
import type { Origin, Where } from "./useWhere"

export type DraftExtras = ReturnType<typeof useDraft>

/**
 * The files being attached (task/Attachments' `useAttachmentDraft`): not yet on this server's new task dialog, which
 * attaches nothing until the task view's attachments come over (M2). A draft's saved files are kept in it as they were.
 */
export interface AttachmentDraft {
  readonly enabled: boolean
  readonly items: ReadonlyArray<{ key: string; name: string; ref?: AttachmentRef | undefined }>
  readonly dragging: boolean
  readonly files: ReadonlyArray<AttachmentRef>
  readonly uploading: boolean
  readonly clear: () => void
  readonly restore: (refs: ReadonlyArray<AttachmentRef>) => void
  readonly onPaste?: undefined
  readonly dropProps: object
}

const noAttachments = (files: ReadonlyArray<AttachmentRef>): AttachmentDraft => ({
  enabled: false,
  items: [],
  dragging: false,
  files,
  uploading: false,
  clear: () => {},
  restore: () => {},
  dropProps: {},
})

/** The files and Asana tasks it's for, and the draft (with them) kept in localStorage as it's written. */
export function useDraft({ draft, saved }: Origin, _where: Where, { profile }: AgentChoice, { description }: EditorText, { text, pending }: Tokens) {
  const attach = noAttachments(saved?.files ?? [])
  // The Asana tasks it's for, in the profile it goes in, unless that has Asana turned off (6.11).
  const linking = usesAsana(profile)
  const [links, setLinks] = useState<ExternalLink[]>(saved?.links ?? [])
  const [pickingLink, setPickingLink] = useState(false)
  const hasContent = !!text.trim() || attach.items.length > 0
  // Saved as it's written, tokens and all (and when it's only tokens, the options they pick). Files still uploading are left out until they're on the host.
  const draftJson =
    description.trim() || attach.files.length || links.length || pending
      ? toJson({ v: 2, description, files: [...attach.files], links, ...(pending ? { fanout: pending } : {}) } satisfies Draft)
      : null
  useEffect(() => {
    if (draftJson) localStorage.setItem(draft, draftJson)
    else localStorage.removeItem(draft)
  }, [draft, draftJson])
  return { attach, linking, links, setLinks, pickingLink, setPickingLink, hasContent }
}
