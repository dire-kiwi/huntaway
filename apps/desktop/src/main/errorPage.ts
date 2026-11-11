import { RETRY_URL, SKIP_BACKUP_URL } from "./urls.ts"

// The page a window shows when there is no board to show: a `data:` URL with what went wrong, the server's last
// output, the desktop.json path, and Retry (and, for a backup that failed, "Start without a backup") as links the
// window stops on their way (urls.ts).

const esc = (s: string) => s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;")

const button = (href: string, label: string, primary = true) =>
  `<a href="${href}" style="display:inline-block;margin:8px 8px 0 0;padding:6px 14px;border-radius:6px;background:${primary ? "#6366f1" : "#24242e"};color:#fff;text-decoration:none">${esc(label)}</a>`

export interface ErrorPage {
  readonly message: string
  readonly title?: string | null
  readonly backup?: { readonly reason: string; readonly why: string; readonly dir: string } | null
  /** The server's last lines of output. */
  readonly log: ReadonlyArray<string>
  readonly configPath: string
}

/** The error page as a `data:` URL. */
export const errorPage = (page: ErrorPage): string => {
  const log =
    page.log.length > 0
      ? `<p style="color:#9a9aab;margin-top:24px">The server's last output:</p>
    <pre style="white-space:pre-wrap;font:12px ui-monospace,monospace;color:#c8c8d0;background:#16161d;border:1px solid #24242e;border-radius:8px;padding:12px;max-height:50vh;overflow:auto">${esc(page.log.join("\n"))}</pre>`
      : ""
  let body = `<h2>${esc(page.title ?? "Huntaway couldn't start")}</h2><pre style="white-space:pre-wrap;color:#f87171">${esc(page.message)}</pre>`
  let buttons = button(RETRY_URL, "Retry")
  const backup = page.backup ?? null
  if (backup !== null) {
    const fixes: Readonly<Record<string, string>> = {
      space: `Free some space on that disk (older backups in ${backup.dir} can go), then Retry.`,
      permissions: `Let Huntaway write to ${backup.dir}, then Retry.`,
    }
    body = `<h2>Huntaway couldn't back up its database</h2>
    <p style="max-width:720px;line-height:1.5">When its version changes, Huntaway copies the database before the new version opens it,
    so that it can go back with its data if the new version is no good. This time it couldn't:</p>
    <pre style="white-space:pre-wrap;color:#f87171">${esc(backup.why)}</pre>
    <p style="max-width:720px;line-height:1.5">${esc(fixes[backup.reason] ?? "Retry, or start without a backup.")} Start without a backup opens the
    database as it is: if the new version changes it, there's no copy from before to go back to.</p>`
    buttons += button(SKIP_BACKUP_URL, "Start without a backup", false)
  }
  const html = `<body style="background:#0b0b0e;color:#e6e6ec;font:14px system-ui;padding:40px">
    ${body}<p>${buttons}</p>${log}
    <p style="color:#9a9aab">Config: ${esc(page.configPath)}</p></body>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
