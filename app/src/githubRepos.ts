import type { GithubRepo } from "./api";

/** A profile's clone folder when it hasn't picked one: `~/<name>`, as the server has it (db::default_clone_dir). */
export function defaultCloneDir(name: string) {
  const n = name.trim().replaceAll("/", "-");
  return !n || n === "." || n === ".." ? "~" : `~/${n}`;
}

/** Where a repository named `name` is cloned in the folder `dir`: a folder named after it. */
export const clonePath = (dir: string, name: string) => `${dir.trim().replace(/\/+$/, "")}/${name}`;

/**
 * `OWNER/REPO` from what's typed or pasted: itself, or a github.com URL (`https://github.com/o/r/…`,
 * `git@github.com:o/r.git`). As the server takes it (github::check_repo).
 */
export function repoFromInput(text: string): string | null {
  let t = text.trim();
  const url = t.match(/^(?:https?:\/\/(?:www\.)?github\.com\/|(?:ssh:\/\/)?git@(?:ssh\.)?github\.com(?::\d+)?[:/])(.*)$/i);
  if (url) t = url[1].split(/[?#]/)[0].split("/").slice(0, 2).join("/");
  const m = t.match(/^([A-Za-z0-9][A-Za-z0-9_.-]{0,99})\/([A-Za-z0-9_.-]{1,100})$/);
  const name = m?.[2].replace(/\.git$/, "");
  return m && name && name !== "." && name !== ".." ? `${m[1]}/${name}` : null;
}

/** The repositories with every word of `query` in their `OWNER/NAME`, in the order they're in. */
export function filterRepos(repos: GithubRepo[], query: string) {
  const words = query.toLowerCase().split(/[\s/]+/).filter(Boolean);
  return repos.filter((r) => words.every((w) => r.full_name.toLowerCase().includes(w)));
}

/** `listed`, then the ones in `found` that aren't among them. */
export function mergeRepos(listed: GithubRepo[], found: GithubRepo[]) {
  const seen = new Set(listed.map((r) => r.full_name.toLowerCase()));
  return [...listed, ...found.filter((r) => !seen.has(r.full_name.toLowerCase()))];
}

const SOURCE_KEY = "ia.newProjectSource";

/** Where the new project dialog adds a project from: a folder on the host, or a GitHub repository it clones. */
export type ProjectSource = "folder" | "github";

/** The source picked last in this browser. */
export function loadProjectSource(): ProjectSource {
  try {
    return localStorage.getItem(SOURCE_KEY) === "github" ? "github" : "folder";
  } catch {
    return "folder";
  }
}

export function saveProjectSource(source: ProjectSource) {
  try {
    localStorage.setItem(SOURCE_KEY, source);
  } catch {
    // It's only remembered for this dialog then.
  }
}
