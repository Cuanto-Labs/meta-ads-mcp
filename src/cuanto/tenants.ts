import { AsyncLocalStorage } from "node:async_hooks";
import { createHash, randomInt } from "node:crypto";
import { getMcpDb, type Db } from "./db.js";

const tenantContext = new AsyncLocalStorage<{ tenantId: string }>();

export function runWithTenant<T>(tenantId: string, fn: () => T): T {
  return tenantContext.run({ tenantId }, fn);
}

export function currentTenantId(): string | undefined {
  return tenantContext.getStore()?.tenantId;
}

export function hashTenantKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

const KEY_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randomKey(length: number): string {
  let out = "";
  for (let i = 0; i < length; i++) out += KEY_ALPHABET[randomInt(KEY_ALPHABET.length)];
  return out;
}

/** The tenant a bearer key belongs to, or null when unknown or revoked. */
export async function resolveTenant(bearer: string, db: Db = getMcpDb()): Promise<string | null> {
  if (!bearer) return null;
  const { rows } = await db.query<{ tenant_id: string }>(
    "select tenant_id from tenant_keys where key_hash = $1 and revoked_at is null",
    [hashTenantKey(bearer)],
  );
  return rows[0]?.tenant_id ?? null;
}

/** Mints a key; the plaintext is returned once and never stored. */
export async function createTenantKey(
  tenantId: string,
  label: string | null,
  db: Db = getMcpDb(),
): Promise<{ key: string; keyHash: string }> {
  const key = `cak_${randomKey(40)}`;
  const keyHash = hashTenantKey(key);
  await db.query("insert into tenant_keys (key_hash, tenant_id, label) values ($1, $2, $3)", [keyHash, tenantId, label]);
  return { key, keyHash };
}

export async function revokeTenantKey(keyHash: string, db: Db = getMcpDb()): Promise<boolean> {
  const { rows } = await db.query<{ key_hash: string }>(
    "update tenant_keys set revoked_at = now() where key_hash = $1 and revoked_at is null returning key_hash",
    [keyHash],
  );
  return rows.length > 0;
}

/** One switch for the whole fork mode: Postgres store, tenant keys and the tenant guard go together. */
export function isCuantoMode(): boolean {
  return process.env.STORE_BACKEND?.trim() === "postgres";
}
