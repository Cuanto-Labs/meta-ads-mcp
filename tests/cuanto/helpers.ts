import { newDb } from "pg-mem";
import type { Db } from "../../src/cuanto/db.js";
import { runMigrations } from "../../src/cuanto/db.js";

export const TENANT_A = "11111111-1111-4111-8111-111111111111";
export const TENANT_B = "22222222-2222-4222-8222-222222222222";
export const HEX64 = "a".repeat(64);

export async function memDb(): Promise<Db> {
  const mem = newDb();
  const { Pool } = mem.adapters.createPg();
  const pool = new Pool() as unknown as Db;
  await runMigrations(pool);
  return pool;
}
