/* todo v2 client.
 *
 * Model: the server owns the truth ({rev, lists, tasks}). The client never
 * uploads the whole list; it queues small ops (add/update/delete/move/...),
 * applies them optimistically, and flushes them to api/ops. The server reply
 * is the new truth; ops still queued are re-applied on top of it. Ops survive
 * reloads and offline periods (localStorage) and are retried with backoff.
 * Polling (api/state?since=rev) keeps other devices in sync.
 *
 * All URLs are relative: the app lives at /todo/ behind nginx.
 */
(function () {
  'use strict';

  const API = 'api/';
  const LS_STATE = 'todo2.state';
  const LS_PENDING = 'todo2.pending';
  const LS_LIST = 'todo2.list';
  const LS_DONE_OPEN = 'todo2.doneOpen';
  const POLL_MS = 4000;
  const PRIOS = ['medium', 'high', 'low'];

  const $ = (id) => document.getElementById(id);
  const el = {
    tabs: $('tabs'), form: $('add'), input: $('input'), addBtn: $('add-btn'),
    active: $('active'), done: $('done'), doneWrap: $('done-wrap'), doneToggle: $('done-toggle'),
    doneCount: $('done-count'), clearDone: $('clear-done'), empty: $('empty'),
    sync: $('sync'), syncText: $('sync-text'), date: $('date'),
    toast: $('toast'), toastText: $('toast-text'), toastUndo: $('toast-undo'),
  };

  // ── state ────────────────────────────────────────────────────────────────
  let server = read(LS_STATE, null) || { rev: -1, lists: [{ id: 'todo', name: 'todo' }, { id: 'groceries', name: 'groceries' }], tasks: [] };
  let pending = read(LS_PENDING, []);
  let view = clone(server);           // server + pending ops
  pending.forEach((op) => applyLocal(view, op));
  let current = localStorage.getItem(LS_LIST) || view.lists[0].id;
  let doneOpen = localStorage.getItem(LS_DONE_OPEN) === '1';
  let inflight = false;
  let backoff = 0;
  let retryTimer = null;
  let editingId = null;
  let dragging = null;
  let undoFn = null;
  let toastTimer = null;
  const nodes = new Map();            // task id -> <li>
  const fresh = new Set();            // ids added locally this session (animate once)

  function read(k, d) { try { const v = JSON.parse(localStorage.getItem(k)); return v ?? d; } catch { return d; } }
  function write(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }
  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 8); }
  function slug(s) { return s.toLowerCase().normalize('NFKD').replace(/[^\w]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'list'; }

  // ── local op mirror (must match server.apply_op semantics) ───────────────
  function idx(tasks, id) { return tasks.findIndex((t) => t.id === id); }

  function applyLocal(s, op) {
    const T = s.tasks;
    switch (op.op) {
      case 'add':
        if (idx(T, op.task.id) !== -1) return;
        if (Number.isInteger(op.index) && op.index >= 0 && op.index <= T.length) T.splice(op.index, 0, clone(op.task));
        else T.unshift(clone(op.task));
        return;
      case 'update': {
        const i = idx(T, op.id); if (i === -1) return;
        const t = T[i], f = op.fields;
        if (typeof f.text === 'string' && f.text.trim()) t.text = f.text.trim();
        if (PRIOS.includes(f.priority)) t.priority = f.priority;
        if ('completed' in f) {
          if (f.completed && !t.completed) t.doneAt = Date.now();
          if (!f.completed) delete t.doneAt;
          t.completed = !!f.completed;
        }
        if (f.list && s.lists.some((l) => l.id === f.list)) t.list = f.list;
        return;
      }
      case 'delete': { const i = idx(T, op.id); if (i !== -1) T.splice(i, 1); return; }
      case 'move': {
        const i = idx(T, op.id); if (i === -1 || op.before === op.id) return;
        const [t] = T.splice(i, 1);
        const j = op.before ? idx(T, op.before) : -1;
        if (j === -1) T.push(t); else T.splice(j, 0, t);
        return;
      }
      case 'clear_done':
        s.tasks = T.filter((t) => !(t.completed && (op.list == null || t.list === op.list)));
        return;
      case 'list_add':
        if (!s.lists.some((l) => l.id === op.list.id)) s.lists.push(clone(op.list));
        return;
      case 'list_rename': { const l = s.lists.find((x) => x.id === op.id); if (l && op.name) l.name = op.name; return; }
      case 'list_delete':
        if (s.lists.length <= 1) return;
        s.lists = s.lists.filter((l) => l.id !== op.id);
        s.tasks = T.filter((t) => t.list !== op.id);
        return;
      case 'list_move': {
        const i = s.lists.findIndex((l) => l.id === op.id); if (i === -1) return;
        const [l] = s.lists.splice(i, 1);
        const j = op.before ? s.lists.findIndex((x) => x.id === op.before) : -1;
        if (j === -1) s.lists.push(l); else s.lists.splice(j, 0, l);
        return;
      }
    }
  }

  // ── sync ─────────────────────────────────────────────────────────────────
  function queue(...ops) {
    for (const op of ops) { pending.push(op); applyLocal(view, op); }
    write(LS_PENDING, pending);
    render();
    flush();
  }

  function adopt(snap) {
    server = { rev: snap.rev, lists: snap.lists, tasks: snap.tasks };
    write(LS_STATE, server);
    view = clone(server);
    pending.forEach((op) => applyLocal(view, op));
    render();
  }

  async function flush() {
    if (inflight || !pending.length) { setSync(); return; }
    inflight = true; setSync();
    const batch = pending.slice(0, 200);
    try {
      const res = await fetch(API + 'ops', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ops: batch }), cache: 'no-store',
      });
      if (res.status >= 400 && res.status < 500) {
        // Rejected batch: drop it so the queue can never get stuck.
        console.warn('ops rejected', res.status, await res.text());
        pending = pending.slice(batch.length);
      } else if (!res.ok) {
        throw new Error('HTTP ' + res.status);
      } else {
        const snap = await res.json();
        if (snap.errors) console.warn('op errors', snap.errors);
        pending = pending.slice(batch.length);
        write(LS_PENDING, pending);
        adopt(snap);
      }
      write(LS_PENDING, pending);
      backoff = 0;
      inflight = false;
      if (pending.length) return flush();
      setSync();
    } catch (err) {
      inflight = false;
      backoff = Math.min(backoff ? backoff * 2 : 2000, 30000);
      setSync(true);
      clearTimeout(retryTimer);
      retryTimer = setTimeout(flush, backoff);
    }
  }

  async function poll() {
    if (document.hidden || inflight || pending.length || dragging || editingId) return;
    try {
      const res = await fetch(API + 'state?since=' + server.rev, { cache: 'no-store' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const snap = await res.json();
      if (!snap.unchanged && !pending.length && !inflight) adopt(snap);
      if (backoff) { backoff = 0; }
      setSync();
    } catch { setSync(true); }
  }

  function setSync(offline) {
    const c = el.sync.classList;
    c.toggle('offline', !!offline || backoff > 0);
    c.toggle('pending', !offline && !backoff && (pending.length > 0 || inflight));
    const txt = (offline || backoff) ? `offline${pending.length ? ' · ' + pending.length + ' queued' : ''}`
      : (pending.length || inflight) ? 'saving' : 'synced';
    el.syncText.textContent = txt;
    el.sync.title = txt;
  }

  // ── render ───────────────────────────────────────────────────────────────
  function render() {
    if (!view.lists.some((l) => l.id === current)) current = view.lists[0].id;
    localStorage.setItem(LS_LIST, current);
    renderTabs();
    const list = view.lists.find((l) => l.id === current);
    el.input.placeholder = `add to ${list ? list.name : 'list'}`;
    const mine = view.tasks.filter((t) => t.list === current);
    const open = mine.filter((t) => !t.completed);
    const done = mine.filter((t) => t.completed).sort((a, b) => (b.doneAt || 0) - (a.doneAt || 0));
    if (!dragging) reconcile(el.active, open);
    reconcile(el.done, done);
    el.empty.hidden = open.length > 0;
    el.doneWrap.hidden = done.length === 0;
    el.doneCount.textContent = done.length;
    el.done.hidden = !doneOpen;
    el.doneToggle.setAttribute('aria-expanded', String(doneOpen));
    const left = view.tasks.filter((t) => t.list === current && !t.completed).length;
    document.title = left ? `todo (${left})` : 'todo';
    // drop nodes for tasks that no longer exist
    const alive = new Set(view.tasks.map((t) => t.id));
    for (const [id, li] of nodes) if (!alive.has(id)) { li.remove(); nodes.delete(id); }
  }

  function renderTabs() {
    const counts = {};
    for (const t of view.tasks) if (!t.completed) counts[t.list] = (counts[t.list] || 0) + 1;
    el.tabs.textContent = '';
    for (const l of view.lists) {
      const b = document.createElement('button');
      b.type = 'button'; b.className = 'tab' + (l.id === current ? ' on' : '');
      b.dataset.list = l.id;
      b.title = l.id === current ? 'tap again to rename / delete' : '';
      b.append(l.name);
      if (counts[l.id]) { const n = document.createElement('span'); n.className = 'n'; n.textContent = counts[l.id]; b.append(n); }
      b.addEventListener('click', () => (l.id === current ? editList(l) : switchList(l.id)));
      el.tabs.append(b);
    }
    const plus = document.createElement('button');
    plus.type = 'button'; plus.className = 'tab plus'; plus.textContent = '+'; plus.title = 'new list';
    plus.addEventListener('click', newList);
    el.tabs.append(plus);
  }

  function reconcile(ul, tasks) {
    let i = 0;
    for (const t of tasks) {
      let li = nodes.get(t.id);
      if (!li) { li = makeRow(t); nodes.set(t.id, li); }
      if (t.id !== editingId) updateRow(li, t);
      const at = ul.children[i];
      if (at !== li) ul.insertBefore(li, at || null);   // only moves nodes that are out of place
      i++;
    }
    // rows past the end belong to another section / list; the other reconcile re-homes them
    while (ul.children.length > i) ul.children[i].remove();
  }

  function makeRow(t) {
    const li = document.createElement('li');
    li.className = 'row' + (fresh.has(t.id) ? ' new' : '');
    fresh.delete(t.id);
    li.dataset.id = t.id;
    li.innerHTML =
      '<span class="handle" aria-hidden="true">⋮⋮</span>' +
      '<input type="checkbox" class="check" aria-label="done">' +
      '<span class="text"></span>' +
      '<button type="button" class="dot" aria-label="priority"></button>' +
      '<button type="button" class="del" aria-label="delete">×</button>';
    li.querySelector('.check').addEventListener('change', (e) =>
      queue({ op: 'update', id: t.id, fields: { completed: e.target.checked } }));
    li.querySelector('.text').addEventListener('click', () => startEdit(t.id));
    li.querySelector('.dot').addEventListener('click', () => cyclePriority(t.id));
    li.querySelector('.del').addEventListener('click', () => deleteTask(t.id));
    li.querySelector('.handle').addEventListener('pointerdown', (e) => startDrag(e, t.id));
    return li;
  }

  function updateRow(li, t) {
    li.classList.toggle('done', !!t.completed);
    const cb = li.querySelector('.check'); if (cb.checked !== !!t.completed) cb.checked = !!t.completed;
    const tx = li.querySelector('.text'); if (tx && tx.textContent !== t.text) tx.textContent = t.text;
    const dot = li.querySelector('.dot');
    dot.className = 'dot ' + t.priority;
    dot.title = 'priority: ' + t.priority;
    li.querySelector('.handle').hidden = !!t.completed;
    li.title = 'added ' + new Date(t.createdAt).toLocaleString();
  }

  // ── actions ──────────────────────────────────────────────────────────────
  function parseInput(raw) {
    let priority = 'medium';
    let text = raw.replace(/(^|\s)!(h|high|!)(?=\s|$)/i, () => { priority = 'high'; return ' '; })
                  .replace(/(^|\s)!(l|low)(?=\s|$)/i, () => { priority = 'low'; return ' '; })
                  .replace(/\s+/g, ' ').trim();
    return { text, priority };
  }

  function addTasks(lines) {
    const ops = [];
    for (const line of lines.slice().reverse()) {      // reverse so first line ends on top
      const { text, priority } = parseInput(line);
      if (!text) continue;
      const task = { id: uid(), text, list: current, priority, completed: false, createdAt: Date.now() };
      fresh.add(task.id);
      ops.push({ op: 'add', task });
    }
    if (ops.length) queue(...ops);
  }

  function startEdit(id) {
    const li = nodes.get(id);
    const t = view.tasks.find((x) => x.id === id);
    if (!li || !t || editingId) return;
    editingId = id;
    const span = li.querySelector('.text');
    const inp = document.createElement('input');
    inp.className = 'edit'; inp.value = t.text; inp.maxLength = 500;
    span.replaceWith(inp);
    inp.focus();
    inp.setSelectionRange(inp.value.length, inp.value.length);
    let finished = false;
    const finish = (save) => {
      if (finished) return; finished = true;
      editingId = null;
      const v = inp.value.trim();
      inp.replaceWith(span);
      if (save && v && v !== t.text) {
        const { text, priority } = parseInput(v);
        const fields = { text };
        if (priority !== 'medium') fields.priority = priority;
        queue({ op: 'update', id, fields });
      } else render();
    };
    inp.addEventListener('blur', () => finish(true));
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); finish(true); }
      if (e.key === 'Escape') { e.preventDefault(); finish(false); }
    });
  }

  function cyclePriority(id) {
    const t = view.tasks.find((x) => x.id === id); if (!t) return;
    queue({ op: 'update', id, fields: { priority: PRIOS[(PRIOS.indexOf(t.priority) + 1) % PRIOS.length] } });
  }

  function deleteTask(id) {
    const i = idx(view.tasks, id); if (i === -1) return;
    const task = clone(view.tasks[i]);
    queue({ op: 'delete', id });
    toast(`deleted “${short(task.text)}”`, () => queue({ op: 'add', task, index: i }));
  }

  function clearDone() {
    const gone = view.tasks.map((t, i) => [t, i]).filter(([t]) => t.completed && t.list === current);
    if (!gone.length) return;
    queue({ op: 'clear_done', list: current });
    toast(`cleared ${gone.length} done`, () =>
      queue(...gone.map(([t, i]) => ({ op: 'add', task: clone(t), index: i }))));
  }

  function switchList(id) {
    if (editingId) return;
    current = id;
    for (const li of nodes.values()) li.remove();
    nodes.clear();
    render();
  }

  function newList() {
    const name = (prompt('new list name') || '').trim().slice(0, 40);
    if (!name) return;
    const id = slug(name) + '-' + Math.random().toString(36).slice(2, 6);
    queue({ op: 'list_add', list: { id, name } });
    switchList(id);
    el.input.focus();
  }

  function editList(l) {
    const v = prompt(`rename “${l.name}”\n(clear the name to delete the list)`, l.name);
    if (v === null) return;
    const name = v.trim().slice(0, 40);
    if (name) { if (name !== l.name) queue({ op: 'list_rename', id: l.id, name }); return; }
    if (view.lists.length <= 1) { alert('cannot delete the last list'); return; }
    const tasks = view.tasks.map((t, i) => [t, i]).filter(([t]) => t.list === l.id);
    if (!confirm(`delete list “${l.name}” and its ${tasks.length} task${tasks.length === 1 ? '' : 's'}?`)) return;
    const pos = view.lists.findIndex((x) => x.id === l.id);
    const after = view.lists[pos + 1] ? view.lists[pos + 1].id : null;
    queue({ op: 'list_delete', id: l.id });
    toast(`deleted list “${short(l.name)}”`, () => queue(
      { op: 'list_add', list: clone(l) },
      { op: 'list_move', id: l.id, before: after },
      ...tasks.map(([t, i]) => ({ op: 'add', task: clone(t), index: i }))));
  }

  function short(s) { return s.length > 28 ? s.slice(0, 27) + '…' : s; }

  // ── toast / undo ─────────────────────────────────────────────────────────
  function toast(msg, undo) {
    el.toastText.textContent = msg;
    undoFn = undo;
    el.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, 7000);
  }
  function hideToast() { el.toast.hidden = true; undoFn = null; }
  function doUndo() { const f = undoFn; hideToast(); if (f) f(); }

  // ── drag to reorder (pointer events: mouse + touch) ──────────────────────
  function startDrag(e, id) {
    const li = nodes.get(id);
    const t = view.tasks.find((x) => x.id === id);
    if (!li || !t || t.completed || editingId) return;
    e.preventDefault();
    // Listen on window, not the handle: moving the row in the DOM releases
    // pointer capture, after which the handle stops receiving events.
    const pid = e.pointerId;
    const startY = e.clientY;
    const startTop = li.offsetTop;
    dragging = { id, li, tab: null };
    li.classList.add('dragging');
    li.style.pointerEvents = 'none';   // let elementFromPoint see the tab under the row

    const move = (ev) => {
      if (ev.pointerId !== pid) return;
      ev.preventDefault();
      const y = ev.clientY;
      // live reorder: slot = number of other rows whose midpoint is above the pointer
      const others = [...el.active.children].filter((r) => r !== li);
      let k = 0;
      for (const r of others) {
        const b = r.getBoundingClientRect();
        if (y > b.top + b.height / 2) k++; else break;
      }
      const ref = others[k] || null;
      if (li.nextElementSibling !== ref) el.active.insertBefore(li, ref);
      li.style.transform = `translateY(${y - startY - (li.offsetTop - startTop)}px)`;
      // hovering a tab = move to that list
      const over = document.elementFromPoint(ev.clientX, ev.clientY);
      const tab = over && over.closest && over.closest('.tab[data-list]');
      if (dragging.tab && dragging.tab !== tab) dragging.tab.classList.remove('drop');
      dragging.tab = tab && tab.dataset.list !== current ? tab : null;
      if (dragging.tab) dragging.tab.classList.add('drop');
    };
    const end = (ev) => {
      if (ev.pointerId !== pid) return;
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      li.classList.remove('dragging');
      li.style.transform = '';
      li.style.pointerEvents = '';
      const d = dragging; dragging = null;
      if (d.tab) {
        d.tab.classList.remove('drop');
        const target = view.lists.find((l) => l.id === d.tab.dataset.list);
        queue({ op: 'update', id, fields: { list: d.tab.dataset.list } });
        toast(`moved to ${target ? target.name : 'list'}`, () => queue({ op: 'update', id, fields: { list: t.list } }));
        return;
      }
      const next = li.nextElementSibling;
      const before = next ? next.dataset.id : null;
      // only send if the order actually changed
      const open = view.tasks.filter((x) => x.list === current && !x.completed);
      const oldNext = open[open.findIndex((x) => x.id === id) + 1];
      if ((oldNext ? oldNext.id : null) !== before) queue({ op: 'move', id, before });
      else render();
    };
    window.addEventListener('pointermove', move, { passive: false });
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  }

  // ── wiring ───────────────────────────────────────────────────────────────
  el.input.addEventListener('input', () => { el.addBtn.disabled = !el.input.value.trim(); });
  el.form.addEventListener('submit', (e) => {
    e.preventDefault();
    const v = el.input.value;
    if (!v.trim()) return;
    addTasks([v]);
    el.input.value = '';
    el.addBtn.disabled = true;
    el.input.focus();
  });
  el.input.addEventListener('paste', (e) => {
    const txt = (e.clipboardData || window.clipboardData).getData('text');
    const lines = txt.split(/\r?\n/).map((s) => s.replace(/^\s*(?:[-*•]|\d+[.)]|\[[ x]\])\s*/i, '').trim()).filter(Boolean);
    if (lines.length > 1) { e.preventDefault(); addTasks(lines); }
  });
  el.doneToggle.addEventListener('click', () => {
    doneOpen = !doneOpen; localStorage.setItem(LS_DONE_OPEN, doneOpen ? '1' : '0'); render();
  });
  el.clearDone.addEventListener('click', clearDone);
  el.toastUndo.addEventListener('click', doUndo);

  document.addEventListener('keydown', (e) => {
    const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement.tagName);
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z' && !typing && undoFn) { e.preventDefault(); doUndo(); return; }
    if (typing) { if (e.key === 'Escape') document.activeElement.blur(); return; }
    if (e.key === 'n' || e.key === '/') { e.preventDefault(); el.input.focus(); }
  });

  document.addEventListener('visibilitychange', () => { if (!document.hidden) { poll(); flush(); } });
  window.addEventListener('online', () => { backoff = 0; flush(); poll(); });
  window.addEventListener('focus', poll);

  el.date.textContent = new Date().toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });

  render();
  setSync();
  flush();
  poll();
  setInterval(poll, POLL_MS);
})();
