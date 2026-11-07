import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";

/** Docs (API 124): each profile's documents, which its agents publish through the run's `docs` MCP server, with versions
 *  and pages (see apps/server/src/api/docs.ts). */
export const DOCS_API = 124;

export const hasDocs = (h: Host | undefined) => hostSupports(h, DOCS_API);

export type DocSummary = {
  profile_id: string;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  latest_version: number;
  /** How many pages its latest version has. */
  pages: number;
};

/** The task that published a version, if it's still there. */
export type DocPublisher = { id: string; title: string; key: string | null };

export type DocVersion = {
  number: number;
  message: string | null;
  task_id: string | null;
  run_id: string | null;
  created_at: string;
  task: DocPublisher | null;
};

export type DocPageSummary = { path: string; title: string; format: "md" | "mdx"; position: number };

export type DocDetail = DocSummary & { versions: DocVersion[]; pages: DocPageSummary[] };

export type DocNavNode = { segment: string; title: string; page: string | null; children: DocNavNode[] };

export type RenderedDocPage = {
  path: string;
  title: string;
  format: "md" | "mdx";
  /** Its URL under the version's `base_url` (`plan/` for `plan/index`, `` for `index`). */
  url_suffix: string;
  html: string | null;
  toc: { depth: number; id: string; text: string }[];
  has_h1: boolean;
  warnings: string[];
  /** Why it couldn't be rendered, if it couldn't. */
  error: string | null;
};

export type RenderedDocVersion = {
  slug: string;
  title: string;
  number: number;
  latest_version: number;
  message: string | null;
  created_at: string;
  task: DocPublisher | null;
  /** What relative links between its pages were rendered against. */
  base_url: string;
  nav: DocNavNode[];
  pages: RenderedDocPage[];
};

export const docsApi = ({ on }: Http) => ({
  docs: (h: string, profileId: string) => on(h).get<DocSummary[]>(`/profiles/${enc(profileId)}/docs`),
  doc: (h: string, profileId: string, slug: string) => on(h).get<DocDetail>(`/profiles/${enc(profileId)}/docs/${enc(slug)}`),
  /** A version's pages, rendered (`version` a number or `latest`); `path` for only one, `baseUrl` for links other than the board's own. */
  docVersion: (h: string, profileId: string, slug: string, version: number | "latest", o: { path?: string; baseUrl?: string } = {}) => {
    const q = new URLSearchParams();
    if (o.path !== undefined) q.set("path", o.path);
    if (o.baseUrl !== undefined) q.set("base_url", o.baseUrl);
    const qs = q.toString();
    return on(h).get<RenderedDocVersion>(`/profiles/${enc(profileId)}/docs/${enc(slug)}/versions/${version}${qs ? `?${qs}` : ""}`);
  },
  deleteDoc: (h: string, profileId: string, slug: string) => on(h).del(`/profiles/${enc(profileId)}/docs/${enc(slug)}`),
});
