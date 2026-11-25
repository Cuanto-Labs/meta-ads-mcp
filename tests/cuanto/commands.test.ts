import { readFileSync } from "node:fs";
import { newDb } from "pg-mem";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { claimCommands, processCommands, recoverStuckCommands } from "../../src/cuanto/commands.js";
import { configureMcpDb, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { configureGuard, resetGuardForTests } from "../../src/cuanto/guard.js";
import { mockFetchResponse } from "../setup.js";
import { HEX64, memDb } from "./helpers.js";

const SYSTEM_TOKEN = "EAAtest-system-user-token-value";
const APP_SECRET = "app-secret-for-tests";
const realFetch = globalThis.fetch;

type Reply = { status?: number; body: unknown };
let calls: Array<{ method: string; path: string; body: URLSearchParams | null }> = [];
let replies: Array<(method: string, path: string) => Reply | undefined> = [];

/**
 * pg-mem parses neither `for update skip locked` nor LIMIT inside an UPDATE subquery, so the claim runs as
 * select-then-update here. The real statement is asserted textually below and exercised on Neon in live verification.
 */
function mem(db: Db): Db {
  return {
    async query(text, params) {
      if (/^\s*update ops\.meta_commands\s+set state = 'running'/i.test(text)) {
        const { rows } = await db.query<{ id: number }>("select id from ops.meta_commands where state = 'queued' order by id limit 5");
        if (rows.length === 0) return { rows: [] };
        return db.query(
          `update ops.meta_commands set state = 'running', started_at = now(), attempts = attempts + 1 where id in (${rows.map((r) => Number(r.id)).join(",")}) and state = 'queued' returning id, created_at, kind, target_id, meta_account_id, value`,
        );
      }
      return db.query(text, params);
    },
  };
}

async function warehouse(): Promise<{ db: Db; raw: Db }> {
  const m = newDb();
  const { Pool } = m.adapters.createPg();
  const raw = new Pool() as unknown as Db;
  const ddl = readFileSync(new URL("../../migrations/warehouse/002_commands.sql", import.meta.url), "utf8").split("do $$")[0]!;
  await raw.query(ddl);
  return { db: mem(raw), raw };
}

async function insert(db: Db, over: Record<string, unknown> = {}): Promise<number> {
  const row = { kind: "campaign_status", target_id: "5001", meta_account_id: "act_111", value: "PAUSED", ...over };
  const { rows } = await db.query<{ id: number }>(
    `insert into ops.meta_commands (kind, target_id, meta_account_id, value, created_by${row.created_at ? ", created_at" : ""}) values ($1,$2,$3,$4,'tester'${row.created_at ? ", $5" : ""}) returning id`,
    [row.kind, row.target_id, row.meta_account_id, row.value, ...(row.created_at ? [row.created_at] : [])],
  );
  return Number(rows[0]!.id);
}

async function get(db: Db, id: number) {
  const { rows } = await db.query<{ state: string; result: string | null; done_at: unknown; attempts: number }>("select * from ops.meta_commands where id = $1", [id]);
  return rows[0]!;
}

function owner(map: Record<string, string>) {
  replies.push((method, path) => (method === "GET" && map[path.slice(1)] ? { body: { account_id: map[path.slice(1)].replace("act_", ""), id: path.slice(1) } } : undefined));
}

let wh: Db;
let rawWh: Db;

beforeEach(async () => {
  vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
  vi.stubEnv("META_APP_SECRET", APP_SECRET);
  vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
  vi.stubEnv("META_API_VERSION", undefined);
  vi.stubEnv("COMMAND_MAX_DAILY_BUDGET_MINOR", undefined);
  resetKeyCacheForTests();
  configureMcpDb(await memDb());
  const reader = await memDb();
  await reader.query("create table ad_accounts (account_id uuid, meta_account_id text, status text, access_path text)");
  await reader.query("insert into ad_accounts values ('11111111-1111-4111-8111-111111111111', 'act_111', 'active', 'partner'), ('11111111-1111-4111-8111-111111111111', 'act_222', 'active', 'partner')");
  configureGuard({ readerDb: reader });
  ({ db: wh, raw: rawWh } = await warehouse());
  calls = [];
  replies = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname !== "graph.facebook.com") return realFetch(input, init);
    const method = init?.method ?? "GET";
    const path = url.pathname.replace(/^\/v[\d.]+/, "");
    calls.push({ method, path, body: init?.body ? new URLSearchParams(String(init.body)) : null });
    for (const fn of replies) {
      const r = fn(method, path);
      if (r) return mockFetchResponse(r.body, { status: r.status ?? 200 });
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

const posts = () => calls.filter((c) => c.method === "POST");

describe("command worker", () => {
  it("rejects a foreign account with zero Graph calls", async () => {
    const id = await insert(wh, { meta_account_id: "act_999" });
    await processCommands({ db: wh, sleep: async () => {} });
    const row = await get(wh, id);
    expect(row.state).toBe("rejected");
    expect(row.result).toMatch(/not an active/);
    expect(calls).toHaveLength(0);
  });

  it("rejects a target that resolves to another account", async () => {
    owner({ "5001": "act_222" });
    const id = await insert(wh);
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  it("rejects when the target does not resolve", async () => {
    const id = await insert(wh);
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  it("pauses a campaign with one POST and marks done", async () => {
    owner({ "5001": "act_111" });
    replies.push((m) => (m === "POST" ? { body: { success: true } } : undefined));
    const id = await insert(wh);
    await processCommands({ db: wh, sleep: async () => {} });
    const row = await get(wh, id);
    expect(row.state).toBe("done");
    expect(row.done_at).toBeTruthy();
    expect(posts()).toHaveLength(1);
    expect(posts()[0]!.path).toBe("/5001");
    expect(posts()[0]!.body!.get("status")).toBe("PAUSED");
    expect(posts()[0]!.body!.get("appsecret_proof")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("sets an ad set daily budget as a string of minor units", async () => {
    owner({ "6001": "act_111" });
    replies.push((m) => (m === "POST" ? { body: { success: true } } : undefined));
    const id = await insert(wh, { kind: "adset_daily_budget", target_id: "6001", value: "5000" });
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("done");
    expect(posts()[0]!.body!.get("daily_budget")).toBe("5000");
  });

  it.each([["100001"], ["0"], ["-5"], ["12.5"], ["abc"]])("rejects budget %s", async (value) => {
    owner({ "6001": "act_111" });
    const id = await insert(wh, { kind: "adset_daily_budget", target_id: "6001", value });
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  it("honours COMMAND_MAX_DAILY_BUDGET_MINOR", async () => {
    vi.stubEnv("COMMAND_MAX_DAILY_BUDGET_MINOR", "200");
    owner({ "6001": "act_111" });
    const id = await insert(wh, { kind: "adset_daily_budget", target_id: "6001", value: "201" });
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("rejected");
  });

  it("rejects a bad status value", async () => {
    owner({ "5001": "act_111" });
    const id = await insert(wh, { value: "DELETED" });
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).state).toBe("rejected");
    expect(posts()).toHaveLength(0);
  });

  it("rejects rows older than 1 h as stale", async () => {
    owner({ "5001": "act_111" });
    const id = await insert(wh, { created_at: new Date(Date.now() - 61 * 60_000).toISOString() });
    await processCommands({ db: wh, sleep: async () => {} });
    const row = await get(wh, id);
    expect(row.state).toBe("rejected");
    expect(row.result).toMatch(/stale/);
    expect(calls).toHaveLength(0);
  });

  it("two workers never take the same row", async () => {
    for (let i = 0; i < 8; i++) await insert(wh);
    const [a, b] = await Promise.all([claimCommands(wh), claimCommands(wh)]);
    const ids = [...a, ...b].map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    const rest = await claimCommands(wh);
    const all = [...ids, ...rest.map((r) => r.id)];
    expect(new Set(all).size).toBe(8);
    expect(all).toHaveLength(8);
    expect(a.length).toBeLessThanOrEqual(5);
    expect(b.length).toBeLessThanOrEqual(5);
  });

  it("claims with FOR UPDATE SKIP LOCKED", async () => {
    const seen: string[] = [];
    await claimCommands({ query: async (t: string) => { seen.push(t); return { rows: [] }; } } as unknown as Db);
    expect(seen.join(" ")).toMatch(/for update skip locked/i);
  });

  it("marks a Meta error failed with the message and no token", async () => {
    owner({ "5001": "act_111" });
    replies.push((m) => (m === "POST" ? { status: 400, body: { error: { code: 100, message: `Invalid parameter for token ${SYSTEM_TOKEN}` } } } : undefined));
    const id = await insert(wh);
    await processCommands({ db: wh, sleep: async () => {} });
    const row = await get(wh, id);
    expect(row.state).toBe("failed");
    expect(row.result).toContain("Invalid parameter");
    expect(row.result).not.toContain(SYSTEM_TOKEN);
    expect(row.result).not.toMatch(/EAA/);
  });

  it("never writes the token into result on success", async () => {
    owner({ "5001": "act_111" });
    replies.push((m) => (m === "POST" ? { body: { success: true } } : undefined));
    const id = await insert(wh);
    await processCommands({ db: wh, sleep: async () => {} });
    expect((await get(wh, id)).result ?? "").not.toContain(SYSTEM_TOKEN);
  });

  it("requeues a stuck running row once, then fails it", async () => {
    const id = await insert(wh);
    await claimCommands(wh);
    await rawWh.query("update ops.meta_commands set started_at = $2 where id = $1", [id, new Date(Date.now() - 6 * 60_000)]);
    await recoverStuckCommands(wh);
    expect((await get(wh, id)).state).toBe("queued");
    await claimCommands(wh);
    await rawWh.query("update ops.meta_commands set started_at = $2 where id = $1", [id, new Date(Date.now() - 6 * 60_000)]);
    await recoverStuckCommands(wh);
    const row = await get(wh, id);
    expect(row.state).toBe("failed");
    expect(row.result).toMatch(/stuck/);
  });

  it("leaves a fresh running row alone", async () => {
    const id = await insert(wh);
    await claimCommands(wh);
    await recoverStuckCommands(wh);
    expect((await get(wh, id)).state).toBe("running");
  });
});
