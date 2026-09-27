import { useEffect, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { KeyRound, Loader2, ShieldCheck } from "lucide-react";
import type { McpJsonImportDraft } from "@paperclipai/shared";
import { toolsApi } from "@/api/tools";
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
import { useNavigate } from "@/lib/router";
import {
  adoptImportJson,
  hasRedactedSecrets,
  knownHeaderCredentialValues,
} from "./mcp-server-form";

export interface AdoptTarget {
  name: string;
  config: Record<string, unknown>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

function draftUrl(draft: McpJsonImportDraft): string | null {
  const raw = draft.config?.url;
  if (typeof raw !== "string") return null;
  try {
    const parsed = new URL(raw.trim());
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

/**
 * "Adopt into Paperclip": the same flow as Apps → Advanced setup → Paste a
 * config. The native entry is previewed through `POST /tools/mcp/import-json`,
 * then connected as a governed Paperclip connection via `tools/apps/connect`,
 * and the operator finishes permissions (or sign-in) on the connection page.
 */
export function AdoptMcpServerDialog({
  companyId,
  target,
  onClose,
}: {
  companyId: string;
  target: AdoptTarget | null;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const [connectionName, setConnectionName] = useState("");
  const [credentialValues, setCredentialValues] = useState<Record<string, string>>({});

  const previewMutation = useMutation({
    mutationFn: (value: AdoptTarget) =>
      toolsApi.importMcpJson(companyId, { mcpJson: adoptImportJson(value.name, value.config) }),
  });
  const connectMutation = useMutation({
    mutationFn: (input: { draft: McpJsonImportDraft; link: string }) => {
      const values: Record<string, string> = {};
      for (const field of input.draft.credentialFields) {
        const value = credentialValues[field.configPath]?.trim();
        if (value) values[field.configPath] = value;
      }
      return toolsApi.connectApp(companyId, {
        link: input.link,
        name: connectionName.trim() || input.draft.name,
        credentialValues: values,
      });
    },
    onSuccess: (result) => {
      onClose();
      navigate(`/apps/${result.connectionId}/permissions`);
    },
  });

  const { mutate: preview, reset: resetPreview } = previewMutation;
  const { reset: resetConnect } = connectMutation;
  useEffect(() => {
    if (!target) return;
    setConnectionName(target.name);
    setCredentialValues(knownHeaderCredentialValues(target.config));
    resetConnect();
    resetPreview();
    preview(target);
  }, [target, preview, resetPreview, resetConnect]);

  const draft = previewMutation.data?.drafts[0] ?? null;
  const link = draft ? draftUrl(draft) : null;
  const missing = (draft?.credentialFields ?? []).filter(
    (field) => field.required && !credentialValues[field.configPath]?.trim(),
  );
  const redacted = target ? hasRedactedSecrets(target.config) : false;

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Adopt {target?.name} into Paperclip</DialogTitle>
          <DialogDescription>
            Creates a governed Paperclip connection for this server, with approvals and audit. The native Claude Code
            entry stays until you delete it here.
          </DialogDescription>
        </DialogHeader>

        {previewMutation.isPending ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Reading the server config…
          </p>
        ) : null}
        {previewMutation.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Couldn’t read this server config: {errorMessage(previewMutation.error)}
          </p>
        ) : null}

        {draft ? (
          <div className="space-y-4">
            {redacted ? (
              <p className="flex items-start gap-2 rounded-md border border-border bg-muted/50 px-3 py-2 text-xs text-muted-foreground">
                <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                Stored secrets aren’t sent to the browser, so credentials must be re-entered in Paperclip. Paperclip
                stores them as its own secrets.
              </p>
            ) : null}
            {!link ? (
              <p className="text-sm text-destructive" role="alert">
                This server has no http(s) URL, so Paperclip can’t connect to it.
              </p>
            ) : null}
            <div className="space-y-1.5">
              <Label htmlFor="adopt-connection-name">Connection name</Label>
              <Input
                id="adopt-connection-name"
                value={connectionName}
                onChange={(event) => setConnectionName(event.target.value)}
              />
            </div>
            {draft.credentialFields.map((field) => (
              <div key={field.configPath} className="space-y-1.5">
                <Label htmlFor={`adopt-${field.configPath}`}>
                  {field.label}
                  {field.required ? null : <span className="text-muted-foreground"> (optional)</span>}
                </Label>
                <Input
                  id={`adopt-${field.configPath}`}
                  type="password"
                  autoComplete="off"
                  value={credentialValues[field.configPath] ?? ""}
                  onChange={(event) =>
                    setCredentialValues((prev) => ({ ...prev, [field.configPath]: event.target.value }))
                  }
                  className="font-mono text-xs"
                />
              </div>
            ))}
            {draft.warnings.length > 0 ? (
              <ul className="space-y-1 text-xs text-muted-foreground">
                {draft.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {connectMutation.isError ? (
          <p className="text-sm text-destructive" role="alert">
            Couldn’t create the Paperclip connection: {errorMessage(connectMutation.error)}
          </p>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="button"
            disabled={!draft || !link || missing.length > 0 || connectMutation.isPending}
            onClick={() => (draft && link ? connectMutation.mutate({ draft, link }) : undefined)}
          >
            {connectMutation.isPending ? <Loader2 className="animate-spin" /> : <ShieldCheck />}
            Adopt into Paperclip
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
