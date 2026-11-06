import { useEffect, useState } from "react";
import { hostSupports, type ExternalLink } from "../../../api";
import { useAttachmentDraft } from "../../task/Attachments";
import { LINKS_API, usesAsana } from "../../task/ExternalLinks";
import type { Draft } from "./draft";
import type { AgentChoice } from "./useAgentChoice";
import type { EditorText } from "./useEditorText";
import type { Tokens } from "./useTokens";
import type { Origin, Where } from "./useWhere";

export type DraftExtras = ReturnType<typeof useDraft>;

/** The files and Asana tasks it's for, and the draft (with them) kept in localStorage as it's written. */
export function useDraft({ draft, saved }: Origin, { target, host }: Where, { profile }: AgentChoice, { description }: EditorText, { text, pending }: Tokens) {
  const attach = useAttachmentDraft(target.host_id, hostSupports(host, 18), saved?.files);
  // The Asana tasks it's for (API 57), in the profile it goes in, unless that has Asana turned off.
  const linking = hostSupports(host, LINKS_API) && usesAsana(profile);
  const [links, setLinks] = useState<ExternalLink[]>(saved?.links ?? []);
  const [pickingLink, setPickingLink] = useState(false);
  const hasContent = !!text.trim() || attach.items.length > 0;
  // Saved as it's written, tokens and all (and when it's only tokens, the options they pick). Files still uploading are left out until they're on the host.
  const draftJson =
    description.trim() || attach.files.length || links.length || pending
      ? JSON.stringify({ description, files: attach.files, links, ...(pending ? { fanout: pending } : {}) } satisfies Draft)
      : null;
  useEffect(() => {
    if (draftJson) localStorage.setItem(draft, draftJson);
    else localStorage.removeItem(draft);
  }, [draft, draftJson]);
  return { attach, linking, links, setLinks, pickingLink, setPickingLink, hasContent };
}
