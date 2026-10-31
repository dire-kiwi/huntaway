import clsx from "clsx";
import { ChevronDown, ChevronRight, Plus, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { api, canRunAgents, hostSupports, type AgentTools, type GlobalAgentTools, type McpServerConfig, type Project, type ProjectMcpServer, type ProjectSkill } from "../api";
import { useShallow } from "zustand/react/shallow";
import { useStore } from "../store";
import { HostSelect } from "./Hosts";
import { Button, Field, Input, Modal, ModalFooter, SUBMIT_KEYS, Textarea, Toggle, timeAgo, useConfirm } from "./ui";

const SKILL_TEMPLATE = `---
name: my-skill
description: What this skill does, and when Claude should use it.
---

# My skill

Instructions for Claude to follow when it uses this skill.
`;

type DisabledKey = "disabled_skills" | "disabled_mcp_servers";
const toggleIn = (list: string[], name: string, off: boolean) => (off ? [...list.filter((n) => n !== name), name] : list.filter((n) => n !== name));

/** The project's own skills and MCP servers, and switches for the ones its agents get from elsewhere. */
export function ProjectAgentTools({ project }: { project: Project }) {
  const [tools, setTools] = useState<AgentTools | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const hostId = project.host_id;
  // Switches for skills and servers from elsewhere save the whole list, so each click builds on
  // the ones before it (not on what was last rendered) and the saves go one at a time.
  const wanted = useRef<Pick<AgentTools, DisabledKey> | null>(null);
  const saving = useRef(0);
  const queue = useRef<Promise<void>>(Promise.resolve());
  const show = useCallback((t: AgentTools) => {
    // While switches are saving, keep showing them as clicked.
    setTools(saving.current ? { ...t, ...wanted.current } : t);
    if (!saving.current) wanted.current = { disabled_skills: t.disabled_skills, disabled_mcp_servers: t.disabled_mcp_servers };
  }, []);
  const reload = useCallback(
    () =>
      api.agentTools(hostId, project.id).then(
        (t) => {
          show(t);
          setErr(null);
        },
        (e) => setErr((e as Error).message),
      ),
    [hostId, project.id, show],
  );
  useEffect(() => {
    reload();
  }, [reload]);
  const confirm = useConfirm();
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  if (!tools) return err ? <div className="text-xs text-red-400">{err}</div> : null;
  const seen = Object.values(tools.seen);
  const lastSeen = seen.map((s) => s.at).sort().pop();
  const toggleOther = (key: DisabledKey, name: string, on: boolean) => {
    const set = (off: boolean) => {
      wanted.current = { ...wanted.current!, [key]: toggleIn(wanted.current![key], name, off) };
      setTools((t) => t && { ...t, ...wanted.current });
    };
    set(!on);
    setErr(null);
    saving.current++;
    queue.current = queue.current.then(async () => {
      let saved: AgentTools | null = null;
      try {
        saved = await api.updateAgentTools(hostId, project.id, { [key]: wanted.current![key] });
      } catch (e) {
        setErr((e as Error).message);
        set(on);
      }
      saving.current--;
      if (saved && !saving.current) show(saved);
    });
  };
  const globalNames = new Set([...(tools.global_skills ?? []), ...(tools.global_mcp_servers ?? [])].map((g) => g.name));
  const shared = (items: (ProjectSkill | ProjectMcpServer)[] | undefined, own: (ProjectSkill | ProjectMcpServer)[], what: string) =>
    items?.length ? (
      <SharedList
        what={what}
        items={items}
        replaced={new Set(own.filter((o) => o.enabled).map((o) => o.name))}
        profileOn={(id) => !!tools.profile_switches?.[id]}
        override={(id) => tools.project_switches?.[id] ?? null}
        onChange={(id, enabled) => run(() => api.setAgentToolSwitch(hostId, { scope: "project", scope_id: project.id, item_id: id, enabled }))}
      />
    ) : null;
  return (
    <>
      <SkillsSection
        tools={tools}
        shared={shared(tools.global_skills, tools.skills, "skills")}
        seenSkills={dedupe(seen.flatMap((s) => s.skills))
          .map((s) => s.name)
          .filter((n) => !globalNames.has(n))}
        lastSeen={lastSeen}
        onToggleOther={(name, on) => toggleOther("disabled_skills", name, on)}
        onToggle={(s, enabled) => run(() => api.updateSkill(hostId, project.id, s.id, { enabled }))}
        onDelete={(s) =>
          confirm.ask({
            title: `Delete skill ${s.name}`,
            body: `Delete the skill "${s.name}"?`,
            action: "Delete skill",
            danger: true,
            onConfirm: () => api.deleteSkill(hostId, project.id, s.id).then(reload),
          })
        }
        onSave={async (skill, content) => {
          if (skill) await api.updateSkill(hostId, project.id, skill.id, { content });
          else await api.createSkill(hostId, project.id, { content });
          await reload();
        }}
      />
      <McpSection
        tools={tools}
        shared={shared(tools.global_mcp_servers, tools.mcp_servers, "MCP servers")}
        seenServers={dedupe(seen.flatMap((s) => s.mcp_servers)).filter((s) => !globalNames.has(s.name))}
        lastSeen={lastSeen}
        onToggleOther={(name, on) => toggleOther("disabled_mcp_servers", name, on)}
        onUpdate={(s, b) => run(() => api.updateMcpServer(hostId, project.id, s.id, b))}
        onDelete={(s) =>
          confirm.ask({
            title: `Delete MCP server ${s.name}`,
            body: `Delete the MCP server "${s.name}"?`,
            action: "Delete server",
            danger: true,
            onConfirm: () => api.deleteMcpServer(hostId, project.id, s.id).then(reload),
          })
        }
        onSave={async (server, b) => {
          if (server) await api.updateMcpServer(hostId, project.id, server.id, b);
          else await api.createMcpServer(hostId, project.id, b);
          await reload();
        }}
      />
      {err && <div className="text-xs text-red-400">{err}</div>}
      {confirm.dialog}
    </>
  );
}

function dedupe<T extends { name: string }>(items: T[]): T[] {
  const byName = new Map<string, T>();
  for (const i of items) if (!byName.has(i.name)) byName.set(i.name, i);
  return [...byName.values()];
}

const describe = (i: ProjectSkill | ProjectMcpServer) => ("content" in i ? i.description : serverSummary(i.config));

/** A project's switches for the host's global skills or servers: its profile's default, or on or off. */
function SharedList({
  what,
  items,
  replaced,
  profileOn,
  override,
  onChange,
}: {
  what: string;
  items: (ProjectSkill | ProjectMcpServer)[];
  /** Names of the project's own ones that are on, which take the place of global ones with the same name. */
  replaced: Set<string>;
  profileOn: (id: string) => boolean;
  override: (id: string) => boolean | null;
  onChange: (id: string, enabled: boolean | null) => void;
}) {
  return (
    <div className="rounded-md border border-line/70">
      <div className="px-3 pt-2 text-[12px] text-muted">Global {what}</div>
      <div className="divide-y divide-line/70">
        {items.map((i) => {
          const o = override(i.id);
          const on = o ?? profileOn(i.id);
          const mine = replaced.has(i.name);
          return (
            <div key={i.id} className="flex items-center gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className={clsx("font-mono text-[12.5px]", (!on || mine) && "text-faint")}>{i.name}</div>
                <div className="truncate text-[11.5px] text-faint">{mine ? "Replaced by this project's own, while that's on" : describe(i)}</div>
              </div>
              <select
                value={o === null ? "" : o ? "on" : "off"}
                onChange={(e) => onChange(i.id, e.target.value === "" ? null : e.target.value === "on")}
                className="h-7 shrink-0 rounded-md border border-line bg-panel px-2 text-[12px] outline-none"
              >
                <option value="">Profile default ({profileOn(i.id) ? "on" : "off"})</option>
                <option value="on">On</option>
                <option value="off">Off</option>
              </select>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Section({ title, action, hint, children }: { title: string; action: ReactNode; hint: ReactNode; children: ReactNode }) {
  return (
    <div className="space-y-3 rounded-xl border border-line p-4">
      <div className="flex items-center justify-between gap-3">
        <div className="text-[13px] font-medium">{title}</div>
        {action}
      </div>
      <div className="text-[12px] text-faint">{hint}</div>
      {children}
    </div>
  );
}

/** Skills or servers the agents get from Claude configs, plugins or the repository, each with an on/off switch. */
function OtherList<T extends { name: string }>({
  label,
  items,
  disabled,
  lastSeen,
  placeholder,
  detail,
  onToggle,
}: {
  label: string;
  items: T[];
  disabled: string[];
  lastSeen?: string;
  /** An example name, for turning off one that isn't listed. */
  placeholder: string;
  detail?: (item: T) => string | undefined;
  onToggle: (name: string, on: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  // Turned off but not seen lately: still listed, so they can be turned back on.
  const all = useMemo(() => {
    const names = new Set(items.map((i) => i.name));
    const gone = disabled.filter((n) => !names.has(n)).map((name) => ({ name }) as unknown as T);
    return [...items, ...gone].sort((a, b) => a.name.localeCompare(b.name));
  }, [items, disabled]);
  const shown = all.filter((i) => i.name.toLowerCase().includes(filter.toLowerCase()));
  const off = all.filter((i) => disabled.includes(i.name)).length;
  const [adding, setAdding] = useState("");
  const add = () => {
    const name = adding.trim();
    if (name && !disabled.includes(name)) onToggle(name, false);
    setAdding("");
  };
  return (
    <div className="rounded-md border border-line/70">
      <button type="button" onClick={() => setOpen(!open)} className="flex w-full items-center gap-1.5 px-3 py-2 text-left text-[12.5px] text-muted hover:text-fg">
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        {label} from Claude configs, plugins and the repository
        <span className="ml-auto text-[11.5px] text-faint">{all.length ? `${all.length - off} on${off > 0 ? `, ${off} off` : ""}` : "none seen yet"}</span>
      </button>
      {open && (
        <div className="space-y-2.5 border-t border-line/70 px-3 py-2.5">
          {all.length > 10 && <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter" className="h-7 text-[12px]" />}
          {all.length > 0 && (
            <div className="max-h-72 space-y-1.5 overflow-y-auto">
              {shown.map((i) => (
                <div key={i.name} className="flex items-center gap-2">
                  <Toggle
                    checked={!disabled.includes(i.name)}
                    onChange={(on) => onToggle(i.name, on)}
                    label={<span className={clsx("font-mono text-[12px]", disabled.includes(i.name) && "text-faint line-through")}>{i.name}</span>}
                  />
                  {detail?.(i) && <span className="truncate text-[11.5px] text-faint">{detail(i)}</span>}
                </div>
              ))}
            </div>
          )}
          <div className="text-[11.5px] text-faint">
            {all.length > 0
              ? `What this project's agent runs have reported${lastSeen ? ` (last ${timeAgo(lastSeen)})` : ""}. `
              : "Listed once this project's agents have run. "}
            Turning one off denies it to the agents from their next message.
          </div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              add();
            }}
          >
            <Input value={adding} onChange={(e) => setAdding(e.target.value)} placeholder={`Turn off another by name, e.g. ${placeholder}`} className="h-7 font-mono text-[12px]" />
            <Button size="sm" disabled={!adding.trim()}>
              Turn off
            </Button>
          </form>
        </div>
      )}
    </div>
  );
}

// ---------- skills ----------

function SkillsSection({
  tools,
  shared,
  seenSkills,
  lastSeen,
  onToggleOther,
  onToggle,
  onDelete,
  onSave,
}: {
  tools: AgentTools;
  /** The project's switches for global ones. */
  shared: ReactNode;
  seenSkills: string[];
  lastSeen?: string;
  onToggleOther: (name: string, on: boolean) => void;
  onToggle: (s: ProjectSkill, enabled: boolean) => void;
  onDelete: (s: ProjectSkill) => void;
  onSave: (skill: ProjectSkill | null, content: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ProjectSkill | "new" | null>(null);
  const own = new Set(tools.skills.map((s) => s.name));
  return (
    <Section
      title="Skills"
      action={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> New skill
        </Button>
      }
      hint="This project's own skills, kept on its host rather than in the repository. Global ones (Settings → Skills and MCP servers) follow the profile's default unless you switch them here. Changes apply from each thread's next message."
    >
      {tools.skills.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {tools.skills.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <Toggle checked={s.enabled} onChange={(v) => onToggle(s, v)} label="" />
              <div className="min-w-0 flex-1">
                <div className={clsx("font-mono text-[12.5px]", !s.enabled && "text-faint")}>{s.name}</div>
                <div className="truncate text-[11.5px] text-faint">{s.description}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(s)} title="Delete">
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {shared}
      <OtherList
        label="Skills"
        items={seenSkills.filter((n) => !own.has(n)).map((name) => ({ name }))}
        disabled={tools.disabled_skills}
        lastSeen={lastSeen}
        placeholder="pdf"
        onToggle={onToggleOther}
      />
      {editing && <SkillEditor skill={editing === "new" ? null : editing} onSave={onSave} onClose={() => setEditing(null)} />}
    </Section>
  );
}

function SkillEditor({ skill, onSave, onClose }: { skill: ProjectSkill | null; onSave: (skill: ProjectSkill | null, content: string) => Promise<void>; onClose: () => void }) {
  const [content, setContent] = useState(skill?.content ?? SKILL_TEMPLATE);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(skill, content);
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={skill ? `Edit ${skill.name}` : "New skill"} onClose={onClose} onSubmit={save} width="max-w-3xl">
      <div className="space-y-3">
        <Field
          label="SKILL.md"
          hint={
            <>
              The frontmatter's <code>name</code> (lowercase letters, numbers and hyphens) names the skill, and Claude reads its <code>description</code>{" "}
              to decide when to use it. Other frontmatter, such as <code>allowed-tools</code>, works as in any skill.
            </>
          }
        >
          <Textarea rows={20} className="font-mono text-[12px]" value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} autoFocus />
        </Field>
        <ModalFooter className="space-y-3">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <span className="mr-auto text-[11.5px] text-faint">{SUBMIT_KEYS} to save</span>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy} onClick={save}>
              {skill ? "Save skill" : "Add skill"}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------- MCP servers ----------

const serverSummary = (c: McpServerConfig) => (c.type === "http" || c.type === "sse" ? `${c.type} · ${c.url}` : [c.command, ...(c.args ?? [])].join(" "));

function McpSection({
  tools,
  shared,
  seenServers,
  lastSeen,
  onToggleOther,
  onUpdate,
  onDelete,
  onSave,
}: {
  tools: AgentTools;
  /** The project's switches for global ones. */
  shared: ReactNode;
  seenServers: { name: string; status?: string; source?: string }[];
  lastSeen?: string;
  onToggleOther: (name: string, on: boolean) => void;
  onUpdate: (s: ProjectMcpServer, b: { enabled?: boolean; auto_allow?: boolean }) => void;
  onDelete: (s: ProjectMcpServer) => void;
  onSave: (server: ProjectMcpServer | null, b: { name: string; config: McpServerConfig }) => Promise<void>;
}) {
  const [editing, setEditing] = useState<ProjectMcpServer | "new" | null>(null);
  const own = new Set(tools.mcp_servers.map((s) => s.name));
  return (
    <Section
      title="MCP servers"
      action={
        <Button size="sm" onClick={() => setEditing("new")}>
          <Plus size={13} /> Add server
        </Button>
      }
      hint="This project's own MCP servers, on top of the board's. Their tools ask for approval like any other, unless you allow them. Global ones follow the profile's default unless you switch them here."
    >
      {tools.mcp_servers.length > 0 && (
        <div className="divide-y divide-line/70 rounded-md border border-line/70">
          {tools.mcp_servers.map((s) => (
            <div key={s.id} className="flex items-center gap-3 px-3 py-2">
              <Toggle checked={s.enabled} onChange={(v) => onUpdate(s, { enabled: v })} label="" />
              <div className="min-w-0 flex-1">
                <div className={clsx("font-mono text-[12.5px]", !s.enabled && "text-faint")}>{s.name}</div>
                <div className="truncate font-mono text-[11px] text-faint">{serverSummary(s.config)}</div>
              </div>
              <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" title="Run this server's tools without asking for approval">
                <input type="checkbox" checked={s.auto_allow} onChange={(e) => onUpdate(s, { auto_allow: e.target.checked })} className="accent-accent" />
                Allow all tools
              </label>
              <Button size="sm" variant="ghost" onClick={() => setEditing(s)}>
                Edit
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onDelete(s)} title="Delete">
                <Trash2 size={13} />
              </Button>
            </div>
          ))}
        </div>
      )}
      {shared}
      <OtherList
        label="Servers"
        items={seenServers.filter((s) => !own.has(s.name))}
        disabled={tools.disabled_mcp_servers}
        lastSeen={lastSeen}
        placeholder="claude.ai Gmail"
        detail={(s) => [s.source, s.status].filter(Boolean).join(" · ") || undefined}
        onToggle={onToggleOther}
      />
      {editing && <McpEditor server={editing === "new" ? null : editing} onSave={onSave} onClose={() => setEditing(null)} />}
    </Section>
  );
}

/** `KEY=value` (or `Name: value` for headers) lines ↔ an object. */
const toLines = (o: Record<string, string> | undefined, sep: string) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n");

function fromLines(text: string, sep: string, what: string): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const line of text.split("\n").map((l) => l.trim()).filter(Boolean)) {
    const i = line.indexOf(sep.trim());
    if (i <= 0) throw new Error(`Each ${what} line needs ${sep.trim()}: ${line}`);
    out[line.slice(0, i).trim()] = line.slice(i + sep.trim().length).trim();
  }
  return Object.keys(out).length ? out : undefined;
}

type Form = { type: "stdio" | "http" | "sse"; command: string; args: string; env: string; url: string; headers: string };

function toForm(c: McpServerConfig): Form {
  return {
    type: c.type ?? (c.url ? "http" : "stdio"),
    command: c.command ?? "",
    args: (c.args ?? []).join("\n"),
    env: toLines(c.env, "="),
    url: c.url ?? "",
    headers: toLines(c.headers, ": "),
  };
}

/** The form's fields over `base`, so settings the form doesn't show (e.g. `timeout`) stay. */
function fromForm(f: Form, base: McpServerConfig): McpServerConfig {
  const rest = Object.fromEntries(Object.entries(base).filter(([k]) => !["type", "command", "args", "env", "url", "headers"].includes(k)));
  if (f.type === "stdio") {
    const args = f.args.split("\n").map((a) => a.trim()).filter(Boolean);
    return { ...rest, type: "stdio", command: f.command.trim(), ...(args.length ? { args } : {}), ...(f.env.trim() ? { env: fromLines(f.env, "=", "environment") } : {}) };
  }
  return { ...rest, type: f.type, url: f.url.trim(), ...(f.headers.trim() ? { headers: fromLines(f.headers, ": ", "header") } : {}) };
}

function McpEditor({
  server,
  onSave,
  onClose,
}: {
  server: ProjectMcpServer | null;
  onSave: (server: ProjectMcpServer | null, b: { name: string; config: McpServerConfig }) => Promise<void>;
  onClose: () => void;
}) {
  const [name, setName] = useState(server?.name ?? "");
  const [base, setBase] = useState<McpServerConfig>(server?.config ?? {});
  const [form, setForm] = useState<Form>(toForm(server?.config ?? { type: "stdio" }));
  const [json, setJson] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v });
  const config = () => (json !== null ? (JSON.parse(json) as McpServerConfig) : fromForm(form, base));
  const switchMode = () => {
    setErr(null);
    try {
      if (json === null) setJson(JSON.stringify(fromForm(form, base), null, 2));
      else {
        const c = JSON.parse(json) as McpServerConfig;
        setBase(c);
        setForm(toForm(c));
        setJson(null);
      }
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onSave(server, { name: name.trim(), config: config() });
      onClose();
    } catch (e) {
      setErr((e as Error).message);
      setBusy(false);
    }
  };
  return (
    <Modal title={server ? `Edit ${server.name}` : "Add MCP server"} onClose={onClose} onSubmit={save} width="max-w-xl">
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Name" hint="Its tools are named mcp__<name>__<tool>.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className="font-mono text-[12px]" autoFocus />
          </Field>
          {json === null && (
            <Field label="Transport">
              <select value={form.type} onChange={(e) => set("type", e.target.value as Form["type"])} className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none">
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </Field>
          )}
        </div>
        {json !== null ? (
          <Field label="Config" hint={<>An entry of <code>mcpServers</code>, as in <code>.mcp.json</code>.</>}>
            <Textarea rows={12} className="font-mono text-[12px]" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          </Field>
        ) : form.type === "stdio" ? (
          <>
            <Field label="Command" hint="Run on the project's host, in the agent's working directory.">
              <Input value={form.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" className="font-mono text-[12px]" />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <Textarea rows={3} value={form.args} onChange={(e) => set("args", e.target.value)} placeholder={"-y\n@modelcontextprotocol/server-github"} className="font-mono text-[12px]" spellCheck={false} />
            </Field>
            <Field label="Environment" hint="KEY=value, one per line.">
              <Textarea rows={3} value={form.env} onChange={(e) => set("env", e.target.value)} placeholder="GITHUB_TOKEN=…" className="font-mono text-[12px]" spellCheck={false} />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input value={form.url} onChange={(e) => set("url", e.target.value)} placeholder="https://mcp.example.com/mcp" className="font-mono text-[12px]" />
            </Field>
            <Field label="Headers" hint="Name: value, one per line.">
              <Textarea rows={3} value={form.headers} onChange={(e) => set("headers", e.target.value)} placeholder="Authorization: Bearer …" className="font-mono text-[12px]" spellCheck={false} />
            </Field>
          </>
        )}
        <ModalFooter className="space-y-4">
          {err && <div className="text-xs text-red-400">{err}</div>}
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" className="mr-auto" onClick={switchMode}>
              {json === null ? "Edit as JSON" : "Edit as form"}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={busy || !name.trim()} onClick={save}>
              {server ? "Save server" : "Add server"}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  );
}

// ---------- global ----------

/** A host's global skills and MCP servers, each switched on or off by default per profile. */
export function GlobalAgentToolsPanel() {
  const hosts = useStore(useShallow((s) => s.hosts.filter((h) => canRunAgents(h) && hostSupports(h, 22))));
  const firstHost = hosts.find((h) => h.local)?.id ?? hosts[0]?.id ?? "";
  const [picked, setHostId] = useState("");
  const hostId = hosts.some((h) => h.id === picked) ? picked : firstHost;
  const allHosts = useStore((s) => s.hosts.filter(canRunAgents).length);
  const profiles = useStore((s) => s.profiles).filter((p) => p.host_id === hostId);
  const [tools, setTools] = useState<GlobalAgentTools | null>(null);
  const [editing, setEditing] = useState<{ kind: "skill" | "server"; item: ProjectSkill | ProjectMcpServer | null } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const reload = useCallback(() => {
    if (!hostId) return Promise.resolve();
    return api.globalAgentTools(hostId).then(setTools, (e) => setErr((e as Error).message));
  }, [hostId]);
  useEffect(() => {
    setTools(null);
    reload();
  }, [reload]);
  const confirm = useConfirm();
  if (!hostId) return null;
  const run = async (fn: () => Promise<unknown>) => {
    setErr(null);
    try {
      await fn();
      await reload();
    } catch (e) {
      setErr((e as Error).message);
    }
  };
  const isOn = (profileId: string, id: string) => !!tools?.profile_switches[profileId]?.[id];
  const row = (item: ProjectSkill | ProjectMcpServer, kind: "skill" | "server") => (
    <div key={item.id} className="space-y-1.5 px-3 py-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="font-mono text-[12.5px]">{item.name}</div>
          <div className={clsx("truncate text-[11.5px] text-faint", kind === "server" && "font-mono")}>{describe(item)}</div>
        </div>
        {"auto_allow" in item && (
          <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-muted" title="Run this server's tools without asking for approval">
            <input
              type="checkbox"
              checked={item.auto_allow}
              onChange={(e) => run(() => api.updateGlobalMcpServer(hostId, item.id, { auto_allow: e.target.checked }))}
              className="accent-accent"
            />
            Allow all tools
          </label>
        )}
        <Button size="sm" variant="ghost" onClick={() => setEditing({ kind, item })}>
          Edit
        </Button>
        <Button
          size="sm"
          variant="ghost"
          title="Delete"
          onClick={() =>
            confirm.ask({
              title: `Delete ${item.name}`,
              body: `Delete "${item.name}" from every profile and project on this host?`,
              action: kind === "skill" ? "Delete skill" : "Delete server",
              danger: true,
              onConfirm: () => (kind === "skill" ? api.deleteGlobalSkill(hostId, item.id) : api.deleteGlobalMcpServer(hostId, item.id)).then(reload),
            })
          }
        >
          <Trash2 size={13} />
        </Button>
      </div>
      {profiles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 text-[11.5px] text-faint">
          On by default in
          {profiles.map((p) => {
            const on = isOn(p.id, item.id);
            return (
              <button
                key={p.id}
                type="button"
                onClick={() => run(() => api.setAgentToolSwitch(hostId, { scope: "profile", scope_id: p.id, item_id: item.id, enabled: on ? null : true }))}
                className={clsx(
                  "rounded-full border px-2 py-0.5 transition-colors",
                  on ? "border-accent/50 bg-accent/15 text-fg" : "border-line text-faint hover:text-muted",
                )}
                title={on ? `On by default in ${p.name}'s projects. Click to turn off.` : `Off by default in ${p.name}'s projects. Click to turn on.`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-2">
        <h2 className="text-[13px] font-semibold">Skills and MCP servers</h2>
        <div className="flex gap-2">
          <Button size="sm" onClick={() => setEditing({ kind: "skill", item: null })}>
            <Plus size={13} /> New skill
          </Button>
          <Button size="sm" onClick={() => setEditing({ kind: "server", item: null })}>
            <Plus size={13} /> Add MCP server
          </Button>
        </div>
      </div>
      <p className="mb-3 text-[12.5px] text-muted">
        Skills and MCP servers for agents, kept on the host rather than in a repository. Each profile switches them on or off by default for its projects,
        and a project can override that in its settings, or add its own.
      </p>
      {allHosts > 1 && (
        <div className="mb-3 w-64">
          <HostSelect value={hostId} onChange={setHostId} />
        </div>
      )}
      {tools && (
        <div className="space-y-3">
          {tools.skills.length + tools.mcp_servers.length === 0 && (
            <div className="rounded-xl border border-dashed border-line p-4 text-[12.5px] text-faint">No global skills or MCP servers on this host yet.</div>
          )}
          {tools.skills.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="px-3 pt-2.5 text-[12px] font-medium text-muted">Skills</div>
              <div className="divide-y divide-line/70">{tools.skills.map((s) => row(s, "skill"))}</div>
            </div>
          )}
          {tools.mcp_servers.length > 0 && (
            <div className="rounded-xl border border-line">
              <div className="px-3 pt-2.5 text-[12px] font-medium text-muted">MCP servers</div>
              <div className="divide-y divide-line/70">{tools.mcp_servers.map((s) => row(s, "server"))}</div>
            </div>
          )}
        </div>
      )}
      {err && <div className="mt-2 text-xs text-red-400">{err}</div>}
      {confirm.dialog}
      {editing?.kind === "skill" && (
        <SkillEditor
          skill={editing.item as ProjectSkill | null}
          onSave={async (skill, content) => {
            if (skill) await api.updateGlobalSkill(hostId, skill.id, { content });
            else await api.createGlobalSkill(hostId, { content });
            await reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}
      {editing?.kind === "server" && (
        <McpEditor
          server={editing.item as ProjectMcpServer | null}
          onSave={async (server, b) => {
            if (server) await api.updateGlobalMcpServer(hostId, server.id, b);
            else await api.createGlobalMcpServer(hostId, b);
            await reload();
          }}
          onClose={() => setEditing(null)}
        />
      )}
    </section>
  );
}
