import { Schema } from "effect"
import { Rpc, RpcGroup } from "effect/rpc"
import { Conflict, External, Invalid, NotFound } from "../errors.ts"
import { ProfileId } from "../ids.ts"
import { Project } from "../project.ts"
import { Auth, RequiredScope } from "../session.ts"

// 6.11: adding a project from GitHub (docs/plan/inventory/04-git-review.md §2.21, 06-integrations.md §2.5): the
// accounts gh is signed in to, the repositories one can clone, cloning one and creating one for a folder.

/** A GitHub repository gh can reach, which a new project can be cloned from. */
export const GithubRepo = Schema.Struct({
  /** `OWNER/NAME`. */
  full_name: Schema.String,
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  private: Schema.Boolean,
  fork: Schema.Boolean,
  archived: Schema.Boolean,
  pushed_at: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
})
export interface GithubRepo extends Schema.Schema.Type<typeof GithubRepo> {}

/** The repositories an account can clone, or why there are none (`error`). `account` is who gh acts as. */
export const GithubRepoList = Schema.Struct({
  account: Schema.NullOr(Schema.String),
  repos: Schema.Array(GithubRepo),
  error: Schema.NullOr(Schema.String),
})
export interface GithubRepoList extends Schema.Schema.Type<typeof GithubRepoList> {}

/** A GitHub account gh is signed in to on this host. `account` is what a profile or project saves. */
export const GithubAccount = Schema.Struct({
  account: Schema.String,
  host: Schema.String,
  login: Schema.String,
  /** The account gh uses by default on its host. */
  active: Schema.Boolean,
  /** Whether gh's login for it works. */
  ok: Schema.Boolean,
})
export interface GithubAccount extends Schema.Schema.Type<typeof GithubAccount> {}

/** The accounts gh is signed in to; `error` says why there are none. */
export const GithubAccounts = Schema.Struct({ accounts: Schema.Array(GithubAccount), error: Schema.NullOr(Schema.String) })
export interface GithubAccounts extends Schema.Schema.Type<typeof GithubAccounts> {}

/** What `projects.createOnGithub` made on GitHub. */
export const CreatedRepo = Schema.Struct({
  /** `OWNER/REPO`. */
  full_name: Schema.String,
  /** Whether the folder's commits were pushed to it (a folder without commits has none to push). */
  pushed: Schema.Boolean,
  /** Why they weren't, when the repository was made but the push failed. */
  push_error: Schema.NullOr(Schema.String),
})
export interface CreatedRepo extends Schema.Schema.Type<typeof CreatedRepo> {}

/** What `projects.clone` takes. */
export const CloneProject = Schema.Struct({
  profile_id: ProfileId,
  /** `OWNER/REPO`. */
  repo: Schema.String,
  /** Where to clone it: by default a folder named after it in the profile's clone folder. May start with `~/`. */
  repo_path: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  key: Schema.optional(Schema.NullOr(Schema.String)),
})
export interface CloneProject extends Schema.Schema.Type<typeof CloneProject> {}

/** What `projects.createOnGithub` takes. */
export const NewGithubProject = Schema.Struct({
  profile_id: ProfileId,
  /** The folder: a git repository, a folder that isn't one yet, or one that doesn't exist yet. May start with `~/`. */
  repo_path: Schema.String,
  name: Schema.optional(Schema.String),
  key: Schema.optional(Schema.NullOr(Schema.String)),
  /** The repository's name on GitHub: by default the folder's. */
  repo_name: Schema.optional(Schema.NullOr(Schema.String)),
  /** Who owns it: by default the profile's GitHub account (gh's active one without), or an organization. */
  owner: Schema.optional(Schema.NullOr(Schema.String)),
  visibility: Schema.Literals(["public", "private"]),
})
export interface NewGithubProject extends Schema.Schema.Type<typeof NewGithubProject> {}

/** Adding a project from GitHub. gh runs as the profile's GitHub account, or gh's active one when it has none. */
export class GithubRepoRpcs extends RpcGroup.make(
  /** The accounts gh is signed in to on this host (the old `GET /github-accounts`). */
  Rpc.make("profiles.githubAccounts", { success: GithubAccounts }).annotate(RequiredScope, "read"),
  /**
   * The repositories `account` can clone (gh's active one without it), newest push first; with `q`, those named like it
   * among its own and its organizations' (the old `GET /github-repos`). gh's failures are the list's `error`.
   */
  Rpc.make("profiles.githubRepos", {
    payload: { account: Schema.optional(Schema.NullOr(Schema.String)), q: Schema.optional(Schema.NullOr(Schema.String)) },
    success: GithubRepoList,
    error: Invalid,
  }).annotate(RequiredScope, "read"),
  /**
   * Clones a repository with gh as the profile's GitHub account and adds it as a project (the old `POST
   * /profiles/{id}/projects/clone`). A clone of it already in the folder is added as it is. `Conflict` (`duplicate_name`)
   * when the folder is a project of the profile's already; `External` when gh can't clone it.
   */
  Rpc.make("projects.clone", {
    payload: { clone: CloneProject },
    success: Project,
    error: Schema.Union([NotFound, Invalid, Conflict, External]),
  }).annotate(RequiredScope, "settings"),
  /**
   * Creates a GitHub repository for a folder (made a git repository first if it isn't one), makes it the folder's
   * `origin`, pushes its commits, and adds the folder as a project (the old `POST /profiles/{id}/projects/github`).
   */
  Rpc.make("projects.createOnGithub", {
    payload: { project: NewGithubProject },
    success: Schema.Struct({ project: Project, github: CreatedRepo }),
    error: Schema.Union([NotFound, Invalid, Conflict, External]),
  }).annotate(RequiredScope, "settings"),
).middleware(Auth) {}
