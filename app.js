/* ===================================================
   Todo App — flat, in-place updates
   =================================================== */

(function () {
  'use strict';

  const STORAGE_KEY = 'todo_app_tasks';

  // ─── DOM ─────────────────────────────────────
  const taskForm        = document.getElementById('add-task-form');
  const taskInput       = document.getElementById('task-input');
  const prioritySelect  = document.getElementById('priority-select');
  const addBtn          = document.getElementById('add-btn');
  const taskList        = document.getElementById('task-list');
  const emptyState      = document.getElementById('empty-state');
  const statsText       = document.getElementById('stats-text');
  const clearCompletedBtn = document.getElementById('clear-completed-btn');
  const dateDisplay     = document.getElementById('date-display');
  const greetingEl      = document.getElementById('greeting');
  const filterBtns      = document.querySelectorAll('.filter-btn');
  const emptyTitleEl    = emptyState.querySelector('.empty-title');
  const emptySubtitleEl = emptyState.querySelector('.empty-subtitle');

  // ─── State ───────────────────────────────────
  let tasks = loadTasks();
  let currentFilter = 'all';
  let draggedId = null;

  // ─── Init ────────────────────────────────────
  function init() {
    setDateAndGreeting();
    bindEvents();
    buildList();
    renderStats();
    updateEmptyState();
    // Background sync from server. If something changed, rebuild.
    syncFromServer().catch(() => {});
  }

  // ─── Persistence ─────────────────────────────
  function loadTasks() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch { return []; }
  }

  function saveTasks() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
    fetch('/api/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(tasks),
    }).catch(err => console.warn('sync failed:', err));
  }

  async function syncFromServer() {
    try {
      const res = await fetch('/api/tasks', { cache: 'no-store' });
      if (!res.ok) return;
      const remote = await res.json();
      const local = loadTasks();
      if (JSON.stringify(remote) !== JSON.stringify(local)) {
        tasks = remote;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
        buildList();
        renderStats();
        updateEmptyState();
      }
    } catch (err) {
      console.warn('syncFromServer failed:', err);
    }
  }

  // ─── Header ──────────────────────────────────
  function setDateAndGreeting() {
    const now = new Date();
    dateDisplay.textContent = now.toLocaleDateString('en-US', {
      weekday: 'long', month: 'long', day: 'numeric',
    });
    const hour = now.getHours();
    let g;
    if      (hour < 12) g = 'Good morning';
    else if (hour < 17) g = 'Good afternoon';
    else if (hour < 21) g = 'Good evening';
    else                g = 'Night owl';
    greetingEl.textContent = `${g} — what's on your plate today?`;
  }

  // ─── Events ──────────────────────────────────
  function bindEvents() {
    taskForm.addEventListener('submit', handleAddTask);
    taskInput.addEventListener('input', () => {
      addBtn.disabled = taskInput.value.trim().length === 0;
    });

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        if (btn.classList.contains('active')) return;
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        buildList();
        updateEmptyState();
      });
    });

    clearCompletedBtn.addEventListener('click', handleClearCompleted);
  }

  // ─── Add Task ────────────────────────────────
  function handleAddTask(e) {
    e.preventDefault();
    const text = taskInput.value.trim();
    if (!text) return;

    const task = {
      id: generateId(),
      text,
      priority: prioritySelect.value,
      completed: false,
      createdAt: Date.now(),
    };
    tasks.unshift(task);
    saveTasks();
    // Only re-render the list when the new item is in the current filter.
    const visible = taskMatchesFilter(task, currentFilter);
    if (visible) {
      const li = createTaskElement(task, /*entering*/ true);
      taskList.prepend(li);
    }
    renderStats();
    updateEmptyState();

    taskInput.value = '';
    addBtn.disabled = true;
    taskInput.focus();
  }

  // ─── Toggle Complete (in-place) ──────────────
  function toggleComplete(id) {
    const task = tasks.find(t => t.id === id);
    if (!task) return;
    task.completed = !task.completed;
    saveTasks();

    const li = taskList.querySelector(`[data-id="${id}"]`);
    if (li) {
      if (task.completed) li.classList.add('completed');
      else                li.classList.remove('completed');
      const cb = li.querySelector('input[type="checkbox"]');
      if (cb) cb.checked = task.completed;
    }
    renderStats();
    updateEmptyState();
  }

  // ─── Delete Task (in-place) ──────────────────
  function deleteTask(id) {
    const li = taskList.querySelector(`[data-id="${id}"]`);
    if (!li) return;

    li.classList.add('removing');
    const cleanup = () => {
      tasks = tasks.filter(t => t.id !== id);
      saveTasks();
      li.remove();
      renderStats();
      updateEmptyState();
    };
    // 200ms matches CSS removing transition
    setTimeout(cleanup, 200);
  }

  // ─── Edit Task ───────────────────────────────
  function startEdit(id) {
    const task = tasks.find(t => t.id === id);
    if (!task || task.completed) return;
    const li = taskList.querySelector(`[data-id="${id}"]`);
    if (!li) return;
    const textEl = li.querySelector('.task-text');
    const currentText = task.text;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.value = currentText;
    input.maxLength = 200;

    textEl.replaceWith(input);
    input.focus();
    input.select();

    let done = false;
    function finishEdit(commit) {
      if (done) return;
      done = true;
      if (commit) {
        const newText = input.value.trim();
        if (newText && newText !== currentText) {
          task.text = newText;
          saveTasks();
        }
      }
      buildList();
    }
    input.addEventListener('blur', () => finishEdit(true));
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
      if (e.key === 'Escape') { e.preventDefault(); finishEdit(false); }
    });
  }

  // ─── Clear Completed ─────────────────────────
  function handleClearCompleted() {
    const completedIds = new Set(tasks.filter(t => t.completed).map(t => t.id));
    if (completedIds.size === 0) return;

    // In-place remove each
    const lis = taskList.querySelectorAll('.task-item.completed');
    lis.forEach(li => li.classList.add('removing'));
    setTimeout(() => {
      tasks = tasks.filter(t => !t.completed);
      saveTasks();
      buildList();
      renderStats();
      updateEmptyState();
    }, 200);
  }

  // ─── Drag & Drop ─────────────────────────────
  function handleDragStart(e, id) {
    draggedId = id;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }
  function handleDragEnd(e) {
    draggedId = null;
    e.currentTarget.classList.remove('dragging');
    taskList.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
  }
  function handleDragOver(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    e.currentTarget.classList.add('drag-over');
  }
  function handleDragLeave(e) {
    e.currentTarget.classList.remove('drag-over');
  }
  function handleDrop(e, targetId) {
    e.preventDefault();
    e.currentTarget.classList.remove('drag-over');
    if (draggedId === targetId) return;
    const fromIdx = tasks.findIndex(t => t.id === draggedId);
    const toIdx   = tasks.findIndex(t => t.id === targetId);
    if (fromIdx === -1 || toIdx === -1) return;
    const [moved] = tasks.splice(fromIdx, 1);
    tasks.splice(toIdx, 0, moved);
    saveTasks();
    buildList();
  }

  // ─── Build list (one full re-render) ─────────
  function buildList() {
    const filtered = getFilteredTasks();
    taskList.innerHTML = '';
    filtered.forEach(task => {
      taskList.appendChild(createTaskElement(task, false));
    });
  }

  function createTaskElement(task, entering) {
    const li = document.createElement('li');
    li.className = 'task-item' + (task.completed ? ' completed' : '')
                  + (entering ? ' entering' : '');
    li.dataset.id = task.id;
    li.draggable = true;

    const dot = document.createElement('span');
    dot.className = 'priority-dot ' + task.priority;

    const label = document.createElement('label');
    label.className = 'task-checkbox';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!task.completed;
    cb.setAttribute('aria-label', 'Toggle task completion');
    label.appendChild(cb);

    const text = document.createElement('span');
    text.className = 'task-text';
    text.textContent = task.text;

    const time = document.createElement('span');
    time.className = 'task-time';
    time.textContent = formatTime(task.createdAt);

    const del = document.createElement('button');
    del.className = 'delete-btn';
    del.setAttribute('aria-label', 'Delete task');
    del.innerHTML =
      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" ' +
      'stroke="currentColor" stroke-width="2" stroke-linecap="round" ' +
      'stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/>' +
      '<line x1="6" y1="6" x2="18" y2="18"/></svg>';

    li.append(dot, label, text, time, del);

    // events
    cb.addEventListener('change', () => toggleComplete(task.id));
    del.addEventListener('click', (e) => { e.stopPropagation(); deleteTask(task.id); });
    text.addEventListener('dblclick', () => startEdit(task.id));
    li.addEventListener('dragstart', (e) => handleDragStart(e, task.id));
    li.addEventListener('dragend', handleDragEnd);
    li.addEventListener('dragover', handleDragOver);
    li.addEventListener('dragleave', handleDragLeave);
    li.addEventListener('drop', (e) => handleDrop(e, task.id));

    return li;
  }

  // ─── Stats & empty state (independent updates) ─
  function renderStats() {
    const active    = tasks.filter(t => !t.completed).length;
    const completed = tasks.filter(t => t.completed).length;
    statsText.textContent =
      `${active} task${active !== 1 ? 's' : ''} remaining`
      + (completed > 0 ? ` · ${completed} done` : '');
    clearCompletedBtn.classList.toggle('visible', completed > 0);
  }

  function updateEmptyState() {
    const visible = getFilteredTasks();
    if (visible.length > 0) {
      emptyState.classList.remove('visible');
      return;
    }
    emptyState.classList.add('visible');
    if (tasks.length === 0) {
      emptyTitleEl.textContent = 'No tasks yet';
      emptySubtitleEl.textContent = 'Add your first task above to get started';
    } else if (currentFilter === 'active') {
      emptyTitleEl.textContent = 'Nothing active';
      emptySubtitleEl.textContent = 'All tasks are completed — nice work.';
    } else if (currentFilter === 'completed') {
      emptyTitleEl.textContent = 'Nothing completed';
      emptySubtitleEl.textContent = 'Check off a task to see it here.';
    } else {
      emptyTitleEl.textContent = 'No tasks';
      emptySubtitleEl.textContent = '';
    }
  }

  // ─── Filter helpers ──────────────────────────
  function getFilteredTasks() {
    if (currentFilter === 'active')    return tasks.filter(t => !t.completed);
    if (currentFilter === 'completed') return tasks.filter(t => t.completed);
    return tasks;
  }
  function taskMatchesFilter(task, filter) {
    if (filter === 'active')    return !task.completed;
    if (filter === 'completed') return task.completed;
    return true;
  }

  // ─── Utilities ───────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now  = new Date();
    const diff = now - date;
    if (diff < 60_000)        return 'just now';
    if (diff < 3_600_000)     return Math.floor(diff / 60_000) + 'm ago';
    if (diff < 86_400_000)    return Math.floor(diff / 3_600_000) + 'h ago';
    if (date.toDateString() === now.toDateString())
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ─── Boot ────────────────────────────────────
  init();
})();
