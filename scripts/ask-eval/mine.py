#!/usr/bin/env python3
"""Mine a board's database (read-only) for the ends of agents' turns, as cases for eval.py.

    scripts/ask-eval/mine.py [--data-dir ~/.local/share/issue-agent] [--all] > $TMPDIR/cases.json

Each case is one turn of a task's agent that ended without `request_user_input`: the message that started the turn,
the agent's final message, the user's next message in the thread, and the system prompt its run was launched with
(from runs/<id>/spec.json). Without --all, only turns whose final message looks like it asks the user something (a
loose regex: it finds offers and reports too, so label the cases before using them). The cases are the user's own
threads: keep them in $TMPDIR, not in the repository.
"""
import argparse, json, os, re, sqlite3, sys

ASKS = re.compile(
    r"\?\s*$|\bwhich (one|would you|do you)|\bwould you like\b|\bdo you want\b|\bwant me to\b|\bshould i\b|\blet me know\b|\btell me\b|"
    r"\bonce you (approve|confirm|decide|answer|pick|choose|say)|\bif you approve\b|\bwhen you('re| are) ready\b|\bawait|\bwaiting (for|on) (you|your)\b|"
    r"\byour (call|decision|answer|go-ahead)\b|\bneeds? (your|a) (decision|answer|approval)\b|\bapprove\b|\bconfirm\b",
    re.I,
)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data-dir", default=os.path.expanduser("~/.local/share/issue-agent"))
    ap.add_argument("--all", action="store_true", help="every turn end without request_user_input, not just those that look like asking")
    a = ap.parse_args()
    db_path = next((p for p in (os.path.join(a.data_dir, n) for n in ("huntaway.db", "issue-agent.db")) if os.path.exists(p)), None)
    if not db_path:
        sys.exit(f"no database in {a.data_dir}")
    c = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    tasks = c.execute(
        "SELECT t.id, t.number, t.title, t.labels, t.status, p.key AS pkey, pr.name AS prof FROM tasks t "
        "LEFT JOIN projects p ON p.id=t.project_id LEFT JOIN profiles pr ON pr.id=t.profile_id WHERE t.kind='task'"
    ).fetchall()
    cases = []
    for t in tasks:
        runs = c.execute("SELECT id, created_at, ended_at FROM runs WHERE task_id=? AND kind='prompt' ORDER BY created_at", (t["id"],)).fetchall()
        rows = c.execute("SELECT id, kind, data, created_at FROM messages WHERE task_id=? AND kind IN ('user','question','claude') ORDER BY id", (t["id"],)).fetchall()
        prompt, asked, texts, pending = None, False, [], None

        def flush(next_user):
            if pending is not None:
                pending["next_user"] = next_user
                cases.append(pending)

        for r in rows:
            try:
                d = json.loads(r["data"])
            except ValueError:
                continue
            if r["kind"] == "user":
                text = d.get("text") or ""
                flush(text[:3000])
                pending = None
                if not d.get("steered"):
                    prompt, asked, texts = text, False, []
            elif r["kind"] == "question":
                asked = True
            elif d.get("type") == "assistant":
                for b in (d.get("message") or {}).get("content") or []:
                    if b.get("type") == "text":
                        texts.append(b.get("text") or "")
                    elif b.get("type") == "tool_use" and (b.get("name") or "").endswith("request_user_input"):
                        asked = True
            elif d.get("type") == "result":
                final = d.get("result") or (texts[-1] if texts else "")
                flush(None)
                pending = None
                if asked or not final or prompt is None:
                    continue
                if not a.all and not ASKS.search(final[-500:]):
                    continue
                at = r["created_at"]
                run = next((x for x in reversed(runs) if x["created_at"] <= at), None)
                system = None
                if run:
                    try:
                        args = json.load(open(os.path.join(a.data_dir, "runs", run["id"], "spec.json")))["args"]
                        if "--append-system-prompt-file" in args:
                            # Runs since HA-160 (HA-203 in the TS server) have it in a file, in the run's folder.
                            system = open(args[args.index("--append-system-prompt-file") + 1]).read()
                        else:
                            system = args[args.index("--append-system-prompt") + 1]
                    except (OSError, ValueError, KeyError, IndexError):
                        pass
                pending = {
                    "id": f"{t['pkey']}-{t['number']}#{r['id']}", "task": f"{t['pkey']}-{t['number']}", "profile": t["prof"], "title": t["title"],
                    "labels": json.loads(t["labels"] or "[]"), "at": at, "system": system, "prompt": prompt, "final": final, "next_user": None,
                }
        flush(None)
    json.dump(cases, sys.stdout, indent=1)
    print(f"{len(cases)} cases", file=sys.stderr)


if __name__ == "__main__":
    main()
