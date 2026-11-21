// `projects.create`, `projects.clone` and `projects.createOnGithub` (6.11); the project arrives on the board with the
// `project` event. The project goes on any host that can run agents (HE-38): on one without the picked profile, the
// profile is made there first, with the configs picked, or with the folder typed as its first config when the host has
// none (as Settings → Profiles does).
import { holdsProjects, mutate } from "@huntaway/client"
import { AgentConfigId } from "@huntaway/contracts"
import { clsx } from "clsx"
import { Effect, Exit, Fiber } from "effect"
import { Folder, Globe, Loader2, Lock } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { board, useBoard } from "../../state/board"
import { useAction } from "../../state/mutation"
import { navigate } from "../../state/route"
import { defaultAgentHost, profileNames, useShallow } from "../boardHelpers"
import { ConfigPicker } from "./ClaudeConfigs"
import { clonePath, defaultCloneDir, loadProjectSource, saveProjectSource, type ProjectSource } from "./repoSource"
import { DirPicker } from "./DirPicker"
import { GithubMark, GithubRepoPicker, type RepoChoice } from "./GithubRepos"
import { HostSelect } from "./hosts/profileFields"
import { Button, Field, Input, Modal, ModalFooter, Select } from "../ui"

/** The last folder in a path. */
const lastPart = (path: string) => path.split("/").findLast((p) => p !== "")

/** Adds a project, in `profile` to start with: a folder on a host, or a GitHub repository it clones. */
export function NewProjectModal({ profile, onClose }: { profile?: string | undefined; onClose: () => void }) {
  const [names] = useState(() => profileNames(board.get().profiles))
  // With every profile on the board, the project's profile is picked here.
  const [profileName, setProfileName] = useState(profile !== undefined && names.includes(profile) ? profile : (names[0] ?? ""))
  const [host, setHost] = useState(() => defaultAgentHost() ?? board.get().localHostId ?? "")
  const hostCount = useBoard((s) => s.hosts.filter((h) => holdsProjects(h, s.hostSettings[h.id]?.role)).length)
  const profileRow = useBoard((s) => s.profiles.find((p) => p.host_id === host && p.name === profileName))
  const profileId = profileRow?.id
  // Without the profile on the host, it's made there: with the host's configs picked, or the folder typed as its first.
  const hostConfigs = useBoard(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === host)))
  const pickConfigs = hostConfigs.length > 0
  const [configIds, setConfigIds] = useState<ReadonlyArray<string>>([])
  const pickedConfigs = configIds.filter((id) => hostConfigs.some((c) => c.id === id))
  const [configDir, setConfigDir] = useState("~/.claude")
  const canMakeProfile = profileName.trim() !== "" && (pickConfigs ? pickedConfigs.length > 0 : configDir.trim() !== "")
  const ready = profileId !== undefined || canMakeProfile
  const [name, setName] = useState("")
  const [path, setPath] = useState("")
  const [key, setKey] = useState("")
  const [source, setSource] = useState(loadProjectSource)
  const fromGithub = source === "github"
  const [repo, setRepo] = useState<RepoChoice | null>(null)
  // Where it's cloned: in the profile's clone folder, named after the repository, unless it's changed here.
  const cloneDir = profileRow?.clone_dir?.trim() || defaultCloneDir(profileName)
  const [dest, setDest] = useState<string | null>(null)
  const clonePathNow = repo ? (dest ?? clonePath(cloneDir, repo.name)) : ""
  // Folder tab: also create a GitHub repository for the folder.
  const canCreateRepo = !fromGithub
  const [createRepo, setCreateRepo] = useState(false)
  const [repoName, setRepoName] = useState("")
  const [owner, setOwner] = useState("")
  const [visibility, setVisibility] = useState<"private" | "public">("private")
  const creating = canCreateRepo && createRepo
  const folderName = lastPart(path) ?? ""
  // The repository was created and the project added, but its commits weren't pushed: said here rather than closing as if all went well.
  const [pushFailed, setPushFailed] = useState<{ projectId: string; repo: string; path: string; error: string } | null>(null)
  const [{ busy, error }, run] = useAction()
  // Its error goes once another source is picked, until it's tried again.
  const [hidden, setHidden] = useState(false)
  const err = hidden ? null : error
  // Whether the dialog has gone. Open again on each mount, as StrictMode mounts it twice in development.
  const closed = useRef(false)
  useEffect(() => {
    closed.current = false
    return () => {
      closed.current = true
    }
  }, [])
  const pickSource = (s: ProjectSource) => {
    setSource(s)
    saveProjectSource(s)
    setHidden(true)
  }
  const submit = (): void => {
    if (!ready || busy) return
    setHidden(false)
    const key_ = key || undefined
    const add = Effect.gen(function* () {
      // The profile has to be on the project's host first.
      let pid = profileId
      if (pid === undefined) {
        const ids = pickConfigs
          ? pickedConfigs.map((id) => AgentConfigId.make(id))
          : [(yield* mutate("configs.create", host, { config: { name: profileName, config_dir: configDir.trim() } })).id]
        pid = (yield* mutate("profiles.create", host, { profile: { name: profileName, claude_config_ids: ids } })).id
      }
      if (fromGithub && repo) {
        const clone = { profile_id: pid, repo: repo.full_name, repo_path: clonePathNow.trim(), name, key: key_ }
        return { project: yield* mutate("projects.clone", host, { clone }), github: undefined }
      }
      if (creating) {
        const project = {
          profile_id: pid,
          repo_path: path,
          visibility,
          repo_name: repoName.trim() || undefined,
          owner: owner.trim() || undefined,
          name,
          key: key_,
        }
        return yield* mutate("projects.createOnGithub", host, { project })
      }
      return { project: yield* mutate("projects.create", host, { project: { profile_id: pid, name, repo_path: path, key: key_ } }), github: undefined }
    })
    // A clone can take a while, and the dialog can be closed meanwhile: the clone goes on (detached, so the dialog's
    // action ending with it doesn't stop it), and a closed dialog does nothing with its answer.
    void run(Effect.forkDetach(add, { startImmediately: true }).pipe(Effect.flatMap(Fiber.join))).then((exit) => {
      if (closed.current || !Exit.isSuccess(exit)) return
      const { project: p, github } = exit.value
      if (github?.push_error) {
        setPushFailed({ projectId: p.id, repo: github.full_name, path: p.repo_path, error: github.push_error })
        return
      }
      onClose()
      navigate({ name: "board", projectId: p.id })
    })
  }
  if (pushFailed) {
    return (
      <Modal title="Project added, but not pushed" onClose={onClose} width="max-w-xl">
        <div className="space-y-4 text-[13px]">
          <p>
            Created <span className="font-mono">{pushFailed.repo}</span> on GitHub and added the project, but its commits weren't pushed:
          </p>
          <div role="alert" className="rounded-md border border-red-500/40 bg-red-500/10 p-2 text-xs text-red-300">
            {pushFailed.error}
          </div>
          <p className="text-muted">
            The repository on GitHub is empty. Once that's sorted out, push it from <span className="font-mono">{pushFailed.path}</span> with{" "}
            <span className="font-mono">git push -u origin HEAD</span>.
          </p>
          <ModalFooter>
            <div className="flex justify-end">
              <Button
                variant="primary"
                onClick={() => {
                  onClose()
                  navigate({ name: "board", projectId: pushFailed.projectId })
                }}
              >
                Open project
              </Button>
            </div>
          </ModalFooter>
        </div>
      </Modal>
    )
  }
  return (
    <Modal title="Add project" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        <div className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Add it from">
          {(
            [
              { id: "folder", label: "Folder", icon: <Folder size={12} />, hint: "A folder on the host: a repository, or a new folder" },
              { id: "github", label: "GitHub", icon: <GithubMark size={12} />, hint: "Clone one of the GitHub repositories gh can reach on the host" },
            ] as const
          ).map((t) => (
            <button
              key={t.id}
              type="button"
              role="radio"
              aria-checked={source === t.id}
              title={t.hint}
              onClick={() => pickSource(t.id)}
              className={clsx(
                "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]",
                source === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg",
              )}
            >
              {t.icon} {t.label}
            </button>
          ))}
        </div>
        {hostCount > 1 && (
          <Field label="Host" hint="The machine the repository is on. Its agents run there.">
            <HostSelect
              projects
              value={host}
              onChange={(h) => {
                setHost(h)
                setConfigIds([])
                setPath("")
                setRepo(null)
                setDest(null)
                setHidden(true)
              }}
            />
          </Field>
        )}
        {names.length > 1 && (
          <Field label="Profile" hint="The Claude profile the project's agents run under.">
            <Select value={profileName} onChange={setProfileName} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </Select>
          </Field>
        )}
        {fromGithub ? (
          <>
            <Field label="Repository">
              <GithubRepoPicker
                hostId={host}
                account={profileRow?.github_account || null}
                whose={profileRow?.github_account ? `${profileName}'s GitHub account` : "gh's active account"}
                value={repo}
                onChange={(r) => {
                  setRepo(r)
                  setDest(null)
                  setHidden(true)
                }}
              />
            </Field>
            {repo && (
              <Field
                label={`Clone ${repo.full_name} into`}
                hint={
                  <>
                    A new folder, or an empty one. A clone of it that's there already is added as it is. {profileName}'s repositories go in{" "}
                    <span className="font-mono">{cloneDir}</span> (Settings → Profiles).
                  </>
                }
              >
                <Input className="font-mono text-[12px]" value={clonePathNow} onChange={(e) => setDest(e.target.value)} spellCheck={false} />
              </Field>
            )}
          </>
        ) : (
          <>
            <Field label="Repository folder">
              <DirPicker hostId={host} value={path} onChange={setPath} />
            </Field>
            {canCreateRepo && (
              <div className="space-y-3 rounded-lg border border-line bg-panel/50 p-3">
                <label className="flex items-center gap-2 text-[13px]">
                  <input type="checkbox" checked={createRepo} onChange={(e) => setCreateRepo(e.target.checked)} />
                  Create a GitHub repository for it
                </label>
                {creating && (
                  <>
                    <div className="flex w-fit items-center gap-0.5 rounded-lg border border-line bg-panel p-0.5" role="radiogroup" aria-label="Visibility">
                      {(["private", "public"] as const).map((v) => (
                        <button
                          key={v}
                          type="button"
                          role="radio"
                          aria-checked={visibility === v}
                          onClick={() => setVisibility(v)}
                          className={clsx(
                            "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]",
                            visibility === v ? "bg-raised text-fg" : "text-muted hover:text-fg",
                          )}
                        >
                          {v === "private" ? <Lock size={12} /> : <Globe size={12} />} {v === "private" ? "Private" : "Public"}
                        </button>
                      ))}
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <Field label="Owner" hint="An organization, or leave empty for the profile's GitHub account.">
                        <Input
                          value={owner}
                          placeholder={profileRow?.github_account?.split("/").pop() || "your account"}
                          onChange={(e) => setOwner(e.target.value)}
                          spellCheck={false}
                        />
                      </Field>
                      <Field label="Repository name">
                        <Input value={repoName} placeholder={folderName || "name"} onChange={(e) => setRepoName(e.target.value)} spellCheck={false} />
                      </Field>
                    </div>
                  </>
                )}
              </div>
            )}
          </>
        )}
        {!profileId &&
          (pickConfigs ? (
            <Field label={`Configs for "${profileName}" on this host`} hint="This host has no such profile yet; it's created with these configs.">
              <ConfigPicker hostId={host} value={configIds} onChange={setConfigIds} />
            </Field>
          ) : (
            <Field
              label={`Claude config directory for "${profileName}" on this host`}
              hint="This host has no such profile yet; it's created with this directory."
            >
              <Input value={configDir} onChange={(e) => setConfigDir(e.target.value)} className="font-mono text-[12px]" spellCheck={false} />
            </Field>
          ))}
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Name">
            <Input value={name} placeholder={lastPart(fromGithub ? clonePathNow : path) ?? "Project"} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Key">
            <Input value={key} placeholder="auto" onChange={(e) => setKey(e.target.value.toUpperCase())} maxLength={6} />
          </Field>
        </div>
        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            {fromGithub ? (
              <Button variant="primary" disabled={busy || !ready || !repo || !clonePathNow.trim()} onClick={submit}>
                {busy && <Loader2 size={13} className="animate-spin" />} {busy ? "Cloning…" : "Clone and add project"}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || !ready || !path || (creating && !(repoName.trim() || folderName))} onClick={submit}>
                {busy && creating && <Loader2 size={13} className="animate-spin" />}{" "}
                {creating ? (busy ? "Creating…" : `Create ${visibility} repository and add project`) : "Add project"}
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
