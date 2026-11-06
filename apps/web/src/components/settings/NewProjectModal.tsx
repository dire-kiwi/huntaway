import clsx from "clsx";
import { Folder, Globe, Loader2, Lock } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, hostSupports } from "../../api";
import { clonePath, defaultCloneDir, loadProjectSource, saveProjectSource, type ProjectSource } from "./repoSource";
import { navigate } from "../../router";
import { defaultAgentHost, profileNames, useHost, useStore } from "../../store";
import { DirPicker } from "./DirPicker";
import { GithubMark, GithubRepoPicker, type RepoChoice } from "./GithubRepos";
import { HostSelect } from "./Hosts";
import { Button, Field, Input, Modal, ModalFooter } from "../ui";

/** Adds a project, in `profile` to start with: a folder on a host, or a GitHub repository it clones (API 55). */
export function NewProjectModal({ profile, onClose }: { profile?: string; onClose: () => void }) {
  const [names] = useState(() => profileNames(useStore.getState().profiles));
  // With every profile on the board, the project's profile is picked here.
  const [profileName, setProfileName] = useState(profile && names.includes(profile) ? profile : names[0]);
  const [host, setHost] = useState(defaultAgentHost() ?? useStore.getState().localHostId!);
  const hostCount = useStore((s) => s.hosts.filter((h) => h.connected).length);
  const hostRow = useHost(host);
  const profileRow = useStore((s) => s.profiles.find((p) => p.host_id === host && p.name === profileName));
  const profileId = profileRow?.id;
  const [configDir, setConfigDir] = useState("~/.claude");
  const [name, setName] = useState("");
  const [path, setPath] = useState("");
  const [key, setKey] = useState("");
  const [source, setSource] = useState(loadProjectSource);
  const fromGithub = source === "github" && hostSupports(hostRow, 55);
  const [repo, setRepo] = useState<RepoChoice | null>(null);
  // Where it's cloned: in the profile's clone folder, named after the repository, unless it's changed here.
  const cloneDir = profileRow?.clone_dir?.trim() || defaultCloneDir(profileName);
  const [dest, setDest] = useState<string | null>(null);
  const clonePathNow = repo ? (dest ?? clonePath(cloneDir, repo.name)) : "";
  // Folder tab: also create a GitHub repository for the folder (API 102).
  const canCreateRepo = !fromGithub && hostSupports(hostRow, 102);
  const [createRepo, setCreateRepo] = useState(false);
  const [repoName, setRepoName] = useState("");
  const [owner, setOwner] = useState("");
  const [visibility, setVisibility] = useState<"private" | "public">("private");
  const creating = canCreateRepo && createRepo;
  const folderName = path.split("/").filter(Boolean).pop() ?? "";
  // The repository was created and the project added, but its commits weren't pushed: said here rather than closing as if all went well.
  const [pushFailed, setPushFailed] = useState<{ projectId: string; repo: string; path: string; error: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // A clone can take a while, and the dialog can be closed meanwhile. Open again on each mount, as
  // StrictMode mounts it twice in development.
  const closed = useRef(false);
  useEffect(() => {
    closed.current = false;
    return () => {
      closed.current = true;
    };
  }, []);
  const pickSource = (s: ProjectSource) => {
    setSource(s);
    saveProjectSource(s);
    setErr(null);
  };
  const submit = async () => {
    setBusy(true);
    try {
      // The profile has to exist on the project's host first.
      let pid = profileId;
      if (!pid) {
        pid = (await api.createProfile(host, { name: profileName, claude_config_dir: configDir })).id;
        await useStore.getState().loadProfiles();
      }
      const p = fromGithub
        ? await api.cloneProject(host, pid, { repo: repo!.full_name, repo_path: clonePathNow.trim(), name, key: key || undefined })
        : creating
          ? await api.createGithubProject(host, pid, {
              repo_path: path,
              visibility,
              repo_name: repoName.trim() || undefined,
              owner: owner.trim() || undefined,
              name,
              key: key || undefined,
            })
          : await api.createProject(host, pid, { name, repo_path: path, key: key || undefined });
      const { github, ...project } = p as typeof p & { github?: { full_name: string; push_error: string | null } };
      useStore.getState().upsertProject({ ...project, host_id: host });
      if (closed.current) return;
      if (github?.push_error) {
        setPushFailed({ projectId: p.id, repo: github.full_name, path: p.repo_path, error: github.push_error });
        setBusy(false);
        return;
      }
      onClose();
      navigate({ name: "board", projectId: p.id });
    } catch (e) {
      if (closed.current) return;
      setErr((e as Error).message);
      setBusy(false);
    }
  };
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
                  onClose();
                  navigate({ name: "board", projectId: pushFailed.projectId });
                }}
              >
                Open project
              </Button>
            </div>
          </ModalFooter>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title="Add project" onClose={onClose} width="max-w-xl">
      <div className="space-y-4">
        {hostSupports(hostRow, 55) && (
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
        )}
        {hostCount > 1 && (
          <Field label="Host" hint="The machine the repository is on. Its agents run there.">
            <HostSelect value={host} onChange={setHost} />
          </Field>
        )}
        {names.length > 1 && (
          <Field label="Profile" hint="The Claude profile the project's agents run under.">
            <select
              value={profileName}
              onChange={(e) => setProfileName(e.target.value)}
              className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
            >
              {names.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
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
                  setRepo(r);
                  setDest(null);
                  setErr(null);
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
        {!profileId && (
          <Field
            label={`Claude config directory for "${profileName}" on this host`}
            hint="This host has no such profile yet; it's created with this directory."
          >
            <Input value={configDir} onChange={(e) => setConfigDir(e.target.value)} className="font-mono text-[12px]" />
          </Field>
        )}
        <div className="grid grid-cols-[1fr_120px] gap-3">
          <Field label="Name">
            <Input
              value={name}
              placeholder={(fromGithub ? clonePathNow : path).split("/").filter(Boolean).pop() ?? "Project"}
              onChange={(e) => setName(e.target.value)}
            />
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
              <Button variant="primary" disabled={busy || !repo || !clonePathNow.trim()} onClick={submit}>
                {busy && <Loader2 size={13} className="animate-spin" />} {busy ? "Cloning…" : "Clone and add project"}
              </Button>
            ) : (
              <Button variant="primary" disabled={busy || !path || (creating && !(repoName.trim() || folderName))} onClick={submit}>
                {busy && creating && <Loader2 size={13} className="animate-spin" />}{" "}
                {creating ? (busy ? "Creating…" : `Create ${visibility} repository and add project`) : "Add project"}
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}
