import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configureMcpDb, logCall, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { createTenantKey, currentTenantId, resolveTenant, revokeTenantKey, runWithTenant } from "../../src/cuanto/tenants.js";
import { memDb, TENANT_A } from "./helpers.js";

describe("tenant keys", () => {
  let db: Db;

  beforeEach(async () => {
    db = await memDb();
    configureMcpDb(db);
  });

  afterEach(() => resetMcpDbForTests());

  it("resolves a fresh key to its tenant and stores only the hash", async () => {
    const { key, keyHash } = await createTenantKey(TENANT_A, "agent");
    expect(key).toMatch(/^cak_[A-Za-z0-9]{40}$/);
    expect(keyHash).toBe(createHash("sha256").update(key).digest("hex"));
    expect(await resolveTenant(key)).toBe(TENANT_A);
    const { rows } = await db.query<{ key_hash: string }>("select key_hash from tenant_keys");
    expect(rows.map((r) => r.key_hash)).toEqual([keyHash]);
  });

  it("returns null for an unknown, empty or revoked key", async () => {
    const { key, keyHash } = await createTenantKey(TENANT_A, "agent");
    expect(await resolveTenant("cak_unknown")).toBeNull();
    expect(await resolveTenant("")).toBeNull();
    expect(await revokeTenantKey(keyHash)).toBe(true);
    expect(await resolveTenant(key)).toBeNull();
  });

  it("threads the tenant through async work", async () => {
    expect(currentTenantId()).toBeUndefined();
    await runWithTenant(TENANT_A, async () => {
      await Promise.resolve();
      expect(currentTenantId()).toBe(TENANT_A);
    });
  });

  it("logs Graph calls to call_log", async () => {
    await logCall({ tenantId: TENANT_A, path: "/act_1/insights", httpStatus: 200, metaCode: null });
    await logCall({ tenantId: null, path: "/me", httpStatus: 400, metaCode: 190 });
    const { rows } = await db.query<{ http_status: number; meta_code: number | null }>(
      "select http_status, meta_code from call_log order by http_status",
    );
    expect(rows).toEqual([{ http_status: 200, meta_code: null }, { http_status: 400, meta_code: 190 }]);
  });
});
