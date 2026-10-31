#!/usr/bin/env python3
"""Tests for scripts/ia-api, with the server and the clock faked: python3 scripts/ia-api-test.py
($IA_API_SCRIPT tests another copy of the script.)"""
import importlib.machinery
import importlib.util
import io
import os
import sys
import unittest
import urllib.error
from contextlib import redirect_stderr, redirect_stdout

path = os.environ.get("IA_API_SCRIPT") or os.path.join(os.path.dirname(os.path.abspath(__file__)), "ia-api")
sys.dont_write_bytecode = True  # no __pycache__ next to the scripts
loader = importlib.machinery.SourceFileLoader("ia_api", path)
spec = importlib.util.spec_from_loader("ia_api", loader)
ia_api = importlib.util.module_from_spec(spec)
loader.exec_module(ia_api)


class Clock:
    """Stands in for the `time` module: sleeping moves the clock on."""

    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, secs):
        self.now += secs
        if self.now > 1000:
            raise AssertionError("wait-idle never returned")


class FakeApi(ia_api.Api):
    """Answers GET /tasks/<id> from `states` (the last one repeats), and records approvals."""

    def __init__(self, states, pending=()):
        super().__init__({"IA_TEST_URL": "http://127.0.0.1:1", "IA_TEST_TOKEN": "t"})
        self.states, self.prompts, self.approved = list(states), list(pending), []

    def call(self, method, path, body=None, **_):
        if path.startswith("/tasks/"):
            return self.states.pop(0) if len(self.states) > 1 else self.states[0]
        if path.startswith("/permissions?") or path == "/permissions":
            return self.prompts
        if path.startswith("/permissions/"):
            self.approved.append(body["decision"])
            return {"ok": True, "status": "allowed"}
        raise AssertionError(f"unexpected {method} {path}")


def task(running=False, merging=False, status="in_progress", pending=0, run="r1"):
    return {"task": {"id": "t", "running": running, "merging": merging, "status": status, "run_started_at": run}, "pending_permissions": pending,
            "last_message": None}


def wait(api, timeout=60, grace=5, approve=False):
    clock = Clock()
    ia_api.time = clock
    with redirect_stdout(io.StringIO()), redirect_stderr(io.StringIO()):
        code = ia_api.wait_idle(api, "t", timeout, grace, approve, None)
    return code, clock.now


class WaitIdle(unittest.TestCase):
    def test_a_finished_run_is_idle(self):
        self.assertEqual(wait(FakeApi([task(running=True), task(running=True), task(status="in_review", run="r1")]))[0], 0)

    def test_a_merge_that_needs_attention_returns_at_once(self):
        # runner::finish keeps `merging` when a merge stops without merging.
        stopped = task(merging=True, status="needs_attention")
        code, elapsed = wait(FakeApi([stopped]))
        self.assertEqual(code, 2)
        self.assertLess(elapsed, 2)

    def test_a_merge_in_progress_is_waited_for(self):
        merging = task(merging=True, status="ready_for_merge")
        self.assertEqual(wait(FakeApi([merging, merging, merging, task(status="done", run="r2")]))[0], 0)
        self.assertEqual(wait(FakeApi([merging]), timeout=10)[0], 124)

    def test_prompts_that_keep_coming_dont_outlast_the_timeout(self):
        api = FakeApi([task(running=True, status="needs_attention", pending=1)], [{"id": "p", "task_id": "t", "tool_name": "Bash", "input": {}}])
        code, elapsed = wait(api, timeout=2, approve=True)
        self.assertEqual(code, 124)
        self.assertLess(elapsed, 3)
        self.assertTrue(api.approved)

    def test_a_prompt_without_approve_needs_attention(self):
        self.assertEqual(wait(FakeApi([task(running=True, status="needs_attention", pending=1)]))[0], 2)

    def test_nothing_starting_returns_after_the_grace(self):
        code, elapsed = wait(FakeApi([task(status="todo")]), grace=5)
        self.assertEqual(code, 0)
        self.assertGreaterEqual(elapsed, 5)


class ApproveAll(unittest.TestCase):
    def approve(self, code):
        api = ia_api.Api({"IA_TEST_URL": "http://127.0.0.1:1", "IA_TEST_TOKEN": "t"})
        api.pending = lambda task=None: [{"id": "p", "task_id": "t", "tool_name": "Bash", "input": {}}]

        def urlopen(req, timeout=None):
            raise urllib.error.HTTPError(req.full_url, code, "error", {}, io.BytesIO(b'{"error": "nope"}'))

        real, ia_api.urllib.request.urlopen = ia_api.urllib.request.urlopen, urlopen
        try:
            with redirect_stderr(io.StringIO()):
                return api.approve_all()
        finally:
            ia_api.urllib.request.urlopen = real

    def test_a_prompt_answered_meanwhile_is_reported(self):
        [d] = self.approve(409)
        self.assertIn("HTTP 409", d["status"])

    def test_other_errors_fail(self):
        with self.assertRaises(SystemExit) as e:
            self.approve(500)
        self.assertEqual(e.exception.code, 1)


class TaskKeys(unittest.TestCase):
    """task_id: project keys in $IA_TEST_PROJECT (or a former key), and S-/G- keys in a profile's tasks."""

    class Api(ia_api.Api):
        def __init__(self, env=None):
            super().__init__({"IA_TEST_URL": "http://127.0.0.1:1", "IA_TEST_TOKEN": "t", **(env or {})})
            self.asked = []

        def call(self, method, path, body=None, **_):
            self.asked.append(path)
            if path == "/projects/pr":
                return {"id": "pr", "key": "TES", "former_keys": ["OLD"]}
            if path == "/projects/pr/tasks":
                return [{"id": "tes-1", "number": 1, "project_id": "pr"}, {"id": "tes-2", "number": 2, "project_id": "pr"}]
            if path == "/profiles":
                return [{"id": "a"}, {"id": "b"}]
            if path == "/profiles/a/tasks":
                return [{"id": "tes-2", "number": 2, "project_id": "pr"}, {"id": "a-s2", "number": 2, "project_id": None, "task_type": "scratch"},
                        {"id": "a-g2", "number": 2, "project_id": None, "group_name": "g"}, {"id": "a-s3", "number": 3, "project_id": None, "task_type": "scratch"}]
            if path == "/profiles/b/tasks":
                return [{"id": "b-s3", "number": 3, "project_id": None, "task_type": "scratch"}]
            raise AssertionError(f"unexpected {method} {path}")

    def resolve(self, ref, **env):
        api = self.Api(env)
        err = io.StringIO()
        try:
            with redirect_stderr(err):
                return api.task_id(ref), api.asked
        except SystemExit:
            return None, err.getvalue()

    def test_project_keys(self):
        self.assertEqual(self.resolve("tes-2", IA_TEST_PROJECT="pr")[0], "tes-2")
        self.assertEqual(self.resolve("OLD-1", IA_TEST_PROJECT="pr")[0], "tes-1")
        # One list of the project's tasks, without ?kind= (scratch tasks are kind task now).
        self.assertEqual(self.resolve("TES-1", IA_TEST_PROJECT="pr")[1], ["/projects/pr", "/projects/pr/tasks"])
        self.assertIn("isn't a key of project TES", self.resolve("XYZ-1", IA_TEST_PROJECT="pr")[1])
        self.assertIn("no task TES-9", self.resolve("TES-9", IA_TEST_PROJECT="pr")[1])
        self.assertIn("no IA_TEST_PROJECT", self.resolve("TES-1")[1])

    def test_scratch_and_group_keys(self):
        self.assertEqual(self.resolve("S-2", IA_TEST_PROJECT="pr")[0], "a-s2")
        self.assertEqual(self.resolve("g-2")[0], "a-g2")
        self.assertEqual(self.resolve("S-3", IA_TEST_PROFILE="b"), ("b-s3", ["/profiles/b/tasks"]))
        self.assertIn("more than one profile", self.resolve("S-3")[1])
        self.assertIn("no task G-3", self.resolve("G-3")[1])

    def test_ids_are_left_alone(self):
        self.assertEqual(self.resolve("0b6f1c2e-uuid"), ("0b6f1c2e-uuid", []))


class OnlyTestServers(unittest.TestCase):
    def connect(self, url, answer=None):
        """Api(url), with GET /api/open-token answered by `answer` (bytes, or an exception to raise); its stderr if it refuses."""
        asked = []

        def urlopen(req, timeout=None):
            asked.append(req if isinstance(req, str) else req.full_url)
            if isinstance(answer, Exception):
                raise answer
            return io.BytesIO(answer)

        real, ia_api.urllib.request.urlopen = ia_api.urllib.request.urlopen, urlopen
        err = io.StringIO()
        try:
            with redirect_stderr(err):
                ia_api.Api({"IA_TEST_URL": url, "IA_TEST_TOKEN": "t"})
            return asked, None
        except SystemExit:
            return asked, err.getvalue()
        finally:
            ia_api.urllib.request.urlopen = real

    def test_a_test_server_is_taken_without_asking(self):
        for url in ("http://127.0.0.1:41234", "http://localhost:5000/", "http://[::1]:41234"):
            self.assertEqual(self.connect(url, AssertionError("asked")), ([], None))

    def test_port_7878_is_the_live_board(self):
        for url in ("http://127.0.0.1:7878", "http://board.example:7878"):
            asked, err = self.connect(url, b'{"token": "t"}')
            self.assertIn("is the live board", err)

    def test_another_host_has_to_hand_out_its_token(self):
        self.assertEqual(self.connect("https://pr7.board.example/", b'{"token": "abc"}'), (["https://pr7.board.example/api/open-token"], None))

    def test_another_host_that_keeps_its_token_is_refused(self):
        unauthorized = urllib.error.HTTPError("u", 401, "Unauthorized", {}, io.BytesIO(b""))
        for answer in (b"<!doctype html><html></html>", b'{"ok": true}', b'["t"]', unauthorized):
            asked, err = self.connect("https://board.example", answer)
            self.assertIn("isn't a test server or a preview", err, answer)

    def test_a_host_that_doesnt_answer_says_so(self):
        asked, err = self.connect("https://board.example", urllib.error.URLError("Name or service not known"))
        self.assertIn("Name or service not known (is the server running?)", err)


if __name__ == "__main__":
    unittest.main()
