import { describe, expect, it } from "vitest";
import {
  parseTodoListInput,
  subagentToolLabel,
  summarizeTodoProgress,
} from "./tool-input-shapes";

const TODOS = {
  todos: [
    { content: "Read the plan", status: "completed", activeForm: "Reading the plan" },
    { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
    { content: "Ship it", status: "pending", activeForm: "Shipping it" },
  ],
};

describe("parseTodoListInput", () => {
  it("parses the TodoWrite todos shape regardless of the tool's name", () => {
    expect(parseTodoListInput(TODOS)).toEqual([
      { content: "Read the plan", status: "completed", activeForm: "Reading the plan" },
      { content: "Write tests", status: "in_progress", activeForm: "Writing tests" },
      { content: "Ship it", status: "pending", activeForm: "Shipping it" },
    ]);
  });

  it("accepts a JSON string payload and normalizes unknown statuses to pending", () => {
    expect(
      parseTodoListInput(JSON.stringify({ todos: [{ content: "A", status: "weird" }] })),
    ).toEqual([{ content: "A", status: "pending" }]);
  });

  it("returns null for inputs that are not a todo list", () => {
    expect(parseTodoListInput(null)).toBeNull();
    expect(parseTodoListInput({ command: "ls" })).toBeNull();
    expect(parseTodoListInput({ todos: "nope" })).toBeNull();
    expect(parseTodoListInput({ todos: [{ status: "pending" }] })).toBeNull();
    expect(parseTodoListInput("not json")).toBeNull();
  });
});

describe("summarizeTodoProgress", () => {
  it("counts completed todos and names the active one", () => {
    expect(summarizeTodoProgress(parseTodoListInput(TODOS)!)).toBe(
      "1/3 done · Writing tests",
    );
    expect(
      summarizeTodoProgress([{ content: "A", status: "completed" }]),
    ).toBe("1/1 done");
  });
});

describe("subagentToolLabel", () => {
  const input = {
    subagent_type: "Explore",
    description: "Map adapter",
    prompt: "Look through the adapter package and map it.",
  };

  it("labels Task/Agent spawns with subagent type and description", () => {
    expect(subagentToolLabel("Task", input)).toBe("Subagent · Explore — Map adapter");
    expect(subagentToolLabel("Agent", input)).toBe("Subagent · Explore — Map adapter");
  });

  it("keys off the input shape when an ACP title replaces the tool name", () => {
    expect(subagentToolLabel("Map adapter", input)).toBe("Subagent · Explore — Map adapter");
  });

  it("degrades gracefully with partial input", () => {
    expect(subagentToolLabel("Task", { description: "Map adapter" })).toBe("Subagent — Map adapter");
    expect(subagentToolLabel("Agent", { subagent_type: "Plan" })).toBe("Subagent · Plan");
  });

  it("returns null for non-subagent calls", () => {
    expect(subagentToolLabel("Bash", { command: "ls", description: "List files" })).toBeNull();
    expect(subagentToolLabel("Task", undefined)).toBeNull();
    expect(subagentToolLabel("TaskOutput", { description: "x" })).toBeNull();
  });
});
