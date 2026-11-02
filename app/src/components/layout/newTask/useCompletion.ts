import { useState } from "react";
import { insertCompletion, type TokenPrefix } from "../taskTokens";
import { LABEL_INFO } from "../../task/Document";
import type { AgentChoice } from "./useAgentChoice";
import type { EditorText } from "./useEditorText";
import type { Tokens } from "./useTokens";
import type { Opened, Origin, Where } from "./useWhere";
import { DEFAULT_WORD, GROUP_WORD, NONE_WORD, TOKEN_HELP, typeWord, type Suggestion } from "./words";

export type Completion = ReturnType<typeof useCompletion>;

/** What's offered for each prefix as it's typed (the completion list), and the legend's examples of each. */
export function useCompletion(opened: Opened, origin: Origin, ed: EditorText, where: Where, agent: AgentChoice, tok: Tokens) {
  const { projects, subproject, scratch } = opened;
  const { hosts, group } = origin;
  const { completing, description, caret, edit } = ed;
  const { typeTabs, offered, atVocab, placeNames, project } = where;
  const { pickConfig, inherited, hostSettings, efforts, modelList } = agent;
  const { labelWords, labelling, harnessVocab, specific, named, effortList, depTasks, depKey, deps, depProject } = tok;
  const hostCount = hosts.length;
  // What's offered for each prefix as it's typed.
  const suggestions: Record<TokenPrefix, Suggestion[]> = {
    "/": [
      ...typeTabs.map((t) => ({ value: typeWord(t.id), label: t.label, hint: t.hint })),
      ...LABEL_INFO.filter((l) => labelWords.includes(l.id)).map((l) => ({ value: l.id, label: labelling ? `${l.label} label` : l.label, hint: l.hint })),
    ],
    "@": subproject
      ? []
      : [
          ...(projects ?? []).map((p, i) => ({ value: placeNames[i], label: p.name, hint: hostCount > 1 ? hosts.find((h) => h.id === p.host_id)?.name : undefined })),
          ...(group ? [{ value: GROUP_WORD, label: `Group task (${group})`, hint: "Plans the work across the group's projects" }] : []),
          ...(scratch ? [{ value: NONE_WORD, label: `No project (${scratch.name})`, hint: "A scratch task, with no repository" }] : []),
        ],
    // Each `!` makes a task with its model, so naming several makes a task for each (IA-227).
    "!": harnessVocab
      .filter((w) => !specific.includes(w))
      .map((w) => ({
        value: w.word,
        label: w.word === DEFAULT_WORD && !pickConfig ? (inherited ? `Default model (${inherited})` : "Default model") : w.label,
        hint: named.length ? "Another ! makes another task from this prompt, with that model" : undefined,
      })),
    "^": efforts
      ? [
          { value: DEFAULT_WORD, label: hostSettings?.default_effort ? `Default effort (${hostSettings.default_effort})` : "Default effort" },
          ...effortList.map((e) => ({ value: e, label: `${e} effort` })),
        ]
      : [],
    "#": depTasks.map((t) => ({ value: depKey(t), label: t.title })),
  };
  // The one that's what's typed comes first, then those starting with it, then those whose name has it.
  const query = completing?.query.toLowerCase() ?? "";
  const matches = completing
    ? [
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() === query),
        ...suggestions[completing.prefix].filter((s) => s.value.toLowerCase() !== query && s.value.toLowerCase().startsWith(query)),
        ...(query ? suggestions[completing.prefix].filter((s) => !s.value.toLowerCase().startsWith(query) && s.label.toLowerCase().includes(query)) : []),
      ].slice(0, 8)
    : [];
  const listOpen = !!completing && matches.length > 0;
  const [hl, setHl] = useState(0);
  const lit = Math.min(hl, matches.length - 1);
  const pick = (s: Suggestion) => {
    if (!completing) return;
    const r = insertCompletion(description, completing, completing.prefix, s.value);
    edit(r.text, r.caret);
  };

  // The prefixes that can set something here, for the legend and the placeholder, with an example of each.
  const example: Partial<Record<TokenPrefix, string>> = {
    ...(labelWords.length ? { "/": "plan" } : typeTabs.length > 1 ? { "/": typeWord(typeTabs.find((t) => t.id !== offered[0])?.id ?? null) } : {}),
    ...(atVocab.length ? { "@": placeNames[(projects ?? []).findIndex((p) => p.id !== project?.id)] ?? atVocab[0] } : {}),
    "!": modelList[0]?.id ?? DEFAULT_WORD,
    ...(efforts ? { "^": effortList.includes("high") ? "high" : (effortList[0] ?? DEFAULT_WORD) } : {}),
    ...(deps ? { "#": depTasks[0] ? depKey(depTasks[0]) : `${depProject!.key}-1` } : {}),
  };
  const help = TOKEN_HELP.filter((h) => example[h.prefix]);
  const tokenHint = `Type ${help.map((h, i) => `${i === help.length - 1 && i > 0 ? "or " : ""}${h.prefix} for ${h.asks}`).join(", ")}.`;

  // A legend's prefix, typed at the caret, to pick its value from the list.
  const typePrefix = (prefix: TokenPrefix) => {
    const space = caret > 0 && !/\s/.test(description[caret - 1]) ? " " : "";
    edit(description.slice(0, caret) + space + prefix + description.slice(caret), caret + space.length + 1);
  };

  return { matches, listOpen, setHl, lit, pick, example, help, tokenHint, typePrefix };
}
