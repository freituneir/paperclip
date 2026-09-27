import { useQuery } from "@tanstack/react-query";
import { SquareTerminal } from "lucide-react";
import { claudeHomeApi } from "@/api/claudeHome";
import { queryKeys } from "@/lib/queryKeys";
import { Link } from "@/lib/router";

/**
 * Apps page notice: native Claude Code MCP servers live in the company Claude
 * Home and bypass Paperclip approvals. Counts what `claude mcp list` reports
 * (plugin servers and claude.ai connectors included) and falls back to the
 * file-based inventory when the CLI isn't available. Renders nothing when there
 * are none, and nothing when neither can be read (for example without board
 * access), so it never breaks the page it sits on.
 */
export function ClaudeHomeNotice({ companyId }: { companyId: string }) {
  const mcpQuery = useQuery({
    queryKey: queryKeys.claudeCli.mcp(companyId),
    queryFn: () => claudeHomeApi.listMcp(companyId),
    retry: false,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
  });
  const useCli = mcpQuery.isSuccess && mcpQuery.data.cliAvailable !== false;
  const inventoryQuery = useQuery({
    queryKey: queryKeys.claudeHome(companyId),
    queryFn: () => claudeHomeApi.get(companyId),
    retry: false,
    enabled: mcpQuery.isError || (mcpQuery.isSuccess && !useCli),
  });

  const count = useCli
    ? mcpQuery.data?.servers.length ?? 0
    : inventoryQuery.isError
      ? 0
      : inventoryQuery.data?.mcpServers.length ?? 0;
  if (count === 0) return null;

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
