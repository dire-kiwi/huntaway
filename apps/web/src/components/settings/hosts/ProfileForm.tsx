import { canRunAgents, type HostAgentConfig as ClaudeConfig, type HostProfile as Profile } from "@huntaway/client"
import { AgentConfigId, LinkId, type ProfilePatch, type Reviewer } from "@huntaway/contracts"
import { Loader2 } from "lucide-react"
import { useState } from "react"
import { useShallow } from "../../boardHelpers"
import { useBoard } from "../../../state/board"
import { rpc } from "../../../state/rpc"
import { defaultCloneDir } from "../repoSource"
import { ConfigPicker } from "../ClaudeConfigs"
import { DEFAULT_REVIEWER, ReviewerList, SummarizerList, useReviewerExtras } from "../../task/Reviewers"
import { Button, Field, Input, ModalFooter, NotYet, Toggle, useAsyncAction } from "../../ui"
import { TintField } from "./TintField"
import { AccessPicker, AssistantHostSelect, GithubAccountSelect, HostSelect, ThreadConfigSelect } from "./profileFields"

// Step 1 (docs/plan/09-frontend.md). Every host takes every field, so the old API gates are gone, and a profile's
// summarizers are always a list. A profile has agent configs, never a folder of its own: with none on the host yet, the
// folder typed here is made its first config, named after the profile, as the old server did. Connecting Asana with a
// token (task/ExternalLinks' `AsanaAccount`) is 6.11's: a marked slot below.

/** Off: the board leaves Asana out of the profile's tasks (task/ExternalLinks' `usesAsana`). */
export const usesAsana = (p: Pick<Profile, "asana_enabled"> | undefined): boolean => p?.asana_enabled !== false

/** Connecting a profile's Asana account with a personal access token: 6.11's `AsanaAccount`, not on this server yet. */
function AsanaAccount(_props: { hostId: string; profile: Profile }) {
  return <NotYet what="Connecting an Asana account" />
}

export function ProfileForm({
  hostId,
  initial,
  name: presetName,
  onDone,
  onCancel,
}: {
  hostId: string
  initial?: Profile | undefined
  name?: string | undefined
  onDone: () => void
  onCancel?: (() => void) | undefined
}) {
  const hosts = useBoard(useShallow((s) => s.hosts.filter((h) => canRunAgents(h))))
  const [host, setHost] = useState(hostId)
  const [name, setName] = useState(initial?.name ?? presetName ?? "")
  const [dir, setDir] = useState("~/.claude")
  const [configIds, setConfigIds] = useState<ReadonlyArray<string>>(initial?.claude_config_ids ?? [])
  const [model, setModel] = useState(initial?.default_model ?? "")
  const [access, setAccess] = useState<ReadonlyArray<string>>(initial?.agent_access ?? [])
  const [github, setGithub] = useState(initial?.github_account ?? "")
  const [cloneDir, setCloneDir] = useState(initial?.clone_dir ?? "")
  const [asana, setAsana] = useState(usesAsana(initial))
  const [limitWait, setLimitWait] = useState(!!initial?.limit_wait)
  const [limitSwitch, setLimitSwitch] = useState(!!initial?.limit_switch)
  const [reviewers, setReviewers] = useState<ReadonlyArray<Reviewer>>(initial?.reviewers ?? [])
  const [summarizers, setSummarizers] = useState<ReadonlyArray<Reviewer>>(initial?.summarizers.length ? initial.summarizers : [DEFAULT_REVIEWER])
  const [mergeApproval, setMergeApproval] = useState(!!initial?.merge_approval)
  const [prApproval, setPrApproval] = useState(!!initial?.require_pr_approval)
  const [telemetry, setTelemetry] = useState(!!initial?.telemetry)
  const [telemetryTitles, setTelemetryTitles] = useState(initial?.telemetry_titles ?? true)
  const [assistantHost, setAssistantHost] = useState(initial?.assistant_host ?? "")
  const [assistantConfig, setAssistantConfig] = useState(initial?.assistant_config_id ?? "")
  const [threadsConfig, setThreadsConfig] = useState(initial?.threads_config_id ?? "")
  // undefined until a colour is picked, so the board shows this one only from then.
  const [tint, setTint] = useState<string | null | undefined>(undefined)
  // Its Asana connection is saved as it's changed, so it follows the store rather than the form.
  const liveProfile = useBoard((s) => s.profiles.find((p) => p.host_id === initial?.host_id && p.id === initial?.id))
  const { busy, error: err, run } = useAsyncAction()
  // This board's own profiles can run their assistants on a linked host.
  const assistantHosts = useBoard(useShallow((s) => s.hosts.filter((h) => !h.local && h.connected)))
  const onBoardHost = useBoard((s) => !!s.hosts.find((h) => h.id === host)?.local)
  const placing = onBoardHost && (assistantHosts.length > 0 || !!initial?.assistant_host)
  const hostConfigs = useBoard(useShallow((s) => s.claudeConfigs.filter((c) => c.host_id === host)))
  const reviewExtras = useReviewerExtras(host)
  // With no configs on the host yet, the directory typed here becomes the first.
  const pick = hostConfigs.length > 0
  // The assistant's and the threads' come from the profile's own configs: one taken off it goes back to the default.
  const ownConfigs = configIds.map((id) => hostConfigs.find((c) => c.id === id)).filter((c): c is ClaudeConfig => !!c)
  const threadPick = (id: string): AgentConfigId | null => (ownConfigs.some((c) => c.id === id) ? AgentConfigId.make(id) : null)
  const submit = (): void => {
    void run(async () => {
      // With no configs on the host, the folder typed becomes its first, named after the profile.
      const ids = pick
        ? configIds.map((id) => AgentConfigId.make(id))
        : [(await rpc(host, "configs.create", { config: { name: name.trim(), config_dir: dir.trim() } })).id]
      const fields = {
        default_model: model || null,
        claude_config_ids: ids,
        agent_access: access,
        github_account: github || null,
        clone_dir: cloneDir.trim() || null,
        asana_enabled: asana,
        limit_wait: limitWait,
        limit_switch: limitSwitch,
        // The host saves just the defaults as none, which is the same.
        reviewers,
        summarizers,
        merge_approval: mergeApproval,
        require_pr_approval: prApproval,
        ...(tint !== undefined ? { tint } : {}),
        ...(placing ? { assistant_host: assistantHost ? LinkId.make(assistantHost) : null } : {}),
        ...(pick ? { assistant_config_id: threadPick(assistantConfig), threads_config_id: threadPick(threadsConfig) } : {}),
      }
      if (initial) {
        const patch: ProfilePatch = { name: name.trim(), ...fields, telemetry, telemetry_titles: telemetryTitles }
        await rpc(initial.host_id, "profiles.update", { id: initial.id, patch })
      } else await rpc(host, "profiles.create", { profile: { name: name.trim(), ...fields } })
      onDone()
    })
  }
  return (
    <div className="space-y-3">
      {!initial && hosts.length > 1 && (
        <Field label="Host">
          <HostSelect
            value={host}
            onChange={(h) => {
              setHost(h)
              setConfigIds([])
            }}
          />
        </Field>
      )}
      <div className="grid grid-cols-2 gap-3">
        <Field label="Name">
          <Input value={name} placeholder="work / personal" onChange={(e) => setName(e.target.value)} disabled={!!presetName} />
        </Field>
        <Field label="Default model">
          <Input value={model} placeholder="claude default" onChange={(e) => setModel(e.target.value)} />
        </Field>
      </div>
      {pick ? (
        <Field
          label="Agent configs"
          hint="The ones its agents can use; projects can pick their own. With more than one, new tasks ask which, starting with the default."
        >
          <ConfigPicker hostId={host} value={configIds} onChange={setConfigIds} />
        </Field>
      ) : (
        <Field
          label="Claude config directory"
          hint="On that host. Saved as a Claude config named after the profile, passed as CLAUDE_CONFIG_DIR, so it has its own login, settings and history."
        >
          <Input className="font-mono text-[12px]" value={dir} onChange={(e) => setDir(e.target.value)} />
        </Field>
      )}
      {pick && ownConfigs.length > 0 && (
        <div className="grid grid-cols-2 gap-3">
          <Field label="Assistant agent" hint="The config the assistant and its routines start a conversation with.">
            <ThreadConfigSelect configs={ownConfigs} value={threadPick(assistantConfig) ?? ""} onChange={setAssistantConfig} />
          </Field>
          <Field label="Threads agent" hint="The config the pens thread and each pen's own thread start a conversation with.">
            <ThreadConfigSelect configs={ownConfigs} value={threadPick(threadsConfig) ?? ""} onChange={setThreadsConfig} />
          </Field>
          <span className="col-span-2 -mt-1.5 block text-xs text-faint">
            A thread that has started keeps its agent until you send <span className="font-mono">/new</span> in it, which starts a new conversation.
          </span>
        </div>
      )}
      <Field
        label="GitHub account"
        hint="The account its agents act as on GitHub through their gh tools (pull requests, issues, the API, pushes over HTTPS), from gh's logins on this host. Projects can pick their own."
      >
        <GithubAccountSelect hostId={host} value={github} onChange={setGithub} inherit={(active) => `gh's active account${active ? ` (${active})` : ""}`} />
      </Field>
      <Field label="Clone folder" hint="Where Add project's GitHub tab clones repositories on this host, each into a folder named after it.">
        <Input
          className="font-mono text-[12px]"
          value={cloneDir}
          placeholder={defaultCloneDir(name)}
          onChange={(e) => setCloneDir(e.target.value)}
          spellCheck={false}
        />
      </Field>
      <TintField value={tint === undefined ? (initial?.tint ?? null) : tint} onChange={setTint} picked={tint !== undefined} />
      {/* Not a Field, whose label would pass clicks anywhere in it on to the toggle. */}
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted">Asana</span>
        <Toggle checked={asana} onChange={setAsana} label="Link tasks to Asana tasks" />
        {asana && initial && <AsanaAccount hostId={host} profile={liveProfile ?? initial} />}
        <span className="block text-xs text-faint">
          {!asana
            ? "Off: the board leaves Asana out of this profile's tasks. A token it has is kept for when it's turned on again."
            : initial
              ? "Finds the Asana tasks you link tasks to, with a personal access token kept on this host."
              : "Finds the Asana tasks you link tasks to. Connect it with a personal access token once the profile is created."}
        </span>
      </div>
      <div className="space-y-1.5">
        <span className="block text-xs font-medium text-muted">When a config runs out of usage</span>
        <Toggle checked={limitWait} onChange={setLimitWait} label="Wait for the limit to reset, then carry on" />
        <Toggle checked={limitSwitch} onChange={setLimitSwitch} label="Start new tasks on the next config with room" />
        <span className="block text-xs text-faint">
          {limitWait
            ? "A task whose agent runs out waits in In progress until the limit resets and then carries on, and a task started on a config that's out waits for it too."
            : "Off, a task whose agent runs out needs your attention, and offers to carry on once the limit resets."}{" "}
          {limitSwitch ? "A task that hasn't started yet starts on the next of its configs (of the same agent) that isn't out, instead of its own." : ""}
        </span>
      </div>
      <Field label="Reviewers" hint="Who reviews the tasks of its projects, each in a thread of its own. A project can choose its own in its Review settings.">
        <ReviewerList hostId={host} configs={hostConfigs} models={{ profile: model }} value={reviewers} onChange={setReviewers} extras={reviewExtras} />
      </Field>
      <Field
        label="Summarizers"
        hint="Who summarises a task's changes once its review passes, unless its project chooses its own, each in a thread of its own: give them different skills or prompts to compare which summarises best. A quick, cheap model is usually enough."
      >
        <SummarizerList hostId={host} configs={hostConfigs} models={{ profile: model }} value={summarizers} onChange={setSummarizers} />
      </Field>
      <div className="space-y-1.5">
        <Toggle checked={mergeApproval} onChange={setMergeApproval} label="Approve each merge first" />
        <span className="block text-xs text-faint">
          {mergeApproval
            ? "A task moved to Ready for merge has its agent summarize what will be merged, and merges only once you approve it in its thread. A project can say otherwise in its Review settings."
            : "A task moved to Ready for merge is merged by its agent without asking you first, unless its project says otherwise in its Review settings."}
        </span>
      </div>
      <div className="space-y-1.5">
        <Toggle checked={prApproval} onChange={setPrApproval} label="Require GitHub approval before Ready for merge" />
        <span className="block text-xs text-faint">
          {prApproval
            ? "A task can only be moved to Ready for merge once its pull request has an approving review on GitHub. A project can say otherwise in its Review settings."
            : "A task can be moved to Ready for merge without a review on GitHub, unless its project says otherwise in its Review settings."}
        </span>
      </div>
      {initial && (
        <div className="space-y-1.5">
          <Toggle checked={telemetry} onChange={setTelemetry} label="Send this profile's tasks to telemetry" />
          <span className="block text-xs text-faint">
            {telemetry
              ? "Its tasks' runs, costs, prompts, reviews and merges go to the ClickHouse set up in the host's Telemetry settings, if it has one: ids, keys, models, tools, counts and times, never prompts, messages, tool input or output, or diffs."
              : "Nothing about its tasks is sent, even when the host sends telemetry."}
          </span>
          {telemetry && <Toggle checked={telemetryTitles} onChange={setTelemetryTitles} label="Include task titles" />}
        </div>
      )}
      {placing && (
        <Field
          label="Assistant host"
          hint="Where the profile's assistant runs: another machine linked over SSH keeps its credentials, and its agents, off this one. That host needs a profile of the same name. Let its agents use this board in Settings → Hosts, so it can create and message tasks here. Its routines are that host's too: those made on this one don't run while it's there."
        >
          <AssistantHostSelect value={assistantHost} onChange={setAssistantHost} />
        </Field>
      )}
      <Field
        label="Agents from other profiles"
        hint="Agents in these profiles can list, read, create and change this profile's projects and tasks with their board tools. Tasks they create here run with this profile's Claude configs."
      >
        <AccessPicker own={name.trim()} value={access} onChange={setAccess} />
      </Field>
      <ModalFooter className="space-y-3">
        {err && <div className="text-xs text-red-400">{err}</div>}
        <div className="flex justify-end gap-2">
          {onCancel && (
            <Button variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button variant="primary" disabled={!name.trim() || busy} onClick={submit}>
            {busy && <Loader2 size={13} className="animate-spin" />} {initial ? "Save" : "Create profile"}
          </Button>
        </div>
      </ModalFooter>
    </div>
  )
}
