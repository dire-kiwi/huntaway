#!/usr/bin/env python3
"""Fake both title CLIs, recording the selected runtime, login and prompt."""
import json
import os
import sys


def record(**fields):
    with open(os.environ["IA_TITLE_LOG"], "a") as log:
        log.write(json.dumps(fields) + "\n")


def emit(value):
    print(json.dumps(value), flush=True)


if sys.argv[1] != "app-server":
    record(agent="claude", home=os.environ.get("CLAUDE_CONFIG_DIR"), args=sys.argv[1:], input=sys.stdin.read())
    print('"Fix the Claude title."')
    sys.exit(0)

record(agent="codex", home=os.environ.get("CODEX_HOME"))
for line in sys.stdin:
    request = json.loads(line)
    if "id" not in request:
        continue
    record(request=request)
    method = request["method"]
    result = {}
    if method == "config/read":
        result = {"config": {"mcp_servers": {"user-tools": {"command": "must-not-run"}}}}
    elif method == "thread/start":
        result = {"thread": {"id": "title"}}
    elif method == "turn/start":
        result = {"turn": {"id": "turn"}}
    emit({"id": request["id"], "result": result})
    if method == "turn/start":
        mode = os.environ.get("IA_TITLE_MODE", "success")
        text = "" if mode == "empty" else '"Fix Codex task naming."'
        emit({"method": "item/completed", "params": {"threadId": "title", "item": {
            "type": "agentMessage", "text": text}}})
        emit({"method": "turn/completed", "params": {"threadId": "title", "turn": {
            "status": "failed" if mode == "failed" else "completed", "error": {"message": "test failure"}}}})
