import { useEffect, useMemo, useState } from "react";
import { useMutation } from "@tanstack/react-query";
import type { ClaudeHomeInventory } from "@paperclipai/shared";
import { claudeHomeApi } from "@/api/claudeHome";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { InlineError, NamedItemList, Section, errorMessage } from "./shared";

interface InventoryEditorProps {
  companyId: string;
  inventory: ClaudeHomeInventory;
  onSaved: (next: ClaudeHomeInventory) => void;
}

export function SettingsSection({ companyId, inventory, onSaved }: InventoryEditorProps) {
  const initial = useMemo(() => JSON.stringify(inventory.settings ?? {}, null, 2), [inventory.settings]);
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);

  const parseError = useMemo(() => {
    try {
      const parsed: unknown = JSON.parse(text);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return "Settings must be a JSON object.";
      return null;
    } catch (error) {
      return `Invalid JSON: ${errorMessage(error)}`;
    }
  }, [text]);

  const save = useMutation({
    mutationFn: () => claudeHomeApi.updateSettings(companyId, JSON.parse(text) as Record<string, unknown>),
    onSuccess: onSaved,
  });
  const dirty = text !== initial;

  return (
    <Section
      title="Settings"
      description={
        <>
          settings.json for this home. Secret values show as <code className="font-mono">__redacted__</code>; leave
          them as-is to keep the stored value.
        </>
      }
    >
      {inventory.settingsParseError ? (
        <p className="text-xs text-destructive" role="alert">
          settings.json on disk couldn’t be parsed: {inventory.settingsParseError}. Fix it in Claude Code on the host
          before saving here.
        </p>
      ) : null}
      <Textarea
        aria-label="settings.json"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (save.isSuccess) save.reset();
        }}
        rows={14}
        spellCheck={false}
        className="font-mono text-xs"
      />
      {parseError ? <p className="text-xs text-destructive">{parseError}</p> : null}
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={!dirty || Boolean(parseError) || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save settings"}
        </Button>
        {save.isSuccess && !dirty ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </Section>
  );
}

export function ClaudeMdSection({ companyId, inventory, onSaved }: InventoryEditorProps) {
  const initial = inventory.claudeMd ?? "";
  const [text, setText] = useState(initial);
  useEffect(() => setText(initial), [initial]);

  const save = useMutation({
    mutationFn: () => claudeHomeApi.updateClaudeMd(companyId, text),
    onSuccess: onSaved,
  });
  const dirty = text !== initial;

  return (
    <Section title="CLAUDE.md" description="User-level memory every agent in this home loads.">
      <Textarea
        aria-label="CLAUDE.md"
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          if (save.isSuccess) save.reset();
        }}
        rows={10}
        spellCheck={false}
        placeholder="No CLAUDE.md yet."
        className="font-mono text-xs"
      />
      <InlineError error={save.error} />
      <div className="flex items-center gap-3">
        <Button type="button" size="sm" disabled={!dirty || save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? "Saving…" : "Save CLAUDE.md"}
        </Button>
        {save.isSuccess && !dirty ? <span className="text-xs text-muted-foreground">Saved.</span> : null}
      </div>
    </Section>
  );
}

/** File-based plugin list: the read-only fallback when the Claude Code CLI isn't available. */
export function InventoryPluginsSection({ inventory }: { inventory: ClaudeHomeInventory }) {
  return (
    <Section title="Installed plugins" description="Read from this home's plugin files. Manage them with /plugin in Claude Code.">
      <NamedItemList
        items={inventory.plugins}
        empty={
          <>
            No plugins installed. Run <code className="font-mono">/plugin install &lt;name&gt;</code> in Claude Code
            opened with the command above.
          </>
        }
        renderTrailing={(item) => (
          <Badge variant={item.description === "enabled" ? "secondary" : "outline"}>
            {item.description === "enabled" ? "Enabled" : "Disabled"}
          </Badge>
        )}
      />
    </Section>
  );
}

export function SkillsAndAgentsSections({ inventory }: { inventory: ClaudeHomeInventory }) {
  const dir = inventory.dir;
  return (
    <div className="space-y-8">
      <Section title="Skills">
        <NamedItemList
          items={inventory.skills}
          empty={
            <>
              No native skills. Add a folder with a SKILL.md under{" "}
              <code className="break-all font-mono">{dir}/skills/</code>.
            </>
          }
        />
      </Section>
      <Section title="Subagents">
        <NamedItemList
          items={inventory.subagents}
          empty={
            <>
              No subagents. Create one with <code className="font-mono">/agents</code> in Claude Code, or add a
              Markdown file under <code className="break-all font-mono">{dir}/agents/</code>.
            </>
          }
        />
      </Section>
      <Section title="Slash commands">
        <NamedItemList
          items={inventory.commands}
          empty={
            <>
              No custom slash commands. Add a Markdown file under{" "}
              <code className="break-all font-mono">{dir}/commands/</code>.
            </>
          }
        />
      </Section>
      <Section title="Hooks">
        {inventory.hooks.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No hooks. Add them under <code className="font-mono">hooks</code> on the Settings tab, or with{" "}
            <code className="font-mono">/hooks</code> in Claude Code.
          </p>
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border">
            {inventory.hooks.map((hook) => (
              <li key={hook.event} className="flex items-center justify-between gap-3 px-3 py-2 text-xs">
                <span className="font-mono">{hook.event}</span>
                <span className="text-muted-foreground">
                  {hook.count} {hook.count === 1 ? "hook" : "hooks"}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  );
}
