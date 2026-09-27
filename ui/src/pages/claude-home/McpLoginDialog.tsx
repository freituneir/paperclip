import { useEffect, useRef, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { ExternalLink, Loader2 } from "lucide-react";
import type { ClaudeCliLoginStartResponse, ClaudeCliMcpServer } from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { InlineError } from "./shared";

/**
 * The terminal's no-browser OAuth flow (`claude mcp login <name> --no-browser`):
 * the server starts a login session and hands back the auth URL; the operator
 * signs in in their own browser and pastes the URL it ended on, which the
 * server feeds to the waiting CLI. Closing without finishing cancels the session.
 */
export function McpLoginDialog({
  companyId,
  serverName,
  onClose,
  onSignedIn,
}: {
  companyId: string;
  /** The server to sign in to; null keeps the dialog closed. */
  serverName: string | null;
  onClose: () => void;
  onSignedIn: (servers: ClaudeCliMcpServer[]) => void;
}) {
  const [session, setSession] = useState<ClaudeCliLoginStartResponse | null>(null);
  const [redirectUrl, setRedirectUrl] = useState("");
  const sessionRef = useRef<ClaudeCliLoginStartResponse | null>(null);

  const start = useMutation({
    mutationFn: (name: string) => claudeHomeApi.startMcpLogin(companyId, name),
    onSuccess: (next) => {
      sessionRef.current = next;
      setSession(next);
    },
  });
  const complete = useMutation({
    mutationFn: (input: { sessionId: string; redirectUrl: string }) =>
      claudeHomeApi.completeMcpLogin(companyId, input.sessionId, input.redirectUrl),
    onSuccess: (next) => {
      sessionRef.current = null;
      onSignedIn(next.servers);
      onClose();
    },
  });

  const { mutate: startLogin, reset: resetStart } = start;
  const { reset: resetComplete } = complete;
  // Start once per opening (StrictMode re-runs effects; the CLI allows one session per server).
  const startedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!serverName) {
      startedFor.current = null;
      return;
    }
    if (startedFor.current === serverName) return;
    startedFor.current = serverName;
    sessionRef.current = null;
    setSession(null);
    setRedirectUrl("");
    resetStart();
    resetComplete();
    startLogin(serverName);
  }, [serverName, startLogin, resetStart, resetComplete]);

  const cancel = () => {
    const pending = sessionRef.current;
    sessionRef.current = null;
    if (pending) {
      // Best effort: the server also expires sessions after 10 minutes.
      void claudeHomeApi.cancelMcpLogin(companyId, pending.sessionId).catch(() => undefined);
    }
    onClose();
  };

  const trimmed = redirectUrl.trim();

  return (
    <Dialog open={serverName !== null} onOpenChange={(open) => (!open ? cancel() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Sign in to {serverName}</DialogTitle>
          <DialogDescription>
            The same sign-in as <code className="font-mono">/mcp</code> in Claude Code. The token is stored in this
            Claude Home.
          </DialogDescription>
        </DialogHeader>

        {start.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden />
            Starting sign-in…
          </p>
        ) : null}
        <InlineError error={start.error} prefix="Couldn’t start sign-in" />

        {session ? (
          <form
            className="space-y-4"
            onSubmit={(event) => {
              event.preventDefault();
              if (!trimmed || complete.isPending) return;
              complete.mutate({ sessionId: session.sessionId, redirectUrl: trimmed });
            }}
          >
            <div className="space-y-2">
              <div className="text-sm font-medium">1. Sign in with the provider</div>
              <Button asChild size="sm" variant="outline">
                <a href={session.authUrl} target="_blank" rel="noopener noreferrer" data-testid="mcp-login-auth-link">
                  <ExternalLink aria-hidden />
                  Open sign-in page
                </a>
              </Button>
            </div>
            <div className="space-y-2">
              <Label htmlFor="mcp-login-redirect" className="text-sm font-medium">
                2. Paste the URL your browser ended on
              </Label>
              <Input
                id="mcp-login-redirect"
                value={redirectUrl}
                onChange={(event) => setRedirectUrl(event.target.value)}
                placeholder="http://localhost:…/callback?code=…"
                spellCheck={false}
                autoComplete="off"
                className="font-mono text-xs"
              />
              <p className="text-xs text-muted-foreground">
                After you approve access, the browser lands on a page that may not load. Copy its full address.
              </p>
            </div>
            <InlineError error={complete.error} prefix="Sign-in didn’t finish" />
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              <Button type="submit" disabled={!trimmed || complete.isPending}>
                {complete.isPending ? "Finishing sign-in…" : "Finish sign-in"}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}
