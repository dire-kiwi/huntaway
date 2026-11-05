#!/usr/bin/env python3
"""A stand-in for the board's MCP server for ask-eval: it offers the board's `request_user_input` (with the board's
description and schema, read from server-ts/src/mcp.ts by eval.py and passed in IA_EVAL_TOOLS) and a few read-only
tools, answers every call as the board would, and does nothing else. Newline-delimited JSON-RPC on stdio."""
import json, os, sys

TOOLS = json.loads(os.environ.get("IA_EVAL_TOOLS") or "[]")


def reply(id, result=None, error=None):
    m = {"jsonrpc": "2.0", "id": id}
    if error is not None:
        m["error"] = error
    else:
        m["result"] = result
    sys.stdout.write(json.dumps(m) + "\n")
    sys.stdout.flush()


def text(s):
    return {"content": [{"type": "text", "text": s}]}


for line in sys.stdin:
    try:
        msg = json.loads(line)
    except ValueError:
        continue
    method, id = msg.get("method"), msg.get("id")
    if id is None:
        continue  # a notification
    if method == "initialize":
        reply(id, {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}},
                   "serverInfo": {"name": "huntaway", "version": "eval"}})
    elif method == "tools/list":
        reply(id, {"tools": TOOLS})
    elif method == "tools/call":
        name = msg.get("params", {}).get("name")
        if name == "request_user_input":
            reply(id, text(json.dumps({"ok": True, "note": "The user will be notified and shown your question with its options. End your turn now; "
                                       "their answer (the options they picked, or what they wrote) comes as their next message."})))
        else:
            reply(id, text(json.dumps({"error": "Not available in this evaluation: end your turn."})))
    else:
        reply(id, error={"code": -32601, "message": f"Method not found: {method}"})
