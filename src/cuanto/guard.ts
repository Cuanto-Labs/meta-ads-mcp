import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { NextFunction, Request, Response } from "express";
import pg from "pg";
import { requestContext } from "../auth/token-store.js";
import { metaApiClient } from "../meta/client.js";
import {
  ARG_ROLES,
  BUDGET_ARGS,
  DASHBOARD_ONLY,
  ID_LIKE_ARG,
  STATUS_ARGS,
  TOOL_POLICY,
  type ArgRole,
} from "./allowlist.js";
import type { Db } from "./db.js";
import { PgTokenStore, type AccessPath } from "./pg-store.js";
import { currentTenantId, resolveTenant, runWithTenant } from "./tenants.js";

const ACCOUNTS_TTL_MS = 60_000;
const RESOLVE_TTL_MS = 10 * 60_000;
const NUMERIC_ID = /^\d{1,30}$/;
const ACCOUNT_ID = /^(act_)?(\d{1,30})$/;
const STORY_ID = /^(\d{1,30})_(\d{1,30})$/;
const RETIRE_STATUSES = new Set(["ARCHIVED", "DELETED"]);

export type GuardDecision =
  | { allow: true; args: Record<string, unknown>; account: string | null }
  | { allow: false; reason: string };

export type GraphGet = (path: string, params: Record<string, string>) => Promise<unknown>;

/** Allowed ad accounts (act_<digits> → access path) for a tenant. */
export type AllowedAccounts = (tenantId: string) => Promise<Map<string, AccessPath>>;

// ─── Wiring (overridable in tests) ────────────────────────────────────

let readerDb: Db | undefined;
let tokenStore: PgTokenStore | undefined;
let stdioTenantId: string | undefined;
const accountCache = new Map<string, { at: number; accounts: Map<string, AccessPath> }>();
const resolveCache = new Map<string, { at: number; account: string }>();
const pagesCache = new Map<string, { at: number; pages: Set<string> }>();

function getReaderDb(): Db {
  if (readerDb) return readerDb;
  const url = process.env.CUANTO_ADS_READER_URL?.trim();
  if (!url) throw new Error("CUANTO_ADS_READER_URL is not set");
  readerDb = new pg.Pool({ connectionString: url, max: 3 }) as unknown as Db;
  return readerDb;
}

function getTokenStore(): PgTokenStore {
  tokenStore ??= new PgTokenStore();
  return tokenStore;
}

export function configureGuard(deps: { readerDb?: Db; tokenStore?: PgTokenStore }): void {
  if (deps.readerDb) readerDb = deps.readerDb;
  if (deps.tokenStore) tokenStore = deps.tokenStore;
}

export function setStdioTenant(tenantId: string | undefined): void {
  stdioTenantId = tenantId;
}

export function resetGuardForTests(): void {
  readerDb = undefined;
  tokenStore = undefined;
  stdioTenantId = undefined;
  accountCache.clear();
  resolveCache.clear();
  pagesCache.clear();
}

export const allowedAdAccounts: AllowedAccounts = async (tenantId) => {
  const hit = accountCache.get(tenantId);
  if (hit && Date.now() - hit.at < ACCOUNTS_TTL_MS) return hit.accounts;
  const { rows } = await getReaderDb().query<{ meta_account_id: string; access_path: string | null }>(
    "select meta_account_id, access_path from ad_accounts where account_id = $1 and status = 'active'",
    [tenantId],
  );
  const accounts = new Map<string, AccessPath>();
  for (const row of rows) {
    if (ACCOUNT_ID.test(row.meta_account_id)) {
      accounts.set(normalizeAccount(row.meta_account_id)!, row.access_path === "login" ? "login" : "partner");
    }
  }
  accountCache.set(tenantId, { at: Date.now(), accounts });
  return accounts;
};

export type AccountStatus = "active" | "awaiting_operator";

/** Every ad account in this environment (any tenant) whose row status is one of `statuses`. 60 s cache. */
export async function accountsInEnvironment(statuses: readonly AccountStatus[] = ["active"]): Promise<Set<string>> {
  const key = `*:${[...statuses].sort().join(",")}`;
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNTS_TTL_MS) return new Set(hit.accounts.keys());
  const { rows } = await getReaderDb().query<{ meta_account_id: string; status: string }>(
    "select meta_account_id, status from ad_accounts",
  );
  const accounts = new Map<string, AccessPath>();
  for (const row of rows) {
    if (!(statuses as readonly string[]).includes(row.status)) continue;
    const act = normalizeAccount(row.meta_account_id);
    if (act) accounts.set(act, "partner");
  }
  accountCache.set(key, { at: Date.now(), accounts });
  return new Set(accounts.keys());
}

/** Graph reads made by the guard itself always use the system-user token. */
const systemGraphGet: GraphGet = async (path, params) => {
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  if (!token) throw new Error("META_SYSTEM_USER_TOKEN is not configured");
  return requestContext.run({ accessToken: token }, () => metaApiClient.get(path, params));
};

// ─── Argument walk ────────────────────────────────────────────────────

interface Needs {
  accounts: Set<string>;
  objects: Set<string>;
  pages: Set<string>;
  denied: string[];
  invalid: string[];
  statusValues: string[];
  budgetKeys: string[];
}

function normalizeAccount(value: string): string | null {
  const match = ACCOUNT_ID.exec(value);
  return match ? `act_${match[2]}` : null;
}

function parseJsonish(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return undefined;
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function idsOf(value: unknown): unknown[] {
  if (Array.isArray(value)) return value.map((v) => (v && typeof v === "object" ? (v as { id?: unknown }).id : v));
  if (typeof value === "string") {
    const parsed = parseJsonish(value);
    if (parsed !== undefined) return idsOf(parsed);
    return value.split(",").map((s) => s.trim()).filter(Boolean);
  }
  if (typeof value === "number") return [String(value)];
  return [value];
}

function applyRole(role: ArgRole, key: string, value: unknown, needs: Needs): void {
  if (role === "deny") {
    needs.denied.push(key);
    return;
  }
  for (const raw of idsOf(value)) {
    const id = typeof raw === "number" ? String(raw) : raw;
    if (typeof id !== "string" || id === "") {
      needs.invalid.push(key);
      continue;
    }
    switch (role) {
      case "account": {
        const act = normalizeAccount(id);
        if (act) needs.accounts.add(act);
        else needs.invalid.push(key);
        break;
      }
      case "object_or_account": {
        if (id.startsWith("act_")) {
          const act = normalizeAccount(id);
          if (act) needs.accounts.add(act);
          else needs.invalid.push(key);
        } else if (NUMERIC_ID.test(id)) needs.objects.add(id);
        else needs.invalid.push(key);
        break;
      }
      case "object":
      case "audience_list":
        if (NUMERIC_ID.test(id)) needs.objects.add(id);
        else needs.invalid.push(key);
        break;
      case "page":
        if (NUMERIC_ID.test(id)) needs.pages.add(id);
        else needs.invalid.push(key);
        break;
      case "story": {
        const match = STORY_ID.exec(id);
        if (match) needs.pages.add(match[1]);
        else needs.invalid.push(key);
        break;
      }
    }
  }
}

function walk(value: unknown, needs: Needs, depth: number, topLevel: boolean): void {
  if (depth > 12) {
    needs.invalid.push("(too deep)");
    return;
  }
  if (typeof value === "string") {
    const parsed = parseJsonish(value);
    if (parsed !== undefined) walk(parsed, needs, depth + 1, false);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) walk(item, needs, depth + 1, false);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (child === undefined || child === null) continue;
    if (STATUS_ARGS.has(key) && typeof child === "string") needs.statusValues.push(child.toUpperCase());
    if (BUDGET_ARGS.has(key)) needs.budgetKeys.push(key);
    const role = ARG_ROLES[key];
    if (role) {
      applyRole(role, key, child, needs);
      if (role === "audience_list") continue;
    } else if (ID_LIKE_ARG.test(key) || (topLevel && key === "id")) {
      needs.denied.push(key);
      continue;
    }
    walk(child, needs, depth + 1, false);
  }
}

// ─── Resolution ───────────────────────────────────────────────────────

/** Owning ad account (act_<digits>) of a Graph object, or null. Cached 10 min. */
export async function resolveAccount(id: string, graphGet: GraphGet): Promise<string | null> {
  const hit = resolveCache.get(id);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.account;
  try {
    const body = (await graphGet(`/${id}`, { fields: "account_id" })) as { account_id?: unknown };
    const account = typeof body?.account_id === "string" ? normalizeAccount(body.account_id) : null;
    if (account) resolveCache.set(id, { at: Date.now(), account });
    return account;
  } catch {
    return null;
  }
}

async function effectiveStatus(id: string, graphGet: GraphGet): Promise<string | null> {
  try {
    const body = (await graphGet(`/${id}`, { fields: "effective_status" })) as { effective_status?: unknown };
    return typeof body?.effective_status === "string" ? body.effective_status : null;
  } catch {
    return null;
  }
}

async function promotePages(account: string, graphGet: GraphGet): Promise<Set<string>> {
  const hit = pagesCache.get(account);
  if (hit && Date.now() - hit.at < RESOLVE_TTL_MS) return hit.pages;
  try {
    const body = (await graphGet(`/${account}/promote_pages`, { fields: "id", limit: "500" })) as {
      data?: Array<{ id?: unknown }>;
    };
    const pages = new Set((body?.data ?? []).map((p) => String(p.id)));
    pagesCache.set(account, { at: Date.now(), pages });
    return pages;
  } catch {
    return new Set();
  }
}

function deny(reason: string): GuardDecision {
  return { allow: false, reason };
}

// ─── Guard ────────────────────────────────────────────────────────────

/** Decides one tool call for a tenant. Default deny. */
export async function guardToolCall(
  tenantId: string,
  tool: string,
  args: Record<string, unknown>,
  deps: { allowed?: AllowedAccounts; graphGet?: GraphGet } = {},
): Promise<GuardDecision> {
  const policy = TOOL_POLICY[tool];
  if (!policy) return deny(`Tool ${tool} is not available in Cuanto Ads.`);
  const graphGet = deps.graphGet ?? systemGraphGet;

  const nextArgs: Record<string, unknown> = { ...args };
  if (policy.kind === "create" && policy.forcePaused) nextArgs.status = "PAUSED";

  const needs: Needs = {
    accounts: new Set(),
    objects: new Set(),
    pages: new Set(),
    denied: [],
    invalid: [],
    statusValues: [],
    budgetKeys: [],
  };
  walk(nextArgs, needs, 0, true);

  if (needs.denied.length) return deny(`Arguments not allowed in Cuanto Ads: ${[...new Set(needs.denied)].join(", ")}.`);
  if (needs.invalid.length) return deny(`Invalid id in: ${[...new Set(needs.invalid)].join(", ")}.`);

  if (policy.kind === "create" && needs.statusValues.some((s) => s !== "PAUSED")) return deny(DASHBOARD_ONLY);
  if (policy.kind !== "create" && needs.statusValues.includes("ACTIVE")) return deny(DASHBOARD_ONLY);
  if (policy.kind === "update" && needs.budgetKeys.length) return deny(DASHBOARD_ONLY);

  const scoped = needs.accounts.size + needs.objects.size + needs.pages.size > 0;
  if (!scoped) {
    if (policy.kind === "read" && policy.unscoped) return { allow: true, args: nextArgs, account: null };
    return deny(`Tool ${tool} needs an ad account or object id.`);
  }

  const allowed = await (deps.allowed ?? allowedAdAccounts)(tenantId);
  for (const account of needs.accounts) {
    if (!allowed.has(account)) return deny(`Ad account ${account} is not connected to this workspace.`);
  }
  const resolved: string[] = [];
  for (const id of needs.objects) {
    const account = await resolveAccount(id, graphGet);
    if (!account || !allowed.has(account)) return deny(`Object ${id} is not in an ad account connected to this workspace.`);
    resolved.push(account);
  }
  if (needs.pages.size) {
    const pageSets = await Promise.all([...allowed.keys()].map((a) => promotePages(a, graphGet)));
    for (const page of needs.pages) {
      if (!pageSets.some((set) => set.has(page))) return deny(`Page ${page} is not promotable by a connected ad account.`);
    }
  }

  const retiring = policy.kind === "update" && needs.statusValues.some((s) => RETIRE_STATUSES.has(s));
  if (policy.kind === "delete" || retiring) {
    if (needs.objects.size !== 1) return deny("Deletes take exactly one object.");
    const [id] = needs.objects;
    if ((await effectiveStatus(id, graphGet)) !== "PAUSED") return deny("Pause the object before deleting or archiving it.");
  }

  const account = [...needs.accounts][0] ?? resolved[0] ?? null;
  return { allow: true, args: nextArgs, account };
}

// ─── Dispatch wrap ────────────────────────────────────────────────────

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError: true };

function denied(reason: string): ToolResult {
  return { content: [{ type: "text", text: `Refused: ${reason}` }], isError: true };
}

export function tenantForCall(): string | undefined {
  return currentTenantId() ?? stdioTenantId;
}

async function tokenFor(tenantId: string, account: string | null): Promise<string> {
  const path = account ? (await allowedAdAccounts(tenantId)).get(account) ?? "partner" : "partner";
  return getTokenStore().tokenForCall(tenantId, path);
}

/**
 * The single choke point (FORK.md): every handler registered after this call
 * runs only after guardToolCall allows it, on the token chosen for its account.
 */
export function wrapToolDispatch(
  server: McpServer,
  deps: { guard?: typeof guardToolCall; token?: typeof tokenFor } = {},
): void {
  const guard = deps.guard ?? guardToolCall;
  const token = deps.token ?? tokenFor;
  const original = server.registerTool.bind(server) as (...a: unknown[]) => unknown;
  (server as unknown as { registerTool: (...a: unknown[]) => unknown }).registerTool = (
    name: unknown,
    config: unknown,
    handler: unknown,
  ) => {
    const run = handler as (...a: unknown[]) => Promise<unknown>;
    const hasArgs = (config as { inputSchema?: unknown } | undefined)?.inputSchema !== undefined;
    const guarded = async (...callArgs: unknown[]) => {
      const tenantId = tenantForCall();
      if (!tenantId) return denied("no Cuanto tenant for this call.");
      const args = hasArgs ? ((callArgs[0] as Record<string, unknown> | undefined) ?? {}) : {};
      const decision = await guard(tenantId, String(name), args);
      if (!decision.allow) return denied(decision.reason);
      const accessToken = await token(tenantId, decision.account);
      const forwarded = hasArgs ? [decision.args, ...callArgs.slice(1)] : callArgs;
      return requestContext.run({ accessToken }, () => runWithTenant(tenantId, () => run(...forwarded)));
    };
    return original(name, config, guarded);
  };
}

// ─── HTTP auth ────────────────────────────────────────────────────────

/** `/mcp` auth in Cuanto mode: tenant only from `Authorization: Bearer <tenant key>`. */
export async function cuantoMcpAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
  const header = req.headers.authorization;
  const bearer = typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7).trim() : "";
  let tenantId: string | null = null;
  try {
    tenantId = bearer ? await resolveTenant(bearer) : null;
  } catch {
    tenantId = null;
  }
  if (!tenantId) {
    res.status(401).json({ jsonrpc: "2.0", error: { code: -32001, message: "Invalid or missing tenant key." }, id: null });
    return;
  }
  runWithTenant(tenantId, () => next());
}
