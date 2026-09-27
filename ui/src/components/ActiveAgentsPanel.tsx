import { memo, useCallback, useMemo, type CSSProperties } from "react";
import { Link } from "@/lib/router";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueThreadInteraction } from "@paperclipai/shared";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import type { TranscriptEntry } from "../adapters";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { cn, relativeTime } from "../lib/utils";
import { Clock3 } from "lucide-react";
import { Identity } from "./Identity";
import { StatusGlyph } from "./StatusGlyph";
import { RunChatSurface } from "./RunChatSurface";
import {
  ClaudePermissionCard,
  readClaudePermissionPayload,
  type ClaudePermissionPayload,
} from "./claude/ClaudePermissionCard";
import { useLiveRunTranscripts } from "./transcript/useLiveRunTranscripts";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";

const MIN_DASHBOARD_RUNS = 4;
const DASHBOARD_RUN_CARD_LIMIT = 4;
// When grouping by agent, pad with enough history that each agent's latest run is
// likely included even if one busy agent produced most of the recent runs.
const GROUPED_MIN_RUNS = 50;
const DASHBOARD_LOG_POLL_INTERVAL_MS = 15_000;
const DASHBOARD_LOG_READ_LIMIT_BYTES = 64_000;
const DASHBOARD_MAX_CHUNKS_PER_RUN = 40;
// Permission cards the Claude bridge creates do not emit a live event, so a
// live run's task interactions are re-read at the transcript poll cadence.
const DASHBOARD_INTERACTION_POLL_INTERVAL_MS = DASHBOARD_LOG_POLL_INTERVAL_MS;
const EMPTY_TRANSCRIPT: TranscriptEntry[] = [];
const WAITING_CHIP_STYLE = { "--sc": "var(--status-agent-paused)" } as CSSProperties;
const EMPTY_RUNS: LiveRunForIssue[] = [];

const runStatusLabels: Record<string, string> = {
  running: "Running",
  queued: "Queued",
  succeeded: "Succeeded",
  failed: "Failed",
  timed_out: "Timed out",
  cancelled: "Cancelled",
  interrupted: "Interrupted",
};

interface ActiveAgentsPanelProps {
  companyId: string;
  title?: string;
  minRunCount?: number;
  fetchLimit?: number;
  cardLimit?: number;
  gridClassName?: string;
  cardClassName?: string;
  emptyMessage?: string;
  queryScope?: string;
  showMoreLink?: boolean;
  showTranscripts?: boolean;
  /** Show one card per agent (its live run, else its most recent run) instead of one card per run. */
  groupByAgent?: boolean;
}

/**
 * Keeps the first run seen for each agent. The live-runs endpoint returns
 * queued/running runs first, then finished runs, each newest-first — so the
 * first run per agent is its live run if it has one, otherwise its latest run.
 */
export function latestRunPerAgent(runs: LiveRunForIssue[]): LiveRunForIssue[] {
  const seen = new Set<string>();
  return runs.filter((run) => {
    if (seen.has(run.agentId)) return false;
    seen.add(run.agentId);
    return true;
  });
}

function isLiveRun(run: Pick<LiveRunForIssue, "status">): boolean {
  return run.status === "queued" || run.status === "running";
}

export interface PendingClaudePermission {
  interaction: IssueThreadInteraction;
  permission: ClaudePermissionPayload;
}

/**
 * The first PENDING Claude Code permission card on a task that belongs to the
 * given agent (cards without an agent id are attributed to the task's run).
 */
export function findPendingClaudePermission(
  interactions: readonly IssueThreadInteraction[] | undefined,
  agentId: string,
): PendingClaudePermission | null {
  for (const interaction of interactions ?? []) {
    if (interaction.status !== "pending") continue;
    const permission = readClaudePermissionPayload(interaction);
    if (!permission) continue;
    if (permission.agentId && permission.agentId !== agentId) continue;
    return { interaction, permission };
  }
  return null;
}

/**
 * Reads the live run's task interactions (same query key + API as the task
 * chat, so answers and live-event invalidations are shared) and exposes the
 * pending Claude permission card with task-chat accept/reject semantics.
 */
function usePendingClaudePermission(run: LiveRunForIssue) {
  const queryClient = useQueryClient();
  const issueId = run.issueId ?? null;
  const enabled = Boolean(issueId) && isLiveRun(run);
  const { data: interactions } = useQuery({
    queryKey: queryKeys.issues.interactions(issueId ?? "__none__"),
    queryFn: () => issuesApi.listInteractions(issueId!),
    enabled,
    refetchInterval: enabled ? DASHBOARD_INTERACTION_POLL_INTERVAL_MS : false,
    retry: false,
  });
  const pending = enabled ? findPendingClaudePermission(interactions, run.agentId) : null;

  const settle = useCallback(
    (updated: IssueThreadInteraction) => {
      if (!issueId) return;
      queryClient.setQueryData<IssueThreadInteraction[] | undefined>(
        queryKeys.issues.interactions(issueId),
        (current) => current?.map((entry) => (entry.id === updated.id ? updated : entry)),
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.interactions(issueId) });
    },
    [issueId, queryClient],
  );
  const interactionId = pending?.interaction.id ?? null;
  const allow = useCallback(
    async (rememberAction: boolean) => {
      if (!issueId || !interactionId) return;
      settle(await issuesApi.acceptInteraction(issueId, interactionId, { rememberAction }));
    },
    [interactionId, issueId, settle],
  );
  const deny = useCallback(async () => {
    if (!issueId || !interactionId) return;
    settle(await issuesApi.rejectInteraction(issueId, interactionId));
  }, [interactionId, issueId, settle]);

  return { pending, allow, deny };
}

export function ActiveAgentsPanel({
  companyId,
  title = "Agents",
  minRunCount = MIN_DASHBOARD_RUNS,
  fetchLimit,
  cardLimit = DASHBOARD_RUN_CARD_LIMIT,
  gridClassName,
  cardClassName,
  emptyMessage = "No recent agent runs.",
  queryScope = "dashboard",
  showMoreLink = true,
  showTranscripts = false,
  groupByAgent = false,
}: ActiveAgentsPanelProps) {
  const effectiveMinRunCount = groupByAgent ? Math.max(minRunCount, GROUPED_MIN_RUNS) : minRunCount;
  const liveRunsQueryKey = [...queryKeys.liveRuns(companyId), queryScope, { minRunCount: effectiveMinRunCount, fetchLimit }] as const;
  const sharedLiveRuns = useSharedPollingQuery({
    companyId,
    resourceKey: `live-runs:${queryScope}:${effectiveMinRunCount}:${fetchLimit ?? "default"}`,
    queryKey: liveRunsQueryKey,
    enabled: !!companyId,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { minCount: effectiveMinRunCount, limit: fetchLimit }),
    enabled: sharedLiveRuns.enabled,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);

  const runs = useMemo(
    () => (groupByAgent ? latestRunPerAgent(liveRuns ?? EMPTY_RUNS) : liveRuns ?? EMPTY_RUNS),
    [groupByAgent, liveRuns],
  );
  const visibleRuns = useMemo(() => runs.slice(0, cardLimit), [cardLimit, runs]);
  const hiddenRunCount = Math.max(0, runs.length - visibleRuns.length);
  const visibleIssueIds = useMemo(
    () => [...new Set(visibleRuns.map((run) => run.issueId).filter((issueId): issueId is string => Boolean(issueId)))],
    [visibleRuns],
  );

  const issueQueries = useQueries({
    queries: visibleIssueIds.map((issueId) => ({
      queryKey: queryKeys.issues.detail(issueId),
      queryFn: () => issuesApi.get(issueId),
      staleTime: 30_000,
      retry: false,
    })),
  });

  const issueById = useMemo(() => {
    const map = new Map<string, Issue>();
    for (const query of issueQueries) {
      const issue = query.data;
      if (issue) map.set(issue.id, issue);
    }
    return map;
  }, [issueQueries]);

  const { transcriptByRun, hasOutputForRun } = useLiveRunTranscripts({
    runs: showTranscripts ? visibleRuns : EMPTY_RUNS,
    companyId,
    maxChunksPerRun: DASHBOARD_MAX_CHUNKS_PER_RUN,
    logPollIntervalMs: DASHBOARD_LOG_POLL_INTERVAL_MS,
    logReadLimitBytes: DASHBOARD_LOG_READ_LIMIT_BYTES,
    enableRealtimeUpdates: false,
  });

  return (
    <div>
      <h3 className="mb-3 text-sm font-semibold uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {runs.length === 0 ? (
        <div className="rounded-xl border border-border p-4">
          <p className="text-sm text-muted-foreground">{emptyMessage}</p>
        </div>
      ) : (
        <div className={cn("grid grid-cols-1 items-start gap-2 sm:grid-cols-2 sm:gap-4 xl:grid-cols-4", gridClassName)}>
          {visibleRuns.map((run) => (
            <AgentRunCard
              key={run.id}
              companyId={companyId}
              run={run}
              issue={run.issueId ? issueById.get(run.issueId) : undefined}
              transcript={transcriptByRun.get(run.id) ?? EMPTY_TRANSCRIPT}
              hasOutput={hasOutputForRun(run.id)}
              showTranscript={showTranscripts}
              issueLoadFailed={issueQueries.some((query, index) => visibleIssueIds[index] === run.issueId && query.isError)}
              className={cardClassName}
            />
          ))}
        </div>
      )}
      {showMoreLink && runs.length > 0 && (
        <div className="mt-3 flex justify-end text-xs text-muted-foreground">
          <Link to="/dashboard/live" className="hover:text-foreground hover:underline">
            {hiddenRunCount > 0
              ? groupByAgent
                ? `${hiddenRunCount} more agent${hiddenRunCount === 1 ? "" : "s"}`
                : `${hiddenRunCount} more active/recent run${hiddenRunCount === 1 ? "" : "s"}`
              : "View all runs"}
          </Link>
        </div>
      )}
    </div>
  );
}

export const AgentRunCard = memo(function AgentRunCard({
  companyId,
  run,
  issue,
  transcript = EMPTY_TRANSCRIPT,
  hasOutput = false,
  showTranscript = false,
  issueLoadFailed = false,
  className,
}: {
  companyId: string;
  run: LiveRunForIssue;
  issue?: Pick<Issue, "identifier" | "title" | "status">;
  transcript?: TranscriptEntry[];
  hasOutput?: boolean;
  showTranscript?: boolean;
  issueLoadFailed?: boolean;
  className?: string;
}) {
  const statusLabel = runStatusLabels[run.status] ?? run.status.replace(/[_-]/g, " ");
  const runUrl = `/agents/${run.agentId}/runs/${run.id}`;
  const timestamp = run.finishedAt
    ? `Finished ${relativeTime(run.finishedAt)}`
    : run.startedAt ? `Started ${relativeTime(run.startedAt)}` : `Queued ${relativeTime(run.createdAt)}`;
  const taskTitle = issue?.title ?? (issueLoadFailed ? "Task unavailable" : "Loading task…");
  const { pending: pendingPermission, allow, deny } = usePendingClaudePermission(run);
  const waitingForYou = pendingPermission !== null;

  return (
    <div className={cn(
      "dashboard-agent-card flex min-w-0 flex-col overflow-hidden rounded-xl border",
      showTranscript && !waitingForYou && "h-(--sz-320px)",
      waitingForYou
        ? "border-(--status-agent-paused) bg-background shadow-(--shadow-extract-1)"
        : run.status === "running"
          ? "border-(--dashboard-run-border) bg-(--dashboard-run-background) shadow-(--shadow-extract-1)"
          : "border-border bg-background/70",
      className,
    )} data-run-status={run.status} data-waiting-for-you={waitingForYou ? "true" : undefined}>
      <div className={cn("flex shrink-0 flex-col gap-3 p-3", showTranscript && "border-b border-border/60")}>
        <div className="flex min-w-0 items-center gap-2">
          <Link
            to={runUrl}
            title={`${run.agentName} — ${statusLabel} · ${timestamp}`}
            aria-label={`${run.agentName} — ${statusLabel}. View run`}
            className="flex min-w-0 items-center gap-2 rounded-md text-foreground hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            <Identity name={run.agentName} className="gap-2 font-medium" />
          </Link>
          {waitingForYou ? (
            <span
              className="status-chip ml-auto inline-flex shrink-0 items-center rounded-full border px-2.5 py-0.5 text-xs font-medium whitespace-nowrap"
              style={WAITING_CHIP_STYLE}
              data-testid="agent-card-waiting-for-you"
            >
              Waiting for you
            </span>
          ) : null}
        </div>

        {run.issueId ? (
          <Link
            to={`/issues/${issue?.identifier ?? run.issueId}`}
            className="min-w-0 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-sm text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            title={issue ? `${issue.title} · ${issue.identifier}` : taskTitle}
          >
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="flex min-w-0 flex-1 items-baseline gap-1.5">
                <StatusGlyph
                  status={issue?.status ?? "backlog"}
                  size="md"
                  className="self-center"
                  title={issue ? `Task ${issue.status.replace(/_/g, " ")}` : undefined}
                />
                <span className="truncate">{taskTitle}</span>
              </span>
              <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">{issue?.identifier ?? run.issueId.slice(0, 8)}</span>
            </span>
          </Link>
        ) : (
          <Link to={runUrl} className="flex items-center gap-1.5 rounded-lg border border-border/60 bg-background/60 px-2.5 py-2 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
            <Clock3 className="size-4 shrink-0" aria-hidden />
            <span className="truncate">{run.invocationSource === "timer" ? "Scheduled heartbeat" : "No linked task"}</span>
          </Link>
        )}
        <time
          dateTime={run.finishedAt ?? run.startedAt ?? run.createdAt}
          className="text-right font-sans text-xs text-muted-foreground/70"
        >
          {timestamp}
        </time>
      </div>

      {pendingPermission ? (
        <div
          className={cn("shrink-0 p-3", showTranscript && "border-b border-border/60")}
          role="region"
          aria-label={`${run.agentName} is waiting for your permission`}
        >
          <ClaudePermissionCard
            interaction={pendingPermission.interaction}
            permission={pendingPermission.permission}
            onAllow={allow}
            onDeny={deny}
          />
        </div>
      ) : null}

      {showTranscript && (
        <div className={cn("min-h-0 flex-1 overflow-y-auto p-3", waitingForYou && "max-h-(--sz-320px)")}>
          <RunChatSurface
            run={run}
            transcript={transcript}
            hasOutput={hasOutput}
            companyId={companyId}
          />
        </div>
      )}
    </div>
  );
});
