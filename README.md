# todo

Personal todo / groceries app at https://thauyel.com/todo/. Vanilla HTML/CSS/JS,
stdlib Python server, no build step, no dependencies.

- Lists as tabs (todo, groceries, + your own). Tap the active tab to rename;
  clear the name to delete (with undo).
- Tap a task to edit, tap its dot to cycle priority, `!h` / `!l` when typing.
- Drag ⋮⋮ to reorder (mouse and touch); drop onto a tab to move it to that list.
- Paste several lines to add several tasks at once.
- Undo for delete, clear done and list delete (toast or ctrl+z).
- Works offline: changes queue locally and sync when the connection is back.
- Live across devices (polls every 4 s, instantly on focus).
- The recipe app (thauyel.com/recipe/) can push a recipe's ingredients into
  the groceries list.

## Sync model

The server owns the state (`tasks.json`, `{rev, lists, tasks}`). Clients never
upload the whole list; they send small ops to `POST /api/ops` which the server
applies to the current state, so two devices editing at once merge instead of
overwriting each other. Every change is auto-committed and pushed (2 s
debounce) as `Iris <iris@thauyel.com>`, so git history is the backup.

## API

    GET  /api/state[?since=REV]   {rev, lists, tasks} or {rev, unchanged: true}
    POST /api/ops                 {ops: [...]} -> new state
    GET  /api/tasks               flat task array (read-only, legacy)
    GET  /api/health

Ops: `add`, `update`, `delete`, `move`, `clear_done`, `list_add`,
`list_rename`, `list_delete`, `list_move`. See the docstring in `server.py`.

## Dev

    TODO_PORT=8790 TODO_NO_GIT=1 python3 server.py
    python3 test_server.py
