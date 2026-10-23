#!/usr/bin/env python3
"""
todo v2 - stdlib server + op-based JSON sync, served at thauyel.com/todo/.

  GET  /                    index.html
  GET  /<whitelisted file>  app.js, style.css, manifest.webmanifest, icon.svg
  GET  /api/state[?since=N] {"rev", "lists", "tasks"}  ({"rev", "unchanged": true} if rev == N)
  POST /api/ops             {"ops": [...]}  -> applies ops in order, returns full state
  GET  /api/tasks           legacy read-only: flat task array
  POST /api/tasks           410 (full-replace writes are gone: they let stale tabs wipe the list)
  GET  /api/health          {"ok": true, "rev": N}

Why ops instead of full replace: v1 POSTed the whole array on every change, so
any stale tab or phone could overwrite everything (that is how the list was
emptied on 2026-10-23). Ops are applied server-side against the current state,
so two devices editing at once merge instead of clobbering.

Ops (all idempotent by id where it makes sense):
  {"op": "add",         "task": {...}, "index"?: int}
  {"op": "update",      "id": str, "fields": {text|priority|completed|list|note}}
  {"op": "delete",      "id": str}
  {"op": "move",        "id": str, "before": str|null}     # null = end of array
  {"op": "clear_done",  "list": str}
  {"op": "list_add",    "list": {"id": str, "name": str}}
  {"op": "list_rename", "id": str, "name": str}
  {"op": "list_delete", "id": str}                         # also drops its tasks
  {"op": "list_move",   "id": str, "before": str|null}

Every write: atomic replace of tasks.json, then debounced (2s) git commit+push
as Iris <iris@thauyel.com>.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_FILE = ROOT / "tasks.json"
PORT = int(os.environ.get("TODO_PORT", "8765"))
HOST = os.environ.get("TODO_HOST", "127.0.0.1")
DEBOUNCE_S = 2.0
NO_GIT = os.environ.get("TODO_NO_GIT") == "1"   # tests

MAX_BODY = 256 * 1024
MAX_TEXT = 500
MAX_NOTE = 2000
MAX_TASKS = 5000
MAX_LISTS = 50
PRIORITIES = ("low", "medium", "high")
ID_RE = re.compile(r"^[A-Za-z0-9_\-]{1,64}$")

DEFAULT_LISTS = [{"id": "todo", "name": "todo"}, {"id": "groceries", "name": "groceries"}]

# Only these files are ever served. v1 served the whole directory, which
# exposed .git/, server.py and backups to the internet.
STATIC = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "style.css": "text/css; charset=utf-8",
    "manifest.webmanifest": "application/manifest+json",
    "icon.svg": "image/svg+xml",
}

_state_lock = threading.RLock()
_state: dict = {}


# ── persistence ─────────────────────────────────────────────────────────────
def _now_ms() -> int:
    return int(time.time() * 1000)


def _clean_task(t: object, lists: set[str], fallback_list: str) -> dict | None:
    if not isinstance(t, dict):
        return None
    tid = str(t.get("id", ""))
    if not ID_RE.match(tid):
        return None
    text = str(t.get("text", "")).strip()[:MAX_TEXT]
    if not text:
        return None
    prio = t.get("priority") if t.get("priority") in PRIORITIES else "medium"
    lst = t.get("list") if t.get("list") in lists else fallback_list
    out = {
        "id": tid,
        "text": text,
        "list": lst,
        "priority": prio,
        "completed": bool(t.get("completed")),
        "createdAt": int(t.get("createdAt") or _now_ms()),
    }
    if out["completed"]:
        out["doneAt"] = int(t.get("doneAt") or out["createdAt"])
    note = str(t.get("note", "") or "").strip()[:MAX_NOTE]
    if note:
        out["note"] = note
    return out


def _normalize(raw) -> dict:
    """Accept v1 (flat array) or v2 (object) and return a clean v2 state."""
    if isinstance(raw, list):                       # v1 migration
        raw = {"rev": 0, "lists": DEFAULT_LISTS, "tasks": raw}
    if not isinstance(raw, dict):
        raw = {}
    lists = []
    seen = set()
    for l in raw.get("lists") or []:
        if isinstance(l, dict) and ID_RE.match(str(l.get("id", ""))) and l["id"] not in seen:
            name = str(l.get("name") or l["id"]).strip()[:40] or l["id"]
            lists.append({"id": l["id"], "name": name})
            seen.add(l["id"])
    if not lists:
        lists = [dict(l) for l in DEFAULT_LISTS]
        seen = {l["id"] for l in lists}
    tasks, tseen = [], set()
    for t in raw.get("tasks") or []:
        c = _clean_task(t, seen, lists[0]["id"])
        if c and c["id"] not in tseen:
            tasks.append(c)
            tseen.add(c["id"])
    return {"version": 2, "rev": int(raw.get("rev") or 0), "lists": lists, "tasks": tasks}


def load_state() -> dict:
    try:
        raw = json.loads(DATA_FILE.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        raw = None
    return _normalize(raw)


def save_state(state: dict) -> None:
    tmp = DATA_FILE.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(state, indent=1, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, DATA_FILE)


# ── ops ─────────────────────────────────────────────────────────────────────
class OpError(ValueError):
    pass


def _find(tasks: list, tid: str) -> int:
    for i, t in enumerate(tasks):
        if t["id"] == tid:
            return i
    return -1


def apply_op(state: dict, op: dict) -> bool:
    """Mutate state in place. Returns True if anything changed.
    Ops that target something already gone are no-ops, not errors, so a
    delayed op from a second device never fails the whole batch."""
    if not isinstance(op, dict):
        raise OpError("op must be an object")
    kind = op.get("op")
    tasks, lists = state["tasks"], state["lists"]
    list_ids = {l["id"] for l in lists}

    if kind == "add":
        if len(tasks) >= MAX_TASKS:
            raise OpError("too many tasks")
        t = _clean_task(op.get("task"), list_ids, lists[0]["id"])
        if not t:
            raise OpError("invalid task")
        if _find(tasks, t["id"]) != -1:
            return False
        idx = op.get("index")
        if isinstance(idx, int) and 0 <= idx <= len(tasks):
            tasks.insert(idx, t)
        else:
            tasks.insert(0, t)
        return True

    if kind == "update":
        i = _find(tasks, str(op.get("id", "")))
        if i == -1:
            return False
        fields = op.get("fields") or {}
        if not isinstance(fields, dict):
            raise OpError("fields must be an object")
        t = dict(tasks[i])
        if "text" in fields:
            text = str(fields["text"]).strip()[:MAX_TEXT]
            if text:
                t["text"] = text
        if fields.get("priority") in PRIORITIES:
            t["priority"] = fields["priority"]
        if "completed" in fields:
            done = bool(fields["completed"])
            if done and not t["completed"]:
                t["doneAt"] = _now_ms()
            if not done:
                t.pop("doneAt", None)
            t["completed"] = done
        if fields.get("list") in list_ids:
            t["list"] = fields["list"]
        if "note" in fields:
            note = str(fields["note"] or "").strip()[:MAX_NOTE]
            if note:
                t["note"] = note
            else:
                t.pop("note", None)
        if t == tasks[i]:
            return False
        tasks[i] = t
        return True

    if kind == "delete":
        i = _find(tasks, str(op.get("id", "")))
        if i == -1:
            return False
        tasks.pop(i)
        return True

    if kind == "move":
        i = _find(tasks, str(op.get("id", "")))
        if i == -1:
            return False
        before = op.get("before")
        if before == op.get("id"):
            return False
        t = tasks.pop(i)
        j = _find(tasks, str(before)) if before else -1
        if j == -1:
            tasks.append(t)
        else:
            tasks.insert(j, t)
        return _find(tasks, t["id"]) != i

    if kind == "clear_done":
        lst = op.get("list")
        before = len(tasks)
        tasks[:] = [t for t in tasks if not (t["completed"] and (lst is None or t["list"] == lst))]
        return len(tasks) != before

    if kind == "list_add":
        l = op.get("list") or {}
        lid = str(l.get("id", ""))
        name = str(l.get("name", "")).strip()[:40]
        if not ID_RE.match(lid) or not name:
            raise OpError("invalid list")
        if lid in list_ids:
            return False
        if len(lists) >= MAX_LISTS:
            raise OpError("too many lists")
        lists.append({"id": lid, "name": name})
        return True

    if kind == "list_rename":
        name = str(op.get("name", "")).strip()[:40]
        for l in lists:
            if l["id"] == op.get("id") and name and l["name"] != name:
                l["name"] = name
                return True
        return False

    if kind == "list_delete":
        lid = op.get("id")
        if lid not in list_ids:
            return False
        if len(lists) == 1:
            raise OpError("cannot delete the last list")
        lists[:] = [l for l in lists if l["id"] != lid]
        tasks[:] = [t for t in tasks if t["list"] != lid]
        return True

    if kind == "list_move":
        ids = [l["id"] for l in lists]
        if op.get("id") not in ids:
            return False
        i = ids.index(op["id"])
        l = lists.pop(i)
        ids.pop(i)
        before = op.get("before")
        j = ids.index(before) if before in ids else len(lists)
        lists.insert(j, l)
        return i != j

    raise OpError(f"unknown op {kind!r}")


def apply_ops(ops: list) -> tuple[dict, list[str]]:
    """Apply a batch atomically-per-op. Bad ops are reported, good ones kept."""
    errors = []
    with _state_lock:
        changed = False
        for n, op in enumerate(ops):
            try:
                changed |= apply_op(_state, op)
            except OpError as e:
                errors.append(f"op {n}: {e}")
        if changed:
            _state["rev"] += 1
            save_state(_state)
            schedule_commit()
        return snapshot(), errors


def snapshot() -> dict:
    with _state_lock:
        return json.loads(json.dumps({k: _state[k] for k in ("rev", "lists", "tasks")}))


# ── git auto-commit (debounced) ─────────────────────────────────────────────
_GIT_ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "Iris",
    "GIT_AUTHOR_EMAIL": "iris@thauyel.com",
    "GIT_COMMITTER_NAME": "Iris",
    "GIT_COMMITTER_EMAIL": "iris@thauyel.com",
    "GIT_TERMINAL_PROMPT": "0",
}
_debounce_timer: threading.Timer | None = None
_debounce_lock = threading.Lock()
_git_lock = threading.Lock()


def _git(*args: str, timeout: int = 60) -> tuple[int, str, str]:
    try:
        p = subprocess.run(["git", *args], cwd=ROOT, env=_GIT_ENV, capture_output=True,
                           text=True, check=False, timeout=timeout)
        return p.returncode, p.stdout, p.stderr
    except subprocess.TimeoutExpired:
        return 124, "", "timeout"


def _commit_and_push() -> None:
    with _git_lock:
        rc, out, _ = _git("status", "--porcelain", "--", DATA_FILE.name)
        if rc != 0 or not out.strip():
            return
        ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
        _git("add", DATA_FILE.name)
        rc, _, err = _git("commit", "-m", f"tasks: auto-update {ts}", "--", DATA_FILE.name)
        if rc != 0:
            print(f"[git] commit failed: {err.strip()}", file=sys.stderr, flush=True)
            return
        rc, out, err = _git("push", "origin", "main")
        if rc != 0:
            print(f"[git] push failed: {err.strip()} {out.strip()}", file=sys.stderr, flush=True)
        else:
            print(f"[git] pushed rev {_state.get('rev')} at {ts}", flush=True)


def schedule_commit() -> None:
    global _debounce_timer
    if NO_GIT:
        return
    with _debounce_lock:
        if _debounce_timer is not None:
            _debounce_timer.cancel()
        _debounce_timer = threading.Timer(DEBOUNCE_S, _commit_and_push)
        _debounce_timer.daemon = True
        _debounce_timer.start()


# ── HTTP ────────────────────────────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    server_version = "todo/2"

    def log_message(self, format, *args):  # noqa: A002
        if "/api/state" in (self.path or "") and " 200 " in (format % args):
            return  # polling noise
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    def _send(self, status: int, body: bytes, ctype: str, extra: dict | None = None) -> None:
        try:
            self.send_response(status)
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-cache")
            self.send_header("X-Content-Type-Options", "nosniff")
            for k, v in (extra or {}).items():
                self.send_header(k, v)
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            pass

    def _json(self, status: int, payload) -> None:
        self._send(status, json.dumps(payload, ensure_ascii=False).encode("utf-8"),
                   "application/json; charset=utf-8")

    def _path_query(self) -> tuple[str, dict]:
        path, _, q = (self.path or "/").partition("?")
        params = dict(p.split("=", 1) for p in q.split("&") if "=" in p)
        return path, params

    def do_HEAD(self):
        self.do_GET()

    def do_GET(self):
        path, params = self._path_query()
        if path == "/api/state":
            snap = snapshot()
            since = params.get("since", "")
            if since.isdigit() and int(since) == snap["rev"]:
                return self._json(200, {"rev": snap["rev"], "unchanged": True})
            return self._json(200, snap)
        if path == "/api/tasks":
            return self._json(200, snapshot()["tasks"])
        if path in ("/api/health", "/healthz"):
            return self._json(200, {"ok": True, "rev": snapshot()["rev"]})
        name = "index.html" if path in ("/", "") else path.lstrip("/")
        if name in STATIC:
            try:
                return self._send(200, (ROOT / name).read_bytes(), STATIC[name])
            except OSError:
                pass
        return self._json(404, {"error": "not found"})

    def do_POST(self):
        path, _ = self._path_query()
        length = int(self.headers.get("Content-Length") or 0)
        if length > MAX_BODY:
            return self._json(413, {"error": "body too large"})
        body = self.rfile.read(length) if length else b""
        if path == "/api/tasks":
            return self._json(410, {"error": "full-replace writes removed; reload the page"})
        if path != "/api/ops":
            return self._json(404, {"error": "not found"})
        try:
            data = json.loads(body or b"null")
        except json.JSONDecodeError:
            return self._json(400, {"error": "invalid JSON"})
        ops = data.get("ops") if isinstance(data, dict) else None
        if not isinstance(ops, list) or not ops or len(ops) > 500:
            return self._json(400, {"error": "expected {ops: [...]} with 1-500 ops"})
        snap, errors = apply_ops(ops)
        if errors:
            snap["errors"] = errors
        return self._json(200, snap)


def main() -> None:
    global _state
    _state = load_state()
    if not DATA_FILE.exists() or json.loads(DATA_FILE.read_text() or "null") != _state:
        save_state(_state)   # migrate v1 -> v2 on disk
    httpd = ThreadingHTTPServer((HOST, PORT), Handler)
    httpd.daemon_threads = True
    print(f"todo v2 on {HOST}:{PORT} rev={_state['rev']} tasks={len(_state['tasks'])}", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        httpd.shutdown()


if __name__ == "__main__":
    main()
