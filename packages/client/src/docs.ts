import { enc, type Http } from "./http";
import { type Host, hostSupports } from "./hosts";

/** Docs (API 124): each profile's documents, which its agents publish through the run's `docs` MCP server, with versions
 *  and pages (see apps/server/src/api/docs.ts). */
export const DOCS_API = 124;

export const hasDocs = (h: Host | undefined) => hostSupports(h, DOCS_API);

/** Hosted docs (API 125, HA-282): a profile connects to a docs site and publishes its documents there. */
export const HOSTED_DOCS_API = 125;

export const hasHostedDocs = (h: Host | undefined) => hostSupports(h, HOSTED_DOCS_API);

/** Where a document went on the profile's docs site: its slug there, and the last version published (the site's and the local one). */
export type DocPublished = {
  site_url: string;
  remote_slug: string;
  remote_version: number;
  local_version: number;
  url: string;
  version_url: string;
  /** The site's username it was published as, if it was known (HA-286; missing from hosts before it). */
  login?: string | null;
  published_at: string;
};

/** A profile's connection to its docs site (never its tokens), and the device sign-in under way, if any. */
export type HostedDocsStatus = {
  default_site_url: string;
  site_url: string;
  connected: boolean;
  kind: "oauth" | "token" | null;
  /** The site's username, once it's known (from the profile's documents there). */
  login: string | null;
  connected_at: string | null;
  pending: {
    site_url: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string | null;
    expires_at: string;
    /** Why it stopped: denied, expired or failed. */
    error: string | null;
  } | null;
};

export type DocPublishResult = { published: DocPublished; warnings: { page: string; warning: string }[] };

/** The site's document at the slug a publish with `ask` would have added a version to (HA-286), for the user to confirm. */
export type DocPublishExists = { slug: string; title: string; latest_version: number | null; url: string | null; owner: string | null };

export type DocSummary = {
  profile_id: string;
  slug: string;
  title: string;
  created_at: string;
  updated_at: string;
  latest_version: number;
  /** How many pages its latest version has. */
  page_count: number;
  /** The task that published its latest version, if it's still there (HA-281: missing from hosts before it). */
  task?: DocPublisher | null;
  /** Where it was published on the profile's docs site (HA-282: missing from hosts before it). */
  published?: DocPublished | null;
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
  /**
   * A version's pages, rendered (`version` a number or `latest`); `path` for only one, `first` for only the first (or, with
   * `path`, the first if there's no such page; hosts before HA-286 give all of them), `baseUrl` for links other than
   * the board's own.
   */
  docVersion: (h: string, profileId: string, slug: string, version: number | "latest", o: { path?: string; first?: boolean; baseUrl?: string } = {}) => {
    const q = new URLSearchParams();
    if (o.path !== undefined) q.set("path", o.path);
    if (o.first) q.set("first", "1");
    if (o.baseUrl !== undefined) q.set("base_url", o.baseUrl);
    const qs = q.toString();
    return on(h).get<RenderedDocVersion>(`/profiles/${enc(profileId)}/docs/${enc(slug)}/versions/${version}${qs ? `?${qs}` : ""}`);
  },
  deleteDoc: (h: string, profileId: string, slug: string) => on(h).del(`/profiles/${enc(profileId)}/docs/${enc(slug)}`),
  hostedDocs: (h: string, profileId: string) => on(h).get<HostedDocsStatus>(`/profiles/${enc(profileId)}/hosted_docs`),
  /** Start a device sign-in to the docs site at `siteUrl`. */
  hostedDocsSignIn: (h: string, profileId: string, siteUrl: string) =>
    on(h).post<HostedDocsStatus>(`/profiles/${enc(profileId)}/hosted_docs/device`, { site_url: siteUrl }),
  hostedDocsCancelSignIn: (h: string, profileId: string) => on(h).del<HostedDocsStatus>(`/profiles/${enc(profileId)}/hosted_docs/device`),
  /** Connect with a personal access token from the site's Access page. */
  hostedDocsToken: (h: string, profileId: string, siteUrl: string, token: string) =>
    on(h).post<HostedDocsStatus>(`/profiles/${enc(profileId)}/hosted_docs/token`, { site_url: siteUrl, token }),
  hostedDocsDisconnect: (h: string, profileId: string) => on(h).del<HostedDocsStatus>(`/profiles/${enc(profileId)}/hosted_docs`),
  /**
   * Publish a version (the latest by default) to the profile's docs site; `slug` is the remote one (by default the one
   * it went to, else the local one; another re-targets it). With `ask`, a host since HA-286 answers `{exists}` instead
   * of adding to a document of the user's at a slug it wasn't published to.
   */
  publishDoc: (h: string, profileId: string, slug: string, o: { version?: number; slug?: string; ask?: boolean } = {}) =>
    on(h).post<DocPublishResult | { exists: DocPublishExists }>(`/profiles/${enc(profileId)}/docs/${enc(slug)}/publish`, o),
});
