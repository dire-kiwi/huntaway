/** The plan theme's colours, from the board's own (index.css) so a plan follows it. */
const COLORS: [string, string][] = [
  ["--bg", "--color-bg"],
  ["--panel", "--color-panel"],
  ["--panel-2", "--color-panel-2"],
  ["--raised", "--color-raised"],
  ["--line", "--color-line"],
  ["--line-strong", "--color-line-strong"],
  ["--fg", "--color-fg"],
  ["--muted", "--color-muted"],
  ["--faint", "--color-faint"],
  ["--accent", "--color-accent"],
  ["--ok", "--color-st-done"],
  ["--warn", "--color-st-attention"],
  ["--info", "--color-st-progress"],
];

function boardColors(): string {
  const style = getComputedStyle(document.documentElement);
  const vars = COLORS.map(([to, from]) => [to, style.getPropertyValue(from).trim()]).filter(([, v]) => v);
  return `:root{${vars.map(([k, v]) => `${k}:${v}`).join(";")}}`;
}

/**
 * Sizes an <ia-html>'s frame to its content (not the window, which the frame sets): it reports the
 * body's extent, overflow included, to the plan's frame (iaHtmlHeight). Chromium doesn't update the
 * rendering of an offscreen frame of another origin, so observers of size don't fire there until it's
 * scrolled to: it also reports when the page has loaded and when the DOM changes. It runs in the
 * component's frame, as source.
 */
function fitFrame() {
  let last = -1;
  const post = () => {
    const body = document.body;
    if (!body) return;
    const height = Math.max(body.scrollHeight, Math.ceil(body.getBoundingClientRect().height));
    if (height === last) return;
    last = height;
    parent.postMessage({ iaHtmlHeight: height }, "*");
  };
  const sizes = new ResizeObserver(post);
  const observe = (el: Element) => [el, ...el.querySelectorAll("*")].forEach((e) => sizes.observe(e));
  addEventListener("DOMContentLoaded", () => {
    observe(document.body);
    new MutationObserver((changes) => {
      for (const c of changes) for (const n of c.addedNodes) if (n instanceof Element) observe(n);
      post();
    }).observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    post();
  });
  for (const type of ["load", "transitionend", "animationend"]) addEventListener(type, post);
}

/**
 * Turns each <ia-html>'s <template> into a page of its own: a sandboxed frame (srcdoc) sized to fit
 * its content, with the theme's colours and fonts. So its HTML, CSS and scripts work as in any page
 * (scripts share a scope, run in order, see DOMContentLoaded and load, inline handlers work), and
 * neither its styles nor its scripts touch the plan. It runs in the plan's frame, as source (so it
 * can't use anything from outside).
 */
function iaHtml(fit: string) {
  const vars = ["--bg", "--panel", "--panel-2", "--raised", "--line", "--line-strong", "--fg", "--heading", "--muted", "--faint", "--accent", "--ok", "--warn", "--danger", "--info", "--font-sans", "--font-mono"];
  const style = getComputedStyle(document.documentElement);
  const theme = vars.map((v) => `${v}:${style.getPropertyValue(v).trim()}`).join(";");
  // Written out so that the plan's own <script> holding this isn't closed by it.
  const end = String.fromCharCode(60) + "/script>";
  const sizer = `<script>${fit}${end}`;
  // The body contains what's positioned absolutely, and the margins of what's in it, so its extent is the content's.
  const head = `<!doctype html><meta charset="utf-8"><style>:root{color-scheme:dark;${theme}}html,body{margin:0;background:transparent}body{position:relative;display:flow-root;color:var(--fg);font:15px/1.65 var(--font-sans)}</style>${sizer}\n`;
  addEventListener("message", (e) => {
    if (typeof e.data?.iaHtmlHeight !== "number") return;
    for (const f of document.querySelectorAll<HTMLIFrameElement>("ia-html > iframe")) if (f.contentWindow === e.source) f.style.height = `${e.data.iaHtmlHeight}px`;
  });
  const up = () => {
    for (const host of document.querySelectorAll("ia-html")) {
      const template = host.querySelector(":scope > template");
      if (!(template instanceof HTMLTemplateElement)) continue;
      const frame = document.createElement("iframe");
      frame.sandbox.add("allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox", "allow-forms");
      frame.title = host.getAttribute("title") ?? "";
      frame.srcdoc = head + template.innerHTML;
      template.replaceWith(frame);
    }
  };
  if (document.readyState === "loading") addEventListener("DOMContentLoaded", up);
  else up();
}

type Control = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement;

/** Ask the board to render Mermaid with its bundled library, outside this opaque-origin sandbox.
 *  Only images come back; the plan doesn't need a CDN or access to the board's origin. Runs as source. */
function iaDiagrams() {
  const pending = new Map<string, { host: Element; pre: HTMLElement; status: HTMLElement }>();
  addEventListener("message", (e) => {
    if (e.source !== parent || typeof e.data?.iaDiagram !== "string") return;
    const entry = pending.get(e.data.iaDiagram);
    if (!entry) return;
    const { host, pre, status } = entry;
    if (typeof e.data.image === "string" && e.data.image.startsWith("data:image/svg+xml;")) {
      const img = document.createElement("img");
      img.alt = host.getAttribute("title") || "Diagram";
      img.src = e.data.image;
      img.style.width = "100%";
      if (typeof e.data.width === "number" && e.data.width > 0) img.style.maxWidth = `${e.data.width}px`;
      status.replaceWith(img);
    } else if (typeof e.data.error === "string") {
      status.className = "ia-diagram-error";
      status.setAttribute("role", "alert");
      status.textContent = `Mermaid: ${e.data.error}`;
      pre.hidden = false;
    } else return;
    host.removeAttribute("aria-busy");
    pending.delete(e.data.iaDiagram);
  });
  const prefix = `${Date.now()}-${Math.random()}-`;
  for (const [i, pre] of [...document.querySelectorAll<HTMLElement>("ia-diagram > pre")].entries()) {
    const host = pre.parentElement!;
    const id = prefix + i;
    const status = document.createElement("p");
    status.textContent = "Drawing diagram…";
    status.setAttribute("role", "status");
    host.setAttribute("aria-busy", "true");
    pre.hidden = true;
    host.append(status);
    pending.set(id, { host, pre, status });
    parent.postMessage({ iaDiagram: id, source: pre.textContent ?? "" }, "*");
  }
}

/**
 * A plan's questions: turns each <ia-question> into its form fields, and reports every named field
 * in the plan (with its question and answer) to the board (iaForm, see planAnswers.ts) when the plan
 * loads and as the user answers, with `touched` on those the user changed. `saved` is the answers
 * the user hasn't sent yet, put back in; `readOnly` (an earlier version) disables the fields; `key`
 * (iaFormKey) says which document the reports are about. Each
 * field also has its `initial` value and answer, as the plan has them. The board sends iaFormSent
 * (with the names of the fields it sent as they are) when it has sent the answers, and iaFormReset to
 * go back to the plan's own.
 * It runs in the plan's frame, as source (so it can't use anything from outside).
 */
function iaForm(saved: Record<string, { v: string[]; o?: string }>, readOnly: boolean, key: string | null) {
  const OTHER = "\u0000other";
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  let unnamed = 0;
  for (const q of document.querySelectorAll("ia-question")) {
    const options = [...q.querySelectorAll(":scope > option")];
    const name = q.getAttribute("name") || `question-${++unnamed}`;
    const asked = q.getAttribute("title") ?? q.getAttribute("label") ?? "";
    let type = (q.getAttribute("type") ?? "").toLowerCase();
    if (!["radio", "checkbox", "select", "text", "textarea", "number", "date"].includes(type)) type = options.length ? "radio" : "text";
    q.setAttribute("name", name);
    q.setAttribute("type", type);
    // Shown as its heading rather than as a tooltip over all of it.
    q.removeAttribute("title");
    q.setAttribute("data-question", asked);
    const body = document.createElement("div");
    body.className = "ia-answer";
    const selected = (o: Element) => o.hasAttribute("selected") || o.hasAttribute("checked");
    const valueOf = (o: Element) => o.getAttribute("value") ?? clean(o.textContent);
    if (type === "radio" || type === "checkbox") {
      const choice = (value: string, content: Node[], checked: boolean) => {
        const label = document.createElement("label");
        const input = document.createElement("input");
        input.type = type;
        input.name = name;
        input.value = value;
        input.defaultChecked = checked;
        const text = document.createElement("span");
        text.append(...content);
        label.append(input, text);
        body.append(label);
        return label;
      };
      for (const o of options) {
        choice(valueOf(o), [...o.childNodes], selected(o));
        o.remove();
      }
      if (q.hasAttribute("other")) {
        const label = choice(OTHER, [document.createTextNode(q.getAttribute("other") || "Other")], false);
        const text = document.createElement("input");
        text.type = "text";
        text.className = "ia-other";
        text.dataset.iaOther = name;
        text.placeholder = q.getAttribute("placeholder") ?? "";
        // Typing in it picks it.
        text.addEventListener("input", () => {
          const box = label.querySelector("input");
          if (box && text.value.trim()) box.checked = true;
        });
        label.append(text);
      }
    } else if (type === "select") {
      const select = document.createElement("select");
      select.name = name;
      if (!options.some(selected)) select.append(new Option(q.getAttribute("placeholder") ?? "Choose…", "", true, true));
      for (const o of options) {
        select.append(new Option(clean(o.textContent), valueOf(o), selected(o), selected(o)));
        o.remove();
      }
      body.append(select);
    } else {
      const input = document.createElement(type === "textarea" ? "textarea" : "input");
      input.name = name;
      if (input instanceof HTMLInputElement) input.type = type;
      else input.rows = Number(q.getAttribute("rows")) || 3;
      input.placeholder = q.getAttribute("placeholder") ?? "";
      input.defaultValue = q.getAttribute("value") ?? "";
      body.append(input);
    }
    if (asked) {
      const head = document.createElement("div");
      head.className = "ia-ask";
      head.textContent = asked;
      q.prepend(head);
    }
    q.append(body);
  }

  const SKIP = ["submit", "button", "reset", "image", "file", "hidden", "password"];
  const checkable = (c: Control): c is HTMLInputElement => c instanceof HTMLInputElement && (c.type === "radio" || c.type === "checkbox");
  const groups = () => {
    const all = new Map<string, Control[]>();
    for (const c of document.querySelectorAll<Control>("input[name], select[name], textarea[name]")) {
      if (c instanceof HTMLInputElement && SKIP.includes(c.type)) continue;
      if (!all.has(c.name)) all.set(c.name, []);
      all.get(c.name)!.push(c);
    }
    return all;
  };
  const otherBox = (name: string) => [...document.querySelectorAll<HTMLInputElement>("input[data-ia-other]")].find((i) => i.dataset.iaOther === name);
  const question = (c: Control) =>
    clean(
      c.closest("[data-question]")?.getAttribute("data-question") ||
        c.closest("fieldset")?.querySelector(":scope > legend")?.textContent ||
        c.getAttribute("aria-label") ||
        (checkable(c) ? null : c.labels?.[0]?.textContent) ||
        c.title,
    );
  const read = (name: string, controls: Control[]) => {
    const v: string[] = [];
    const answer: string[] = [];
    const other = otherBox(name)?.value ?? "";
    for (const c of controls) {
      if (checkable(c)) {
        if (!c.checked) continue;
        v.push(c.value);
        const label = clean(c.labels?.[0]?.textContent) || c.value;
        answer.push(c.value === OTHER ? (other.trim() ? `${label}: ${other.trim()}` : label) : label);
      } else if (c instanceof HTMLSelectElement) {
        for (const o of c.selectedOptions) {
          if (!o.value) continue;
          v.push(o.value);
          answer.push(clean(o.text) || o.value);
        }
      } else {
        v.push(c.value);
        if (c.value.trim()) answer.push(c.value.trim());
      }
    }
    return { value: other ? { v, o: other } : { v }, answer };
  };
  const write = (name: string, controls: Control[], value: { v: string[]; o?: string }) => {
    let i = 0;
    for (const c of controls) {
      if (checkable(c)) c.checked = value.v.includes(c.value);
      else if (c instanceof HTMLSelectElement) for (const o of c.options) o.selected = value.v.includes(o.value);
      else c.value = value.v[i++] ?? "";
    }
    const other = otherBox(name);
    if (other) other.value = value.o ?? "";
  };

  // As the plan has them, before the user's answers go in.
  const initial = new Map([...groups()].map(([name, controls]) => [name, read(name, controls)]));
  const touched = new Set(Object.keys(saved));
  for (const [name, controls] of groups()) if (saved[name]) write(name, controls, saved[name]);
  if (readOnly) for (const c of document.querySelectorAll<Control>("input, select, textarea")) c.disabled = true;

  // `dropped`: fields the user put back as the plan has them, whose saved answers go.
  const report = (user: boolean, dropped: string[] = []) => {
    const fields = [...groups()].map(([name, controls]) => {
      const now = read(name, controls);
      return { name, label: question(controls[0]), type: controls[0].type, ...now, touched: touched.has(name), initial: initial.get(name) ?? now };
    });
    parent.postMessage({ iaForm: fields, iaFormUser: user, iaFormKey: key, iaFormDropped: dropped }, "*");
  };
  const changed = (e: Event) => {
    const t = e.target as Control | null;
    const name = t?.name || (t instanceof HTMLInputElement ? t.dataset.iaOther : "");
    if (!name) return;
    touched.add(name);
    report(true);
  };
  document.addEventListener("input", changed);
  document.addEventListener("change", changed);
  // A <form> of the plan's own would load its action in the frame.
  document.addEventListener("submit", (e) => e.preventDefault());
  // A <form>'s reset button puts its fields back as the plan has them, without input or change events: once it has
  // (after the event), they're no longer the user's answers.
  document.addEventListener("reset", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    setTimeout(() => {
      // A plan's own handler can call the reset off (say, when the user declines to), leaving the fields as they were.
      if (e.defaultPrevented) return;
      const names = new Set<string>();
      for (const c of form.elements) {
        if (!(c instanceof HTMLInputElement || c instanceof HTMLSelectElement || c instanceof HTMLTextAreaElement)) continue;
        const name = c.name || (c instanceof HTMLInputElement ? c.dataset.iaOther : "");
        if (name) names.add(name);
      }
      if (!names.size) return;
      for (const name of names) touched.delete(name);
      report(true, [...names]);
    });
  });
  addEventListener("message", (e) => {
    if (e.source !== parent) return;
    // The names of the fields whose answers were sent as they are now.
    if (Array.isArray(e.data?.iaFormSent)) for (const name of e.data.iaFormSent) touched.delete(name);
    if (e.data?.iaFormReset) {
      touched.clear();
      for (const c of document.querySelectorAll<Control>("input, select, textarea")) {
        if (checkable(c)) c.checked = c.defaultChecked;
        else if (c instanceof HTMLSelectElement) for (const o of c.options) o.selected = o.defaultSelected;
        else c.value = c.defaultValue;
      }
      report(false);
    }
  });
  report(false);
}

/**
 * Whether a plan is a whole page of its own (as plans were before the theme), shown as it is rather
 * than in the theme, whose colours would fight its own.
 */
export const isWholePage = (html: string) => /^\s*(<!--[\s\S]*?-->\s*)*<(!doctype|html)\b/i.test(html);

/**
 * A plan's content (not a whole page) as a page in the board's theme (planTheme.css), with the
 * components' scripts. `colors` (CSS) defaults to the board's own. `form` is what its questions start
 * with (see iaForm).
 */
export function themedPlan(
  html: string,
  css: string,
  colors = boardColors(),
  form: { answers?: Record<string, { v: string[]; o?: string }>; readOnly?: boolean; key?: string } = {},
): string {
  // Inside a <script>, so what the user typed mustn't close it.
  const answers = JSON.stringify(form.answers ?? {}).replace(/</g, "\\u003c");
  return (
    `<!doctype html><meta charset="utf-8"><style>${css}\n${colors}</style>\n${html}\n` +
    `<script>(${iaForm})(${answers}, ${!!form.readOnly}, ${JSON.stringify(form.key ?? null).replace(/</g, "\\u003c")})</script>\n` +
    `<script>(${iaHtml})(${JSON.stringify(`(${fitFrame})()`)})</script>\n<script>(${iaDiagrams})()</script>`
  );
}
