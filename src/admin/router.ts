import { Router } from "express";
import { AdminCommand, AdminProtocolError, createAdminHandler } from "./admin-protocol";
import { crmSettings, crmSources } from "./crm-settings";
import { instanceSettings } from "./instance-settings";
import { withAdminActor } from "./settings-utils";

const delegatedActions = new Set(["getSettings", "getTargets", "saveSettings", "getReceipt"]);
export function createAdminRouter() {
  const router = Router();
  router.post("/api/internal/admin", (req, res) => {
    // This selection is untrusted. Each branch verifies the complete signed audience/body again.
    const delegated = crmSources.has(String((req.body as AdminCommand | undefined)?.source));
    const handler = createAdminHandler(delegated ? "users" : "instances", async (command, context) => withAdminActor(context.actor, async () => {
      if (delegated) {
        if (!crmSources.has(command.source ?? "") || !delegatedActions.has(command.action)) throw new AdminProtocolError(403, "Delegação CRM inválida.");
        return crmSettings(command);
      }
      if (command.action === "listSources") return { sources: [{ id: "tenant", label: "Parâmetros técnicos do tenant", category: "Integrações", available: true }, { id: "database", label: "Conexão CRM", category: "Integrações", available: true }] };
      return instanceSettings(command);
    }));
    return handler(req, res);
  });
  return router;
}
