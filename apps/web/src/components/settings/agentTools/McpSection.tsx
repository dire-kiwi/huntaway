import { clsx } from "clsx"
import { Plus, Trash2 } from "lucide-react"
import { useState, type ReactNode } from "react"
import type { McpServer, McpServerConfig, ProjectAgentTools as AgentTools } from "@huntaway/contracts"
import { Exit, Option, Schema } from "effect"
import { useAction } from "../../../state/mutation"
import { Button, errorText, Field, Input, Modal, ModalFooter, parseJson, Textarea, Toggle } from "../../ui"
import { OtherList, Section, serverSummary, type Save } from "./parts"

/** A server as saved: its name and its `mcpServers` entry. */
export interface ServerBody {
  name: string
  config: McpServerConfig
}

export function McpSection({
  tools,
  shared,
  seenServers,
  lastSeen,
  onToggleOther,
  onUpdate,
  onDelete,
  onSave,
}: {
  tools: AgentTools
  /** The project's switches for global ones. */
  shared: ReactNode
  seenServers: { name: string; status: string | null; source: string | null }[]
  lastSeen?: string | undefined
  onToggleOther: (name: string, on: boolean) => void
  onUpdate: (s: McpServer, b: { enabled?: boolean; auto_allow?: boolean }) => void
  onDelete: (s: McpServer) => void
  onSave: Save<[server: McpServer | null, b: ServerBody]>
}) {
  const [editing, setEditing] = useState<McpServer | "new" | null>(null)
  const own = new Set(tools.mcp_servers.map((s) => s.name))
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
  )
}

/** `KEY=value` (or `Name: value` for headers) lines ↔ an object. */
const toLines = (o: Readonly<Record<string, string>> | undefined, sep: string) =>
  Object.entries(o ?? {})
    .map(([k, v]) => `${k}${sep}${v}`)
    .join("\n")

function fromLines(text: string, sep: string, what: string): Record<string, string> | undefined {
  const out: Record<string, string> = {}
  for (const line of text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)) {
    const i = line.indexOf(sep.trim())
    if (i <= 0) throw new Error(`Each ${what} line needs ${sep.trim()}: ${line}`)
    out[line.slice(0, i).trim()] = line.slice(i + sep.trim().length).trim()
  }
  return Object.keys(out).length ? out : undefined
}

type Form = { type: "stdio" | "http" | "sse"; command: string; args: string; env: string; url: string; headers: string }

function toForm(c: McpServerConfig): Form {
  return {
    type: c.type ?? (c.url ? "http" : "stdio"),
    command: c.command ?? "",
    args: (c.args ?? []).join("\n"),
    env: toLines(c.env, "="),
    url: c.url ?? "",
    headers: toLines(c.headers, ": "),
  }
}

/** The form's fields over `base`, so settings the form doesn't show (e.g. `timeout`) stay. */
function fromForm(f: Form, base: McpServerConfig): McpServerConfig {
  const rest = Object.fromEntries(Object.entries(base).filter(([k]) => !["type", "command", "args", "env", "url", "headers"].includes(k)))
  if (f.type === "stdio") {
    const args = f.args
      .split("\n")
      .map((a) => a.trim())
      .filter(Boolean)
    const env = f.env.trim() ? fromLines(f.env, "=", "environment") : undefined
    return { ...rest, type: "stdio", command: f.command.trim(), ...(args.length ? { args } : {}), ...(env ? { env } : {}) }
  }
  const headers = f.headers.trim() ? fromLines(f.headers, ": ", "header") : undefined
  return { ...rest, type: f.type, url: f.url.trim(), ...(headers ? { headers } : {}) }
}

const encodePretty = Schema.encodeUnknownOption(Schema.fromJsonString(Schema.Unknown, { space: 2 }))
const prettyJson = (value: unknown): string => Option.getOrElse(encodePretty(value), () => "{}")

/** A config typed as JSON: an object, as `mcpServers` has them (the server checks the rest). */
function parseConfig(text: string): McpServerConfig {
  const v = parseJson(text)
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("The config must be a JSON object")
  const out: Record<string, unknown> = {}
  for (const [k, x] of Object.entries(v)) out[k] = x
  return out
}

export function McpEditor({
  server,
  onSave,
  onClose,
}: {
  server: McpServer | null
  onSave: Save<[server: McpServer | null, b: ServerBody]>
  onClose: () => void
}) {
  const [name, setName] = useState(server?.name ?? "")
  const [base, setBase] = useState<McpServerConfig>(server?.config ?? {})
  const [form, setForm] = useState<Form>(toForm(server?.config ?? { type: "stdio" }))
  const [json, setJson] = useState<string | null>(null)
  const [saving, run] = useAction()
  const busy = saving.busy
  // Why the form's config doesn't read (as JSON, or from the form), else why the last save failed.
  const [invalid, setErr] = useState<string | null>(null)
  const err = invalid ?? saving.error
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm({ ...form, [k]: v })
  const config = () => (json !== null ? parseConfig(json) : fromForm(form, base))
  const switchMode = () => {
    setErr(null)
    try {
      if (json === null) setJson(prettyJson(fromForm(form, base)))
      else {
        const c = parseConfig(json)
        setBase(c)
        setForm(toForm(c))
        setJson(null)
      }
    } catch (e) {
      setErr(errorText(e))
    }
  }
  const save = () => {
    setErr(null)
    let body: ServerBody
    try {
      body = { name: name.trim(), config: config() }
    } catch (e) {
      setErr(errorText(e))
      return
    }
    void run(onSave(server, body)).then((exit) => {
      if (Exit.isSuccess(exit)) onClose()
    })
  }
  return (
    <Modal title={server ? `Edit ${server.name}` : "Add MCP server"} onClose={onClose} onSubmit={() => save()} width="max-w-xl">
      <div className="space-y-4">
        <div className="grid grid-cols-[1fr_140px] gap-3">
          <Field label="Name" hint="Its tools are named mcp__<name>__<tool>.">
            <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="github" className="font-mono text-[12px]" autoFocus />
          </Field>
          {json === null && (
            <Field label="Transport">
              <select
                value={form.type}
                onChange={(e) => set("type", e.target.value === "http" || e.target.value === "sse" ? e.target.value : "stdio")}
                className="h-8 w-full rounded-md border border-line bg-panel px-2 text-[13px] outline-none"
              >
                <option value="stdio">stdio</option>
                <option value="http">HTTP</option>
                <option value="sse">SSE</option>
              </select>
            </Field>
          )}
        </div>
        {json !== null ? (
          <Field
            label="Config"
            hint={
              <>
                An entry of <code>mcpServers</code>, as in <code>.mcp.json</code>.
              </>
            }
          >
            <Textarea rows={12} className="font-mono text-[12px]" value={json} onChange={(e) => setJson(e.target.value)} spellCheck={false} />
          </Field>
        ) : form.type === "stdio" ? (
          <>
            <Field label="Command" hint="Run on the project's host, in the agent's working directory.">
              <Input value={form.command} onChange={(e) => set("command", e.target.value)} placeholder="npx" className="font-mono text-[12px]" />
            </Field>
            <Field label="Arguments" hint="One per line.">
              <Textarea
                rows={3}
                value={form.args}
                onChange={(e) => set("args", e.target.value)}
                placeholder={"-y\n@modelcontextprotocol/server-github"}
                className="font-mono text-[12px]"
                spellCheck={false}
              />
            </Field>
            <Field label="Environment" hint="KEY=value, one per line.">
              <Textarea
                rows={3}
                value={form.env}
                onChange={(e) => set("env", e.target.value)}
                placeholder="GITHUB_TOKEN=…"
                className="font-mono text-[12px]"
                spellCheck={false}
              />
            </Field>
          </>
        ) : (
          <>
            <Field label="URL">
              <Input
                value={form.url}
                onChange={(e) => set("url", e.target.value)}
                placeholder="https://mcp.example.com/mcp"
                className="font-mono text-[12px]"
              />
            </Field>
            <Field label="Headers" hint="Name: value, one per line.">
              <Textarea
                rows={3}
                value={form.headers}
                onChange={(e) => set("headers", e.target.value)}
                placeholder="Authorization: Bearer …"
                className="font-mono text-[12px]"
                spellCheck={false}
              />
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
            <Button variant="primary" disabled={busy || !name.trim()} onClick={() => save()}>
              {server ? "Save server" : "Add server"}
            </Button>
          </div>
        </ModalFooter>
      </div>
    </Modal>
  )
}
