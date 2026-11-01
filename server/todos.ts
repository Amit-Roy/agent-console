import crypto from "node:crypto";
import fs from "node:fs";

export interface Todo {
  id: string;
  text: string;
  done: boolean;
  by: "user" | "agent";
  createdAt: number;
  doneAt?: number;
}

export const MAX_TODOS = 100;
export const MAX_TODO_TEXT = 500;

export function cleanTodoText(text: unknown): string {
  const clean = typeof text === "string" ? text.trim() : "";
  if (!clean) throw new Error("Todo text is empty.");
  if (clean.length > MAX_TODO_TEXT)
    throw new Error(`Todo text is over ${MAX_TODO_TEXT} characters.`);
  return clean;
}

/** Per-thread checklist kept beside the transcript, never inside it. */
export class Todos {
  private lists: Record<string, Todo[]> = {};
  private file: string;
  constructor(file: string) {
    this.file = file;
    try {
      const saved = JSON.parse(fs.readFileSync(file, "utf8"));
      if (saved && typeof saved === "object" && !Array.isArray(saved)) this.lists = saved;
    } catch {
      this.lists = {};
    }
  }
  list(threadId: string): Todo[] {
    return (this.lists[threadId] ?? []).map((todo) => ({ ...todo }));
  }
  openCount(threadId: string): number {
    return (this.lists[threadId] ?? []).filter((todo) => !todo.done).length;
  }
  add(threadId: string, text: unknown, by: Todo["by"]): Todo {
    const clean = cleanTodoText(text);
    const items = this.lists[threadId] ?? [];
    if (items.length >= MAX_TODOS)
      throw new Error(`A thread holds at most ${MAX_TODOS} todos. Remove some first.`);
    const todo: Todo = {
      id: crypto.randomBytes(6).toString("base64url"),
      text: clean,
      done: false,
      by,
      createdAt: Date.now(),
    };
    this.lists[threadId] = [...items, todo];
    this.save();
    return { ...todo };
  }
  setDone(threadId: string, id: unknown, done: boolean): Todo {
    const todo = this.find(threadId, id);
    todo.done = done;
    if (done) todo.doneAt = Date.now();
    else delete todo.doneAt;
    this.save();
    return { ...todo };
  }
  remove(threadId: string, id: unknown): void {
    const todo = this.find(threadId, id);
    this.lists[threadId] = this.lists[threadId].filter((item) => item !== todo);
    if (!this.lists[threadId].length) delete this.lists[threadId];
    this.save();
  }
  dropThread(threadId: string): void {
    if (!this.lists[threadId]) return;
    delete this.lists[threadId];
    this.save();
  }
  private find(threadId: string, id: unknown): Todo {
    const todo = this.lists[threadId]?.find((item) => item.id === id);
    if (!todo) throw new Error("No such todo. Use todo_list to see current ids.");
    return todo;
  }
  private save() {
    fs.writeFileSync(this.file + ".tmp", JSON.stringify(this.lists), { mode: 0o600 });
    fs.renameSync(this.file + ".tmp", this.file);
  }
}
