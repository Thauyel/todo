/* ===================================================
   Todo App – Application Logic
   =================================================== */

(function () {
  'use strict';

  // ─── Constants ──────────────────────────────────
  const STORAGE_KEY = 'todo_app_tasks';

  // ─── DOM References ─────────────────────────────
  const taskForm = document.getElementById('add-task-form');
  const taskInput = document.getElementById('task-input');
  const prioritySelect = document.getElementById('priority-select');
  const taskList = document.getElementById('task-list');
  const emptyState = document.getElementById('empty-state');
  const statsText = document.getElementById('stats-text');
  const clearCompletedBtn = document.getElementById('clear-completed-btn');
  const dateDisplay = document.getElementById('date-display');
  const greetingEl = document.getElementById('greeting');
  const filterBtns = document.querySelectorAll('.filter-btn');

  // ─── State ──────────────────────────────────────
  let tasks = loadTasks();
  let currentFilter = 'all';
  let draggedId = null;

  // ─── Initialise ─────────────────────────────────
  function init() {
    setDateAndGreeting();
    bindEvents();
    render();
    // Pull latest from server in the background; if it's the same, no re-render.
    syncFromServer().catch(() => {});
  }

  // ─── Persistence ────────────────────────────────
  // localStorage is a local cache (works offline, instant render).
  // The server is the source of truth — every change syncs up.
  function loadTasks() {
    try {
      const data = localStorage.getItem(STORAGE_KEY);
      return data ? JSON.parse(data) : [];
    } catch {
      return [];
    }
  }

  function saveTasks() {
    // 1. local cache (synchronous, instant)
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}

    // 2. server (fire-and-forget; server auto-commits to git)
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
      // Only re-render if something actually changed
      if (JSON.stringify(remote) !== JSON.stringify(local)) {
        tasks = remote;
        try { localStorage.setItem(STORAGE_KEY, JSON.stringify(tasks)); } catch {}
        render();
      }
    } catch (err) {
      console.warn('syncFromServer failed:', err);
    }
  }

  // ─── Date & Greeting ────────────────────────────
  function setDateAndGreeting() {
    const now = new Date();
    const opts = { weekday: 'long', month: 'long', day: 'numeric' };
    dateDisplay.textContent = now.toLocaleDateString('en-US', opts);

    const hour = now.getHours();
    let greeting;
    if (hour < 12) greeting = 'Good morning ☀️';
    else if (hour < 17) greeting = 'Good afternoon 🌤️';
    else if (hour < 21) greeting = 'Good evening 🌙';
    else greeting = 'Night owl mode 🦉';

    greetingEl.textContent = `${greeting} — what's on your plate today?`;
  }

  // ─── Events ─────────────────────────────────────
  function bindEvents() {
    taskForm.addEventListener('submit', handleAddTask);

    filterBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        filterBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        currentFilter = btn.dataset.filter;
        render();
      });
    });

    clearCompletedBtn.addEventListener('click', handleClearCompleted);
  }

  // ─── Add Task ───────────────────────────────────
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
    render();

    taskInput.value = '';
    taskInput.focus();
  }

  // ─── Toggle Complete ────────────────────────────
  function toggleComplete(id) {
    const task = tasks.find(t => t.id === id);
    if (task) {
      task.completed = !task.completed;
      saveTasks();
      render();
    }
  }

  // ─── Delete Task ────────────────────────────────
  function deleteTask(id) {
    const el = document.querySelector(`[data-id="${id}"]`);
    if (el) {
      el.classList.add('removing');
      el.addEventListener('animationend', () => {
        tasks = tasks.filter(t => t.id !== id);
        saveTasks();
        render();
      });
    }
  }

  // ─── Edit Task ──────────────────────────────────
  function startEdit(id) {
    const task = tasks.find(t => t.id === id);
    if (!task || task.completed) return;

    const el = document.querySelector(`[data-id="${id}"]`);
    const textEl = el.querySelector('.task-text');
    const currentText = task.text;

    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'task-edit-input';
    input.value = currentText;
    input.maxLength = 200;

    textEl.replaceWith(input);
    input.focus();
    input.select();

    function finishEdit() {
      const newText = input.value.trim();
      if (newText && newText !== currentText) {
        task.text = newText;
        saveTasks();
      }
      render();
    }

    input.addEventListener('blur', finishEdit);
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        input.value = currentText;
        input.blur();
      }
    });
  }

  // ─── Clear Completed ───────────────────────────
  function handleClearCompleted() {
    const completedEls = document.querySelectorAll('.task-item.completed');
    if (completedEls.length === 0) {
      tasks = tasks.filter(t => !t.completed);
      saveTasks();
      render();
      return;
    }

    completedEls.forEach(el => el.classList.add('removing'));

    setTimeout(() => {
      tasks = tasks.filter(t => !t.completed);
      saveTasks();
      render();
    }, 300);
  }

  // ─── Drag & Drop ───────────────────────────────
  function handleDragStart(e, id) {
    draggedId = id;
    e.currentTarget.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
  }

  function handleDragEnd(e) {
    draggedId = null;
    e.currentTarget.classList.remove('dragging');
    document.querySelectorAll('.drag-over').forEach(el => el.classList.remove('drag-over'));
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

    const draggedIndex = tasks.findIndex(t => t.id === draggedId);
    const targetIndex = tasks.findIndex(t => t.id === targetId);

    if (draggedIndex === -1 || targetIndex === -1) return;

    const [draggedTask] = tasks.splice(draggedIndex, 1);
    tasks.splice(targetIndex, 0, draggedTask);

    saveTasks();
    render();
  }

  // ─── Render ─────────────────────────────────────
  function render() {
    const filtered = getFilteredTasks();
    const totalActive = tasks.filter(t => !t.completed).length;
    const totalCompleted = tasks.filter(t => t.completed).length;

    // Stats
    statsText.textContent = `${totalActive} task${totalActive !== 1 ? 's' : ''} remaining`;
    clearCompletedBtn.classList.toggle('visible', totalCompleted > 0);

    // Empty state
    if (filtered.length === 0) {
      taskList.innerHTML = '';
      emptyState.classList.add('visible');
      if (tasks.length > 0) {
        emptyState.querySelector('.empty-title').textContent = 'No tasks here';
        emptyState.querySelector('.empty-subtitle').textContent =
          currentFilter === 'active'
            ? 'All tasks are completed — nice work!'
            : 'No completed tasks yet';
      } else {
        emptyState.querySelector('.empty-title').textContent = 'No tasks yet';
        emptyState.querySelector('.empty-subtitle').textContent =
          'Add your first task above to get started';
      }
      return;
    }

    emptyState.classList.remove('visible');

    // Build task list
    taskList.innerHTML = filtered
      .map(
        (task, i) => `
      <li class="task-item ${task.completed ? 'completed' : ''}"
          data-id="${task.id}"
          draggable="true"
          style="animation-delay: ${i * 0.04}s">
        <span class="priority-dot ${task.priority}"></span>
        <label class="task-checkbox">
          <input type="checkbox" ${task.completed ? 'checked' : ''} aria-label="Toggle task completion" />
          <span class="checkmark">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>
          </span>
        </label>
        <span class="task-text">${escapeHtml(task.text)}</span>
        <span class="task-time">${formatTime(task.createdAt)}</span>
        <button class="delete-btn" aria-label="Delete task">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
        </button>
      </li>`
      )
      .join('');

    // Bind task events
    taskList.querySelectorAll('.task-item').forEach(el => {
      const id = el.dataset.id;

      // Checkbox
      el.querySelector('input[type="checkbox"]').addEventListener('change', () =>
        toggleComplete(id)
      );

      // Delete
      el.querySelector('.delete-btn').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteTask(id);
      });

      // Double-click to edit
      el.querySelector('.task-text').addEventListener('dblclick', () => startEdit(id));

      // Drag events
      el.addEventListener('dragstart', (e) => handleDragStart(e, id));
      el.addEventListener('dragend', handleDragEnd);
      el.addEventListener('dragover', handleDragOver);
      el.addEventListener('dragleave', handleDragLeave);
      el.addEventListener('drop', (e) => handleDrop(e, id));
    });
  }

  // ─── Filters ────────────────────────────────────
  function getFilteredTasks() {
    if (currentFilter === 'active') return tasks.filter(t => !t.completed);
    if (currentFilter === 'completed') return tasks.filter(t => t.completed);
    return tasks;
  }

  // ─── Helpers ────────────────────────────────────
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const now = new Date();
    const diff = now - date;

    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;

    if (date.toDateString() === now.toDateString()) {
      return date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    }

    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ─── Boot ───────────────────────────────────────
  init();
})();
