import { toJson } from "../../ui/json"
import { useEffect, useState } from "react"
import type { ComposerDraft } from "@huntaway/client"
import { Atom } from "effect/reactivity"
import type { ExternalLink } from "@huntaway/contracts"
import { useAttachmentDraft } from "../../task/Attachments"
import { usesAsana } from "../../task/ExternalLinks"
import type { Draft } from "./draft"
import type { AgentChoice } from "./useAgentChoice"
import type { EditorText } from "./useEditorText"
import type { Tokens } from "./useTokens"
import type { Origin, Where } from "./useWhere"

export type DraftExtras = ReturnType<typeof useDraft>

/** The files and Asana tasks it's for, and the draft (with them) kept in localStorage as it's written. */
export function useDraft({ draft, saved }: Origin, { target }: Where, { profile }: AgentChoice, { description }: EditorText, { text, pending }: Tokens) {
  // The files pasted, dropped or picked, uploaded to the host it goes on; a saved draft's are already there. Only the
  // files of this atom are used: the text is the dialog's own, kept in the draft below.
  const [files] = useState(() => Atom.make<ComposerDraft | null>({ text: "", files: saved?.files ?? [] }))
  const attach = useAttachmentDraft(target.host_id, files)
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
