// @vitest-environment jsdom

import { act } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IssueThreadInteraction } from "@paperclipai/shared";
import {
  makeClaudePermissionInteraction,
  pendingRequestConfirmationInteraction,
} from "@/fixtures/issueThreadInteractionFixtures";
import {
  CLAUDE_PERMISSION_PARKED_NOTE,
  ClaudePermissionCard,
  readClaudePermissionPayload,
} from "./ClaudePermissionCard";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function staticHtml(interaction: IssueThreadInteraction) {
  const permission = readClaudePermissionPayload(interaction)!;
  return renderToStaticMarkup(
    <ClaudePermissionCard interaction={interaction} permission={permission} onAllow={() => {}} onDeny={() => {}} />,
  );
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function mount(interaction: IssueThreadInteraction, props: { onAllow?: (r: boolean) => void; onDeny?: () => void }) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const permission = readClaudePermissionPayload(interaction)!;
  act(() => {
    root?.render(<ClaudePermissionCard interaction={interaction} permission={permission} {...props} />);
  });
  return container;
}

function button(host: HTMLElement, label: string) {
  return Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label) ?? null;
}

describe("readClaudePermissionPayload", () => {
  it("returns null for interactions without a claudePermission block", () => {
    expect(readClaudePermissionPayload(pendingRequestConfirmationInteraction)).toBeNull();
  });

  it("tolerates missing fields", () => {
    const interaction = makeClaudePermissionInteraction();
    (interaction.payload as unknown as { claudePermission: unknown }).claudePermission = {};
    const parsed = readClaudePermissionPayload(interaction);
    expect(parsed).toMatchObject({ toolName: null, inputPreview: "", options: [], alwaysAvailable: false, parkedAt: null });
  });
});

describe("ClaudePermissionCard", () => {
  it("renders title, caption, label, preview, and Allow once / Deny without Always allow", () => {
    const html = staticHtml(makeClaudePermissionInteraction());
    expect(html).toContain("Claude Code wants to use");
    expect(html).toContain("Bash");
    expect(html).toContain("Matched a permission rule that asks first");
    expect(html).toContain("Claude Code permission");
    expect(html).toContain("git push origin main\n--force-with-lease");
    expect(html).toContain("Allow once");
    expect(html).toContain("Deny");
    expect(html).not.toContain("Always allow");
    expect(html).not.toContain(CLAUDE_PERMISSION_PARKED_NOTE);
  });

  it("falls back to the title when there is no tool name", () => {
    const html = staticHtml(makeClaudePermissionInteraction({ toolName: null }));
    expect(html).toContain("git push origin main</span>");
  });

  it("shows Always allow only when alwaysAvailable", () => {
    expect(staticHtml(makeClaudePermissionInteraction({ alwaysAvailable: true }))).toContain("Always allow");
  });

  it("shows the parked note while pending", () => {
    const html = staticHtml(makeClaudePermissionInteraction({ parkedAt: "2026-09-27T10:00:00.000Z" }));
    expect(html).toContain(CLAUDE_PERMISSION_PARKED_NOTE);
  });

  it("answers with rememberAction for each button", async () => {
    const onAllow = vi.fn();
    const onDeny = vi.fn();
    const host = mount(makeClaudePermissionInteraction({ alwaysAvailable: true }), { onAllow, onDeny });
    await act(async () => button(host, "Allow once")?.click());
    expect(onAllow).toHaveBeenLastCalledWith(false);
    await act(async () => button(host, "Always allow")?.click());
    expect(onAllow).toHaveBeenLastCalledWith(true);
    await act(async () => button(host, "Deny")?.click());
    expect(onDeny).toHaveBeenCalledTimes(1);
  });

  it("shows an inline error when the answer fails", async () => {
    const host = mount(makeClaudePermissionInteraction(), {
      onAllow: () => {
        throw new Error("Only a person can answer this.");
      },
    });
    await act(async () => button(host, "Allow once")?.click());
    expect(host.textContent).toContain("Only a person can answer this.");
  });

  it("renders resolved outcomes read-only", () => {
    const accepted = staticHtml(makeClaudePermissionInteraction({}, { status: "accepted" }));
    expect(accepted).toContain("Allowed once");
    expect(accepted).not.toContain("Deny");

    const consumed = staticHtml(
      makeClaudePermissionInteraction({ consumedAt: "2026-09-27T10:05:00.000Z" }, { status: "accepted" }),
    );
    expect(consumed).toContain("used on the agent&#x27;s retry");

    const rejected = staticHtml(
      makeClaudePermissionInteraction(
        { parkedAt: "2026-09-27T10:00:00.000Z" },
        { status: "rejected", result: { version: 1, outcome: "rejected", reason: "Not on main" } },
      ),
    );
    expect(rejected).toContain("Denied");
    expect(rejected).toContain("Not on main");
    expect(rejected).not.toContain("Allow once");
    expect(rejected).not.toContain(CLAUDE_PERMISSION_PARKED_NOTE);
  });
});
