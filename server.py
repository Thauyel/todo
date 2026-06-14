#!/usr/bin/env python3
"""
Todo static server + tiny JSON API.

  GET  /              -> index.html
  GET  /<file>        -> static file
  GET  /api/tasks     -> tasks.json contents (always [] if missing)
  POST /api/tasks     -> full replace, body = JSON array
  POST /api/tasks/sync -> upsert one task, body = task object

On every successful write we:
  1. Write tasks.json
  2. Auto-commit & auto-push to origin (debounced 2s)
"""

import json
import os
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

ROOT       = Path(__file__).resolve().parent
TASKS_FILE = ROOT / "tasks.json"
PORT       = int(os.environ.get("TODO_PORT", "8765"))
DEBOUNCE_S = 2.0  # collapse bursts of writes

# ── Git auto-commit (debounced) ───────────────────────────────
_debounce_timer: threading.Timer | None = None
_debounce_lock  = threading.Lock()


def _git(*args: str) -> tuple[int, str, str]:
    p = subprocess.run(
        ["git", *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    return p.returncode, p.stdout, p.stderr


def _commit_and_push():
    """Run after debounce: stage, commit, push."""
    # Don't push if there's nothing new
    rc, out, _ = _git("status", "--porcelain")
    if rc != 0 or not out.strip():
        return
    ts = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")
    _git("add", "tasks.json")
    rc, _, err = _git("commit", "-m", f"tasks: auto-update {ts}")
    if rc != 0:
        print(f"[git] commit failed: {err.strip()}", file=sys.stderr)
        return
    rc, out, err = _git("push", "origin", "main")
    if rc != 0:
        print(f"[git] push failed: {err.strip()}\n{out.strip()}", file=sys.stderr)
    else:
        print(f"[git] pushed: tasks updated at {ts}")


def schedule_commit():
    global _debounce_timer
    with _debounce_lock:
        if _debounce_timer is not None:
            _debounce_timer.cancel()
        t = threading.Timer(DEBOUNCE_S, _commit_and_push)
        t.daemon = True
        _debounce_timer = t
        t.start()


# ── HTTP handler ──────────────────────────────────────────────
class Handler(BaseHTTPRequestHandler):
    # Quiet logging
    def log_message(self, format, *args):
        sys.stderr.write(f"[{self.log_date_time_string()}] {format % args}\n")

    # ---- helpers ------------------------------------------------
    def _send_json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()
        self.wfile.write(body)

    def _send_file(self, path: Path):
        if not path.is_file() or not path.resolve().is_relative_to(ROOT):
            self.send_error(404)
            return
        ext = path.suffix.lower()
        mime = {
            ".html": "text/html; charset=utf-8",
            ".css":  "text/css; charset=utf-8",
            ".js":   "application/javascript; charset=utf-8",
            ".json": "application/json; charset=utf-8",
            ".svg":  "image/svg+xml",
            ".png":  "image/png",
            ".ico":  "image/x-icon",
        }.get(ext, "application/octet-stream")
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", mime)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def _read_body(self) -> bytes:
        length = int(self.headers.get("Content-Length") or 0)
        return self.rfile.read(length) if length else b""

    # ---- routing ------------------------------------------------
    def do_OPTIONS(self):
        self._send_json(204, {})

    def do_GET(self):
        if self.path == "/api/tasks":
            if TASKS_FILE.is_file():
                try:
                    return self._send_json(200, json.loads(TASKS_FILE.read_text()))
                except json.JSONDecodeError:
                    return self._send_json(200, [])
            return self._send_json(200, [])
        if self.path == "/api/health":
            return self._send_json(200, {"ok": True})
        if self.path in ("/", "/index.html"):
            return self._send_file(ROOT / "index.html")
        # static
        rel = self.path.lstrip("/").split("?")[0]
        return self._send_file(ROOT / rel)

    def do_POST(self):
        try:
            data = json.loads(self._read_body() or b"null")
        except json.JSONDecodeError:
            return self._send_json(400, {"error": "invalid JSON"})

        if self.path == "/api/tasks":
            if not isinstance(data, list):
                return self._send_json(400, {"error": "expected array"})
            TASKS_FILE.write_text(json.dumps(data, indent=2))
            schedule_commit()
            return self._send_json(200, {"ok": True, "count": len(data)})

        if self.path == "/api/tasks/sync":
            if not isinstance(data, dict) or "id" not in data:
                return self._send_json(400, {"error": "expected task object with id"})
            current = []
            if TASKS_FILE.is_file():
                try:
                    current = json.loads(TASKS_FILE.read_text())
                except json.JSONDecodeError:
                    current = []
            current = [t for t in current if t.get("id") != data["id"]]
            current.append(data)
            TASKS_FILE.write_text(json.dumps(current, indent=2))
            schedule_commit()
            return self._send_json(200, {"ok": True})

        return self._send_json(404, {"error": "not found"})


# ── Boot ──────────────────────────────────────────────────────
def ensure_tasks_file():
    if not TASKS_FILE.is_file():
        TASKS_FILE.write_text("[]")


def main():
    ensure_tasks_file()
    httpd = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"todo server listening on :{PORT}  (root={ROOT})", flush=True)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nshutting down…", flush=True)
        httpd.shutdown()


if __name__ == "__main__":
    main()
