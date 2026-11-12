import { Effect } from "effect"
import { External, GithubRepoRpcs, NotFound } from "@huntaway/contracts"
import { GithubRepos } from "../github/GithubRepos.ts"
import type { GithubFailed } from "../github/GithubRepos.ts"
import { checkGithubAccount } from "../profiles/checks.ts"
import type { ProfileNotFound } from "../profiles/Profiles.ts"

// 6.11: adding a project from GitHub.
const profileNotFound = (e: ProfileNotFound) => Effect.fail(new NotFound({ what: "profile", id: e.id }))
const github = (e: GithubFailed) => Effect.fail(new External({ service: "GitHub", reason: e.message }))

export const GithubRepoHandlers = GithubRepoRpcs.toLayer(
  Effect.gen(function* () {
    const repos = yield* GithubRepos
    return GithubRepoRpcs.of({
      "profiles.githubAccounts": () => repos.accounts,
      "profiles.githubRepos": ({ account, q }) => Effect.flatMap(checkGithubAccount(account ?? null), (a) => repos.list(a, q ?? null)),
      "projects.clone": ({ clone }) => repos.cloneProject(clone).pipe(Effect.catchTags({ ProfileNotFound: profileNotFound, GithubFailed: github })),
      "projects.createOnGithub": ({ project }) =>
        repos.createProject(project).pipe(Effect.catchTags({ ProfileNotFound: profileNotFound, GithubFailed: github })),
    })
  }),
)
