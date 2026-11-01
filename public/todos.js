// Per-thread todo list in a modal dialog; the server owns the list and pushes every change.
import { $, el, icon, iconButton } from "./render.js";

const byDone = (list) => [...list.filter((t) => !t.done), ...list.filter((t) => t.done)];

function todoRow(todo, send, thread) {
  const row = el("li", todo.done ? "done" : "");
  const label = el("label");
  const box = el("input");
  box.type = "checkbox";
  box.checked = todo.done;
  box.onchange = () => send({ t: "todo_set", thread, id: todo.id, done: box.checked });
  label.append(box, el("span", "todo-text", todo.text));
  const remove = iconButton("trash", "Remove todo", "btn icon ghost");
  remove.onclick = () => send({ t: "todo_remove", thread, id: todo.id });
  row.append(label, remove);
  return row;
}

export function createTodos({ send, current }) {
  const lists = new Map();
  const render = () => {
    const list = byDone(lists.get(current()) ?? []);
    $("todo-list").replaceChildren(...list.map((todo) => todoRow(todo, send, current())));
    $("todo-empty").hidden = list.length > 0;
  };
  const dialog = $("todos");
  const form = $("todo-form");
  form.onsubmit = (event) => {
    event.preventDefault();
    const text = $("todo-input").value.trim();
    if (!text) return;
    $("todo-error").textContent = "";
    if (send({ t: "todo_add", thread: current(), text })) $("todo-input").value = "";
    else $("todo-error").textContent = "Reconnect before editing todos.";
  };
  $("todo-close").onclick = () => dialog.close();
  $("todo-toggle").onclick = () => {
    if (!current()) return;
    $("todo-error").textContent = "";
    render();
    send({ t: "todos_get", thread: current() });
    dialog.showModal();
    $("todo-input").focus();
  };
  return {
    // server pushed a list for a thread
    set(thread, todos) {
      lists.set(thread, todos);
      if (thread === current()) render();
    },
    error(thread, message) {
      if (thread === current()) $("todo-error").textContent = message;
    },
    forget(thread) {
      lists.delete(thread);
    },
    // header button state and the open-count badge
    renderBadge(thread) {
      const open = thread?.todoOpen ?? 0;
      $("todo-toggle").disabled = !thread;
      $("todo-badge").hidden = !open;
      $("todo-badge").textContent = open > 99 ? "99+" : String(open);
      $("todo-toggle").title = open ? `Todos (${open} open)` : "Todos";
      $("todo-toggle").setAttribute("aria-label", open ? `Todos, ${open} open` : "Todos");
    },
    close() {
      if (dialog.open) dialog.close();
    },
  };
}
