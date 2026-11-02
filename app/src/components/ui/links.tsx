import clsx from "clsx";
import { Check, GitBranch, GitPullRequest } from "lucide-react";
import { useEffect, useState } from "react";
import type { Task } from "../../api";
import { usePreviewUp } from "./preview";

/** A task in review with a preview URL: polled while shown, the dot is green once it answers 200. */
export const showsPreview = (t: Task) => t.status === "in_review" && !!t.preview_url;

/** Green when the preview answers 200, yellow until then. Links to it. */
export function PreviewDot({ url, label, className }: { url: string; label?: boolean; className?: string }) {
  const up = usePreviewUp(url);
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={up ? `Preview is up: ${url}` : `Preview isn't running yet: ${url}`}
      className={clsx("inline-flex shrink-0 items-center gap-1 hover:text-fg", className)}
    >
      <span className={clsx("inline-block h-2 w-2 rounded-full", up ? "bg-emerald-400" : "bg-amber-400")} />
      {label && <span>preview</span>}
    </a>
  );
}

/** Copy text, also where the async clipboard API is missing (plain HTTP on the LAN). */
export function copyText(text: string) {
  if (navigator.clipboard && window.isSecureContext) {
    navigator.clipboard.writeText(text).catch(() => {});
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  const focused = document.activeElement as HTMLElement | null;
  document.body.appendChild(ta);
  ta.select();
  try {
    document.execCommand("copy");
  } catch {
    /* ignore */
  }
  ta.remove();
  focused?.focus();
}

/** A task's branch as just an icon: hover shows it, a click copies it. */
export function BranchIcon({ branch, className }: { branch: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const t = setTimeout(() => setCopied(false), 1200);
    return () => clearTimeout(t);
  }, [copied]);
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        copyText(branch);
        setCopied(true);
      }}
      title={copied ? `Copied ${branch}` : `${branch} (click to copy)`}
      className={clsx("inline-flex shrink-0 items-center hover:text-fg", copied ? "text-st-done" : className)}
    >
      {copied ? <Check size={11} /> : <GitBranch size={11} />}
    </button>
  );
}

/** "#12" for a GitHub-style pull request URL, else the URL. */
export const prLabel = (url: string) => {
  const n = url.match(/\/pull\/(\d+)/)?.[1];
  return n ? `#${n}` : url;
};

/** A task's pull request as an icon (with `label`, also its number) that links to it. */
export function PrIcon({ url, label, className }: { url: string; label?: boolean; className?: string }) {
  return (
    <a
      href={url}
      target="_blank"
      rel="noreferrer"
      onClick={(e) => e.stopPropagation()}
      title={`Pull request ${prLabel(url)}: ${url}`}
      className={clsx("inline-flex shrink-0 items-center gap-1 hover:text-fg", className)}
    >
      <GitPullRequest size={11} />
      {label && <span>{prLabel(url)}</span>}
    </a>
  );
}
