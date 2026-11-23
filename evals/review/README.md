# Scoring the review prompt

A way to tell whether a change to the board's review instructions (`DEFAULT_REVIEW` in
`apps/server/src/prompts/projectDefaults.ts`) makes reviews better or worse, after the generator, verifier and coach
loop of HE-100. It is run by hand; nothing on the board runs it.

| Part                | Here                                                                                                                    | Who may change it    |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | -------------------- |
| Generator           | The reviewer under [versions/](versions/)'s latest instructions                                                         | A person, by merging |
| Answer key          | [answer-key.md](answer-key.md), with each row's facts in [rows.json](rows.json)                                         | A person             |
| Verifier            | A grader agent given [prompts/grade.md](prompts/grade.md): read-only, it only marks                                     | A person             |
| Coach               | An agent given [prompts/coach.md](prompts/coach.md): one change, written as a candidate                                 | A person             |
| Candidate           | A file in [candidates/](candidates/). One that wins goes to `versions/` in a pull request that changes `DEFAULT_REVIEW` | The coach writes it  |
| What each round did | [results/](results/)                                                                                                    | Whoever runs a round |

## A round

1. `scripts/review-eval-checkout.sh $TMPDIR/rows` makes one clone per row whose history stops at the row's commit.
2. `node scripts/review-eval-render.mjs --instructions evals/review/versions/<latest>.md --clones $TMPDIR/rows --out $TMPDIR/runs/a`
   writes each row's prompt. Start one agent per prompt, each told to read its prompt file and do what it says. Do it
   twice (`a` and `b`): the difference between two runs of the same instructions is the noise a candidate has to
   beat.
3. Give a grader `prompts/grade.md` with the answer key and the run folders. It writes the grades as JSON.
4. Give a coach `prompts/coach.md` with the instructions, the grades and **some** of the rows. Keep the others back,
   so a candidate that only fits what the coach saw shows up.
5. Render and run the candidate the same way (`c`), and grade all the runs again in one go, under labels that don't
   say which is which.
6. Adopt the candidate only if it beats both runs of the current instructions by more than they differ from each
   other, on the rows the coach saw and on the ones it didn't. Write the round up in `results/`, with the grader's JSON beside it: the temp folder's reviews don't last.

## Rules

- The coach makes one change per candidate, and edits nothing but the candidate.
- No agent edits the answer key or the grader's prompt. A reviewer being replayed never reads the answer key.
- Each mistake a review makes on the board is a new row: the commit it was given, and what it should have found.

## What a replay is not

A replayed reviewer reads a clone with no dependencies installed, so it can't run the tests, the type check or the
app as a reviewer on the board does, and it has no pull request to read. It writes a JSON file where the board has
`submit_review`. It runs as a subagent of the session that runs the round, on that session's model. The scores
compare instructions under these conditions; they are not the board's own find rate.
