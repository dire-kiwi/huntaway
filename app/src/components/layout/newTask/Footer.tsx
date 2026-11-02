import { Button, ModalFooter, SUBMIT_KEYS, Toggle } from "../../ui";
import type { Blocks } from "./blocks";
import type { DraftExtras } from "./useDraft";
import type { Options } from "./useOptions";
import type { Submit } from "./useSubmit";
import type { Tokens } from "./useTokens";

/** The error, "Add another" and the task just created with it, and the buttons, whose label says what's created. */
export function Footer({
  submission: { err, created, busy },
  options: { addAnother, changeAddAnother, start },
  tok: { deps, dependsOn, many, runs, noun },
  kept: { attach, hasContent },
  blocks: { submitBlock },
  onClose,
}: {
  submission: Submit;
  options: Options;
  tok: Tokens;
  kept: DraftExtras;
  blocks: Blocks;
  onClose: () => void;
}) {
  return (
    <ModalFooter className="space-y-3">
      {err && <div className="text-xs text-red-400">{err}</div>}
      <div className="-mx-4 flex items-center justify-end gap-2 border-t border-line px-4 pt-4">
        <span className="mr-auto flex min-w-0 items-center gap-3">
          <Toggle checked={addAnother} onChange={changeAddAnother} label="Add another" />
          {created && (
            <span className="truncate text-xs text-muted" title={created.title}>
              Created {created.key}
            </span>
          )}
        </span>
        <Button type="button" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" variant="primary" disabled={busy || attach.uploading || !hasContent || !!submitBlock}>
          {many
            ? start && deps && dependsOn.length
              ? `Create & queue ${runs.length}`
              : start
                ? `Create & start ${runs.length}`
                : `Create ${runs.length} ${noun}s`
            : start && deps && dependsOn.length
              ? "Create & queue"
              : start
                ? "Create & start"
                : `Create ${noun}`}
          <span className="translate-y-px text-[11px] font-normal text-white/60 touch:hidden">{SUBMIT_KEYS}</span>
        </Button>
      </div>
    </ModalFooter>
  );
}
