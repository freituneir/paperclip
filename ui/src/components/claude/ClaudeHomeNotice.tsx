import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { claudeHomeApi } from "@/api/claudeHome";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/**
 * Apps page notice: native Claude Code MCP servers live in the company Claude
 * Home and bypass Paperclip approvals. Renders nothing when there are none, and
 * nothing when the inventory can't be read (for example without board access),
 * so it never breaks the page it sits on.
 */
export function ClaudeHomeNotice({ companyId }: { companyId: string }) {
  const inventoryQuery = useQuery({
    queryKey: queryKeys.claudeHome(companyId),
    queryFn: () => claudeHomeApi.get(companyId),
    retry: false,
  });
  const count = inventoryQuery.data?.mcpServers.length ?? 0;
  if (inventoryQuery.isError || count === 0) return null;

  return (
    <div
      className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-card px-4 py-3 text-sm"
      data-testid="claude-home-notice"
    >
      <SquareTerminal className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden />
      <p className="min-w-0 flex-1 text-muted-foreground">
        {count} MCP {count === 1 ? "server is" : "servers are"} also configured natively in Claude Code. They run
        outside Paperclip approvals.
      </p>
      <Link to="/claude-home" className="text-sm font-medium text-primary hover:underline">
        Open Claude Home
      </Link>
    </div>
  );
}
