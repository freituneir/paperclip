// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { JsonDraftValidityContext, JsonObjectConfigField } from "./runtime-json-fields";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

function typeInto(el: HTMLTextAreaElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!.call(el, value);
  el.dispatchEvent(new Event("input", { bubbles: true }));
}

function render(report: (key: string, invalid: boolean) => void, isCreate = false) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const mark = vi.fn();
  act(() => {
    root.render(
      <TooltipProvider>
        <JsonDraftValidityContext.Provider value={report}>
          <JsonObjectConfigField
            isCreate={isCreate}
            values={isCreate ? ({ claudeSettingsOverlayJson: "" } as never) : null}
            set={isCreate ? vi.fn() : null}
            config={{ settingsOverlay: { model: "a" } }}
            mark={mark}
            label="Settings overlay JSON"
            createKey="claudeSettingsOverlayJson"
            configKey="settingsOverlay"
          />
        </JsonDraftValidityContext.Provider>
      </TooltipProvider>,
    );
  });
  return { container, root, mark };
}

describe("JsonObjectConfigField validity reporting", () => {
  it("reports an invalid edit draft to the form and clears it only when valid again (unmounting keeps Save blocked)", () => {
    const report = vi.fn();
    const { container, root, mark } = render(report);
    const textarea = container.querySelector("textarea")!;

    act(() => typeInto(textarea, "{ nope"));
    expect(report).toHaveBeenLastCalledWith("settingsOverlay", true);
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(mark).not.toHaveBeenCalled();

    act(() => typeInto(textarea, '{"model":"b"}'));
    expect(report).toHaveBeenLastCalledWith("settingsOverlay", false);
    expect(mark).toHaveBeenLastCalledWith("adapterConfig", "settingsOverlay", { model: "b" });

    act(() => typeInto(textarea, "[1]"));
    expect(report).toHaveBeenLastCalledWith("settingsOverlay", true);

    // Collapsing the section must not unblock Save with a stale value.
    act(() => root.unmount());
    roots.splice(roots.indexOf(root), 1);
    expect(report).toHaveBeenLastCalledWith("settingsOverlay", true);
  });

  it("does not report create-mode drafts (they are validated on submit)", () => {
    const report = vi.fn();
    render(report, true);
    expect(report).not.toHaveBeenCalledWith("settingsOverlay", true);
  });
});
