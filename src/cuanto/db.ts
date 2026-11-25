import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pg from "pg";

export interface Db {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
}

const MIGRATIONS_DIR = new URL("../../migrations/", import.meta.url);

let mcpDb: Db | undefined;

/** The fork's own database (`MCP_DATABASE_URL`). Fails closed when unset. */
export function getMcpDb(): Db {
  if (mcpDb) return mcpDb;
  const url = process.env.MCP_DATABASE_URL?.trim();
  if (!url) throw new Error("MCP_DATABASE_URL is not set");
  mcpDb = new pg.Pool({ connectionString: url, max: 5 }) as unknown as Db;
  return mcpDb;
}

export function configureMcpDb(db: Db): void {
  mcpDb = db;
}

export function resetMcpDbForTests(): void {
  mcpDb = undefined;
}

async function appliedMigrations(db: Db): Promise<string[]> {
  try {
    const { rows } = await db.query<{ name: string }>("select name from cuanto_migrations");
    return rows.map((r) => r.name);
  } catch {
    await db.query("create table cuanto_migrations (name text primary key, applied_at timestamptz not null default now())");
    return [];
  }
}

export async function runMigrations(db: Db, dir: URL = MIGRATIONS_DIR): Promise<string[]> {
  const path = dir.pathname;
  const files = readdirSync(path).filter((f) => f.endsWith(".sql")).sort();
  const applied = new Set(await appliedMigrations(db));
  const ran: string[] = [];
  for (const file of files.filter((f) => !applied.has(f))) {
    await db.query(readFileSync(join(path, file), "utf8"));
    await db.query("insert into cuanto_migrations (name) values ($1)", [file]);
    ran.push(file);
  }
  return ran;
}

export interface CallLogEntry {
  tenantId: string | null;
  path: string;
  httpStatus: number;
  metaCode: number | null;
}

export async function logCall(entry: CallLogEntry, db: Db = getMcpDb()): Promise<void> {
  await db.query(
    "insert into call_log (tenant_id, path, http_status, meta_code) values ($1, $2, $3, $4)",
    [entry.tenantId, entry.path, entry.httpStatus, entry.metaCode],
  );
}
