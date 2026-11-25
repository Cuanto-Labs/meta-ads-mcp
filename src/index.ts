#!/usr/bin/env node

import { parseArgs } from "node:util";
import { createServer } from "./server.js";
import { configureCuantoStore } from "./cuanto/pg-store.js";
import { configureMetaTokenRepo } from "./store/meta-token-repo.js";
import { setStdioTenant } from "./cuanto/guard.js";
import { isCuantoMode, resolveTenant } from "./cuanto/tenants.js";
import { startHttpTransport } from "./transport/http.js";
import { startStdioTransport } from "./transport/stdio.js";
import { logger } from "./utils/logger.js";

const { values } = parseArgs({
  options: {
    transport: {
      type: "string",
      short: "t",
      default: "http",
    },
    port: {
      type: "string",
      short: "p",
      default: process.env.PORT ?? "3000",
    },
  },
  strict: false,
});

const transport = values.transport ?? "http";
const port = parseInt(String(values.port ?? "3000"), 10);

async function main(): Promise<void> {
  logger.info(
    { transport, port: transport === "http" ? port : undefined },
    "Starting Meta Ads MCP server",
  );
  await configureCuantoStore(configureMetaTokenRepo);

  if (transport === "stdio") {
    if (isCuantoMode()) {
      const tenantId = await resolveTenant(process.env.CUANTO_TENANT_KEY?.trim() ?? "");
      if (!tenantId) throw new Error("CUANTO_TENANT_KEY is missing, unknown or revoked");
      setStdioTenant(tenantId);
    }
    const server = createServer();
    await startStdioTransport(server);
  } else {
    await startHttpTransport(createServer, port);
  }
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start server");
  process.exit(1);
});
