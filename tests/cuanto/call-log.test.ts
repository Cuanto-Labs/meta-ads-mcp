import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { configureMcpDb, installGraphCallLog, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { configureGuard, resetGuardForTests, wrapToolDispatch } from "../../src/cuanto/guard.js";
import { PgTokenStore } from "../../src/cuanto/pg-store.js";
import { runWithTenant } from "../../src/cuanto/tenants.js";
import { metaApiClient, setGraphCallObserver } from "../../src/meta/client.js";
import { registerCampaignTools } from "../../src/tools/campaigns.js";
import { createMockMcpServer, mockFetchResponse } from "../setup.js";
import { HEX64, memDb, TENANT_A } from "./helpers.js";

const SYSTEM_TOKEN = "system-user-token-plaintext";

describe("call_log for MCP tool calls", () => {
  let mcp: Db;

  beforeEach(async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
    vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
    resetKeyCacheForTests();
    metaApiClient.resetForTests();
    mcp = await memDb();
    configureMcpDb(mcp);
    const reader = await memDb();
    await reader.query("create table ad_accounts (account_id uuid, meta_account_id text, status text, access_path text)");
    await reader.query("insert into ad_accounts values ($1, 'act_111', 'active', 'partner')", [TENANT_A]);
    configureGuard({ readerDb: reader, tokenStore: new PgTokenStore(mcp) });
    installGraphCallLog();
  });

  afterEach(() => {
    setGraphCallObserver(undefined);
    resetGuardForTests();
    resetMcpDbForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function tool(name: string) {
    const server = createMockMcpServer();
    wrapToolDispatch(server as never);
    registerCampaignTools(server as never);
    return server._registeredTools.find((t) => t.name === name)!;
  }

  async function rows() {
    await new Promise((r) => setTimeout(r, 20));
    return (await mcp.query<Record<string, unknown>>("select tenant_id, path, http_status, meta_code from call_log")).rows;
  }

  it("writes exactly one row per Graph call, with no token, proof or query", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ data: [] })));
    await runWithTenant(TENANT_A, () => tool("ads_get_campaigns").handler({ account_id: "act_111" }, {}));
    const logged = await rows();
    expect(logged).toEqual([{ tenant_id: TENANT_A, path: "/act_111/campaigns", http_status: 200, meta_code: null }]);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(SYSTEM_TOKEN);
    expect(text).not.toMatch(/appsecret_proof|access_token|\?/);
  });

  it("records the Meta error code", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ error: { code: 100, message: "Invalid parameter" } }, { status: 400 })));
    await expect(runWithTenant(TENANT_A, () => tool("ads_get_campaigns").handler({ account_id: "act_111" }, {}))).rejects.toThrow();
    expect(await rows()).toEqual([{ tenant_id: TENANT_A, path: "/act_111/campaigns", http_status: 400, meta_code: 100 }]);
  });

  it("does not log refused calls (no Graph call is made)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ data: [] })));
    await runWithTenant(TENANT_A, () => tool("ads_get_campaigns").handler({ account_id: "act_999" }, {}));
    expect(await rows()).toEqual([]);
  });
});
