import { createContext, useContext } from "react";
import type { Resolution } from "../../../threads";

/**
 * How the prompt cards in a thread answer: with the thread's `respond` command (see threadView.ts). Without one (the
 * board's lists of prompts), they use the board's own routes.
 */
export interface PromptAnswerer {
  respond: (request_id: string, resolution: Resolution) => Promise<unknown>;
  /** A question request's answers by its questions' ids, from a list for each question in order. */
  answers: (request_id: string, lists: string[][]) => { [k: string]: string[] };
}

export const PromptAnswers = createContext<PromptAnswerer | null>(null);

export const usePromptAnswers = () => useContext(PromptAnswers);
