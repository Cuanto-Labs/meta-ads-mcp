import { createHmac, timingSafeEqual } from "node:crypto";
import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { resolveMetaApiVersion } from "../meta/api-version.js";
import { logCall } from "./db.js";
import { accountsInEnvironment, resolveAccount, type AccountStatus, type GraphGet } from "./guard.js";
import { PgTokenStore } from "./pg-store.js";
import { createTenantKey, revokeTenantKey } from "./tenants.js";

/**
 * Small allowlisted HTTP API for cuanto-ads (FORK.md, Task 1.4). Every call to
 * Meta uses the system-user token with appsecret_proof. Cloudflare Access guards
 * the edge; the bearer secret below is checked here as well.
 */

const GRAPH = "https://graph.facebook.com";
const TASKS = JSON.stringify(["MANAGE", "ADVERTISE", "ANALYZE"]);
const RETRY_DELAYS_MS = [1_000, 4_000, 16_000];
const RETRYABLE_CODES = new Set([4, 17, 32, 613]);
const ACT = /^act_\d{1,30}$/;
const NUMERIC = /^\d{1,30}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HASH = /^[0-9a-f]{64}$/;
const MAX_LIST_PAGES = 50;

export type MetaErrorKind = "auth" | "capability_unavailable" | "rate_limited" | "invalid" | "network" | "upstream";

export class MetaServiceError extends Error {
  constructor(
    readonly kind: MetaErrorKind,
    message: string,
    readonly code: number | null = null,
    readonly httpStatus: number | null = null,
  ) {
    super(message);
  }
}

function isRetryableCode(code: number): boolean {
  return RETRYABLE_CODES.has(code) || (code >= 80000 && code <= 80014);
}

function kindFor(code: number): MetaErrorKind {
  if (code === 190 || code === 102) return "auth";
  if (code === 3) return "capability_unavailable";
  if (isRetryableCode(code)) return "rate_limited";
  return "invalid";
}

export interface ServiceDeps {
  sleep?: (ms: number) => Promise<void>;
  tokenStore?: PgTokenStore;
}

interface Credentials {
  token: string;
  proof: string;
}

function credentials(): Credentials {
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  const secret = process.env.META_APP_SECRET?.trim();
  if (!token || !secret) throw new MetaServiceError("auth", "META_SYSTEM_USER_TOKEN and META_APP_SECRET must be set");
  return { token, proof: createHmac("sha256", secret).update(token).digest("hex") };
}

function scrub(text: string, token: string): string {
  return token ? text.split(token).join("[redacted]") : text;
}

export function createGraph(deps: ServiceDeps = {}) {
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function once(method: "GET" | "POST", path: string, params: Record<string, string>): Promise<unknown> {
    const { token, proof } = credentials();
    const url = new URL(`${GRAPH}/${resolveMetaApiVersion()}${path}`);
    const fields = { ...params, access_token: token, appsecret_proof: proof };
    let init: RequestInit = { method };
    if (method === "GET") {
      for (const [k, v] of Object.entries(fields)) url.searchParams.set(k, v);
    } else {
      init = { method, headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields).toString() };
    }

    let response: globalThis.Response;
    try {
      response = await fetch(url.toString(), init);
    } catch (err) {
      throw new MetaServiceError("network", scrub(err instanceof Error ? err.message : String(err), token));
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch {
      const kind: MetaErrorKind = response.status >= 500 ? "network" : "upstream";
      void logCall({ tenantId: null, path, httpStatus: response.status, metaCode: null }).catch(() => {});
      throw new MetaServiceError(kind, `Meta returned a non-JSON ${response.status} response`, null, response.status);
    }

    const error = (body as { error?: { code?: unknown; message?: unknown } } | null)?.error;
    const code = typeof error?.code === "number" ? error.code : null;
    void logCall({ tenantId: null, path, httpStatus: response.status, metaCode: code }).catch(() => {});
    if (error) {
      const message = scrub(typeof error.message === "string" ? error.message : "Meta error", token);
      throw new MetaServiceError(code === null ? "upstream" : kindFor(code), message, code, response.status);
    }
    if (!response.ok) throw new MetaServiceError(response.status >= 500 ? "network" : "upstream", `Meta returned ${response.status}`, null, response.status);
    return body;
  }

  async function call(method: "GET" | "POST", path: string, params: Record<string, string> = {}): Promise<unknown> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await once(method, path, params);
      } catch (err) {
        const retryable =
          err instanceof MetaServiceError &&
          (err.kind === "network" || (err.code !== null && isRetryableCode(err.code)));
        if (!retryable || attempt >= RETRY_DELAYS_MS.length) throw err;
        await sleep(RETRY_DELAYS_MS[attempt]);
      }
    }
  }

  return { call, once };
}

function secretMatches(header: string | undefined): boolean {
  const secret = process.env.CUANTO_SERVICE_SECRET?.trim();
  if (!secret || !header?.startsWith("Bearer ")) return false;
  const given = Buffer.from(header.slice(7).trim());
  const expected = Buffer.from(secret);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

class BadRequest extends Error {}

function field(body: unknown, name: string, pattern: RegExp): string {
  const value = (body as Record<string, unknown> | undefined)?.[name];
  if (typeof value !== "string" || !pattern.test(value)) throw new BadRequest(`${name} is missing or malformed`);
  return value;
}

function businessId(): string {
  const id = process.env.META_BUSINESS_ID?.trim();
  if (!id || !NUMERIC.test(id)) throw new MetaServiceError("invalid", "META_BUSINESS_ID is not set");
  return id;
}

function num(value: unknown): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : 0;
}

export function createCuantoServiceRouter(deps: ServiceDeps = {}): Router {
  const router = express.Router();
  const graph = createGraph(deps);
  const graphGet: GraphGet = (path, params) => graph.call("GET", path, params);
  let tokenStore = deps.tokenStore;
  let appScopedUserId: string | undefined;

  async function systemUserId(): Promise<string> {
    if (appScopedUserId) return appScopedUserId;
    const me = (await graph.call("GET", "/me", { fields: "id" })) as { id?: unknown };
    if (typeof me?.id !== "string" || !NUMERIC.test(me.id)) throw new MetaServiceError("upstream", "GET /me returned no id");
    appScopedUserId = me.id;
    return appScopedUserId;
  }

  async function requireActiveAccount(act: string, statuses: AccountStatus[] = ["active"]): Promise<void> {
    if (!(await accountsInEnvironment(statuses)).has(act)) throw new BadRequest(`${act} is not an ${statuses.join(" or ")} ad account`);
  }

  async function requireActiveObject(id: string): Promise<void> {
    const account = await resolveAccount(id, graphGet);
    if (!account || !(await accountsInEnvironment()).has(account)) {
      throw new BadRequest(`${id} is not in an active ad account`);
    }
  }

  router.use(express.json({ limit: "64kb" }));
  router.use((req: Request, res: Response, next: NextFunction) => {
    if (!secretMatches(req.headers.authorization)) {
      res.status(401).json({ error: { kind: "unauthorized" } });
      return;
    }
    next();
  });

  const handle =
    (fn: (req: Request) => Promise<unknown>) =>
    async (req: Request, res: Response): Promise<void> => {
      try {
        res.json(await fn(req));
      } catch (err) {
        if (err instanceof BadRequest) {
          res.status(400).json({ error: { kind: "bad_request", message: err.message } });
        } else if (err instanceof MetaServiceError) {
          const status = err.kind === "capability_unavailable" ? 409 : err.kind === "auth" ? 502 : err.kind === "invalid" ? 422 : 503;
          res.status(status).json({ error: { kind: err.kind, code: err.code, message: err.message } });
        } else {
          res.status(500).json({ error: { kind: "internal" } });
        }
      }
    };

  router.get("/health", handle(async () => {
    await graph.call("GET", "/me", { fields: "id" });
    return { ok: true };
  }));

  // PROVISIONAL: confirm against META-ACCESS.md. At the Limited tier this returns (#3) → capability_unavailable (409).
  router.post("/access/request", handle(async (req) => {
    const act = field(req.body, "meta_account_id", ACT);
    const body = (await graph.call("POST", `/${businessId()}/client_ad_accounts`, { adaccount_id: act, permitted_tasks: TASKS })) as {
      access_status?: unknown;
    };
    return { access_status: typeof body?.access_status === "string" ? body.access_status : "PENDING" };
  }));

  router.get("/access/list", handle(async () => {
    const accounts: Array<{ meta_account_id: string; name: string }> = [];
    let complete = true;
    let path: string | null = `/${businessId()}/client_ad_accounts`;
    let params: Record<string, string> = { fields: "id,name", limit: "100" };
    for (let page = 0; path && page < MAX_LIST_PAGES; page++) {
      let body: { data?: Array<{ id?: unknown; name?: unknown }>; paging?: { next?: unknown; cursors?: { after?: unknown } } };
      try {
        body = (await graph.call("GET", path, params)) as typeof body;
      } catch {
        complete = false;
        break;
      }
      for (const row of body?.data ?? []) {
        if (typeof row.id === "string" && ACT.test(row.id)) accounts.push({ meta_account_id: row.id, name: typeof row.name === "string" ? row.name : "" });
      }
      const after = body?.paging?.cursors?.after;
      if (body?.paging?.next && typeof after === "string") params = { ...params, after };
      else path = null;
      if (path && page === MAX_LIST_PAGES - 1) complete = false;
    }
    return { accounts, complete };
  }));

  router.post("/access/assign", handle(async (req) => {
    const act = field(req.body, "meta_account_id", ACT);
    // Confirm in cuanto-ads assigns first, then marks the row active.
    await requireActiveAccount(act, ["active", "awaiting_operator"]);
    const user = await systemUserId();
    const body = (await graph.call("POST", `/${act}/assigned_users`, { user, tasks: TASKS })) as { success?: unknown };
    return { ok: body?.success === true };
  }));

  router.get("/insights", handle(async (req) => {
    const act = field(req.query, "meta_account_id", ACT);
    const preset = typeof req.query.date_preset === "string" && /^[a-z_0-9]{1,20}$/.test(req.query.date_preset) ? req.query.date_preset : "last_7d";
    await requireActiveAccount(act);
    const body = (await graph.call("GET", `/${act}/insights`, { date_preset: preset, fields: "spend,impressions,clicks,ctr" })) as {
      data?: Array<Record<string, unknown>>;
    };
    const row = body?.data?.[0] ?? {};
    return { spend: num(row.spend), impressions: num(row.impressions), clicks: num(row.clicks), ctr: num(row.ctr) };
  }));

  router.post("/campaigns/:id/status", handle(async (req) => {
    const id = String(req.params.id);
    if (!NUMERIC.test(id)) throw new BadRequest("campaign id is malformed");
    const status = (req.body as { status?: unknown })?.status;
    if (status !== "ACTIVE" && status !== "PAUSED") throw new BadRequest("status must be ACTIVE or PAUSED");
    await requireActiveObject(id);
    const body = (await graph.call("POST", `/${id}`, { status })) as { success?: unknown };
    return { ok: body?.success === true };
  }));

  router.post("/adsets/:id/budget", handle(async (req) => {
    const id = String(req.params.id);
    if (!NUMERIC.test(id)) throw new BadRequest("ad set id is malformed");
    const budget = (req.body as { daily_budget?: unknown })?.daily_budget;
    if (typeof budget !== "number" || !Number.isInteger(budget) || budget <= 0) throw new BadRequest("daily_budget must be a positive integer (minor units)");
    await requireActiveObject(id);
    const body = (await graph.call("POST", `/${id}`, { daily_budget: String(budget) })) as { success?: unknown };
    return { ok: body?.success === true };
  }));

  router.post("/tokens", handle(async (req) => {
    const tenantId = field(req.body, "tenant_id", UUID);
    const userKey = field(req.body, "fb_user_id", NUMERIC);
    const token = field(req.body, "token", /^\S{20,4096}$/);
    tokenStore ??= new PgTokenStore();
    await tokenStore.saveTenantToken({ tenantId, userKey, token, kind: "user" });
    return { ok: true };
  }));

  router.post("/tenant-keys", handle(async (req) => {
    const tenantId = field(req.body, "tenant_id", UUID);
    const label = (req.body as { label?: unknown })?.label;
    const { key, keyHash } = await createTenantKey(tenantId, typeof label === "string" ? label.slice(0, 100) : null);
    return { key, key_hash: keyHash };
  }));

  router.delete("/tenant-keys/:hash", handle(async (req) => {
    const hash = String(req.params.hash);
    if (!HASH.test(hash)) throw new BadRequest("hash is malformed");
    return { ok: await revokeTenantKey(hash) };
  }));

  router.use((_req: Request, res: Response) => {
    res.status(404).json({ error: { kind: "not_found" } });
  });

  return router;
}
