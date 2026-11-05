#!/usr/bin/env python3
"""Check whether agents end their turns with `request_user_input` when they should, under different wordings of
their instructions (variants.py).

    scripts/ask-eval/eval.py --cases $TMPDIR/cases.json --labels $TMPDIR/labels.json [--variants baseline,two_ways]
        [--model opus] [--jobs 6] [--repeat 1] [--only should_ask,optional] [--limit N] [--out $TMPDIR/ask-eval]

A case (from mine.py) is the end of a real turn: the message that started it, the final message the agent wrote, and
the system prompt its run had. Its label says what should have happened: `should_ask` (the agent was waiting on the
user, so it should have called request_user_input), or `optional`/`done` (the work was finished, so it shouldn't).
labels.json maps a case's index in the cases file, or its id, to {"label": …} (or a label string).

`verify` replays one: `claude -p` with the case's system prompt (its paragraph on asking swapped for the variant's),
the board's tools served by stub_mcp.py, and a message giving the agent the turn's prompt and its drafted final
message, asking it to end the turn. It passes if the agent called request_user_input exactly when the label says it
should. The agent's built-in tools are off, so it can only end the turn.
"""
import argparse, concurrent.futures, json, os, re, subprocess, sys, tempfile, threading, time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from variants import TOOL_VARIANTS, VARIANTS  # noqa: E402

# The paragraphs variants replace: how agents ask and finish, since they were told to use request_user_input, with
# HA-198's rule after them in prompts from since then.
ASK_RE = re.compile(r"If you are blocked or need a decision or information from the user, call `request_user_input`.*?"
                    r"When you finish, end with a concise summary of (?P<done>.*?); the task then moves to \"In review\"\."
                    r"(\n\nYou must call `request_user_input` before you end a turn.*?leave that in the summary\.)?", re.S)
ASKING = {"should_ask"}
NOT_ASKING = {"optional", "done"}

MESSAGE = """The message that started this turn:
<message>
{prompt}
</message>

You've done the work for this turn (your other tools are off now), and this is the final message you wrote to end it with:
<final_message>
{final}
</final_message>

End the turn now, as your instructions say."""


def system_for(case, variant):
    """The case's system prompt with the variant's paragraph on asking, or None if it hasn't that paragraph."""
    s = case.get("system")
    if not s:
        return None
    m = ASK_RE.search(s)
    if not m:
        return None
    text = VARIANTS[variant]
    if text is None:
        return s
    return s[: m.start()] + text.replace("{done}", m.group("done")) + s[m.end():]


def board_tools():
    out = subprocess.run(["node", "--experimental-strip-types", "--disable-warning=ExperimentalWarning", os.path.join(HERE, "board_tools.ts")],
                         check=True, capture_output=True, text=True)
    return out.stdout


def tools_for(tools_json, variant):
    """The board's tools, with request_user_input's description as the variant has it (see TOOL_VARIANTS)."""
    extra = TOOL_VARIANTS.get(variant)
    if extra is None:
        return tools_json
    tools = json.loads(tools_json)
    for t in tools:
        if t["name"] == "request_user_input":
            t["description"] = extra(t["description"])
    return json.dumps(tools)


def verify(case, variant, model, tools_json, effort=None, timeout=300):
    """Replay `case` under `variant`: {asked, question, final, cost, error}."""
    system = system_for(case, variant)
    if system is None:
        return {"error": "the case's system prompt has no paragraph on asking"}
    with tempfile.TemporaryDirectory(prefix="ask-eval-") as d:
        cfg = os.path.join(d, "mcp.json")
        json.dump({"mcpServers": {"huntaway": {"type": "stdio", "command": sys.executable, "args": ["-I", os.path.join(HERE, "stub_mcp.py")],
                                               "env": {"IA_EVAL_TOOLS": tools_for(tools_json, variant)}}}}, open(cfg, "w"))
        args = ["claude", "-p", "--model", model, "--output-format", "stream-json", "--verbose", "--append-system-prompt", system,
                "--mcp-config", cfg, "--strict-mcp-config", "--tools", "", "--allowedTools", "mcp__huntaway", "--no-session-persistence",
                "--setting-sources", "", "--disable-slash-commands"]
        if effort:
            args += ["--effort", effort]
        msg = MESSAGE.format(prompt=case["prompt"][:20000], final=case["final"])
        try:
            p = subprocess.run(args, input=msg, capture_output=True, text=True, cwd=d, timeout=timeout)
        except subprocess.TimeoutExpired:
            return {"error": "timed out"}
    asked, question, final, cost, error = False, None, None, None, None
    for line in p.stdout.splitlines():
        try:
            m = json.loads(line)
        except ValueError:
            continue
        if m.get("type") == "assistant":
            for b in (m.get("message") or {}).get("content") or []:
                if b.get("type") == "tool_use" and (b.get("name") or "").endswith("request_user_input"):
                    asked, question = True, (b.get("input") or {}).get("question")
        elif m.get("type") == "result":
            final, cost = m.get("result"), m.get("total_cost_usd")
            if m.get("is_error"):
                error = final or m.get("subtype")
    if final is None and error is None:
        error = (p.stderr or p.stdout or f"exit {p.returncode}").strip()[-500:]
    return {"asked": asked, "question": question, "final": final, "cost": cost, "error": error}


def load_labels(path, cases):
    raw = json.load(open(path))
    out = {}
    for k, v in raw.items():
        label = v["label"] if isinstance(v, dict) else v
        if k.isdigit() and int(k) < len(cases):
            out[cases[int(k)]["id"]] = label
        else:
            out[k] = label
    return out


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--cases", required=True)
    ap.add_argument("--labels", help="labels for the cases, if they don't have a `label` of their own")
    ap.add_argument("--variants", default=",".join(VARIANTS))
    ap.add_argument("--model", default="opus")
    ap.add_argument("--effort")
    ap.add_argument("--jobs", type=int, default=6)
    ap.add_argument("--repeat", type=int, default=1)
    ap.add_argument("--only", default="should_ask,optional,done", help="the labels to run")
    ap.add_argument("--ids", help="file of case ids to run, one per line")
    ap.add_argument("--limit", type=int)
    ap.add_argument("--out", default=os.path.join(os.environ.get("TMPDIR", "/tmp"), "ask-eval"))
    a = ap.parse_args()
    cases = json.load(open(a.cases))
    labels = load_labels(a.labels, cases) if a.labels else {}
    for c in cases:
        c["label"] = labels.get(c["id"], c.get("label"))
    only = set(a.only.split(","))
    run = [c for c in cases if c["label"] in only]
    if a.ids:
        ids = {l.strip() for l in open(a.ids) if l.strip()}
        run = [c for c in run if c["id"] in ids]
    if a.limit:
        run = run[: a.limit]
    variants = a.variants.split(",")
    for v in variants:
        if v not in VARIANTS:
            sys.exit(f"no variant {v}: {', '.join(VARIANTS)}")
    os.makedirs(a.out, exist_ok=True)
    results_path = os.path.join(a.out, f"results-{a.model}-{time.strftime('%Y%m%d-%H%M%S')}.jsonl")
    tools_json = board_tools()
    jobs = [(c, v, i) for v in variants for c in run for i in range(a.repeat)]
    print(f"{len(run)} cases × {len(variants)} variants × {a.repeat} on {a.model}: {len(jobs)} runs, to {results_path}", file=sys.stderr)
    lock = threading.Lock()
    done = 0
    results = []

    def one(job):
        c, v, i = job
        r = verify(c, v, a.model, tools_json, a.effort)
        r.update(case=c["id"], label=c["label"], variant=v, repeat=i)
        r["pass"] = None if r["error"] else (r["asked"] == (c["label"] in ASKING))
        return r

    with open(results_path, "w") as f, concurrent.futures.ThreadPoolExecutor(a.jobs) as ex:
        for r in ex.map(one, jobs):
            with lock:
                done += 1
                results.append(r)
                f.write(json.dumps(r) + "\n")
                f.flush()
                mark = "ERR" if r["error"] else ("ok " if r["pass"] else "BAD")
                print(f"[{done}/{len(jobs)}] {mark} {r['variant']:<10} {r['label']:<10} asked={r['asked']!s:<5} {r['case']}"
                      + (f"  {r['error'][:120]}" if r["error"] else ""), file=sys.stderr)
    report(results)


def report(results):
    print(f"\n{'variant':<12} {'should_ask: asked':>18} {'finished: asked':>16} {'accuracy':>9} {'errors':>7} {'cost':>7}")
    for v in dict.fromkeys(r["variant"] for r in results):
        rs = [r for r in results if r["variant"] == v]
        ok = [r for r in rs if not r["error"]]
        pos = [r for r in ok if r["label"] in ASKING]
        neg = [r for r in ok if r["label"] in NOT_ASKING]
        acc = sum(r["pass"] for r in ok) / len(ok) if ok else 0
        cost = sum(r["cost"] or 0 for r in rs)
        print(f"{v:<12} {sum(r['asked'] for r in pos):>11}/{len(pos):<6} {sum(r['asked'] for r in neg):>9}/{len(neg):<6} {acc:>8.0%} {len(rs) - len(ok):>7} {cost:>7.2f}")


if __name__ == "__main__":
    if len(sys.argv) > 1 and sys.argv[1] == "report":
        report([json.loads(l) for p in sys.argv[2:] for l in open(p)])
    else:
        main()
