import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_META_API_VERSION } from "../../src/meta/api-version.js";
import { MetaApiClient } from "../../src/meta/client.js";
import { buildAuthorizeUrl, fetchPrimaryBusiness, loadMetaOAuthConfig } from "../../src/auth/meta-oauth.js";
import { registerAudienceTools } from "../../src/tools/audiences.js";
import { cleanupTestToken, createMockMcpServer, mockFetchResponse, setupTestToken } from "../setup.js";

const ROOT = join(import.meta.dirname, "..", "..");
const V27 = "https://graph.facebook.com/v27.0/";

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? sourceFiles(path) : path.endsWith(".ts") ? [path] : [];
  });
}

describe("Marketing API v27", () => {
  beforeEach(() => {
    vi.stubEnv("META_API_VERSION", undefined);
    vi.stubEnv("META_APP_ID", "1234567890");
    vi.stubEnv("META_APP_SECRET", "dummy-secret");
    setupTestToken();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("defaults to v27.0", () => {
    expect(DEFAULT_META_API_VERSION).toBe("v27.0");
  });

  it("builds every Graph URL on v27.0", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse({ data: [] }));
    vi.stubGlobal("fetch", fetchMock);

    const client = new MetaApiClient({ maxRetries: 0 });
    await client.get("/me/adaccounts");
    await client.postForm("/act_1/campaigns", { name: "x" });
    await client.delete("/123");
    await fetchPrimaryBusiness("token-x");

    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.length).toBe(4);
    for (const url of urls) expect(url.startsWith(V27)).toBe(true);

    const config = loadMetaOAuthConfig(new URL("https://mcp.example.com"));
    expect(new URL(buildAuthorizeUrl(config!, "s")).pathname.startsWith("/v27.0/")).toBe(true);
  });

  it("creates lookalikes without country or location_spec in lookalike_spec", async () => {
    const fetchMock = vi.fn(async () => mockFetchResponse({ id: "999" }));
    vi.stubGlobal("fetch", fetchMock);
    const server = createMockMcpServer();
    registerAudienceTools(server as never);
    const tool = server._registeredTools.find((t) => t.name === "ads_create_lookalike_audience")!;

    await tool.handler({ account_id: "act_1", name: "LAL", origin_audience_id: "123", ratio: 0.01, country: "US" });

    const body = new URLSearchParams(String((fetchMock.mock.calls[0] as unknown[] as [string, RequestInit])[1].body));
    const spec = JSON.parse(body.get("lookalike_spec")!) as Record<string, unknown>;
    expect(spec).not.toHaveProperty("country");
    expect(spec).not.toHaveProperty("location_spec");
    expect(spec.ratio).toBe(0.01);
  });

  it("no longer uses shapes v27 removed", () => {
    const offenders = sourceFiles(join(ROOT, "src")).filter((file) => {
      const text = readFileSync(file, "utf8");
      return (
        /\/batch["'`]/.test(text) ||
        /total_video_consumption_rate/.test(text) ||
        /lookalike_spec[\s\S]{0,200}\b(country|location_spec)\b\s*[,:}]/.test(text.replace(/\/\/.*$/gm, ""))
      );
    });
    expect(offenders.map((f) => f.slice(ROOT.length + 1))).toEqual([]);
  });
});
