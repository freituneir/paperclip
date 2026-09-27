import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { OriginBadge, originLabel } from "./OriginBadge";

describe("OriginBadge", () => {
  it("labels each origin so native and governed capabilities are distinguishable", () => {
    expect(originLabel("paperclip")).toBe("Paperclip · governed");
    expect(originLabel("claude_home")).toBe("Claude Code");
    expect(originLabel("plugin")).toBe("Claude Code · plugin");
    expect(originLabel("project")).toBe("Claude Code · project");
    expect(originLabel("claude_ai")).toBe("Claude Code · claude.ai");
  });

  it("marks claude.ai connectors as native, not governed", () => {
    const html = renderToStaticMarkup(<OriginBadge origin="claude_ai" />);
    expect(html).toContain("Claude Code · claude.ai");
    expect(html).toContain("not governed by Paperclip approvals");
    expect(html).toContain('data-origin="claude_ai"');
  });

  it("explains in the title that native capabilities skip Paperclip approvals", () => {
    const html = renderToStaticMarkup(<OriginBadge origin="claude_home" />);
    expect(html).toContain("Claude Code");
    expect(html).toContain("not governed by Paperclip approvals");
    expect(html).toContain('data-origin="claude_home"');
  });

  it("marks Paperclip capabilities as governed", () => {
    const html = renderToStaticMarkup(<OriginBadge origin="paperclip" />);
    expect(html).toContain("Paperclip · governed");
    expect(html).toContain("approvals and audit");
  });
});
