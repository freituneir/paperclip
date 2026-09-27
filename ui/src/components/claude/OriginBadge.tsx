import { ShieldCheck, SquareTerminal } from "lucide-react";
import type { ClaudeCapabilityOrigin } from "@paperclipai/shared";
import { Badge } from "@/components/ui/badge";

const ORIGIN_LABELS: Record<ClaudeCapabilityOrigin, string> = {
  paperclip: "Paperclip · governed",
  claude_home: "Claude Code",
  plugin: "Claude Code · plugin",
  project: "Claude Code · project",
};

export function originLabel(origin: ClaudeCapabilityOrigin): string {
  return ORIGIN_LABELS[origin] ?? origin;
}

function originTitle(origin: ClaudeCapabilityOrigin): string {
  return origin === "paperclip"
    ? "Runs through the Paperclip gateway with approvals and audit."
    : "Runs natively in Claude Code and is not governed by Paperclip approvals.";
}

/** Marks where a Claude capability comes from: Paperclip's gateway or native Claude Code. */
export function OriginBadge({ origin }: { origin: ClaudeCapabilityOrigin }) {
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
