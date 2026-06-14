# todo.

A minimal, elegant to-do app. Vanilla HTML/CSS/JS, zero build step, zero dependencies.

- Drag to reorder
- Double-click to edit
- Priority levels (low / medium / high)
- Filters (all / active / completed)
- Tasks persist server-side at `tasks.json` and survive across devices

## Run locally

Open `index.html` in a browser, or serve the directory with any static server:

    python3 -m http.server 8000

## API

`GET  /api/tasks`            – load all tasks
`POST /api/tasks`            – replace all tasks  (body: JSON array)
`POST /api/tasks/sync`       – upsert a single task  (body: task object)

Tasks look like:

    {
      "id": "1718340000000-abc",
      "text": "Buy milk",
      "priority": "medium",
      "completed": false,
      "createdAt": 1718340000000,
      "order": 0
    }
