#!/usr/bin/env python3
"""Deterministic app-server peer for the adapter's subagent/steering regression test."""
import json
import os
import sys


def emit(value):
    print(json.dumps(value), flush=True)


def event(method, thread, **params):
    emit({"method": method, "params": {"threadId": thread, **params}})


for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    with open(os.environ["IA_FAKE_CODEX_LOG"], "a") as log:
        log.write(json.dumps(request) + "\n")
    if "id" not in request:
        continue
    result = {}
    if method == "thread/start":
        result = {"thread": {"id": "main"}, "model": "test"}
    elif method == "turn/start":
        result = {"turn": {"id": "same-turn-id"}}
    emit({"id": request["id"], "result": result})
    if method == "turn/start":
        event("turn/started", "main", turn={"id": "same-turn-id"})
        emit({"method": "thread/started", "params": {"thread": {
            "id": "child", "source": {"subAgent": {"thread_spawn": {"parent_thread_id": "main"}}}, "preview": "Inspect config"
        }}})
        for kind in ("review", "compact"):
            emit({"method": "thread/started", "params": {"thread": {"id": kind, "source": {"subAgent": kind}}}})
            event("turn/completed", kind, turn={"id": kind, "status": "completed"})
        event("turn/started", "child", turn={"id": "same-turn-id"})
        # Thread ids, as well as turn ids, must match before the adapter ends its main turn.
        event("turn/completed", "child", turn={"id": "same-turn-id", "status": "completed"})
    elif method == "turn/steer":
        event("turn/started", "child", turn={"id": "child-followup"})
        event("item/started", "child", item={"type": "commandExecution", "id": "child-bash", "command": "ls"})
        event("warning", "main", message="After child activity, before main activity")
        event("item/started", "main", item={"type": "agentMessage", "id": "main-message"})
        event("item/completed", "main", item={"type": "agentMessage", "id": "main-message", "text": "Main report"})
        event("turn/completed", "main", turn={"id": "same-turn-id", "status": "completed"})
