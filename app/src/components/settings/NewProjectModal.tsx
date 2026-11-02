import clsx from "clsx";
import { Folder, Loader2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { api, hostSupports } from "../../api";
import { clonePath, defaultCloneDir, loadProjectSource, saveProjectSource, type ProjectSource } from "./githubRepos";
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
        : await api.createProject(host, pid, { name, repo_path: path, key: key || undefined });
      useStore.getState().upsertProject({ ...p, host_id: host });
      if (closed.current) return;
      onClose();
      navigate({ name: "board", projectId: p.id });
    } catch (e) {
      if (closed.current) return;
      setErr((e as Error).message);
      setBusy(false);
    }
  };
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
                className={clsx("flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[12px]", source === t.id ? "bg-raised text-fg" : "text-muted hover:text-fg")}
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
            <select value={profileName} onChange={(e) => setProfileName(e.target.value)} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
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
          <Field label="Repository folder">
            <DirPicker hostId={host} value={path} onChange={setPath} />
          </Field>
        )}
        {!profileId && (
          <Field label={`Claude config directory for "${profileName}" on this host`} hint="This host has no such profile yet; it's created with this directory.">
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
              <Button variant="primary" disabled={busy || !path} onClick={submit}>
                Add project
              </Button>
            )}
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}
