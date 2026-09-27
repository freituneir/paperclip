import { Router, type Request } from "express";
import type { Db } from "@paperclipai/db";
import { badRequest, forbidden } from "../errors.js";
import { accessService, logActivity } from "../services/index.js";
import { authorizationDeniedDetails } from "../services/authorization.js";
import { claudeCliService, type ClaudeCliServiceDeps } from "../services/claude-cli.js";
import { assertBoard, assertCompanyAccess, getActorInfo } from "./authz.js";

// Terminal-parity management of Claude Code MCP servers, marketplaces and
// plugins through the real `claude` CLI against the company Claude Home. Same
// access rules as the Claude Home routes: board actor, company access and
// `agents:create` (stdio servers and plugins run code on the host).
export function claudeCliRoutes(db: Db, deps: ClaudeCliServiceDeps = {}) {
  const router = Router();
  const svc = claudeCliService(deps);
  const access = accessService(db);

  async function assertBoardCompany(req: Request, companyId: string) {
    assertBoard(req);
    assertCompanyAccess(req, companyId);
    const decision = await access.decide({
      actor: req.actor,
      action: "agents:create",
      resource: { type: "company", companyId },
    });
    if (!decision.allowed) {
      throw forbidden(decision.explanation, authorizationDeniedDetails(decision));
    }
  }

  async function logCliActivity(req: Request, companyId: string, action: string, target: string) {
    const actor = getActorInfo(req);
    await logActivity(db, {
      companyId,
      actorType: actor.actorType,
      actorId: actor.actorId,
      agentId: actor.agentId,
      runId: actor.runId,
      agentApiKeyId: actor.agentApiKeyId,
      action: `claude_cli.${action}`,
      entityType: "claude_home",
      entityId: target,
      details: { target },
    });
  }

  function body(req: Request): Record<string, unknown> {
    return req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
  }

  const base = "/companies/:companyId/claude-home";

  // ---- MCP servers --------------------------------------------------------

  router.get(`${base}/mcp`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    res.json(await svc.listMcp(companyId));
  });

  router.post(`${base}/mcp`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const { name, config } = body(req);
    if (typeof name !== "string") throw badRequest("name is required");
    const response = await svc.addMcp(companyId, name, config);
    await logCliActivity(req, companyId, "mcp_added", name);
    res.json(response);
  });

  router.post(`${base}/mcp/login/:sessionId/complete`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const { name, response } = await svc.completeLogin(
      companyId,
      req.params.sessionId as string,
      body(req).redirectUrl,
    );
    await logCliActivity(req, companyId, "mcp_login_completed", name);
    res.json(response);
  });

  router.delete(`${base}/mcp/login/:sessionId`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const name = svc.cancelLogin(companyId, req.params.sessionId as string);
    if (name) await logCliActivity(req, companyId, "mcp_login_cancelled", name);
    res.status(204).end();
  });

  router.delete(`${base}/mcp/:name`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const name = req.params.name as string;
    await assertBoardCompany(req, companyId);
    const response = await svc.removeMcp(companyId, name);
    await logCliActivity(req, companyId, "mcp_removed", name);
    res.json(response);
  });

  router.post(`${base}/mcp/:name/login`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const name = req.params.name as string;
    await assertBoardCompany(req, companyId);
    const response = await svc.startLogin(companyId, name);
    await logCliActivity(req, companyId, "mcp_login_started", name);
    res.json(response);
  });

  router.post(`${base}/mcp/:name/logout`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const name = req.params.name as string;
    await assertBoardCompany(req, companyId);
    const response = await svc.logoutMcp(companyId, name);
    await logCliActivity(req, companyId, "mcp_logged_out", name);
    res.json(response);
  });

  // ---- marketplaces -------------------------------------------------------

  router.get(`${base}/marketplaces`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    res.json(await svc.listMarketplaces(companyId));
  });

  router.post(`${base}/marketplaces/update`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const name = body(req).name;
    if (name !== undefined && name !== null && typeof name !== "string") throw badRequest("name must be a string");
    const response = await svc.updateMarketplaces(companyId, name);
    await logCliActivity(req, companyId, "marketplace_updated", typeof name === "string" && name ? name : "*");
    res.json(response);
  });

  router.post(`${base}/marketplaces`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const { source, response } = await svc.addMarketplace(companyId, body(req).source);
    await logCliActivity(req, companyId, "marketplace_added", source);
    res.json(response);
  });

  router.delete(`${base}/marketplaces/:name`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const name = req.params.name as string;
    await assertBoardCompany(req, companyId);
    const response = await svc.removeMarketplace(companyId, name);
    await logCliActivity(req, companyId, "marketplace_removed", name);
    res.json(response);
  });

  // ---- plugins ------------------------------------------------------------

  router.get(`${base}/plugins`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    res.json(await svc.getPlugins(companyId));
  });

  router.post(`${base}/plugins/install`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    const id = body(req).id;
    if (typeof id !== "string") throw badRequest("id is required");
    const response = await svc.pluginAction(companyId, "install", id);
    await logCliActivity(req, companyId, "plugin_installed", id);
    res.json(response);
  });

  const pluginActions = { enable: "plugin_enabled", disable: "plugin_disabled", update: "plugin_updated" } as const;
  for (const [action, activity] of Object.entries(pluginActions) as [keyof typeof pluginActions, string][]) {
    router.post(`${base}/plugins/:id/${action}`, async (req, res) => {
      const companyId = req.params.companyId as string;
      const id = req.params.id as string;
      await assertBoardCompany(req, companyId);
      const response = await svc.pluginAction(companyId, action, id);
      await logCliActivity(req, companyId, activity, id);
      res.json(response);
    });
  }

  router.delete(`${base}/plugins/:id`, async (req, res) => {
    const companyId = req.params.companyId as string;
    const id = req.params.id as string;
    await assertBoardCompany(req, companyId);
    const response = await svc.pluginAction(companyId, "uninstall", id);
    await logCliActivity(req, companyId, "plugin_uninstalled", id);
    res.json(response);
  });

  router.get(`${base}/plugins/:id/details`, async (req, res) => {
    const companyId = req.params.companyId as string;
    await assertBoardCompany(req, companyId);
    res.json(await svc.pluginDetails(companyId, req.params.id as string));
  });

  return router;
}
