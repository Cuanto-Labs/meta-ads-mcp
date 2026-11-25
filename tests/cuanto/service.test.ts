// PROVISIONAL: confirm against META-ACCESS.md. Shapes below follow META-ACCESS.md (Task 0.2, 2026-11-25),
// except the success body of POST /{business}/client_ad_accounts, which Meta has not returned yet (#3 at Limited tier).
import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { configureMcpDb, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { configureGuard, resetGuardForTests } from "../../src/cuanto/guard.js";
import { PgTokenStore } from "../../src/cuanto/pg-store.js";
import { createCuantoServiceRouter } from "../../src/cuanto/service.js";
import { resolveTenant } from "../../src/cuanto/tenants.js";
import { mockFetchResponse } from "../setup.js";
import { HEX64, memDb, TENANT_A } from "./helpers.js";

const realFetch = globalThis.fetch;
const SECRET = "service-secret-for-tests";
const SYSTEM_TOKEN = "EAAtest-system-user-token-value";
const APP_SECRET = "app-secret-for-tests";
const BIZ = "928917586605586";
const APP_SCOPED_ME = "122093302665571961";

type GraphReply = { status?: number; body?: unknown; text?: string; reject?: boolean };
let graphReplies: Array<(url: URL, init?: RequestInit) => GraphReply | undefined> = [];
let graphCalls: Array<{ method: string; url: URL; body: URLSearchParams | null }> = [];

function onGraph(fn: (url: URL, init?: RequestInit) => GraphReply | undefined): void {
  graphReplies.push(fn);
}

function graphPath(url: URL): string {
  return url.pathname.replace(/^\/v[\d.]+/, "");
}

let server: Server;
let base: string;
let mcpDb: Db;
let store: PgTokenStore;

beforeAll(async () => {
  const app = express();
  app.use("/cuanto", createCuantoServiceRouter({ sleep: async () => {}, tokenStore: { saveTenantToken: (...a: unknown[]) => store.saveTenantToken(...(a as [never])) } as never }));
  await new Promise<void>((resolve) => {
    server = app.listen(0, "127.0.0.1", () => resolve());
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

beforeEach(async () => {
  vi.stubEnv("CUANTO_SERVICE_SECRET", SECRET);
  vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_BUSINESS_ID", BIZ);
  vi.stubEnv("META_API_VERSION", undefined);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
  resetKeyCacheForTests();
  mcpDb = await memDb();
  configureMcpDb(mcpDb);
  store = new PgTokenStore(mcpDb);
  const reader = await memDb();
  await reader.query("create table ad_accounts (account_id uuid, meta_account_id text, status text, access_path text)");
  await reader.query("insert into ad_accounts values ($1, 'act_111', 'active', 'partner'), ($1, 'act_222', 'pending', 'partner'), ($1, 'act_444', 'awaiting_operator', 'partner')", [TENANT_A]);
  configureGuard({ readerDb: reader });
  graphReplies = [];
  graphCalls = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
    graphCalls.push({ method: init?.method ?? "GET", url, body: init?.body ? new URLSearchParams(String(init.body)) : null });
    for (const fn of graphReplies) {
      const reply = fn(url, init);
      if (!reply) continue;
      if (reply.reject) throw new TypeError("fetch failed");
      if (reply.text !== undefined) {
        return { ok: false, status: reply.status ?? 502, json: async () => { throw new SyntaxError("Unexpected token <"); }, text: async () => reply.text } as unknown as Response;
      }
      return mockFetchResponse(reply.body, { status: reply.status ?? 200 });
    }
    return mockFetchResponse({ error: { code: 100, message: "no stub" } }, { status: 400 });
  }));
});

afterEach(() => {
  resetGuardForTests();
  resetMcpDbForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetKeyCacheForTests();
});

async function call(method: string, path: string, body?: unknown, secret = SECRET) {
  const res = await realFetch(`${base}/cuanto${path}`, {
    method,
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

describe("service API auth and routing", () => {
  it("401s on a bad or missing secret, before routing", async () => {
    expect((await call("GET", "/access/list", undefined, "wrong")).status).toBe(401);
    expect((await call("GET", "/nope", undefined, "wrong")).status).toBe(401);
    expect((await realFetch(`${base}/cuanto/access/list`)).status).toBe(401);
  });

  it("401s when no secret is configured at all", async () => {
    vi.stubEnv("CUANTO_SERVICE_SECRET", "");
    expect((await call("GET", "/access/list", undefined, "")).status).toBe(401);
  });

  it("404s on unknown paths and methods", async () => {
    expect((await call("GET", "/nope")).status).toBe(404);
    expect((await call("DELETE", "/access/list")).status).toBe(404);
    expect(graphCalls).toHaveLength(0);
  });
});

describe("Meta calls", () => {
  it("forwards access/request to /<META_BUSINESS_ID>/client_ad_accounts with appsecret_proof", async () => {
    onGraph((url) => (graphPath(url) === `/${BIZ}/client_ad_accounts` ? { body: { access_status: "PENDING" } } : undefined));
    const res = await call("POST", "/access/request", { meta_account_id: "act_333" });
    expect(res.json).toEqual({ access_status: "PENDING" });
    const sent = graphCalls[0];
    expect(sent.method).toBe("POST");
    expect(sent.url.toString().startsWith(`https://graph.facebook.com/v27.0/${BIZ}/client_ad_accounts`)).toBe(true);
    expect(sent.body?.get("adaccount_id")).toBe("act_333");
    expect(JSON.parse(sent.body!.get("permitted_tasks")!)).toEqual(["MANAGE", "ADVERTISE", "ANALYZE"]);
    expect(sent.body?.get("appsecret_proof")).toBe(createHmac("sha256", APP_SECRET).update(SYSTEM_TOKEN).digest("hex"));
    expect(res.text).not.toContain(SYSTEM_TOKEN);
  });

  it("maps (#3) to capability_unavailable without retrying", async () => {
    onGraph(() => ({ status: 400, body: { error: { message: "(#3) Application does not have the capability to make this API call.", type: "OAuthException", code: 3 } } }));
    const res = await call("POST", "/access/request", { meta_account_id: "act_333" });
    expect(res.status).toBe(409);
    expect(res.json.error).toMatchObject({ kind: "capability_unavailable", code: 3 });
    expect(graphCalls).toHaveLength(1);
  });

  it("rejects ad account ids not shaped act_<digits>", async () => {
    expect((await call("POST", "/access/request", { meta_account_id: "333" })).status).toBe(400);
    expect((await call("POST", "/access/request", { meta_account_id: "act_1/../me" })).status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("merges list pages and reports complete:true", async () => {
    onGraph((url) => {
      if (graphPath(url) !== `/${BIZ}/client_ad_accounts`) return undefined;
      return url.searchParams.get("after") === "c1"
        ? { body: { data: [{ id: "act_2", name: "Two" }] } }
        : { body: { data: [{ id: "act_1", name: "One" }], paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" } } };
    });
    const res = await call("GET", "/access/list");
    expect(res.json).toEqual({ accounts: [{ meta_account_id: "act_1", name: "One" }, { meta_account_id: "act_2", name: "Two" }], complete: true });
  });

  it("sets complete:false when a page fails", async () => {
    onGraph((url) => {
      if (url.searchParams.get("after") === "c1") return { status: 500, body: { error: { code: 1, message: "unknown" } } };
      return { body: { data: [{ id: "act_1", name: "One" }], paging: { cursors: { after: "c1" }, next: "x" } } };
    });
    const res = await call("GET", "/access/list");
    expect(res.json).toEqual({ accounts: [{ meta_account_id: "act_1", name: "One" }], complete: false });
  });

  it("does not retry 190", async () => {
    onGraph(() => ({ status: 400, body: { error: { code: 190, message: "Error validating access token" } } }));
    const res = await call("GET", "/health");
    expect(res.status).toBe(502);
    expect(res.json.error).toMatchObject({ kind: "auth", code: 190 });
    expect(graphCalls).toHaveLength(1);
  });

  it("retries 17, 17 then succeeds on the third fetch", async () => {
    let n = 0;
    onGraph(() => (++n <= 2 ? { status: 400, body: { error: { code: 17, message: "User request limit reached" } } } : { body: { id: APP_SCOPED_ME } }));
    const res = await call("GET", "/health");
    expect(res.json).toEqual({ ok: true });
    expect(graphCalls).toHaveLength(3);
  });

  it("retries fetch rejection and non-JSON 5xx, at most 3 retries", async () => {
    let n = 0;
    onGraph(() => (++n === 1 ? { reject: true } : { status: 502, text: "<html>Bad Gateway</html>" }));
    const res = await call("GET", "/health");
    expect(res.status).toBe(503);
    expect(res.json.error).toMatchObject({ kind: "network" });
    expect(graphCalls).toHaveLength(4);
  });

  it("assigns with the app-scoped id from GET /me, only for active accounts", async () => {
    onGraph((url) => (graphPath(url) === "/me" ? { body: { id: APP_SCOPED_ME, name: "cuanto-ads" } } : undefined));
    onGraph((url) => (graphPath(url) === "/act_111/assigned_users" ? { body: { success: true } } : undefined));
    expect((await call("POST", "/access/assign", { meta_account_id: "act_111" })).json).toEqual({ ok: true });
    const post = graphCalls.find((c) => c.method === "POST")!;
    expect(post.body?.get("user")).toBe(APP_SCOPED_ME);
    expect((await call("POST", "/access/assign", { meta_account_id: "act_222" })).status).toBe(400);
  });

  it("assigns an awaiting_operator row (Confirm assigns before setting active)", async () => {
    onGraph((url) => (graphPath(url) === "/me" ? { body: { id: APP_SCOPED_ME } } : undefined));
    onGraph((url) => (graphPath(url) === "/act_444/assigned_users" ? { body: { success: true } } : undefined));
    expect((await call("POST", "/access/assign", { meta_account_id: "act_444" })).json).toEqual({ ok: true });
  });

  it("keeps every other id-taking route active-only", async () => {
    onGraph((url, init) => {
      if (init?.method === "POST") return { body: { success: true } };
      if (graphPath(url) === "/705") return { body: { id: "705", account_id: "444" } };
      return { body: { data: [] } };
    });
    expect((await call("GET", "/insights?meta_account_id=act_444")).status).toBe(400);
    expect((await call("POST", "/campaigns/705/status", { status: "PAUSED" })).status).toBe(400);
    expect((await call("POST", "/adsets/705/budget", { daily_budget: 100 })).status).toBe(400);
    expect(graphCalls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  it("returns zeros for insights with no delivery ({data: []})", async () => {
    onGraph((url) => (graphPath(url) === "/act_111/insights" ? { body: { data: [] } } : undefined));
    expect((await call("GET", "/insights?meta_account_id=act_111&date_preset=last_7d")).json).toEqual({ spend: 0, impressions: 0, clicks: 0, ctr: 0 });
  });

  it("returns numbers for insights with delivery", async () => {
    onGraph((url) => (graphPath(url) === "/act_111/insights" ? { body: { data: [{ spend: "12.34", impressions: "1000", clicks: "20", ctr: "2.0" }] } } : undefined));
    expect((await call("GET", "/insights?meta_account_id=act_111")).json).toEqual({ spend: 12.34, impressions: 1000, clicks: 20, ctr: 2 });
  });

  it("refuses insights for an account that is not active", async () => {
    expect((await call("GET", "/insights?meta_account_id=act_999")).status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("changes campaign status and ad set budget only for objects in active accounts", async () => {
    onGraph((url, init) => {
      const p = graphPath(url);
      if (init?.method === "POST") return { body: { success: true } };
      if (p === "/701") return { body: { id: "701", account_id: "111" } };
      if (p === "/702") return { body: { id: "702", account_id: "999" } };
      return undefined;
    });
    expect((await call("POST", "/campaigns/701/status", { status: "ACTIVE" })).json).toEqual({ ok: true });
    expect((await call("POST", "/adsets/701/budget", { daily_budget: 5000 })).json).toEqual({ ok: true });
    expect((await call("POST", "/campaigns/702/status", { status: "ACTIVE" })).status).toBe(400);
    expect((await call("POST", "/campaigns/701/status", { status: "DELETED" })).status).toBe(400);
    expect((await call("POST", "/adsets/701/budget", { daily_budget: -1 })).status).toBe(400);
    expect(graphCalls.filter((c) => c.method === "POST").map((c) => c.body?.get("status") ?? c.body?.get("daily_budget"))).toEqual(["ACTIVE", "5000"]);
  });
});

describe("tokens and tenant keys", () => {
  it("encrypts and upserts a user token, and never echoes it", async () => {
    const token = "EAAuser-token-value-long-enough";
    const res = await call("POST", "/tokens", { tenant_id: TENANT_A, fb_user_id: "1001", token });
    expect(res.json).toEqual({ ok: true });
    expect(res.text).not.toContain(token);
    const { rows } = await mcpDb.query<{ kind: string; sealed_token: string }>("select kind, sealed_token from mcp_tokens");
    expect(rows[0].kind).toBe("user");
    expect(rows[0].sealed_token).not.toContain(token);
    expect(await store.getTenantToken(TENANT_A, "1001")).toBe(token);
  });

  it("mints a tenant key once and revokes it by hash", async () => {
    const minted = await call("POST", "/tenant-keys", { tenant_id: TENANT_A, label: "claude" });
    const key = minted.json.key as string;
    expect(await resolveTenant(key)).toBe(TENANT_A);
    expect((await call("DELETE", `/tenant-keys/${minted.json.key_hash as string}`)).json).toEqual({ ok: true });
    expect(await resolveTenant(key)).toBeNull();
  });

  it("rejects malformed tenant ids", async () => {
    expect((await call("POST", "/tenant-keys", { tenant_id: "not-a-uuid" })).status).toBe(400);
  });
});
