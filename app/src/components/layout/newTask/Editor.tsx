import clsx from "clsx";
import type { ReactNode } from "react";
import type { AttachmentDraft } from "../../task/Attachments";
import type { Completion } from "./useCompletion";
import type { EditorLayout } from "./useEditorLayout";
import type { EditorText } from "./useEditorText";
import type { Tokens } from "./useTokens";
import type { Where } from "./useWhere";
import { TOKEN_HELP } from "./words";

// The editor's text and the highlighting behind it are laid out alike, so the highlights line up with what's typed.
const EDITOR_TEXT = "m-0 px-2.5 py-2 text-[13px] leading-[1.6] whitespace-pre-wrap break-words";

/** The description, with its tokens highlighted behind it and the completion list for the one being typed. */
export function Editor({
  ed,
  completion,
  layout,
  where: { noProject, asGroup },
  tok: { tokens, taskType, docType, asSubproject },
  attach,
}: {
  ed: EditorText;
  completion: Completion;
  layout: EditorLayout;
  where: Where;
  tok: Tokens;
  attach: AttachmentDraft;
}) {
  const { description, setDescription, input, setCaret, setFocused, setClosedAt, completing, found } = ed;
  const { matches, listOpen, setHl, lit, pick, tokenHint } = completion;
  const { mirror, marker, list, setScrolled } = layout;
  const highlighted: ReactNode[] = [];
  {
    let at = 0;
    const marks = [...found.map((t) => ({ at: t.start, token: t })), ...(listOpen ? [{ at: completing!.start, token: null }] : [])].sort((a, b) => a.at - b.at || (a.token ? 1 : -1));
    for (const { token: t, at: s } of marks) {
      highlighted.push(description.slice(at, s));
      if (!t) {
        highlighted.push(<span key="caret" ref={marker} />);
        at = s;
        continue;
      }
      const known = tokens.find((x) => x.start === t.start);
      // The token being typed isn't marked until it's settled.
      const settled = !!known;
      highlighted.push(
        <span
          key={t.start}
          className={clsx(
            settled && "rounded-[3px]",
            known?.value !== undefined ? "bg-accent/20 text-[#c8c8ff] ring-1 ring-accent/30" : settled && "bg-amber-500/10 text-amber-300 ring-1 ring-amber-500/30",
          )}
        >
          {description.slice(t.start, t.end)}
        </span>,
      );
      at = t.end;
    }
    highlighted.push(description.slice(at));
  }

  return (
    <div
      className={clsx(
        "relative rounded-md border border-line bg-panel focus-within:border-accent/60 focus-within:ring-2 focus-within:ring-accent/15",
        attach.dragging && "border-accent/60 bg-accent/5",
      )}
    >
      <div ref={mirror} aria-hidden className={clsx(EDITOR_TEXT, "pointer-events-none absolute top-0 left-0 overflow-hidden text-fg")}>
        {highlighted}
        {"\n"}
      </div>
      <textarea
        ref={input}
        autoFocus
        rows={8}
        spellCheck={false}
        aria-label="Description"
        placeholder={`${
          noProject
            ? "Ask anything, or describe what to try out or look into (markdown). Its agent works in its own folder, with no repository, and can use the board."
            : taskType === "scratch"
              ? "Ask anything about the project, or describe what to look into or try out (markdown). Its agent works in its own folder, reads the repository and can use the board."
              : docType === "plan"
                ? "Describe what to plan. Its agent looks into it and writes an HTML plan that you iterate on together (markdown)."
                : docType === "artifact"
                  ? "Describe the artifact: what it's for and what it should show or do (markdown). Its agent designs it as an HTML page, kept and shown in the task."
                  : docType === "diagram"
                    ? "Describe what to diagram: the flow, structure or sequence to show (markdown). Its agent draws it as a Mermaid diagram."
                    : asGroup
                      ? "Describe the work. Its agent plans it across the group's projects and creates their tasks (markdown)."
                      : asSubproject
                        ? "Describe the subproject. Its agent plans it as a series of small tasks, which merge into its branch (markdown)."
                        : "Describe the task. This becomes the agent's instructions (markdown), and a title is written from it."
        } ${tokenHint}`}
        value={description}
        onChange={(e) => {
          setHl(0);
          setDescription(e.target.value);
          setCaret(e.target.selectionStart);
          setClosedAt(null);
        }}
        onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onScroll={(e) => {
          if (mirror.current) mirror.current.scrollTop = e.currentTarget.scrollTop;
          setScrolled(e.currentTarget.scrollTop);
        }}
        onKeyDown={(e) => {
          if (!listOpen || e.nativeEvent.isComposing) return;
          if (e.key === "ArrowDown" || e.key === "ArrowUp") {
            e.preventDefault();
            setHl((lit + (e.key === "ArrowDown" ? 1 : -1) + matches.length) % matches.length);
          } else if ((e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) || (e.key === "Tab" && !e.shiftKey)) {
            e.preventDefault();
            pick(matches[lit]);
          } else if (e.key === "Escape") {
            // Closes the list, not the dialog.
            e.preventDefault();
            e.stopPropagation();
            setClosedAt(completing!.start);
          }
        }}
        onPaste={attach.onPaste}
        className={clsx(EDITOR_TEXT, "relative block w-full resize-y bg-transparent text-transparent caret-fg outline-none selection:bg-accent/30 placeholder:text-faint")}
      />
      {listOpen && (
        <div
          ref={list}
          role="listbox"
          aria-label={TOKEN_HELP.find((h) => h.prefix === completing!.prefix)!.what}
          className="fixed z-10 w-72 overflow-y-auto rounded-lg border border-line-strong bg-panel-2 p-1 shadow-xl shadow-black/50"
          // Keeps the editor focused, so picking doesn't close the list first.
          onMouseDown={(e) => e.preventDefault()}
        >
          <div className="px-2 pt-1 pb-1 text-[10.5px] font-semibold tracking-wider text-faint uppercase">
            {{ "/": "Type or label", "@": "Where it goes", "!": "Model", "^": "Effort", "#": "Depends on", "from:": "Starts from" }[completing!.prefix]}
          </div>
          {matches.map((s, i) => (
            <button
              key={s.value}
              type="button"
              role="option"
              aria-selected={i === lit}
              title={s.hint}
              onMouseEnter={() => setHl(i)}
              onClick={() => pick(s)}
              className={clsx("flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[12.5px]", i === lit ? "bg-raised text-fg" : "text-muted")}
            >
              <code className="shrink-0 font-mono text-[12px] text-accent">
                {completing!.prefix}
                {s.value}
              </code>
              <span className="truncate">{s.label}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

/** The prefixes that can set something here, with an example of each: a click types it at the caret. */
export function Legend({ completion: { help, example, typePrefix } }: { completion: Completion }) {
  return (
    <div className="flex flex-wrap gap-x-3.5 gap-y-1 text-[11.5px] text-faint">
      {help.map((h) => (
        <button key={h.prefix} type="button" className="hover:text-muted" title={`Type ${h.prefix} for ${h.asks}`} onClick={() => typePrefix(h.prefix)}>
          <code className="font-mono text-muted">
            {h.prefix}
            {example[h.prefix]}
          </code>{" "}
          {h.what}
        </button>
      ))}
    </div>
  );
}
