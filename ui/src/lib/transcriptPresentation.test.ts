import { describe, expect, it } from "vitest";
import {
  describeToolInput,
  displayToolName,
  readToolCallShape,
  summarizeToolInput,
} from "./transcriptPresentation";

describe("summarizeToolInput", () => {
  it("prefers human descriptions over raw commands when both exist", () => {
    expect(
      summarizeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
      }),
    ).toBe("Inspect the issue chat thread layout classes");
  });
});

describe("describeToolInput", () => {
  it("keeps command tools description-first in the detail view", () => {
    expect(
      describeToolInput("command_execution", {
        description: "Inspect the issue chat thread layout classes",
        command: "zsh -lc 'sed -n \"1,220p\" ui/src/components/IssueChatThread.tsx'",
        cwd: "/workspace/paperclip",
      }),
    ).toEqual([
      { label: "Intent", value: "Inspect the issue chat thread layout classes", tone: "default" },
      { label: "Directory", value: "/workspace/paperclip", tone: "default" },
    ]);
  });

  it("surfaces concise structured details for file tools", () => {
    expect(
      describeToolInput("read_file", {
        path: "ui/src/lib/issue-chat-messages.ts",
      }),
    ).toEqual([
      { label: "Path", value: "ui/src/lib/issue-chat-messages.ts", tone: "default" },
    ]);
  });
});

describe("TodoWrite and subagent shapes", () => {
  const todoInput = {
    todos: [
      { content: "Read the plan", status: "completed" },
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
      { content: "Ship it", status: "pending" },
    ],
  };

  it("reads a TodoWrite plan as a checklist with progress instead of a payload summary", () => {
    const shape = readToolCallShape("TodoWrite", todoInput);
    expect(shape).toMatchObject({ kind: "todos", progress: "1/3 done · Writing tests" });
    expect(shape?.kind === "todos" ? shape.todos.map((todo) => todo.status) : null)
      .toEqual(["completed", "in_progress", "pending"]);
    expect(summarizeToolInput("TodoWrite", todoInput)).toBe("1/3 done · Writing tests");
    expect(summarizeToolInput("TodoWrite", JSON.stringify(todoInput))).toBe("1/3 done · Writing tests");
    expect(describeToolInput("TodoWrite", todoInput)).toEqual([
      { label: "Progress", value: "1/3 done · Writing tests" },
    ]);
    expect(displayToolName("TodoWrite", todoInput)).toBe("Todo list");
  });

  it("labels subagent calls with their type and description", () => {
    const input = { subagent_type: "Explore", description: "Map adapter", prompt: "Find the adapter registry" };
    expect(readToolCallShape("Task", input)).toMatchObject({
      kind: "subagent",
      label: "Subagent · Explore — Map adapter",
    });
    expect(displayToolName("Task", input)).toBe("Subagent · Explore — Map adapter");
    expect(summarizeToolInput("Agent", input)).toBe("Subagent · Explore — Map adapter");
    const details = describeToolInput("Task", input);
    expect(details.find((detail) => detail.label === "Intent")).toBeUndefined();
    expect(details).toContainEqual({ label: "Prompt", value: "Find the adapter registry", tone: "default" });
  });

  it("labels a delegation spawn by payload without a subagent type", () => {
    expect(displayToolName("Agent", { description: "Review diff" })).toBe("Subagent — Review diff");
    // A non-delegation tool with a description is not a subagent.
    expect(readToolCallShape("Bash", { description: "List files", command: "ls" })).toBeNull();
  });
});
