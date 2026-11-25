import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { configureMcpDb, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { configureGuard, cuantoMcpAuth, guardToolCall, resetGuardForTests, wrapToolDispatch } from "../../src/cuanto/guard.js";
import { PgTokenStore } from "../../src/cuanto/pg-store.js";
import { createTenantKey, currentTenantId, runWithTenant } from "../../src/cuanto/tenants.js";
import { metaApiClient } from "../../src/meta/client.js";
import { registerCampaignTools } from "../../src/tools/campaigns.js";
import { createMockMcpServer, mockFetchResponse } from "../setup.js";
import { HEX64, memDb, TENANT_A, TENANT_B } from "./helpers.js";

const OWN = "act_111";
const FOREIGN = "act_999";
const SYSTEM_TOKEN = "system-user-token-plaintext";

/** Graph stub: object id → owning account digits; promote_pages per account; effective_status per object. */
function stubGraph(objects: Record<string, { account?: string; status?: string }>, pages: Record<string, string[]> = {}) {
  const fetchMock = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    if (init?.method === "POST") return mockFetchResponse({ id: "555" });
    const pagesMatch = /^\/(act_\d+)\/promote_pages$/.exec(path);
    if (pagesMatch) return mockFetchResponse({ data: (pages[pagesMatch[1]] ?? []).map((id) => ({ id })) });
    const obj = objects[path.slice(1)];
    if (!obj) return mockFetchResponse({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 });
    const fields = url.searchParams.get("fields") ?? "";
    return mockFetchResponse({
      id: path.slice(1),
      ...(fields.includes("account_id") && obj.account ? { account_id: obj.account } : {}),
      ...(fields.includes("effective_status") && obj.status ? { effective_status: obj.status } : {}),
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

async function readerWith(rows: Array<[string, string, string, string]>): Promise<Db> {
  const db = await memDb();
  await db.query("create table ad_accounts (account_id uuid, meta_account_id text, status text, access_path text)");
  for (const row of rows) {
    await db.query("insert into ad_accounts (account_id, meta_account_id, status, access_path) values ($1, $2, $3, $4)", row);
  }
  return db;
}

describe("tenant guard", () => {
  beforeEach(async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
    vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
    resetKeyCacheForTests();
    metaApiClient.resetForTests();
    configureGuard({
      readerDb: await readerWith([
        [TENANT_A, OWN, "active", "partner"],
        [TENANT_A, "act_222", "pending", "partner"],
        [TENANT_B, FOREIGN, "active", "partner"],
      ]),
    });
  });

  afterEach(() => {
    resetGuardForTests();
    resetMcpDbForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    resetKeyCacheForTests();
  });

  it("denies a foreign ad account", async () => {
    stubGraph({});
    const d = await guardToolCall(TENANT_A, "ads_get_campaigns", { account_id: FOREIGN });
    expect(d.allow).toBe(false);
  });

  it("denies an account that is connected but not active", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_get_campaigns", { account_id: "222" })).allow).toBe(false);
  });

  it("allows an own account given as bare digits", async () => {
    stubGraph({});
    const d = await guardToolCall(TENANT_A, "ads_get_campaigns", { account_id: "111" });
    expect(d).toMatchObject({ allow: true, account: OWN });
  });

  it("denies a foreign campaign_id (resolves to another act_)", async () => {
    const fetchMock = stubGraph({ "700": { account: "999" } });
    expect((await guardToolCall(TENANT_A, "ads_get_campaign_details", { campaign_id: "700" })).allow).toBe(false);
    expect(String(fetchMock.mock.calls[0][0])).toContain("fields=account_id");
  });

  it("allows an own campaign", async () => {
    stubGraph({ "701": { account: "111" } });
    expect(await guardToolCall(TENANT_A, "ads_get_campaign_details", { campaign_id: "701" })).toMatchObject({ allow: true, account: OWN });
  });

  it("denies an object Meta cannot resolve", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_get_ad_details", { ad_id: "404" })).allow).toBe(false);
  });

  it("denies a tool outside the fork map allowlist", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_get_ad_accounts", {})).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_register_token", {})).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "made_up_tool", {})).allow).toBe(false);
  });

  it("allows unscoped read-only tools", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_search_interests", { query: "yoga" })).allow).toBe(true);
  });

  it("denies a scoped tool called with no id", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_get_insights", {})).allow).toBe(false);
  });

  it("forces PAUSED on create without status", async () => {
    stubGraph({});
    const d = await guardToolCall(TENANT_A, "ads_create_campaign", { account_id: OWN, name: "x" });
    expect(d).toMatchObject({ allow: true, args: { status: "PAUSED" } });
  });

  it("forces PAUSED on create with ACTIVE", async () => {
    stubGraph({});
    const d = await guardToolCall(TENANT_A, "ads_create_campaign", { account_id: OWN, name: "x", status: "ACTIVE" });
    expect(d).toMatchObject({ allow: true, args: { status: "PAUSED" } });
  });

  it("denies update to status ACTIVE", async () => {
    stubGraph({ "701": { account: "111" } });
    const d = await guardToolCall(TENANT_A, "ads_update_campaign", { campaign_id: "701", status: "ACTIVE" });
    expect(d).toEqual({ allow: false, reason: "activate or change budget from the Cuanto Ads dashboard" });
  });

  it("denies a budget change on update, including through ads_update_entity", async () => {
    stubGraph({ "701": { account: "111" } });
    const a = await guardToolCall(TENANT_A, "ads_update_ad_set", { ad_set_id: "701", daily_budget: 5000 });
    const b = await guardToolCall(TENANT_A, "ads_update_entity", { entity_type: "campaign", entity_id: "701", updates: { lifetime_budget: 1 } });
    const c = await guardToolCall(TENANT_A, "ads_update_entity", { entity_type: "campaign", entity_id: "701", updates: { status: "active" } });
    for (const d of [a, b, c]) expect(d).toMatchObject({ allow: false, reason: "activate or change budget from the Cuanto Ads dashboard" });
  });

  it("allows pausing an own object", async () => {
    stubGraph({ "701": { account: "111" } });
    expect((await guardToolCall(TENANT_A, "ads_update_campaign", { campaign_id: "701", status: "PAUSED" })).allow).toBe(true);
  });

  it("denies a foreign custom audience nested in targeting, also as a JSON string", async () => {
    stubGraph({ "801": { account: "999" }, "701": { account: "111" } });
    const targeting = { geo_locations: { countries: ["US"] }, custom_audiences: [{ id: "801" }] };
    expect((await guardToolCall(TENANT_A, "ads_update_ad_set", { ad_set_id: "701", targeting })).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_update_ad_set", { ad_set_id: "701", targeting: JSON.stringify(targeting) })).allow).toBe(false);
  });

  it("checks pages against promote_pages of allowed accounts", async () => {
    stubGraph({}, { [OWN]: ["3001"], [FOREIGN]: ["4001"] });
    expect((await guardToolCall(TENANT_A, "ads_create_ad_creative", { account_id: OWN, name: "c", page_id: "3001" })).allow).toBe(true);
    expect((await guardToolCall(TENANT_A, "ads_create_ad_creative", { account_id: OWN, name: "c", page_id: "4001" })).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_create_ad_creative", { account_id: OWN, name: "c", object_story_id: "4001_9" })).allow).toBe(false);
  });

  it("denies catalog, pixel, Instagram, video and unknown id args", async () => {
    stubGraph({ "701": { account: "111" } });
    for (const extra of [{ pixel_id: "1" }, { instagram_actor_id: "1" }, { video_id: "1" }, { promoted_object: { product_catalog_id: "1" } }, { mystery_id: "1" }]) {
      expect((await guardToolCall(TENANT_A, "ads_update_ad_set", { ad_set_id: "701", ...extra })).allow).toBe(false);
    }
  });

  it("allows delete only of an own PAUSED object", async () => {
    stubGraph({ "701": { account: "111", status: "PAUSED" }, "702": { account: "111", status: "ACTIVE" }, "703": { account: "999", status: "PAUSED" } });
    expect((await guardToolCall(TENANT_A, "ads_delete_campaign", { campaign_id: "701" })).allow).toBe(true);
    expect((await guardToolCall(TENANT_A, "ads_delete_campaign", { campaign_id: "702" })).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_delete_campaign", { campaign_id: "703" })).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_update_campaign", { campaign_id: "702", status: "ARCHIVED" })).allow).toBe(false);
  });

  it("rejects path-shaped ids", async () => {
    stubGraph({});
    expect((await guardToolCall(TENANT_A, "ads_get_campaign_details", { campaign_id: "701/../act_999" })).allow).toBe(false);
    expect((await guardToolCall(TENANT_A, "ads_get_insights", { object_id: "act_999?x" })).allow).toBe(false);
  });
});

describe("dispatch wrap", () => {
  beforeEach(async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
    vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
    resetKeyCacheForTests();
    metaApiClient.resetForTests();
    configureGuard({ readerDb: await readerWith([[TENANT_A, OWN, "active", "partner"]]), tokenStore: new PgTokenStore(await memDb()) });
  });

  afterEach(() => {
    resetGuardForTests();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  function campaignTool(name: string) {
    const server = createMockMcpServer();
    wrapToolDispatch(server as never);
    registerCampaignTools(server as never);
    return server._registeredTools.find((t) => t.name === name)!;
  }

  it("sends a create as PAUSED on the system-user token", async () => {
    const fetchMock = stubGraph({});
    const tool = campaignTool("ads_create_campaign");
    await runWithTenant(TENANT_A, () =>
      tool.handler({ account_id: OWN, name: "x", objective: "OUTCOME_TRAFFIC", status: "ACTIVE", special_ad_categories: [] }, {}));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === "POST")!;
    const body = String(post[1]!.body);
    expect(body).toContain("status=PAUSED");
    expect(body).not.toContain("ACTIVE");
    expect(String(post[0]) + body).toContain(SYSTEM_TOKEN);
  });

  it("refuses without calling Meta for a foreign account", async () => {
    const fetchMock = stubGraph({});
    const tool = campaignTool("ads_get_campaigns");
    const result = (await runWithTenant(TENANT_A, () => tool.handler({ account_id: FOREIGN }, {}))) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when no tenant is in context", async () => {
    stubGraph({});
    const result = (await campaignTool("ads_get_campaigns").handler({ account_id: OWN }, {})) as { isError?: boolean };
    expect(result.isError).toBe(true);
  });
});

describe("cuantoMcpAuth", () => {
  beforeEach(async () => configureMcpDb(await memDb()));
  afterEach(() => resetMcpDbForTests());

  function fakeRes() {
    const res = { statusCode: 200, body: undefined as unknown, status(code: number) { res.statusCode = code; return res; }, json(b: unknown) { res.body = b; return res; } };
    return res;
  }

  it("401s with no bearer, a bad bearer, or only X-Meta-Token", async () => {
    for (const headers of [{}, { authorization: "Bearer cak_nope" }, { "x-meta-token": "EAAstolen" }]) {
      const res = fakeRes();
      const next = vi.fn();
      await cuantoMcpAuth({ headers } as never, res as never, next);
      expect(res.statusCode).toBe(401);
      expect(next).not.toHaveBeenCalled();
    }
  });

  it("runs the request inside the key's tenant", async () => {
    const { key } = await createTenantKey(TENANT_A, "agent");
    let seen: string | undefined;
    await cuantoMcpAuth({ headers: { authorization: `Bearer ${key}` } } as never, fakeRes() as never, () => { seen = currentTenantId(); });
    expect(seen).toBe(TENANT_A);
  });
});

describe("createServer in Cuanto mode", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it("keeps all 172 tools listed and puts every handler behind the guard", async () => {
    vi.stubEnv("STORE_BACKEND", "postgres");
    const fetchMock = stubGraph({});
    const { createServer } = await import("../../src/server.js");
    const tools = (createServer() as unknown as { _registeredTools: Record<string, { handler: (...a: unknown[]) => Promise<unknown> }> })._registeredTools;
    expect(Object.keys(tools)).toHaveLength(172);
    const result = (await tools.ads_get_ad_accounts.handler({}, {})) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
