import { agentOf, type ClaudeConfig } from "../../../api";
import { CODEX_MODEL_ALIASES, sameHarness } from "../harnesses";
import type { AgentChoice } from "./useAgentChoice";
import type { Options } from "./useOptions";
import type { Tokens } from "./useTokens";
import type { Where } from "./useWhere";

export type Blocks = ReturnType<typeof submitBlocks>;

/** What stops the task being created as the text has it, and the Codex models it waits for. */
export function submitBlocks({ asGroup, inProject, host }: Where, { config, configs, efforts, discovery }: AgentChoice, tok: Tokens, { worktree }: Options) {
  const { fanout, asSubproject, docType, labels, labelTypes, tokens, harnessVocab, harnessConfigs, pickedEffort, runs, harnessOf } = tok;
  // What can't be made a task for each of several harnesses. A group task coordinates its group's work, so it takes one,
  // unless it has labels: then they write documents to compare.
  const fanoutBlock = !fanout
    ? null
    : asSubproject
      ? "A subproject has one agent, so it takes one model."
      : asGroup && !docType && !labels.length
        ? "A group task has one agent, so it takes one model."
        : worktree && inProject?.is_git === false
          ? `${inProject.name} isn't a git repository, so its tasks can't each have their own worktree: pick one model, or make it a scratch task.`
          : null;
  // A host before API 71 makes a task of one label's type.
  const labelBlock = labelTypes && labels.length > 1 ? `${host?.name ?? "This host"} makes a task of one of plan, artifact or diagram, not several: update it for labels.` : null;
  // What a Codex config's models say waits for them: which model a `!` that names none yet is (so a harness isn't left
  // out, with its token sent as text); which config a `!` names a model of, when a config of the same agent before it
  // (the picked one, then in order) may have the model too (so it doesn't depend on which answers first); and whether the effort picked
  // is one a Codex harness's model takes (it's only sent if it is). If they couldn't be fetched, it says so.
  const unknownModels = tokens.filter((t) => t.prefix === "!" && t.value === undefined);
  const asText = unknownModels.map((t) => `!${t.word}`).join(", ");
  const rank = (id: string) => (id === config ? -1 : configs.findIndex((c) => c.id === id));
  const claimable = (c: ClaudeConfig) =>
    tokens.filter((t) => {
      const w = t.prefix === "!" && t.value !== undefined ? harnessVocab.find((x) => x.word === t.value) : undefined;
      const agent = harnessConfigs.find((x) => x.id === w?.harness.config)?.agent;
      const plain = w && (w.word.toLowerCase() === w.harness.model.toLowerCase() || CODEX_MODEL_ALIASES.includes(w.word));
      return !!w && !!w.harness.model && plain && agent === agentOf(c) && rank(c.id) < rank(w.harness.config);
    });
  const effortWaits = (c: ClaudeConfig) => efforts && !!pickedEffort && runs.some((h) => h.config === c.id);
  const waitsFor = (c: ClaudeConfig) => unknownModels.length > 0 || claimable(c).length > 0 || effortWaits(c);
  const loadingFor = discovery.loading.filter(waitsFor);
  const failedFor = discovery.failed.filter((f) => waitsFor(f.config));
  const configNames = (cs: { name: string }[]) => cs.map((c) => c.name).join(", ");
  const claimed = (cs: ClaudeConfig[]) => [...new Set(cs.flatMap((c) => claimable(c).map((t) => `!${t.word}`)))].join(", ");
  // The words that name the config a model is taken from, for a model another config may have too.
  const qualified = (cs: ClaudeConfig[]) =>
    cs
      .flatMap((c) => claimable(c))
      .flatMap((t) => {
        const h = harnessOf(t.value);
        const w = h && harnessVocab.find((x) => sameHarness(x.harness, h) && x.word.toLowerCase() !== h.model.toLowerCase());
        return w ? [`!${w.word}`] : [];
      })
      .filter((w, i, all) => all.indexOf(w) === i)
      .join(", ");
  const unknown = (cs: ClaudeConfig[]) =>
    unknownModels.length
      ? `which ${asText} is`
      : claimed(cs)
        ? `whether ${cs.length > 1 ? "they have" : "it has"} ${claimed(cs)} too`
        : `whether ${cs.length > 1 ? "they take" : "it takes"} ${pickedEffort} effort`;
  const takeOut = (cs: ClaudeConfig[]) =>
    unknownModels.length ? "it out" : claimed(cs) ? `${claimed(cs)} out, or name its config (${qualified(cs)})` : "the effort out";
  const modelsLoading = loadingFor.length > 0;
  const modelsBlock = modelsLoading
    ? `Loading ${configNames(loadingFor)}'s models, to see ${unknown(loadingFor)}…`
    : failedFor.length
      ? `Couldn't load ${configNames(failedFor.map((f) => f.config))}'s models (${failedFor[0].error}), so there's no telling ${unknown(failedFor.map((f) => f.config))}: take ${takeOut(failedFor.map((f) => f.config))}, or open the dialog again to try again.`
      : null;
  // While they're loading, creating it waits for them (see whenLoaded).
  const submitBlock = labelBlock ?? fanoutBlock ?? (modelsLoading ? null : modelsBlock);
  return { fanoutBlock, labelBlock, modelsLoading, modelsBlock, submitBlock };
}
