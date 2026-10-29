import { useEffect, useState } from "react";
import { useStore } from "./store";

/** The UI build a page runs, by its entry script: each build gives it a new hashed name. */
function entryScript(doc: Document) {
  const scripts = [...doc.querySelectorAll<HTMLScriptElement>("script[type=module][src]")];
  return scripts.map((s) => s.getAttribute("src")).join(" ");
}

const loaded = entryScript(document);

/** Whether the server now serves a different UI build than this page loaded. */
async function newBuildServed() {
  const res = await fetch("/", { cache: "no-store" });
  if (!res.ok) return false;
  const served = entryScript(new DOMParser().parseFromString(await res.text(), "text/html"));
  return served !== "" && served !== loaded;
}

/**
 * True once a new UI build is deployed. An open tab keeps running the build it loaded, so it
 * checks when the window regains focus, after reconnecting to the server, and every few minutes.
 */
export function useNewUiBuild() {
  const [found, setFound] = useState(false);
  const connected = useStore((s) => s.connected);
  useEffect(() => {
    if (found) return;
    const check = () => newBuildServed().then((n) => n && setFound(true), () => {});
    check();
    const id = setInterval(check, 5 * 60_000);
    window.addEventListener("focus", check);
    return () => {
      clearInterval(id);
      window.removeEventListener("focus", check);
    };
  }, [found, connected]);
  return found;
}
