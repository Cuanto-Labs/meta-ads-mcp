import pg from "pg";
import { logger } from "../utils/logger.js";
import type { Db } from "./db.js";
import { accountsInEnvironment, resolveAccount, type GraphGet } from "./guard.js";
import { createGraph, MetaServiceError } from "./service.js";
import { isCuantoMode } from "./tenants.js";

/**
 * Metabase "Actions" can only write rows, so they write `ops.meta_commands` in the warehouse
 * and this worker executes them against Meta with the system-user token.
 */

const POLL_MS = 10_000;
const BATCH = 5;
const STALE_MS = 60 * 60_000;
const STUCK_MS = 5 * 60_000;
const MAX_ATTEMPTS = 2;
const DEFAULT_MAX_BUDGET_MINOR = 100_000;
const NUMERIC = /^\d{1,30}$/;
const ACT = /^act_\d{1,30}$/;
const DIGITS = /^\d{1,18}$/;
const KINDS = new Set(["campaign_status", "adset_status", "ad_status", "adset_daily_budget"]);

export interface CommandRow {
  id: number | string;
  created_at: Date | string;
  kind: string;
  target_id: string;
  meta_account_id: string;
  value: string;
}

export interface CommandDeps {
  db: Db;
  sleep?: (ms: number) => Promise<void>;
}

class Rejected extends Error {}

function maxBudget(): number {
  const n = Number(process.env.COMMAND_MAX_DAILY_BUDGET_MINOR);
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_MAX_BUDGET_MINOR;
}

function scrub(text: string): string {
  const token = process.env.META_SYSTEM_USER_TOKEN?.trim();
  const clean = token ? text.split(token).join("[redacted]") : text;
  return clean.replace(/EAA[A-Za-z0-9]{10,}/g, "[redacted]").slice(0, 500);
}

export async function claimCommands(db: Db): Promise<CommandRow[]> {
  const { rows } = await db.query<CommandRow>(
    `update ops.meta_commands
        set state = 'running', started_at = now(), attempts = attempts + 1
      where id in (
        select id from ops.meta_commands
         where state = 'queued'
         order by id
         limit ${BATCH}
         for update skip locked)
      returning id, created_at, kind, target_id, meta_account_id, value`,
  );
  return rows;
}

/** Rows stuck in `running` (worker died): back to `queued` once, then `failed`. */
export async function recoverStuckCommands(db: Db): Promise<void> {
  const cutoff = new Date(Date.now() - STUCK_MS);
  await db.query(
    "update ops.meta_commands set state = 'queued', started_at = null where state = 'running' and started_at < $1 and attempts < $2",
    [cutoff, MAX_ATTEMPTS],
  );
  await db.query(
    "update ops.meta_commands set state = 'failed', result = 'stuck in running after restart; gave up', done_at = now() where state = 'running' and started_at < $1 and attempts >= $2",
    [cutoff, MAX_ATTEMPTS],
  );
}

async function finish(db: Db, id: CommandRow["id"], state: "done" | "failed" | "rejected", result: string): Promise<void> {
  await db.query("update ops.meta_commands set state = $2, result = $3, done_at = now() where id = $1 and state = 'running'", [id, state, result]);
}

async function execute(row: CommandRow, graph: ReturnType<typeof createGraph>, graphGet: GraphGet): Promise<void> {
  if (!KINDS.has(row.kind)) throw new Rejected(`unknown kind ${row.kind}`);
  if (Date.now() - new Date(row.created_at).getTime() > STALE_MS) throw new Rejected("stale: queued for more than 1 h");
  if (!ACT.test(row.meta_account_id) || !(await accountsInEnvironment()).has(row.meta_account_id)) {
    throw new Rejected(`${row.meta_account_id} is not an active ad account`);
  }
  if (!NUMERIC.test(row.target_id)) throw new Rejected("target_id is malformed");
  const params: Record<string, string> = {};
  if (row.kind === "adset_daily_budget") {
    if (!DIGITS.test(row.value) || Number(row.value) <= 0) throw new Rejected("budget must be a positive integer in minor units");
    if (Number(row.value) >= maxBudget()) throw new Rejected(`budget ${row.value} is not below the cap ${maxBudget()}`);
    params.daily_budget = String(Number(row.value));
  } else {
    if (row.value !== "ACTIVE" && row.value !== "PAUSED") throw new Rejected("status must be ACTIVE or PAUSED");
    params.status = row.value;
  }
  const owner = await resolveAccount(row.target_id, graphGet);
  if (owner !== row.meta_account_id) throw new Rejected(`target ${row.target_id} does not belong to ${row.meta_account_id}`);

  const body = (await graph.call("POST", `/${row.target_id}`, params)) as { success?: unknown };
  if (body?.success !== true) throw new MetaServiceError("upstream", "Meta did not confirm success");
}

/** Claims up to 5 queued rows and runs them. Returns how many were claimed. */
export async function processCommands(deps: CommandDeps): Promise<number> {
  const graph = createGraph({ sleep: deps.sleep });
  const graphGet: GraphGet = (path, params) => graph.call("GET", path, params);
  const rows = await claimCommands(deps.db);
  for (const row of rows) {
    try {
      await execute(row, graph, graphGet);
      await finish(deps.db, row.id, "done", "ok");
    } catch (err) {
      if (err instanceof Rejected) await finish(deps.db, row.id, "rejected", err.message);
      else await finish(deps.db, row.id, "failed", scrub(err instanceof Error ? err.message : String(err)));
    }
  }
  return rows.length;
}

/** Starts the poller when cuanto mode and WAREHOUSE_URL are set. Returns a stop function, or undefined. */
export function startCommandWorker(db?: Db): (() => void) | undefined {
  const url = process.env.WAREHOUSE_URL?.trim();
  if (!isCuantoMode() || (!db && !url)) return undefined;
  const warehouse = db ?? (new pg.Pool({ connectionString: url, max: 2 }) as unknown as Db);
  let busy = false;
  const tick = async (): Promise<void> => {
    if (busy) return;
    busy = true;
    try {
      await recoverStuckCommands(warehouse);
      await processCommands({ db: warehouse });
    } catch (err) {
      logger.error({ err: scrub(err instanceof Error ? err.message : String(err)) }, "command worker tick failed");
    } finally {
      busy = false;
    }
  };
  void tick();
  const timer = setInterval(() => void tick(), POLL_MS);
  timer.unref();
  logger.info("meta command worker started");
  return () => clearInterval(timer);
}
