import { ShieldCheck, SquareTerminal } from "lucide-react";
import type { ClaudeCapabilityOrigin, ClaudeCliMcpOrigin } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

/**
 * Every origin a Claude capability can have: the inventory origins plus the
 * CLI-reported ones (for example `claude_ai` connectors from `claude mcp list`).
 */
export type OriginBadgeOrigin = ClaudeCapabilityOrigin | ClaudeCliMcpOrigin;

const ORIGIN_LABELS: Record<OriginBadgeOrigin, string> = {
  paperclip: "Paperclip · governed",
  claude_home: "Claude Code",
  plugin: "Claude Code · plugin",
  project: "Claude Code · project",
  claude_ai: "Claude Code · claude.ai",
};

export function originLabel(origin: OriginBadgeOrigin): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

function originTitle(origin: OriginBadgeOrigin): string {
  if (origin === "paperclip") return "Runs through the Paperclip gateway with approvals and audit.";
  if (origin === "claude_ai") {
    return "A claude.ai connector used natively by Claude Code. It is not governed by Paperclip approvals.";
  }
  return "Runs natively in Claude Code and is not governed by Paperclip approvals.";
}

/** Marks where a Claude capability comes from: Paperclip's gateway or native Claude Code. */
export function OriginBadge({ origin }: { origin: OriginBadgeOrigin }) {
  const governed = origin === "paperclip";
  return (
    <Badge
      variant={governed ? "secondary" : "outline"}
      title={originTitle(origin)}
      data-origin={origin}
    >
      {governed ? <ShieldCheck aria-hidden /> : <SquareTerminal aria-hidden />}
      {originLabel(origin)}
    </Badge>
  );
}
