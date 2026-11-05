# ask-eval: do agents ask when they should?

A task's agent that needs something from the user before it can go on should call the board's `request_user_input`,
which puts the task in **Needs attention**. One that ends its turn with the question in its summary instead puts the
task in **In review**, where it looks finished and stalls (HA-198). This replays the ends of real turns under different
wordings of the agents' instructions on asking (`ask_and_finish` in `server-ts/src/agent/runner/prompt.ts`) and counts
how often the agent asks.

1. **Mine** the turn ends from a board's database (read-only). The cases are the user's own threads, so keep them in
   `$TMPDIR`, never in the repository:

   ```sh
   scripts/ask-eval/mine.py > $TMPDIR/cases.json            # turns whose final message looks like it asks something
   scripts/ask-eval/mine.py --all > $TMPDIR/all-cases.json  # every turn that ended without request_user_input
   ```

2. **Label** them: `should_ask` (the task couldn't go on without the user's answer, choice, approval or information),
   `optional` (the work was done, and the message only offers extras) or `done`. `labels.json` maps a case's index in
   the cases file (or its id) to `{"label": …}`. The miner's regex finds offers and reports too, so read them.

3. **Run** the variants in `variants.py` (each replaces that paragraph of the case's real system prompt; `baseline`
   leaves it as the run had it):

   ```sh
   scripts/ask-eval/eval.py --cases $TMPDIR/cases.json --labels $TMPDIR/labels.json \
     --variants baseline,columns --model opus --jobs 8
   scripts/ask-eval/eval.py report $TMPDIR/ask-eval/results-*.jsonl
   ```

`verify` in `eval.py` is the check: `claude -p` with the case's system prompt, the board's tools served by
`stub_mcp.py` (their definitions come from `server-ts/src/mcp.ts` through `board_tools.ts`, so `npm ci` in
`server-ts/` first) and its built-in tools off, given the message that started the turn and the final message the
agent wrote, and told to end the turn. A case passes if the agent called `request_user_input` exactly when its label
says it should. Each run costs about what a short turn does on the model given, on the login `claude` uses; it isn't
part of CI.

It's a proxy: the replayed agent sees its own final message rather than the hours of context that led to it, so it
judges the ending with fresher eyes than the agent did. Compare variants with each other, not with the board.
