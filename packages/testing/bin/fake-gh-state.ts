// The fake GitHub's state as fake-gh.ts reads and writes it (its schema for tests is src/fakeGitHub.ts): accounts,
// repositories with their pull requests, issues, runs and stacks, gh's help texts, exact-argument routes and the calls log.

export type Json = Record<string, unknown>

export interface Account {
  host: string
  login: string
  token: string
  active?: boolean
}
export interface Check {
  name: string
  state: string
  bucket: string
  workflow?: string
  link?: string
  startedAt?: string
  completedAt?: string
  id?: number
  conclusion?: string
  required?: boolean
  kind?: string
  suite?: { id: number; status: string }
}
export interface Comment {
  author: string
  body: string
  createdAt?: string
  authorAssociation?: string
  id?: string
  bot?: boolean
  url?: string
}
export interface Review {
  author: string
  state: string
  body?: string
  submittedAt?: string
  authorAssociation?: string
  id?: string
  bot?: boolean
  url?: string
}
export interface ThreadComment {
  author: string
  body: string
  id?: string
  createdAt?: string
  authorAssociation?: string
  bot?: boolean
  url?: string
  line?: number | null
}
export interface Thread {
  path: string
  comments: Array<ThreadComment>
}
export interface Pull {
  number: number
  title: string
  body: string
  state: string
  isDraft?: boolean
  head: string
  base: string
  headOid?: string
  author?: string
  mergeable?: string
  mergeStateStatus?: string
  reviewDecision?: string
  isCrossRepository?: boolean
  checks?: Array<Check>
  comments?: Array<Comment>
  reviews?: Array<Review>
  diff?: string
  stack?: number | null
  merged_at?: string | null
  mergeMethod?: string
  autoMerge?: boolean
  deletedBranch?: boolean
  mergeAsync?: string
  mergeAsyncPending?: boolean
  reviewThreads?: Array<Thread>
  threadsPage?: number
  unreadable?: string
  mergeableState?: string
  rebasedTo?: string
}
export interface Issue {
  number: number
  title: string
  body: string
  state: string
  author?: string
  labels?: Array<string>
  comments?: Array<Comment>
}
export interface Run {
  databaseId: number
  workflowName?: string
  displayTitle?: string
  headBranch?: string
  event?: string
  status?: string
  conclusion?: string
  url?: string
  createdAt?: string
  log?: string
}
export interface Repo {
  default_branch?: string
  pulls?: Array<Pull>
  issues?: Array<Issue>
  runs?: Array<Run>
  stacks?: Record<string, Array<number>>
  jobs?: Record<string, string>
}
export interface Route {
  stdout?: string
  stderr?: string
  code?: number
  json?: unknown
}
export interface State {
  accounts?: Array<Account>
  defaultRepo?: string | null
  repos?: Record<string, Repo>
  help?: Record<string, string>
  routes?: Record<string, Route>
  calls?: Array<Json>
}
