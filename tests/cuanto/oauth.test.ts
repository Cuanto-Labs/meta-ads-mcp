import { createHmac } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { configureMcpDb, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { PgTokenStore } from "../../src/cuanto/pg-store.js";
import { createCuantoServiceRouter } from "../../src/cuanto/service.js";
import { mockFetchResponse } from "../setup.js";
import { HEX64, memDb, TENANT_A } from "./helpers.js";

const realFetch = globalThis.fetch;
const SECRET = "service-secret-for-tests";
const APP_SECRET = "app-secret-for-tests";
const SHORT = "EAAshort-lived-token-value-0001";
const LONG = "EAAlong-lived-token-value-00002";
const REDIRECT = "https://ads-dev.cuantolabs.com/api/meta/oauth/callback";

let server: Server;
let base: string;
let db: Db;
let store: PgTokenStore;
let graphCalls: URL[] = [];
let replies: Record<string, unknown> = {};

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
  vi.stubEnv("META_APP_ID", "555000111");
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("META_API_VERSION", undefined);
  vi.stubEnv("OAUTH_REDIRECT_ALLOWLIST", undefined);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
  resetKeyCacheForTests();
  db = await memDb();
  configureMcpDb(db);
  store = new PgTokenStore(db);
  graphCalls = [];
  replies = {
    "/oauth/access_token": { access_token: SHORT, token_type: "bearer" },
    "/me": { id: "10001" },
    "/me/adaccounts": { data: [{ account_id: "123", name: "Shop" }, { account_id: "act_456", name: "Two" }] },
  };
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
    graphCalls.push(url);
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    if (path === "/oauth/access_token" && url.searchParams.get("grant_type") === "fb_exchange_token") {
      return mockFetchResponse(replies.exchange ?? { access_token: LONG }, { status: 200 });
    }
    const body = replies[path];
    const status = (body as { error?: unknown })?.error ? 400 : 200;
    return mockFetchResponse(body ?? { error: { code: 100, message: "no stub" } }, { status });
  }));
});

afterEach(() => {
  resetMcpDbForTests();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  resetKeyCacheForTests();
});

async function exchange(body: unknown, secret = SECRET) {
  const res = await realFetch(`${base}/cuanto/oauth/exchange`, {
    method: "POST",
    headers: { authorization: `Bearer ${secret}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, text, json: JSON.parse(text) as Record<string, unknown> };
}

const good = { code: "AQDcode", redirect_uri: REDIRECT, tenant_id: TENANT_A };

describe("POST /cuanto/oauth/exchange", () => {
  it("401s on a bad secret", async () => {
    expect((await exchange(good, "wrong")).status).toBe(401);
    expect(graphCalls).toHaveLength(0);
  });

  it("400s on a redirect_uri outside the allowlist with 0 fetches", async () => {
    const res = await exchange({ ...good, redirect_uri: "https://evil.example/api/meta/oauth/callback" });
    expect(res.status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("400s on a missing tenant_id or code with 0 fetches", async () => {
    expect((await exchange({ code: "x", redirect_uri: REDIRECT })).status).toBe(400);
    expect((await exchange({ tenant_id: TENANT_A, redirect_uri: REDIRECT })).status).toBe(400);
    expect(graphCalls).toHaveLength(0);
  });

  it("accepts the prod redirect and the env allowlist override", async () => {
    expect((await exchange({ ...good, redirect_uri: "https://ads.cuantolabs.com/api/meta/oauth/callback" })).status).toBe(200);
    vi.stubEnv("OAUTH_REDIRECT_ALLOWLIST", "http://localhost:3000/cb, http://localhost:3001/cb");
    expect((await exchange({ ...good, redirect_uri: "http://localhost:3001/cb" })).status).toBe(200);
    expect((await exchange({ ...good, redirect_uri: REDIRECT })).status).toBe(400);
  });

  it("happy path: 4 Graph calls, sealed row, accounts normalised, no token in the response", async () => {
    const res = await exchange(good);
    expect(res.status).toBe(200);
    expect(graphCalls).toHaveLength(4);
    expect(res.json).toEqual({
      fb_user_id: "10001",
      accounts: [{ meta_account_id: "act_123", name: "Shop" }, { meta_account_id: "act_456", name: "Two" }],
    });
    expect(res.text).not.toContain(LONG);
    expect(res.text).not.toContain(SHORT);
    const { rows } = await db.query<{ sealed_token: string; kind: string }>("select sealed_token, kind from mcp_tokens where tenant_id = $1 and user_key = '10001'", [TENANT_A]);
    expect(rows).toHaveLength(1);
    expect(rows[0].kind).toBe("user");
    expect(rows[0].sealed_token).not.toContain(LONG);
    expect(await store.getTenantToken(TENANT_A, "10001")).toBe(LONG);
  });

  it("sends appsecret_proof on the calls that carry the user token", async () => {
    await exchange(good);
    const proof = createHmac("sha256", APP_SECRET).update(LONG).digest("hex");
    const [first, second, me, accounts] = graphCalls;
    expect(first.searchParams.get("code")).toBe("AQDcode");
    expect(first.searchParams.get("redirect_uri")).toBe(REDIRECT);
    expect(second.searchParams.get("grant_type")).toBe("fb_exchange_token");
    expect(me.searchParams.get("access_token")).toBe(LONG);
    expect(me.searchParams.get("appsecret_proof")).toBe(proof);
    expect(accounts.searchParams.get("appsecret_proof")).toBe(proof);
  });

  it("paginates /me/adaccounts", async () => {
    let page = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      graphCalls.push(url);
      const path = url.pathname.replace(/^\/v[\d.]+/, "");
      if (path === "/oauth/access_token") return mockFetchResponse(url.searchParams.get("grant_type") ? { access_token: LONG } : { access_token: SHORT }, { status: 200 });
      if (path === "/me") return mockFetchResponse({ id: "10001" }, { status: 200 });
      page++;
      return mockFetchResponse(page === 1
        ? { data: [{ account_id: "1", name: "A" }], paging: { next: "https://x", cursors: { after: "c1" } } }
        : { data: [{ account_id: "2", name: "B" }] }, { status: 200 });
    }));
    const res = await exchange(good);
    expect((res.json.accounts as unknown[]).length).toBe(2);
    expect(graphCalls.at(-1)?.searchParams.get("after")).toBe("c1");
  });

  it("maps Graph error 100 to a typed error, stores nothing, does not retry", async () => {
    replies["/oauth/access_token"] = { error: { code: 100, message: "Invalid verification code format." } };
    const res = await exchange(good);
    expect(res.status).toBe(422);
    expect(res.json).toEqual({ error: { kind: "invalid", code: 100, message: "Invalid verification code format." } });
    expect(graphCalls).toHaveLength(1);
    const { rows } = await db.query("select 1 from mcp_tokens");
    expect(rows).toHaveLength(0);
  });

  it("logs to call_log without tokens or query strings", async () => {
    await exchange(good);
    await new Promise((r) => setTimeout(r, 20));
    const { rows } = await db.query<{ path: string }>("select path from call_log");
    expect(rows.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.path).not.toContain("?");
      expect(row.path).not.toContain("EAA");
      expect(row.path).not.toContain("AQDcode");
    }
  });
});
