import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";
import { configureMcpDb, resetMcpDbForTests, type Db } from "../../src/cuanto/db.js";
import { configureCuantoStore, PgTokenStore } from "../../src/cuanto/pg-store.js";
import { runWithTenant } from "../../src/cuanto/tenants.js";
import { HEX64, memDb, TENANT_A, TENANT_B } from "./helpers.js";

const USER_TOKEN = "user-token-plaintext-1";
const SYSTEM_TOKEN = "system-user-token-plaintext";

describe("PgTokenStore", () => {
  let db: Db;
  let store: PgTokenStore;

  beforeEach(async () => {
    vi.stubEnv("TOKEN_ENCRYPTION_KEY", HEX64);
    vi.stubEnv("META_SYSTEM_USER_TOKEN", SYSTEM_TOKEN);
    resetKeyCacheForTests();
    db = await memDb();
    store = new PgTokenStore(db);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetKeyCacheForTests();
  });

  it("round-trips a token for a tenant", async () => {
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: USER_TOKEN, kind: "user" });
    expect(await store.getTenantToken(TENANT_A, "1001")).toBe(USER_TOKEN);
  });

  it("never stores the plaintext", async () => {
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: USER_TOKEN, kind: "user" });
    const { rows } = await db.query<{ sealed_token: string }>("select sealed_token from mcp_tokens");
    expect(rows).toHaveLength(1);
    expect(rows[0].sealed_token).not.toContain(USER_TOKEN);
  });

  it("overwrites on the same tenant and user key", async () => {
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: "first", kind: "user" });
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: "second", kind: "user" });
    const { rows } = await db.query("select * from mcp_tokens");
    expect(rows).toHaveLength(1);
    expect(await store.getTenantToken(TENANT_A, "1001")).toBe("second");
  });

  it("keeps tenants apart: a ciphertext cannot be read under another tenant", async () => {
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: USER_TOKEN, kind: "user" });
    await db.query("update mcp_tokens set tenant_id = $1", [TENANT_B]);
    await expect(store.getTenantToken(TENANT_B, "1001")).rejects.toThrow();
    expect(await store.getTenantToken(TENANT_A, "1001")).toBeNull();
  });

  it("returns upstream's empty values for an unknown user", async () => {
    await runWithTenant(TENANT_A, async () => {
      expect(await store.listTokens("404")).toEqual([]);
      expect(await store.getDefaultTokenName("404")).toBeNull();
      expect(await store.getUser("404")).toBeNull();
      await expect(store.getDecryptedToken("404")).rejects.toThrow("No Meta token registered for user 404");
    });
  });

  it("implements the upstream repo interface inside a tenant context", async () => {
    await runWithTenant(TENANT_A, async () => {
      await store.saveToken({
        fbUserId: "1001", name: "default", accessToken: USER_TOKEN, kind: "user",
        expiresAt: null, metaUserId: "1001", metaUserName: null,
      });
      expect(await store.getDecryptedToken("1001")).toBe(USER_TOKEN);
      expect((await store.listTokens("1001")).map((t) => t.kind)).toEqual(["user"]);
      expect(await store.deleteToken("1001", "default")).toBe(true);
      expect(await store.listTokens("1001")).toEqual([]);
    });
  });

  it("refuses repo calls with no tenant in context", async () => {
    await expect(store.getDecryptedToken("1001")).rejects.toThrow(/tenant/i);
  });

  it("chooses the system-user token for a partner tenant with no user row", async () => {
    expect(await store.tokenForCall(TENANT_A, "partner")).toBe(SYSTEM_TOKEN);
    expect(await store.tokenForCall(TENANT_A, "login")).toBe(SYSTEM_TOKEN);
  });

  it("chooses the tenant's user token for a login-path account", async () => {
    await store.saveTenantToken({ tenantId: TENANT_A, userKey: "1001", token: USER_TOKEN, kind: "user" });
    expect(await store.tokenForCall(TENANT_A, "login")).toBe(USER_TOKEN);
    expect(await store.tokenForCall(TENANT_A, "partner")).toBe(SYSTEM_TOKEN);
    expect(await store.tokenForCall(TENANT_B, "login")).toBe(SYSTEM_TOKEN);
  });

  it("fails closed when no system-user token is configured", async () => {
    vi.stubEnv("META_SYSTEM_USER_TOKEN", "");
    await expect(store.tokenForCall(TENANT_A, "partner")).rejects.toThrow(/META_SYSTEM_USER_TOKEN/);
  });
});

describe("STORE_BACKEND=postgres", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    resetMcpDbForTests();
  });

  it("migrates and installs PgTokenStore as the token repo", async () => {
    vi.stubEnv("STORE_BACKEND", "postgres");
    configureMcpDb(await memDb());
    const configure = vi.fn();
    expect(await configureCuantoStore(configure)).toBe(true);
    expect(configure.mock.calls[0][0]).toBeInstanceOf(PgTokenStore);
  });

  it("leaves upstream's store alone otherwise", async () => {
    vi.stubEnv("STORE_BACKEND", "");
    const configure = vi.fn();
    expect(await configureCuantoStore(configure)).toBe(false);
    expect(configure).not.toHaveBeenCalled();
  });
});
