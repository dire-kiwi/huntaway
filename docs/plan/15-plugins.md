# 15. Plugins

HE-34, 15 November 2026. A plugin adds to the board what the board would otherwise have to build in: an MCP server for
its agents, pages and HTTP routes, over a SQLite database of its own. The first one meant is the docs project's
(`dire-kiwi/docs`): the board's built-in documents copied the hosted docs site's features, and a plugin of the docs
project's replaces them, so the two stop drifting apart. This page is the API and how the board runs it. HE-42 made the
switch: the board is built with `@dire-kiwi/docs-huntaway` (below, The docs plugin), and its own documents are gone.

## What a plugin is

A package that default-exports `definePlugin({ id, name, version, description?, migrations?, make })` from
`@huntaway/plugin` (`packages/plugin`). It runs **in the server's process, on the server's `effect`** (a peer
dependency), so its code is written as the board's is: services, `Effect.fn`, schemas, tagged errors. The example,
`packages/plugin/src/example/notes.ts`, uses every part in one file; the demo board runs it.

- `id` (`[a-z][a-z0-9_]{0,31}`, not one of `RESERVED_IDS`: the board's server names and first path segments) names
  its MCP server (`mcp__<id>__<tool>`), its pages (`/<id>/…`), its routes (`/plugins/<id>/…`) and its data folder.
  It never changes once released: links and approval rules name it.
- `migrations`: `{ name, run }` in order. Each runs once, in a transaction, recorded in its database's own `migrations`
  table; one a newer build recorded is left alone. A migration may copy the board's own tables listed for its id
  (`PluginImport`, `plugins/start.ts`' `IMPORTABLE`: the `docs*`/`doc_*` tables for `docs`), so a feature moving out
  of the board keeps its data.
- `make`: built once as the server starts, after the migrations, with `SqlClient` (its database), `PluginHost` (the
  board's services), `HttpClient`, `FileSystem`, `Path` and the server's `Scope` (for a background fiber). It returns
  its parts: `mcp`, `pages`, `calls`, `routes`, each optional. A plugin that fails in a migration or in `make` is
  listed with its error and has none of its parts; the board starts without it.

## Its database and files

`<data>/plugins/<id>/plugin.db` (SQLite through `@effect/sql-sqlite-node`, WAL, foreign keys on, 0600) and
`<data>/plugins/<id>/files/` (0700, `PluginHost.filesDir`) for what isn't rows (images may be either). One per plugin
per host, as the board's data is per host; data per profile is the plugin's to key by `profile_id`. The board's own
table in it is `huntaway_secrets` (below). The board's backups (`Backup`) don't cover it yet.

## MCP

`mcp: { tools, instructions?, preApproved?, maxRequestBytes? }`. A tool is `pluginTool(Tool.make(…), handler,
{ offer? })`: the same `effect/ai` tool the board's own are made of, its arguments decoded with its schema and its
result encoded. The server defines it with `McpServers.define` (`ServerName` is now any server name; the board's own
are `BuiltInServer`) and adds the tools wrapped as `RegisteredTool`s, so a call goes through `ToolCalls` like gh's:
at most once per call id, recorded in `mcp_calls`, the argument check. Each handler gets the call's `CallContext`:
the run, its task (id, key, title, kind, status), project and profile, whether it's a reviewer's.

- **Served to every run** on this host as an HTTP server in its `mcp.json` (`/api/mcp/<run>/<id>`, the run's secret),
  Claude's and Codex's, unless the project turns it off (denies `mcp__<id>`, or has a server of its own by that name:
  `usesServer`) — `ServedServers.plugins`, `pluginServers`.
- **Per run**: `instructions` may be a function of the run (`initialize` asks with the run's id), and a tool's `offer`
  decides whether a run is offered it (`tools/list`); a call of a tool not offered is refused.
- `preApproved`: its tools are called without asking (`--allowedTools mcp__<id>`, Codex's approved servers), for tools
  that only touch the plugin's own data, as the docs server's are. Otherwise each call asks, as any MCP server's do.
- Tools are read-only hinted by `Tool.Readonly`, as gh's. Plugins' servers answer `resources/list` and `prompts/list`
  with none.

## Pages

`pages: { nav?, settings?, task?, render }`. `render({ slot, path, query, task_id, session })` gives
`Page.html(html, { title })`, `Page.redirect(path)` or (for a task) `Page.empty`. The slots:

| Slot       | Where                                                                  | When                    |
| ---------- | ---------------------------------------------------------------------- | ----------------------- |
| `page`     | `/<id>/<path>`, the board's main area; a menu entry under Docs if `nav` | always                  |
| `settings` | Settings → Plugins, under the plugin's name                            | `settings` is set       |
| `task`     | a section of a task's key items and Details (HE-31), on its host; left out when `empty` | `task` is true |

The web app reads a page with `plugins.page` on the plugin's host, with the address's query string as `query` less the
board's own parameters (`task`, `side`, `compare`, `modal`; `router.ts`'s `pluginQuery`, HE-63). A page isn't kept
once nothing shows it, as other reads are for 10 seconds (`queries.ts`): a plugin can change its pages without an event
that says so (the docs editor's Save, before it goes to the document), so a page opened again is read again, and a new
frame gets one render, not an old one and then the new (Chromium leaves a sandboxed frame whose `srcdoc` is set twice
within a few milliseconds without a layout). It shows the HTML in a frame as documents are
(`components/plugins/frameSource.ts`): `sandbox="allow-scripts"` with no same origin, under `FRAME_CSP` (no network:
images are `data:`/`blob:` URLs, data comes through the bridge), WebRTC taken away. The frame's `:root` has the
board's theme as its own CSS variables (`--color-*`, `--font-*`), and `window.huntaway` is the bridge:

- `huntaway.call(method, payload)` → a promise of the plugin's call's result, over `plugins.call` on its host;
- `huntaway.navigate(path)` and `huntaway.openTask(id)`, after the user's own click in the frame;
- `huntaway.onEvent(listener)` for the plugin's events;
- `huntaway.context`: `{ host, plugin, slot, path, task_id }`.

Links in the page follow the documents' rules: the board's own paths open in the board (after a click), others in a
new tab. A `settings` or `task` frame is as tall as its page. A plugin page's links that name a path are best absolute
(`/notes/<profile id>`): in a `srcdoc` frame a relative link resolves against the board's current address.

The first path segment of a board URL that isn't one of the board's own is a plugin's (`router.ts`), so a plugin's
links are stable and shareable: `<board public URL>/<id>/<path>` (`PluginHost.pageUrl`). `/docs/…` is the docs
plugin's (HE-42), at the paths the built-in documents had, so the links agents were given keep working.

A page is the page's own host's, except one whose path starts with a profile's id (`/docs/<profile id>/…`, as every
document's does): that is the host's that has the profile (the page's own first, where two have one id;
`components/plugins/pluginHost.ts`, HE-60). So a document of a host the hub links opens there, not on the hub, which
has no such profile. Until the board is loaded, a path naming a profile no host has shown yet waits.

## Calls and events

`calls: { [method]: pluginCall({ scope, payload, success, handle }) }`. `plugins.call` needs `read`, and the method's
own `scope` (`read`, `operate`, `settings`) is checked against the session (`Forbidden`). A failure is the plugin's
`PluginError` (`not_found`, `invalid`, `conflict`, `unavailable`, `forbidden`, `failed`), on the wire `PluginFailed`.

`PluginHost.emit({ topic, profile_id?, data?, reload? })` is a board event, `{ type: "plugin", plugin, topic,
profile_id, data, reload }`. The client keeps each plugin's latest (`HostBoard.plugins`, `pluginEventAtom`), its
frames get it, and one with `reload` renders its pages again (`plugins.page`'s trigger). Events are hints, not a log.

## Routes

`routes: [{ method, path, auth?, handle }]` at `/plugins/<id><path>` (`http/plugins.ts`), for what isn't a page (an
export, a webhook). `board` (the default) needs the board token as a bearer token; `public` answers anyone who
reaches the board, and checks what it needs itself. `PluginHost.boardUrl` (and `pageUrl`) is the Public URL setting,
else `http://127.0.0.1:<the port the server listens on>` (`Listening`, so a test server's `--port 0` gives its real
port, HE-63): the docs plugin's upload URLs are made from it.

## The board's services (`PluginHost`)

The board's address (`boardUrl`: its Public URL setting, else its own) and `pageUrl(path)`; `profiles`, `profile(id)`,
`task(id or key)`, `project(id)`; `sendToTask(task, text)` (as the board sends: steers, queues or starts a run;
refusals as `PluginError`s); `emit`; `secrets.get/set/remove(profile | null, name)`, kept in the plugin's database's
`huntaway_secrets` and read as `Redacted`; `hostId`, `hostName`, `filesDir`. Outbound HTTP is `HttpClient`.

## Installing

A plugin is a dependency of `apps/server` (a GitHub release's tarball URL: there is no registry), imported in `apps/server/src/plugins/installed.ts` and listed there; `InstalledLive` (Main.ts) gives that
list, plus `notes` on a demo board. Being a dependency, it can have native or WebAssembly dependencies of its own
(pnpm installs them), and it ships in a release with the server. Tests give their own list
(`TestBoard(overrides, plugins)`).

## The server's side

`apps/server/src/plugins/`, after `mcp` in the dependency order (06-server.md): `InstalledPlugins` (the list),
`start.ts` (folder, database, migrations, `make`), `host.ts` (`PluginHost` over `Identity`, `HostSettings`,
`ProfileRepo`, `ProjectRepo`, `TaskRefs`, `Runs`, `Events`), `Plugins` (starts them in order, defines their servers,
answers `plugins.*`, holds their routes). Transports: `rpc/plugins.ts`, `http/plugins.ts`. Contract:
`packages/contracts/src/plugin.ts`, `rpc/plugins.ts` (`PluginRpcs`, in `HostRpcs`), the `plugin` event. Web:
`components/plugins/` (`PluginPage`, `PluginFrame`, `frameSource.ts`), `layout/sidebar/PluginEntries`,
`settings/Plugins`, `task/view/details/PluginSections`.

## Asked for by the docs project, and where it stands

The docs project's agent (DOC-14) listed what a docs plugin needs. Done here: an MCP server named by the plugin with
per-run tools and instructions and the run's context; a project turning it off; top-level and nested pages with
stable links; the board's theme in a sandboxed frame under a strict policy that can talk to the board (links, open a
task, calls, events); a slot on the task page; a SQLite database per plugin per host with its own migrations; a files
folder; copying the board's docs tables in a migration; sending to a task; looking up tasks and profiles; live events;
the session (the board has one user: what it knows is the session's kind and scopes); per-profile secrets; outbound
HTTP; a Settings section; calls routed to the plugin's host as every RPC is; TypeScript with native or WebAssembly
dependencies, installed from a tarball.

## The docs plugin (HE-42)

`@dire-kiwi/docs-huntaway` (dire-kiwi/docs, `huntaway/`; DOC-16), installed from its `huntaway-v<version>` release's
tarball and listed in `installed.ts`. Its id is `docs`, so `docs` is off `RESERVED_IDS`, and the board's own documents
are gone: `apps/server/src/docs`'s `Docs`, `DocRepo`, `DocImages`, `DocsRender`, `HostedDocs`, `DocsSiteRepo`, the
`docs` built-in server (`BuiltInServer`, `ServedServers.docs`, its 64 MiB limit: the plugin's `maxRequestBytes`), the
`docs.*` RPCs and their contract, the Docs page, its route and sidebar entry, and the demo board's document. What
stays the board's:

- **Its tables.** `docs*`/`doc_*` stay in the board's schema, written by the legacy import (`importLegacy`'s `docs`
  family), so a switch from the old server carries documents over: the plugin's first migration copies them
  (`IMPORTABLE`). Nothing else reads or writes them. That migration runs once per plugin database, so a plugin's data
  (`plugins/`) is the board's it was copied from: `import-legacy --replace` and `scripts/switch-board.sh` set it aside
  with `board.db` (`REPLACED_FILES`) and `--undo` puts it back, and `scripts/copy-live-board.sh` removes it with
  `board.db`, so the plugin copies the imported tables on the next start (`tests/e2e/docs.test.ts`).
- **The note.** A run whose launch serves a server named `docs` (`RunTold.docsServer`) is still told to publish
  write-ups there (`prompts/docsNote.ts`); the plugin's own instructions say how.
- **Links.** A thread's links to `/docs/<profile id>/d/<slug>/` and a `publish_document` call's result open in the
  board as the plugin's page (`task/thread/docLinks.ts`), showing the slug where they showed the title.
- **Old hosts' events.** `docs`, `doc_comments` and `docs_site` stay in `BoardEvent`, which has no catch-all member,
  so a stream from a host before HE-42 still decodes; the web ignores them.

At 0.3.0 (HE-63; DOC-17 to DOC-23) it also has: form fields' answers saved on the board, a document editor with
drafts, mockups (HTML pages) in a design editor, and image files uploaded over HTTP (`create_upload_url`, then the
plugin's public route `/plugins/docs/uploads/<token>`) and named by id in a publish. The plugin API is the same; the
board had to give pages their query string (a mockup's `?details=1` is its document's page, the design editor without
it), read a page again each time it opens, and make `boardUrl` from the port it listens on. The design editor's frames
for mockups are `srcdoc` frames inside the plugin's, which `FRAME_CSP`'s
`frame-src 'none'` doesn't hold (they load nothing), each under its own nonce policy on top of the inherited one
(`tests/e2e/docs.test.ts` uploads an image and publishes it; the editors were tried in a browser).

Updating it is a new release in dire-kiwi/docs (`render-v…` first if it needs a new renderer, then `huntaway-v…`) and
the tarball URL bumped in `apps/server/package.json`. pnpm records no `integrity` for a tarball that is only a
dependency's (the renderer is the plugin's), and `pnpm deploy` (`scripts/package-server.sh`) refuses one without: put
the renderer's in `pnpm-lock.yaml` by hand, `sha512-` and the base64 of its tarball's SHA-512 (`openssl dgst -sha512
-binary <tgz> | base64 -w0`), which later installs keep. (pnpm 10.34 recorded the 0.6.0 renderer's itself, HE-63:
check that the lockfile has it, and that it matches.)

## What's next

- `@huntaway/plugin` published as a tarball on releases, so a plugin outside this repository has its types.
- A plugin's pages on another host than
  the page's own other than by a profile's id in the path (the frame takes a `host`; the menu shows the page's own
  host's), plugins in backups, and the phone app.
