import clsx from "clsx";
import { ArrowUp, Folder, FolderGit2 } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { api, hostSupports, type DirListing } from "../../api";
import { useHost } from "../../store";
import { Input } from "../ui";

const withSlash = (p: string) => (p.endsWith("/") ? p : p + "/");

function commonPrefix(names: string[]) {
  let out = names[0] ?? "";
  for (const n of names) while (!n.startsWith(out)) out = out.slice(0, -1);
  return out;
}

type DirEntry = DirListing["entries"][number];

/** Browse directories on a host. The listing follows what's typed: it shows the folder up to the
 *  last `/`, filtered by the rest. Tab or Enter completes, arrows pick, and `~/` expands. */
export function DirPicker({ hostId, value, onChange }: { hostId: string; value: string; onChange: (v: string) => void }) {
  const host = useHost(hostId);
  const [loaded, setLoaded] = useState<{ dir: string; listing?: DirListing; err?: string } | null>(null);
  const [active, setActive] = useState(-1);
  const valueRef = useRef(value);
  valueRef.current = value;
  const listRef = useRef<HTMLDivElement>(null);
  const slash = value.lastIndexOf("/");
  const dir = value.slice(0, slash + 1);
  const prefix = value.slice(slash + 1);

  // Start in the host's home folder.
  useEffect(() => {
    setLoaded(null);
    api.dirs(hostId).then(
      (l) => onChange(withSlash(l.path)),
      (e) => setLoaded({ dir: "", err: e.message }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId]);

  useEffect(() => {
    if (!dir) return;
    let stale = false;
    const t = setTimeout(
      () =>
        api.dirs(hostId, dir).then(
          (l) => {
            if (stale) return;
            if (dir.startsWith("~")) {
              // Expand ~ in place, keeping whatever was typed after the folder.
              const abs = withSlash(l.path);
              setLoaded({ dir: abs, listing: l });
              onChange(abs + valueRef.current.slice(dir.length));
            } else {
              setLoaded({ dir, listing: l });
            }
          },
          (e) => !stale && setLoaded({ dir, err: e.message }),
        ),
      120,
    );
    return () => {
      stale = true;
      clearTimeout(t);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [hostId, dir]);

  const current = loaded?.dir === dir ? loaded : null;
  const listing = current?.listing;
  const lower = prefix.toLowerCase();
  const matches = (listing?.entries ?? []).filter((e) => (!e.hidden || prefix.startsWith(".")) && e.name.toLowerCase().startsWith(lower));
  const exact = listing?.entries.find((e) => e.name === prefix);

  useEffect(() => {
    setActive(-1);
  }, [value]);
  useEffect(() => {
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const pick = (e: DirEntry | string) => onChange(withSlash(typeof e === "string" ? e : e.path));
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if ((e.key === "ArrowDown" || e.key === "ArrowUp") && matches.length) {
      e.preventDefault();
      const n = matches.length;
      setActive((a) => (e.key === "ArrowDown" ? (a + 1) % n : a <= 0 ? n - 1 : a - 1));
    } else if (e.key === "Tab" && !e.shiftKey && (active >= 0 || (prefix && matches.length))) {
      e.preventDefault();
      if (active >= 0) pick(matches[active]);
      else if (matches.length === 1) pick(matches[0]);
      else {
        const common = commonPrefix(matches.map((m) => m.name));
        if (common.length >= prefix.length) onChange(dir + common);
      }
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (active >= 0) pick(matches[active]);
      else if (exact) pick(exact);
    }
  };

  let status: string | null = null;
  if (listing && prefix !== "." && prefix !== "..") {
    const target = prefix ? exact : listing.exists === false ? undefined : listing;
    if (target) status = target.is_git ? "✓ Git repository. Tasks can use worktrees." : "Not a git repository. Worktrees are disabled.";
    else if (matches.length) status = "Tab to complete, or keep typing to name a new folder.";
    else if (hostSupports(host, 11)) status = "New folder. It's created when you add the project.";
    else status = "This folder doesn't exist.";
  }

  return (
    <div className="space-y-2">
      <Input
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="/path/to/repo"
        className="font-mono text-[12px]"
        autoFocus
        autoComplete="off"
        spellCheck={false}
      />
      <div ref={listRef} className="h-56 overflow-y-auto rounded-md border border-line bg-bg/60">
        {listing?.parent && !prefix && (
          <button
            type="button"
            onClick={() => pick(listing.parent!)}
            className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] text-muted hover:bg-white/[0.04]"
          >
            <ArrowUp size={13} /> ..
          </button>
        )}
        {matches.map((e, i) => (
          <button
            type="button"
            key={e.path}
            data-active={i === active}
            onClick={() => pick(e)}
            className={clsx("flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12.5px] hover:bg-white/[0.04]", i === active && "bg-white/[0.07]")}
          >
            {e.is_git ? <FolderGit2 size={13} className="text-accent" /> : <Folder size={13} className="text-faint" />}
            <span className={e.is_git ? "text-fg" : "text-muted"}>{e.name}</span>
          </button>
        ))}
        {current?.err && <div className="p-3 text-[12px] text-red-400">{current.err}</div>}
        {value && !dir && <div className="p-3 text-[12px] text-faint">Enter an absolute path, or start with ~/</div>}
      </div>
      {status && <div className="text-[11.5px] text-faint">{status}</div>}
    </div>
  );
}
