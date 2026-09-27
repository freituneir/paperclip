import { Circle, CircleCheck, LoaderCircle } from "lucide-react";
import { cn } from "@/lib/utils";
import type { TodoItem, TodoStatus } from "./tool-input-shapes";

const STATUS: Record<TodoStatus, { Icon: typeof Circle; tone: string; label: string }> = {
  completed: { Icon: CircleCheck, tone: "text-(--status-task-icon-done)", label: "Completed" },
  in_progress: { Icon: LoaderCircle, tone: "text-(--status-agent-running)", label: "In progress" },
  pending: { Icon: Circle, tone: "text-muted-foreground", label: "Pending" },
};

/** A TodoWrite plan rendered as a status checklist (never raw JSON). */
export function TodoChecklist({
  todos,
  className,
}: {
  todos: readonly TodoItem[];
  className?: string;
}) {
  return (
    <ul
      data-testid="todo-checklist"
      aria-label="Todo list"
      className={cn("flex min-w-0 flex-col gap-1 text-xs leading-4", className)}
    >
      {todos.map((todo, index) => {
        const { Icon, tone, label } = STATUS[todo.status];
        return (
          <li
            key={`${index}:${todo.content}`}
            data-todo-status={todo.status}
            className="flex min-w-0 items-start gap-2"
          >
            <Icon className={cn("mt-px size-3.5 shrink-0", tone)} aria-hidden="true" />
            <span className="sr-only">{label}: </span>
            <span
              className={cn(
                "min-w-0 break-words",
                todo.status === "completed"
                  ? "text-muted-foreground line-through"
                  : todo.status === "in_progress"
                    ? "font-medium text-foreground"
                    : "text-foreground",
              )}
            >
              {todo.content}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
