#!/usr/bin/env python3
"""Tests for todo v2 server. Run: /usr/bin/python3 test_server.py"""
import json
import os
import shutil
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import ThreadingHTTPServer
from pathlib import Path

os.environ["TODO_NO_GIT"] = "1"
sys.path.insert(0, str(Path(__file__).resolve().parent))
import server  # noqa: E402


def task(i, lst="todo", **kw):
    return {"id": f"t{i}", "text": f"task {i}", "list": lst, "priority": "medium",
            "completed": False, "createdAt": 1000 + i, **kw}


class Base(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        for f in server.STATIC:
            shutil.copy(server.ROOT / f, self.tmp / f)
        self._root, self._data = server.ROOT, server.DATA_FILE
        server.ROOT = self.tmp
        server.DATA_FILE = self.tmp / "tasks.json"
        server._state = server.load_state()

    def tearDown(self):
        server.ROOT, server.DATA_FILE = self._root, self._data
        shutil.rmtree(self.tmp)

    def ops(self, *ops):
        snap, errors = server.apply_ops(list(ops))
        return snap, errors

    def ids(self, lst=None):
        return [t["id"] for t in server._state["tasks"] if lst is None or t["list"] == lst]


class TestOps(Base):
    def test_defaults_and_migration(self):
        self.assertEqual([l["id"] for l in server._state["lists"]], ["todo", "groceries"])
        server.DATA_FILE.write_text(json.dumps([
            {"id": "a1", "text": "milk", "priority": "high", "completed": True, "createdAt": 5},
            {"id": "a2", "text": "  ", "priority": "x"},            # empty text dropped
            {"id": "../evil", "text": "bad id"},                     # bad id dropped
            {"id": "a1", "text": "dup"},                             # duplicate dropped
        ]))
        st = server.load_state()
        self.assertEqual(len(st["tasks"]), 1)
        self.assertEqual(st["tasks"][0]["list"], "todo")
        self.assertEqual(st["tasks"][0]["doneAt"], 5)

    def test_corrupt_file_does_not_crash(self):
        server.DATA_FILE.write_text("{not json")
        st = server.load_state()
        self.assertEqual(st["tasks"], [])

    def test_add_is_idempotent_and_bumps_rev(self):
        s1, _ = self.ops({"op": "add", "task": task(1)})
        s2, _ = self.ops({"op": "add", "task": task(1)})
        self.assertEqual(len(s2["tasks"]), 1)
        self.assertEqual(s1["rev"], 1)
        self.assertEqual(s2["rev"], 1)        # no-op does not bump rev

    def test_add_index_and_default_top(self):
        self.ops({"op": "add", "task": task(1)}, {"op": "add", "task": task(2)})
        self.assertEqual(self.ids(), ["t2", "t1"])
        self.ops({"op": "add", "task": task(3), "index": 2})
        self.assertEqual(self.ids(), ["t2", "t1", "t3"])
        self.ops({"op": "add", "task": task(4), "index": 99})   # out of range -> top
        self.assertEqual(self.ids()[0], "t4")

    def test_add_unknown_list_falls_back(self):
        self.ops({"op": "add", "task": task(1, lst="nope")})
        self.assertEqual(server._state["tasks"][0]["list"], "todo")

    def test_update_fields(self):
        self.ops({"op": "add", "task": task(1)})
        self.ops({"op": "update", "id": "t1", "fields": {
            "text": "  new  ", "priority": "high", "completed": True, "list": "groceries", "note": "n"}})
        t = server._state["tasks"][0]
        self.assertEqual((t["text"], t["priority"], t["completed"], t["list"], t["note"]),
                         ("new", "high", True, "groceries", "n"))
        self.assertIn("doneAt", t)
        self.ops({"op": "update", "id": "t1", "fields": {
            "completed": False, "priority": "bogus", "list": "nope", "text": "  ", "note": ""}})
        t = server._state["tasks"][0]
        self.assertEqual((t["text"], t["priority"], t["completed"], t["list"]), ("new", "high", False, "groceries"))
        self.assertNotIn("doneAt", t)
        self.assertNotIn("note", t)

    def test_ops_on_missing_ids_are_noops(self):
        snap, errors = self.ops({"op": "update", "id": "zz", "fields": {"text": "x"}},
                                {"op": "delete", "id": "zz"}, {"op": "move", "id": "zz", "before": None})
        self.assertEqual(errors, [])
        self.assertEqual(snap["rev"], 0)

    def test_bad_ops_reported_good_ops_kept(self):
        snap, errors = self.ops({"op": "explode"}, {"op": "add", "task": task(1)}, "notadict",
                                {"op": "add", "task": {"id": "x"}})
        self.assertEqual(len(errors), 3)
        self.assertEqual(self.ids(), ["t1"])

    def test_move(self):
        for i in (3, 2, 1):
            self.ops({"op": "add", "task": task(i)})
        self.assertEqual(self.ids(), ["t1", "t2", "t3"])
        self.ops({"op": "move", "id": "t1", "before": None})
        self.assertEqual(self.ids(), ["t2", "t3", "t1"])
        self.ops({"op": "move", "id": "t1", "before": "t2"})
        self.assertEqual(self.ids(), ["t1", "t2", "t3"])
        rev = server._state["rev"]
        self.ops({"op": "move", "id": "t1", "before": "t1"})     # self -> noop
        self.ops({"op": "move", "id": "t1", "before": "t2"})     # already there -> noop
        self.assertEqual(server._state["rev"], rev)
        self.ops({"op": "move", "id": "t2", "before": "ghost"})  # unknown anchor -> end
        self.assertEqual(self.ids(), ["t1", "t3", "t2"])

    def test_clear_done_scoped_to_list(self):
        self.ops({"op": "add", "task": task(1, completed=True)},
                 {"op": "add", "task": task(2, lst="groceries", completed=True)},
                 {"op": "add", "task": task(3)})
        self.ops({"op": "clear_done", "list": "todo"})
        self.assertEqual(sorted(self.ids()), ["t2", "t3"])

    def test_lists(self):
        self.ops({"op": "list_add", "list": {"id": "work", "name": "work"}},
                 {"op": "add", "task": task(1, lst="work")})
        self.ops({"op": "list_rename", "id": "work", "name": "job"})
        self.assertEqual(server._state["lists"][-1], {"id": "work", "name": "job"})
        self.ops({"op": "list_move", "id": "work", "before": "todo"})
        self.assertEqual([l["id"] for l in server._state["lists"]], ["work", "todo", "groceries"])
        self.ops({"op": "list_delete", "id": "work"})
        self.assertEqual(self.ids(), [])
        self.ops({"op": "list_delete", "id": "groceries"})
        _, errors = self.ops({"op": "list_delete", "id": "todo"})
        self.assertTrue(errors)                                  # last list protected
        _, errors = self.ops({"op": "list_add", "list": {"id": "a b", "name": "x"}})
        self.assertTrue(errors)

    def test_undo_roundtrip(self):
        for i in (3, 2, 1):
            self.ops({"op": "add", "task": task(i)})
        t2 = dict(server._state["tasks"][1])
        self.ops({"op": "delete", "id": "t2"})
        self.ops({"op": "add", "task": t2, "index": 1})
        self.assertEqual(self.ids(), ["t1", "t2", "t3"])

    def test_text_limits(self):
        self.ops({"op": "add", "task": dict(task(1), text="x" * 5000)})
        self.assertEqual(len(server._state["tasks"][0]["text"]), server.MAX_TEXT)

    def test_persisted_atomically(self):
        self.ops({"op": "add", "task": task(1)})
        on_disk = json.loads(server.DATA_FILE.read_text())
        self.assertEqual(on_disk["tasks"][0]["id"], "t1")
        self.assertFalse((self.tmp / "tasks.json.tmp").exists())

    def test_concurrent_adds_all_land(self):
        def worker(n):
            for k in range(25):
                server.apply_ops([{"op": "add", "task": task(n * 100 + k)}])
        ths = [threading.Thread(target=worker, args=(n,)) for n in range(8)]
        [t.start() for t in ths]
        [t.join() for t in ths]
        self.assertEqual(len(server._state["tasks"]), 200)
        self.assertEqual(server._state["rev"], 200)
        self.assertEqual(len(json.loads(server.DATA_FILE.read_text())["tasks"]), 200)


class TestHTTP(Base):
    def setUp(self):
        super().setUp()
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), server.Handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def tearDown(self):
        self.httpd.shutdown()
        self.httpd.server_close()
        super().tearDown()

    def req(self, path, body=None, method=None):
        data = json.dumps(body).encode() if body is not None else None
        r = urllib.request.Request(self.base + path, data=data, method=method,
                                   headers={"Content-Type": "application/json"})
        try:
            with urllib.request.urlopen(r) as resp:
                return resp.status, resp.read()
        except urllib.error.HTTPError as e:
            return e.code, e.read()

    def test_static_whitelist(self):
        for p in ("/", "/app.js", "/style.css", "/manifest.webmanifest", "/icon.svg"):
            self.assertEqual(self.req(p)[0], 200, p)
        (self.tmp / "server.py").write_text("secret")
        (self.tmp / ".git").mkdir()
        (self.tmp / ".git" / "config").write_text("secret")
        for p in ("/server.py", "/.git/config", "/tasks.json", "/../etc/passwd", "/%2e%2e/server.py",
                  "/index.html/../server.py"):
            code, body = self.req(p)
            self.assertEqual(code, 404, p)
            self.assertNotIn(b"secret", body)

    def test_state_and_since(self):
        code, body = self.req("/api/ops", {"ops": [{"op": "add", "task": task(1)}]})
        self.assertEqual(code, 200)
        snap = json.loads(body)
        self.assertEqual(snap["rev"], 1)
        _, body = self.req("/api/state?since=1")
        self.assertEqual(json.loads(body), {"rev": 1, "unchanged": True})
        _, body = self.req("/api/state?since=0")
        self.assertEqual(len(json.loads(body)["tasks"]), 1)
        _, body = self.req("/api/tasks")
        self.assertEqual(json.loads(body)[0]["id"], "t1")

    def test_legacy_full_replace_is_refused(self):
        self.req("/api/ops", {"ops": [{"op": "add", "task": task(1)}]})
        code, _ = self.req("/api/tasks", [])
        self.assertEqual(code, 410)
        self.assertEqual(len(server._state["tasks"]), 1)        # nothing wiped

    def test_bad_requests(self):
        self.assertEqual(self.req("/api/ops", {"ops": []})[0], 400)
        self.assertEqual(self.req("/api/ops", {"nope": 1})[0], 400)
        self.assertEqual(self.req("/api/ops", [1, 2])[0], 400)
        r = urllib.request.Request(self.base + "/api/ops", data=b"{bad", method="POST")
        try:
            urllib.request.urlopen(r)
        except urllib.error.HTTPError as e:
            self.assertEqual(e.code, 400)
        big = {"ops": [{"op": "add", "task": dict(task(1), text="x" * 400000)}]}
        self.assertEqual(self.req("/api/ops", big)[0], 413)
        self.assertEqual(self.req("/api/nope", {"ops": [1]})[0], 404)

    def test_health(self):
        code, body = self.req("/api/health")
        self.assertEqual((code, json.loads(body)["ok"]), (200, True))


if __name__ == "__main__":
    unittest.main(verbosity=1)
