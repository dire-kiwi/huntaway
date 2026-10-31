type Mermaid = (typeof import("mermaid"))["default"];
let loaded: Promise<Mermaid> | null = null;
let renders = 0;

// Shared by standalone diagrams and plans; load the bundled library only when a diagram needs it.
const load = () =>
  (loaded ??= import("mermaid").then((m) => {
    m.default.initialize({ startOnLoad: false, theme: "dark", securityLevel: "strict", fontFamily: "Inter, ui-sans-serif, system-ui, sans-serif" });
    return m.default;
  }));

export async function renderMermaid(source: string): Promise<string> {
  const mermaid = await load();
  const id = `ia-mermaid-${++renders}`;
  try {
    return (await mermaid.render(id, source)).svg;
  } finally {
    // Mermaid can leave these behind after a failed render.
    document.getElementById(id)?.remove();
    document.getElementById(`d${id}`)?.remove();
  }
}

// Display SVGs as images, so they can't execute scripts even if something gets past Mermaid's sanitizer.
export const diagramImage = (svg: string) => `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;

/** The width a Mermaid SVG is drawn at, from its viewBox. */
export const svgWidth = (svg: string) => Number(/viewBox="[-\d.]+[ ,]+[-\d.]+[ ,]+([\d.]+)/.exec(svg)?.[1]) || null;

/** Bake a plan's diagrams into its download, so it can be read without the board or a network connection. */
export async function withPlanDiagrams(html: string): Promise<string> {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const pre of doc.querySelectorAll("ia-diagram > pre")) {
    const host = pre.parentElement!;
    try {
      const img = doc.createElement("img");
      img.alt = host.getAttribute("title") || "Diagram";
      const svg = await renderMermaid(pre.textContent ?? "");
      img.src = diagramImage(svg);
      img.style.width = "100%";
      const width = svgWidth(svg);
      if (width) img.style.maxWidth = `${width}px`;
      host.replaceChildren(img);
    } catch (e) {
      const error = doc.createElement("div");
      error.className = "ia-diagram-error";
      error.textContent = `Mermaid: ${(e as Error).message}`;
      // Nest the source so the exported page's component script doesn't ask the board to retry it.
      pre.replaceWith(error);
      error.append(pre);
    }
  }
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}
