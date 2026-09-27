// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ClaudeLocalAdvancedFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";
import { defaultCreateValues } from "../../components/agent-config-defaults";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];

function render(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "claude_local",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark: vi.fn(),
    models: [],
    ...overrides,
  };
  act(() => {
    root.render(
      <TooltipProvider>
        <ClaudeLocalAdvancedFields {...props} />
      </TooltipProvider>,
    );
  });
  return { container, props };
}

function labels(container: HTMLElement) {
  return Array.from(container.querySelectorAll("label, span")).map((el) => el.textContent?.trim() ?? "");
}

function fieldControl<T extends Element>(container: HTMLElement, label: string, selector: string): T {
  const labelEl = Array.from(container.querySelectorAll("label")).find(
    (el) => el.textContent?.trim() === label,
  );
  if (!labelEl) throw new Error(`No field labelled ${label}`);
  const control = labelEl.parentElement!.parentElement!.querySelector<T>(selector as never);
  if (!control) throw new Error(`No ${selector} for ${label}`);
  return control as T;
}

function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  const proto = Object.getPrototypeOf(el);
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.innerHTML = "";
});

describe("Claude Code config fields", () => {
  it("groups the native Claude Code options under a heading in the configuration section", () => {
    const { container } = render({ section: "configuration" });

    const group = container.querySelector('[data-testid="claude-code-fields"]');
    expect(group?.querySelector("h4")?.textContent).toBe("Claude Code");
    const text = labels(container);
    for (const label of [
      "Claude Home",
      "Native MCP servers",
      "Permission mode",
      "Fallback model",
      "Allowed tools",
      "Disallowed tools",
      "Settings overlay JSON",
    ]) {
      expect(text).toContain(label);
    }
    expect(container.textContent).toContain(
      "MCP servers configured in Claude Home run natively and are not governed by Paperclip approvals.",
    );
    expect(container.textContent).toContain("Company: shares one persistent Claude Code config");

    const permission = fieldControl<HTMLSelectElement>(container, "Permission mode", "select");
    expect(permission.options[0]?.textContent).toBe("Paperclip default");
    expect(permission.options[0]?.value).toBe("");

    const advanced = render({ section: "advanced" });
    expect(advanced.container.querySelector('[data-testid="claude-code-fields"]')).toBeNull();
  });

  it("reads stored values in edit mode", () => {
    const { container } = render({
      config: {
        claudeHome: "isolated",
        nativeMcp: "disabled",
        claudePermissionMode: "plan",
        allowedTools: ["Read", "Edit"],
        settingsOverlay: { env: { FOO: "1" } },
      },
    });

    expect(fieldControl<HTMLSelectElement>(container, "Claude Home", "select").value).toBe("isolated");
    expect(fieldControl<HTMLSelectElement>(container, "Permission mode", "select").value).toBe("plan");
    expect(fieldControl<HTMLInputElement>(container, "Allowed tools", "input").value).toBe("Read, Edit");
    expect(JSON.parse(fieldControl<HTMLTextAreaElement>(container, "Settings overlay JSON", "textarea").value)).toEqual({
      env: { FOO: "1" },
    });
    const toggle = container.querySelector('[data-testid="claude-code-fields"] [role="switch"]');
    expect(toggle?.getAttribute("aria-checked")).toBe("false");
  });

  it("marks parsed values in edit mode and keeps invalid overlay JSON local", () => {
    const mark = vi.fn();
    const { container } = render({ mark });

    const tools = fieldControl<HTMLInputElement>(container, "Disallowed tools", "input");
    act(() => {
      setNativeValue(tools, " WebFetch , Bash ");
      tools.dispatchEvent(new Event("input", { bubbles: true }));
    });
    act(() => {
      tools.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "disallowedTools", ["WebFetch", "Bash"]);

    const home = fieldControl<HTMLSelectElement>(container, "Claude Home", "select");
    act(() => {
      setNativeValue(home, "isolated");
      home.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "claudeHome", "isolated");

    const overlay = fieldControl<HTMLTextAreaElement>(container, "Settings overlay JSON", "textarea");
    mark.mockClear();
    act(() => {
      setNativeValue(overlay, "{ nope");
      overlay.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mark).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();

    act(() => {
      setNativeValue(overlay, '{"model":"x"}');
      overlay.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "settingsOverlay", { model: "x" });
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("writes raw create values", () => {
    const set = vi.fn();
    const { container } = render({
      mode: "create",
      isCreate: true,
      values: { ...defaultCreateValues },
      set,
    });

    const permission = fieldControl<HTMLSelectElement>(container, "Permission mode", "select");
    act(() => {
      setNativeValue(permission, "acceptEdits");
      permission.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(set).toHaveBeenCalledWith({ claudePermissionMode: "acceptEdits" });

    const overlay = fieldControl<HTMLTextAreaElement>(container, "Settings overlay JSON", "textarea");
    act(() => {
      setNativeValue(overlay, "{}");
      overlay.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(set).toHaveBeenCalledWith({ claudeSettingsOverlayJson: "{}" });
  });
});
