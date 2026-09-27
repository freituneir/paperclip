import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskChatToolCard } from "./TaskChatToolCard";

describe("TaskChatToolCard", () => {
  it("renders TodoWrite todos as a status checklist", () => {
    const html = renderToStaticMarkup(
      <TaskChatToolCard
        item={{
          id: "todo",
          kind: "tool",
          name: "Todo write",
          rawName: "TodoWrite",
          status: "completed",
          target: "1/3 done · Writing tests",
          todos: [
            { content: "Read the plan", status: "completed" },
            { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
            { content: "Ship it", status: "pending" },
          ],
        }}
      />,
    );
    expect(html).toContain('data-testid="todo-checklist"');
    expect(html).toContain('data-todo-status="completed"');
    expect(html).toContain('data-todo-status="in_progress"');
    expect(html).toContain('data-todo-status="pending"');
    expect(html).toContain("Ship it");
  });
});
