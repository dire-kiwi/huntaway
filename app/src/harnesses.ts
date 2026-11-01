// The agents a new task's prompt can go to (IA-227): each `!` token in the new task dialog names a harness, an agent
// config (Claude Code or Codex) and one of its models, and the dialog makes a task for each, as t3code starts a
// thread for each model picked. `!opus !gpt-5.5` makes two tasks from one prompt.

/** An agent config the task can run with, and the models it offers. */
export interface HarnessConfig {
  id: string;
  name: string;
  agent: "claude" | "codex";
  models: { id: string; label: string }[];
}

/** A config and its model: blank for the model it inherits (from the project, profile or host). */
export interface Harness {
  config: string;
  model: string;
}

/** A word `!` takes, and the harness it names. */
export interface HarnessWord {
  word: string;
  harness: Harness;
  label: string;
}

export const CODEX_MODEL_ALIASES = ["sol", "astra", "terra", "luna"];

/** Only numbered releases of the exact family count; variants and previews keep their full ids. */
function modelWords(c: HarnessConfig) {
  const models = c.models.map((m) => ({ ...m, word: m.id }));
  if (c.agent !== "codex") return models;
  for (const alias of CODEX_MODEL_ALIASES) {
    const releases = c.models.filter((m) => new RegExp(`^gpt-\\d+(?:\\.\\d+)*-${alias}$`, "i").test(m.id));
    const latest = releases.sort((a, b) => b.id.localeCompare(a.id, "en", { numeric: true }))[0];
    if (latest && !models.some((m) => m.word.toLowerCase() === alias)) {
      models.push({ id: latest.id, word: alias, label: `${alias[0].toUpperCase() + alias.slice(1)} (latest · ${latest.id})` });
    }
  }
  return models;
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "config";

/**
 * The words `!` takes, in the order they're offered: `default` (`defaultWord`) for the default model in the `selected`
 * config; the selected config's models by their ids; the other configs' models by their ids too, where no config
 * before them has the id; and, for a model more than one config has (or may have: another config of the same agent),
 * `<model>.<config>` for each (`opus.work`).
 * Codex's family aliases (sol, astra, terra, luna) name its latest listed numbered release. A
 * config's name alone (`!codex`) names it with its default model, unless a model has that id.
 */
export function harnessWords(configs: HarnessConfig[], selected: string, defaultWord: string): HarnessWord[] {
  const sel = configs.find((c) => c.id === selected) ?? configs[0];
  if (!sel) return [];
  const many = configs.length > 1;
  const named = (c: HarnessConfig, what: string) => (many ? `${what} · ${c.name}` : what);
  const order = [sel, ...configs.filter((c) => c !== sel)];
  // Config names as words, told apart when two have the same.
  const slugs = configs.map((c) => slug(c.name));
  const configWord = (c: HarnessConfig) => {
    const i = configs.indexOf(c);
    return slugs.filter((s) => s === slugs[i]).length > 1 ? `${slugs[i]}-${i + 1}` : slugs[i];
  };
  const out: HarnessWord[] = [];
  const taken = (w: string) => out.some((x) => x.word.toLowerCase() === w.toLowerCase());
  const add = (word: string, harness: Harness, label: string) => {
    if (!taken(word)) out.push({ word, harness, label });
  };
  add(defaultWord, { config: sel.id, model: "" }, named(sel, "Default model"));
  for (const c of order) for (const m of modelWords(c)) add(m.word, { config: c.id, model: m.id }, named(c, m.label));
  if (many) {
    for (const c of order) {
      for (const m of modelWords(c)) {
        // Another config has it too, or may have (another of the same agent, whose models may not be known yet).
        if (configs.some((o) => o !== c && (o.agent === c.agent || o.models.some((x) => x.id.toLowerCase() === m.id.toLowerCase())))) {
          add(`${m.word}.${configWord(c)}`, { config: c.id, model: m.id }, named(c, m.label));
        }
      }
    }
    for (const c of order) add(configWord(c), { config: c.id, model: "" }, named(c, "Default model"));
  }
  return out;
}

/** The harness each word names, once each, in the order they're given. */
export function harnessesOf(words: HarnessWord[], given: string[]): Harness[] {
  const out: Harness[] = [];
  for (const g of given) {
    const w = words.find((x) => x.word.toLowerCase() === g.toLowerCase());
    if (w && !out.some((h) => h.config === w.harness.config && h.model === w.harness.model)) out.push(w.harness);
  }
  return out;
}

export const sameHarness = (a: Harness | undefined, b: Harness) => !!a && a.config === b.config && a.model === b.model;

/** An id for the tasks made from one prompt (crypto.randomUUID needs a secure context, which a LAN board may not be). */
export const newFanoutId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
