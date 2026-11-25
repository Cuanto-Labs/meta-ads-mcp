import { decryptToken, encryptToken, type EncryptedPayload } from "../auth/crypto.js";
import type { MetaProfile } from "../auth/meta-oauth.js";
import type {
  MetaTokenRepo,
  MetaTokenSummary,
  SaveTokenInput,
  TokenKind,
  UserDoc,
} from "../store/meta-token-repo.js";
import { getMcpDb, runMigrations, type Db } from "./db.js";
import { currentTenantId } from "./tenants.js";

export type AccessPath = "partner" | "login";

function aadFor(tenantId: string, userKey: string): string {
  return `cuanto_token:${tenantId}:${userKey}`;
}

function requireTenant(): string {
  const tenantId = currentTenantId();
  if (!tenantId) throw new Error("No Cuanto tenant in context: token store access refused");
  return tenantId;
}

interface TokenRow {
  user_key: string;
  sealed_token: string;
  kind: TokenKind;
}

/**
 * MetaTokenRepo on the fork's Postgres `mcp_tokens`, one row per (tenant, Facebook user).
 * Upstream's per-user token names collapse to that single row: the name is the user key.
 */
export class PgTokenStore implements MetaTokenRepo {
  constructor(private readonly db: Db = getMcpDb()) {}

  async saveTenantToken(input: { tenantId: string; userKey: string; token: string; kind: TokenKind }): Promise<void> {
    const sealed = JSON.stringify(encryptToken(input.token, aadFor(input.tenantId, input.userKey)));
    await this.db.query(
      `insert into mcp_tokens (tenant_id, user_key, sealed_token, kind, updated_at)
       values ($1, $2, $3, $4, now())
       on conflict (tenant_id, user_key)
       do update set sealed_token = excluded.sealed_token, kind = excluded.kind, updated_at = now()`,
      [input.tenantId, input.userKey, sealed, input.kind],
    );
  }

  async getTenantToken(tenantId: string, userKey: string): Promise<string | null> {
    const row = await this.row(tenantId, userKey);
    return row ? this.open(tenantId, row) : null;
  }

  /** Token for one Graph call: the tenant's newest user token on a login-path account, else the system user. */
  async tokenForCall(tenantId: string, accessPath: AccessPath): Promise<string> {
    if (accessPath === "login") {
      const { rows } = await this.db.query<TokenRow>(
        "select user_key, sealed_token, kind from mcp_tokens where tenant_id = $1 and kind = 'user' order by updated_at desc limit 1",
        [tenantId],
      );
      if (rows[0]) return this.open(tenantId, rows[0]);
    }
    const systemToken = process.env.META_SYSTEM_USER_TOKEN?.trim();
    if (!systemToken) throw new Error("META_SYSTEM_USER_TOKEN is not configured");
    return systemToken;
  }

  async upsertUser(_fbUserId: string, _profile: MetaProfile): Promise<void> {
    // Profiles live in cuanto-ads; the fork keeps tokens only.
  }

  async getUser(_fbUserId: string): Promise<UserDoc | null> {
    return null;
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    await this.saveTenantToken({ tenantId: requireTenant(), userKey: input.fbUserId, token: input.accessToken, kind: input.kind });
  }

  async setDefaultToken(fbUserId: string, _name: string): Promise<boolean> {
    return (await this.row(requireTenant(), fbUserId)) !== null;
  }

  async deleteToken(fbUserId: string, _name: string): Promise<boolean> {
    const { rows } = await this.db.query<{ user_key: string }>(
      "delete from mcp_tokens where tenant_id = $1 and user_key = $2 returning user_key",
      [requireTenant(), fbUserId],
    );
    return rows.length > 0;
  }

  async listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
    const row = await this.row(requireTenant(), fbUserId);
    if (!row) return [];
    return [{
      name: row.user_key,
      kind: row.kind,
      expiresAt: null,
      metaUserId: row.user_key,
      metaUserName: null,
      businessId: null,
      businessName: null,
      isDefault: true,
      isExpired: false,
    }];
  }

  async getDefaultTokenName(fbUserId: string): Promise<string | null> {
    return (await this.row(requireTenant(), fbUserId))?.user_key ?? null;
  }

  async getDecryptedToken(fbUserId: string, _name?: string, _serverUrl?: URL): Promise<string> {
    const tenantId = requireTenant();
    const row = await this.row(tenantId, fbUserId);
    if (!row) throw new Error(`No Meta token registered for user ${fbUserId}`);
    return this.open(tenantId, row);
  }

  private async row(tenantId: string, userKey: string): Promise<TokenRow | null> {
    const { rows } = await this.db.query<TokenRow>(
      "select user_key, sealed_token, kind from mcp_tokens where tenant_id = $1 and user_key = $2",
      [tenantId, userKey],
    );
    return rows[0] ?? null;
  }

  private open(tenantId: string, row: TokenRow): string {
    return decryptToken(JSON.parse(row.sealed_token) as EncryptedPayload, aadFor(tenantId, row.user_key));
  }
}

/** The repo selected by `STORE_BACKEND=postgres`, or null to keep upstream's choice. */
export function postgresTokenRepoFromEnv(): PgTokenStore | null {
  return process.env.STORE_BACKEND?.trim() === "postgres" ? new PgTokenStore() : null;
}

/** Startup hook: with `STORE_BACKEND=postgres`, migrate the `mcp` database and make PgTokenStore the token repo. */
export async function configureCuantoStore(configure: (repo: MetaTokenRepo) => void): Promise<boolean> {
  const repo = postgresTokenRepoFromEnv();
  if (!repo) return false;
  await runMigrations(getMcpDb());
  configure(repo);
  return true;
}
