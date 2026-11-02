import { on } from "./http";

/** A GitHub repository gh can reach on a host, which a new project can be cloned from (API 55). */
export interface GithubRepo {
  /** `OWNER/NAME`. */
  full_name: string;
  name: string;
  description: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  pushed_at: string | null;
  url: string | null;
}

/** The repositories an account can clone, or why there are none (`error`). `account` is who gh acts as. */
export interface GithubRepoList {
  account: string | null;
  repos: GithubRepo[];
  error: string | null;
}

/** A GitHub account gh is signed in to on a host (API 50). `account` is what a profile or project saves. */
export interface GithubAccount {
  account: string;
  host: string;
  login: string;
  /** The account gh uses by default on its host. */
  active: boolean;
  /** Whether gh's login for it works. */
  ok: boolean;
}

export const githubApi = {
  /** The GitHub accounts gh is signed in to on the host (API 50); `error` says why there are none. */
  githubAccounts: (h: string) => on(h).get<{ accounts: GithubAccount[]; error: string | null }>("/github-accounts"),
  /**
   * The GitHub repositories `account` (gh's active one when null) can clone on the host (API 55): the ones it owns or collaborates on,
   * most recently pushed first, or with `q` the ones named like it among those and its organizations'.
   */
  githubRepos: (h: string, account: string | null, q?: string) => {
    const params = new URLSearchParams();
    if (account) params.set("account", account);
    if (q) params.set("q", q);
    const query = params.toString();
    return on(h).get<GithubRepoList>(`/github-repos${query ? `?${query}` : ""}`);
  },
};
