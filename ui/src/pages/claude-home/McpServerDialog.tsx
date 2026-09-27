import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import {
  emptyMcpServerForm,
  mcpServerConfigFromForm,
  mcpServerFormFromConfig,
  validateMcpServerForm,
  type KeyValueRow,
  type McpServerForm,
  type McpServerFormType,
} from "./mcp-server-form";

export interface McpServerDialogTarget {
  /** Null when adding a new server. */
  name: string | null;
  config: Record<string, unknown>;
}

export function McpServerDialog({
  target,
  saving,
  error,
  onClose,
  onSave,
}: {
  target: McpServerDialogTarget | null;
  saving: boolean;
  error: string | null;
  onClose: () => void;
  onSave: (name: string, config: Record<string, unknown>) => void;
}) {
  const [form, setForm] = useState<McpServerForm>(emptyMcpServerForm);
  const [attempted, setAttempted] = useState(false);

  useEffect(() => {
    if (!target) return;
    setForm(target.name ? mcpServerFormFromConfig(target.name, target.config) : emptyMcpServerForm());
    setAttempted(false);
  }, [target]);

  const editing = Boolean(target?.name);
  const validationError = validateMcpServerForm(form);
  const update = (patch: Partial<McpServerForm>) => setForm((prev) => ({ ...prev, ...patch }));

  const submit = () => {
    setAttempted(true);
    if (validationError || !target) return;
    onSave(form.name.trim(), mcpServerConfigFromForm(form, target.config));
  };

  return (
    <Dialog open={target !== null} onOpenChange={(open) => (!open ? onClose() : undefined)}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{editing ? `Edit ${target?.name}` : "Add MCP server"}</DialogTitle>
          <DialogDescription>
            Saved to this Claude Home's .claude.json. Agents that load native MCP get it on their next run.
          </DialogDescription>
        </DialogHeader>

        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <div className="space-y-1.5">
            <Label htmlFor="claude-mcp-name">Name</Label>
            <Input
              id="claude-mcp-name"
              value={form.name}
              disabled={editing}
              onChange={(event) => update({ name: event.target.value })}
              placeholder="github"
              className="font-mono"
            />
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="claude-mcp-type">Type</Label>
            <Select value={form.type} onValueChange={(value) => update({ type: value as McpServerFormType })}>
              <SelectTrigger id="claude-mcp-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="http">HTTP (streamable)</SelectItem>
                <SelectItem value="sse">SSE</SelectItem>
                <SelectItem value="stdio">stdio (local command)</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {form.type === "stdio" ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="claude-mcp-command">Command</Label>
                <Input
                  id="claude-mcp-command"
                  value={form.command}
                  onChange={(event) => update({ command: event.target.value })}
                  placeholder="npx"
                  className="font-mono"
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="claude-mcp-args">Arguments (one per line)</Label>
                <Textarea
                  id="claude-mcp-args"
                  value={form.args}
                  onChange={(event) => update({ args: event.target.value })}
                  rows={3}
                  spellCheck={false}
                  placeholder={"-y\n@modelcontextprotocol/server-github"}
                  className="font-mono text-xs"
                />
              </div>
              <KeyValueEditor
                label="Environment"
                rows={form.env}
                onChange={(env) => update({ env })}
              />
            </>
          ) : (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="claude-mcp-url">URL</Label>
                <Input
                  id="claude-mcp-url"
                  value={form.url}
                  onChange={(event) => update({ url: event.target.value })}
                  placeholder="https://mcp.example.com/mcp"
                  className="font-mono"
                />
              </div>
              <KeyValueEditor
                label="Headers"
                rows={form.headers}
                onChange={(headers) => update({ headers })}
              />
            </>
          )}

          {attempted && validationError ? (
            <p className="text-xs text-destructive" role="alert">{validationError}</p>
          ) : null}
          {error ? (
            <p className="text-xs text-destructive" role="alert">{error}</p>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={saving}>
              {saving ? "Saving…" : editing ? "Save server" : "Add server"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function KeyValueEditor({
  label,
  rows,
  onChange,
}: {
  label: string;
  rows: KeyValueRow[];
  onChange: (rows: KeyValueRow[]) => void;
}) {
  const setRow = (index: number, patch: Partial<KeyValueRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <fieldset className="space-y-1.5">
      <legend className="text-sm font-medium">{label}</legend>
      {rows.map((row, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            aria-label={`${label} key ${index + 1}`}
            value={row.key}
            onChange={(event) => setRow(index, { key: event.target.value })}
            placeholder="KEY"
            className="font-mono text-xs"
          />
          <Input
            aria-label={`${label} value ${index + 1}`}
            value={row.value}
            onChange={(event) => setRow(index, { value: event.target.value })}
            placeholder={row.redacted ? "•••••• stored secret, unchanged" : "value"}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label={`Remove ${label.toLowerCase()} ${row.key || index + 1}`}
            onClick={() => onChange(rows.filter((_, i) => i !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      {rows.some((row) => row.redacted) ? (
        <p className="text-xs text-muted-foreground">
          Stored secrets stay hidden. Leave a value empty to keep it, or type a new one to replace it.
        </p>
      ) : null}
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => onChange([...rows, { key: "", value: "", redacted: false }])}
      >
        <Plus />
        Add {label.toLowerCase() === "environment" ? "variable" : "header"}
      </Button>
    </fieldset>
  );
}
