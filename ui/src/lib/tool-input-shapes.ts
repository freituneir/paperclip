/**
 * Provider-neutral readers for well-known tool INPUT shapes. Keyed off the
 * payload (and the shared tool taxonomy), never adapter identity, so native
 * stream-json runs and ACP runs render the same way.
 */
// The taxonomy module is pure classification (plus icon lookups); lib code
// reuses it so the dashboard and task chat classify tools identically.
import { toolActivityPresentation } from "../components/task-chat/tool-taxonomy";

export type TodoStatus = "pending" | "in_progress" | "completed";

export interface TodoItem {
  content: string;
  status: TodoStatus;
  activeForm?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.startsWith("{")) return null;
    try {
      return asRecord(JSON.parse(trimmed));
    } catch {
      return null;
    }
  }
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function todoStatus(value: unknown): TodoStatus {
  const raw = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s-]+/g, "_") : "";
  if (raw === "completed" || raw === "done" || raw === "complete") return "completed";
  if (raw === "in_progress" || raw === "active" || raw === "running") return "in_progress";
  return "pending";
}

/**
 * The TodoWrite input shape `{ todos: [{ content, status, activeForm? }] }`,
 * or null when the input is anything else.
 */
export function parseTodoListInput(input: unknown): TodoItem[] | null {
  const record = asRecord(input);
  if (!record || !Array.isArray(record.todos) || record.todos.length === 0) return null;
  const todos: TodoItem[] = [];
  for (const raw of record.todos) {
    const todo = asRecord(raw);
    const content = todo ? text(todo.content) ?? text(todo.activeForm) : undefined;
    if (!todo || !content) return null;
    const activeForm = text(todo.activeForm);
    todos.push({ content, status: todoStatus(todo.status), ...(activeForm ? { activeForm } : {}) });
  }
  return todos;
}

/** One-line progress: "1/3 done · Writing tests". */
export function summarizeTodoProgress(todos: readonly TodoItem[]): string {
  const done = todos.filter((todo) => todo.status === "completed").length;
  const active = todos.find((todo) => todo.status === "in_progress");
  const base = `${done}/${todos.length} done`;
  return active ? `${base} · ${active.activeForm ?? active.content}` : base;
}

export interface SubagentCall {
  type?: string;
  description?: string;
}

/**
 * Subagent spawn identity from a Task/Agent input. `subagent_type` alone marks
 * the shape (ACP retitles the call to its description); otherwise the tool
 * must be a delegation-family spawn carrying a description.
 */
export function parseSubagentCall(name: string | null | undefined, input: unknown): SubagentCall | null {
  const record = asRecord(input);
  if (!record) return null;
  const type = text(record.subagent_type);
  const description = text(record.description);
  if (!type && !description) return null;
  if (!type) {
    const presentation = toolActivityPresentation({ name });
    if (presentation.family !== "agent" || presentation.summaryGroup.key !== "delegation") return null;
  }
  return { ...(type ? { type } : {}), ...(description ? { description } : {}) };
}

export function formatSubagentLabel(call: SubagentCall): string {
  const head = call.type ? `Subagent · ${call.type}` : "Subagent";
  return call.description ? `${head} — ${call.description}` : head;
}

/** "Subagent · Explore — Map adapter", or null for non-subagent calls. */
export function subagentToolLabel(name: string | null | undefined, input: unknown): string | null {
  const call = parseSubagentCall(name, input);
  return call ? formatSubagentLabel(call) : null;
}
