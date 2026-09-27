import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import {
  claudeHomeClaudeMdUpdateSchema,
  claudeHomeMcpServerUpsertSchema,
  claudeHomeSettingsUpdateSchema,
} from "@paperclipai/shared";
import { validate } from "../middleware/validate.js";
import { logActivity } from "../services/index.js";
import { claudeHomeService } from "../services/claude-home.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// Company Claude Home (a shared CLAUDE_CONFIG_DIR). Inventory and edits are
// board-only; the per-agent effective setup is readable by same-company agents.
export function claudeHomeRoutes(db: Db) {
  const router = Router();
  const svc = claudeHomeService(db);

  function assertBoardCompany(req: Request, companyId: string) {
    assertCompanyAccess(req, companyId);
    assertBoard(req);
  }

  async function logClaudeHomeActivity(
    req: Request,
    companyId: string,
    action: string,
    entityId: string,
    details: Record<string, unknown>,
  ) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action,
      entityType: "claude_home",
      entityId,
      details,
    });
  }

  router.get("/companies/:companyId/claude-home", async (req, res) => {
    const companyId = req.params.companyId as string;
    assertBoardCompany(req, companyId);
    res.json(await svc.getInventory(companyId));
  });

  router.put(
    "/companies/:companyId/claude-home/settings",
    validate(claudeHomeSettingsUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardCompany(req, companyId);
      const inventory = await svc.saveSettings(companyId, req.body.settings);
      await logClaudeHomeActivity(req, companyId, "claude_home.settings_updated", "settings.json", {
        keys: Object.keys(req.body.settings as Record<string, unknown>).sort(),
      });
      res.json(inventory);
    },
  );

  router.put(
    "/companies/:companyId/claude-home/claude-md",
    validate(claudeHomeClaudeMdUpdateSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      assertBoardCompany(req, companyId);
      const content = req.body.content as string;
      const inventory = await svc.saveClaudeMd(companyId, content);
      await logClaudeHomeActivity(req, companyId, "claude_home.claude_md_updated", "CLAUDE.md", {
        length: content.length,
      });
      res.json(inventory);
    },
  );

  router.put(
    "/companies/:companyId/claude-home/mcp-servers/:name",
    validate(claudeHomeMcpServerUpsertSchema),
    async (req, res) => {
      const companyId = req.params.companyId as string;
      const name = req.params.name as string;
      assertBoardCompany(req, companyId);
      const { inventory, created } = await svc.upsertMcpServer(companyId, name, req.body.config);
      const summary = inventory.mcpServers.find((server) => server.name === name);
      await logClaudeHomeActivity(req, companyId, "claude_home.mcp_server_upserted", name, {
        name,
        created,
        transport: summary?.transport ?? null,
        target: summary?.target ?? null,
      });
      res.json(inventory);
    },
  );

  router.delete("/companies/:companyId/claude-home/mcp-servers/:name", async (req, res) => {
    const companyId = req.params.companyId as string;
    const name = req.params.name as string;
    assertBoardCompany(req, companyId);
    const inventory = await svc.deleteMcpServer(companyId, name);
    await logClaudeHomeActivity(req, companyId, "claude_home.mcp_server_deleted", name, { name });
    res.json(inventory);
  });

  router.get("/companies/:companyId/agents/:agentId/claude-setup", async (req, res) => {
    const companyId = req.params.companyId as string;
    const agentId = req.params.agentId as string;
    assertCompanyAccess(req, companyId);
    res.json(await svc.getAgentEffectiveSetup(companyId, agentId));
  });

  return router;
}
