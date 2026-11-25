# FORK.md: what this fork changes, and how to take upstream updates

`Cuanto-Labs/meta-ads-mcp` is a fork of `byadsco/meta-ads-mcp` (MIT). Upstream = remote `upstream`, branch `main`.
Our branches: `dev` (default) → `staging` → `main`. This file is the map every fork-only change is written against.

## Where the fork stands (measured 2026-11-25)

- Base: upstream v4.0.0, commit `7c8c631` (pushed 2026-11-23), Graph default `v26.0`.
- Baseline gates: `npm ci && npm run lint && npm test` → lint clean; **2448 passed, 7 skipped** (114 files + 1 skipped).
- Gates before every commit: `npm run lint && npm run typecheck && npm test` (repo's own rule adds `npm run build` + gitleaks before push).
- Apify (`APIFY_TOKEN`) and Gemini (`GEMINI_API_KEY`) add-ons stay unconfigured; their tools are denied by the tenant guard.

## Upstream surfaces the fork hooks into

| What | Where | Name |
|---|---|---|
| Token-store interface | `src/store/meta-token-repo.ts:95` | `interface MetaTokenRepo` (`upsertUser`, `getUser`, `saveToken`, `setDefaultToken`, `deleteToken`, `listTokens`, `getDefaultTokenName`, `getDecryptedToken`) |
| Token-store implementations | `src/store/meta-token-repo.ts:204,350` | `FirestoreMetaTokenRepo`, `InMemoryMetaTokenRepo` |
| Token-store factory | `src/store/meta-token-repo.ts:486-498` | module `activeRepo` + `configureMetaTokenRepo(repo)` / `getMetaTokenRepo()`; called from `configureMultiTenantOAuth()` in `src/transport/http.ts:456` |
| Token encryption | `src/auth/crypto.ts` | `encryptToken(plaintext, aad)` → `EncryptedPayload`, `decryptToken(payload, aad)`; key `TOKEN_ENCRYPTION_KEY` (AES-256-GCM) |
| Per-request token | `src/auth/token-store.ts:18,28` | `requestContext` (AsyncLocalStorage `{accessToken, fbUserId?}`), `getAccessToken()` |
| Tool dispatch (single choke point) | `src/server.ts:39` | `createServer()` → `registerAllTools(server)` (`src/tools/index.ts:54`); every tool is added with `server.registerTool(name, config, handler)`, so wrapping `server.registerTool` inside `createServer()` before `registerAllTools` puts every call through one function. Used by both `/mcp` (`src/transport/http.ts:763`, one server per request) and stdio (`src/index.ts:36`). |
| Graph client | `src/meta/client.ts:97,606` | `class MetaApiClient`, singleton `metaApiClient`; URLs from `buildUrl()` (`:248`) = `https://graph.facebook.com/<apiVersion><path>` |
| API version | `src/meta/api-version.ts:1` | `DEFAULT_META_API_VERSION`, `resolveMetaApiVersion()` (env `META_API_VERSION`) |
| Account id normalizer | `src/utils/format.ts:9` | `normalizeAccountId(id)` → `act_<digits>`, rejects anything else |
| HTTP auth | `src/transport/http.ts:294,342,757` | `createCombinedAuthMiddleware` (API key / OAuth), `buildMetaTokenMiddleware` (**honors `X-Meta-Token` header: must be off in Cuanto mode**), `app.post("/mcp", auth, metaTokenMw, …)` |
| Annotation kinds | `src/tools/_register.ts` | `READ`, `CREATE`, `UPDATE`, `DELETE`, `TOGGLE`, `UPLOAD`, `TOKEN` (kind below is derived from these) |

## Outbound hosts (from `src/`)

- `graph.facebook.com` (`src/meta/client.ts:22`, `src/auth/meta-oauth.ts:4`): every Graph call.
- `www.facebook.com` (OAuth dialog, links in tool text only), `api.apify.com` (`src/apify/client.ts`, unconfigured), Gemini `generativelanguage.googleapis.com` via `src/gemini/` (unconfigured), plus media downloads through `src/utils/safe-download.ts` / `url-guard.ts` (video/image URLs returned by Meta: `*.fbcdn.net`, `scontent*`).
- Nothing else is contacted at runtime; `claude.ai` is only a CORS origin.

## ID-carrying arguments

Ad account: `account_id`, `account_ids`, `ad_account_ids` (audience sharing target). Campaign: `campaign_id`. Ad set: `ad_set_id`, `ad_set_ids`, `source_ad_set_id`, `target_ad_set` (object). Ad: `ad_id`, `ad_ids`. Creative: `creative_id`. Audience: `audience_id`, `origin_audience_id`. Page: `page_id`, `search_page_ids`, `object_story_id` (`<page>_<post>`). Catalog: none (no catalog tools upstream). Generic: `object_id` (insights/report: account, campaign, ad set or ad), `entity_id` + `entity_type`, `parent_id`. Other: `pixel_id`, `dataset_id`, `business_id`, `user_id`, `asset_id`, `video_id`, `instagram_*_id`, `form_id`, `lead_form_id`, `rule_id`, `study_id`, `budget_schedule_id`, `comment_id`, `post_id`, `waba_id`, `phone_number_id`, `flow_id`, `template_id(s)`, `hsm_id`, `run_id`, `report_run_id`, `invoice_id`, `ad_archive_id`.

## Tools that change status or budget

- Status: `ads_create_campaign`, `ads_update_campaign`, `ads_create_ad_set`, `ads_update_ad_set`, `ads_create_ad`, `ads_update_ad`, `ads_bulk_create_video_ads`, `ads_duplicate_ad`, `ads_clone_ad_set_bundle` (`target_ad_set.status`), `ads_activate_entity`, `ads_update_entity` (`updates.status`), `ads_update_lead_form`, `ads_update_ad_rule`; `ads_boost_ig_post` hardcodes `PAUSED` (`src/tools/instagram.ts:221`).
- Budget/bid: `ads_create_campaign`, `ads_update_campaign`, `ads_create_ad_set`, `ads_update_ad_set`, `ads_update_entity` (`updates.*budget*`), `ads_clone_ad_set_bundle` (`target_ad_set`), `ads_create_budget_schedule`, `ads_update_budget_schedule`, `ads_delete_budget_schedule`, `ads_update_spend_cap`, `ads_create_ad_rule` / `ads_update_ad_rule` (`execution_spec` can change budgets or unpause).

## Fork-only code

- Everything fork-only lives in `src/cuanto/` and `tests/cuanto/`; SQL in `migrations/`; helper scripts in `scripts/cuanto/`.
- Upstream files get one-line hooks only (store factory call, `createServer` wrap, `/cuanto` mount); each is listed under "What we changed".
- `scripts/cuanto/tool-map.ts` regenerates the table below (`npx tsx scripts/cuanto/tool-map.ts`, `--json` for machines). After every upstream merge, diff it against this file and against `src/cuanto/allowlist.ts`; a new upstream tool is denied until it is added there.

## What we changed

- (Task 1.0) this file + `scripts/cuanto/tool-map.ts`.
- (Task 1.1) `DEFAULT_META_API_VERSION` = `v27.0` (`src/meta/api-version.ts`) and every pin (`deploy.yml`, `docker-compose.yml`, `.env.example`, `README.md`); `ads_create_lookalike_audience` no longer sends `country` in `lookalike_spec` (arg kept optional and ignored; locations go in ad set targeting). v27 catalog `/batch` and `total_video_consumption_rate`: not used upstream, guarded by `tests/cuanto/version.test.ts`. Upstream tests that pinned the v26 default were moved to v27.
- (Task 1.2) `src/cuanto/db.ts` (`Db`, `getMcpDb()` from `MCP_DATABASE_URL`, `runMigrations`, `logCall`), `src/cuanto/pg-store.ts` (`PgTokenStore implements MetaTokenRepo` on `mcp_tokens`, AAD `cuanto_token:<tenant>:<user_key>`; `tokenForCall(tenantId, accessPath)`; `configureCuantoStore`), `src/cuanto/tenants.ts` (`resolveTenant`, `createTenantKey`, `revokeTenantKey`, `runWithTenant`/`currentTenantId`), `migrations/001_cuanto.sql` (+ `cuanto_migrations` ledger). Hooks: `src/index.ts` calls `configureCuantoStore(configureMetaTokenRepo)` at startup; `src/transport/http.ts:456` prefers `postgresTokenRepoFromEnv()` when `STORE_BACKEND=postgres`. Deps: `pg`; dev `pg-mem`, `@types/pg`. The Docker image must ship `migrations/` (Task 1.5).
- (Task 1.3) `src/cuanto/allowlist.ts` (`TOOL_POLICY`: 68 of 172 tools allowed, rest denied; `ARG_ROLES`, unknown `*_id(s)` args denied), `src/cuanto/guard.ts` (`guardToolCall`, `allowedAdAccounts` from `CUANTO_ADS_READER_URL` `ad_accounts` 60 s cache, `?fields=account_id` resolution 10 min cache, `promote_pages` page check, deletes/archives only on `effective_status=PAUSED`, `wrapToolDispatch`, `cuantoMcpAuth`). Mode switch: `isCuantoMode()` = `STORE_BACKEND=postgres` (store, tenant keys and guard always together). Hooks: `src/server.ts` wraps `registerTool` before `registerAllTools`; `src/transport/http.ts` uses `cuantoMcpAuth` for `/mcp` and skips OAuth mount + `X-Meta-Token` in Cuanto mode; `src/index.ts` stdio resolves `CUANTO_TENANT_KEY`. All 172 tools stay in `tools/list`; denied calls return `isError` with the reason.
- (Task 1.4) `src/cuanto/service.ts` (`createCuantoServiceRouter`, mounted at `/cuanto` in Cuanto mode): bearer `CUANTO_SERVICE_SECRET` (timing-safe, unset = always 401), system-user token + `appsecret_proof`, retries 4/17/32/613/80000-80014 + fetch rejection + non-JSON 5xx (1/4/16 s), typed `MetaServiceError` kinds `auth` (190, 502), `capability_unavailable` (#3, 409, not retried), `rate_limited`, `invalid` (422), `network`/`upstream` (503). `access/assign` uses the app-scoped id from `GET /me` (cached), never `META_SYSTEM_USER_ID`. `insights` returns zeros on `{"data":[]}`. Id-taking routes check against every `active` row in the environment (`accountsInEnvironment`; `access/assign` also accepts `awaiting_operator`, since Confirm assigns before marking the row active), objects via the guard's `resolveAccount`. Every service Graph call writes `call_log` (best effort). `scripts/cuanto/health-check.sh` for the 15 min timer (installed with the deploy).
- Shapes follow `_scratch/meta-access/META-ACCESS.md` (2026-11-25). Still provisional: the success body of `POST /{business}/client_ad_accounts` (Meta returns #3 at the Limited tier; we read `access_status`, default `PENDING`).

## Runtime notes

- Runtime host: `postiz-aws` (static IP already on the Cuanto-socials allowlist), not deb; keep the image host-agnostic.
- Env in Cuanto mode: `STORE_BACKEND=postgres`, `MCP_DATABASE_URL`, `CUANTO_ADS_READER_URL`, `TOKEN_ENCRYPTION_KEY`, `META_SYSTEM_USER_TOKEN`, `META_APP_SECRET`, `META_BUSINESS_ID`, `CUANTO_SERVICE_SECRET`; stdio also `CUANTO_TENANT_KEY`.
- Known v1 limits: Graph calls made by tools (via `metaApiClient`) are not yet in `call_log`; video, Instagram, pixel, catalog, lead and business tools are denied; `access/list` reads `client_ad_accounts` only.

## Taking an update

1. `git fetch upstream && git switch -c chore/upstream-vX dev && git merge upstream/main`.
2. Resolve conflicts (expected only in the hook lines listed above), `npx tsx scripts/cuanto/tool-map.ts` and update the table + allowlist.
3. `npm ci && npm run lint && npm run typecheck && npm test`, merge into `dev`.

## Full tool list (`tools/list`, 172)

Kind: `read` = `READ`; `create` = `CREATE`/`UPLOAD`; `update` = `UPDATE`/`TOGGLE`/`TOKEN`; `delete` = `destructiveHint` (note upstream tags `ads_update_budget_schedule`, `ads_update_custom_audience_users`, `ads_experiment_abtest_update_test`, `ads_assign_user_to_asset` destructive).

| tool | kind | id args | status/budget args |
|---|---|---|---|
| `ads_get_ad_accounts` | read | user_id |  |
| `ads_get_account_info` | read | account_id |  |
| `ads_get_pages_for_business` | read | business_id, account_id |  |
| `ads_get_ad_account_pages` | read | account_id |  |
| `ads_get_user_pages` | read |  |  |
| `ads_get_campaigns` | read | account_id |  |
| `ads_get_campaign_details` | read | campaign_id |  |
| `ads_create_campaign` | create | account_id | status, daily_budget, lifetime_budget, is_adset_budget_sharing_enabled, bid_strategy, spend_cap |
| `ads_update_campaign` | update | campaign_id | status, daily_budget, lifetime_budget, is_adset_budget_sharing_enabled, bid_strategy |
| `ads_delete_campaign` | delete | campaign_id |  |
| `ads_get_ad_sets` | read | account_id, campaign_id |  |
| `ads_get_ad_set_details` | read | ad_set_id |  |
| `ads_clone_ad_set_bundle` | create | account_id, source_ad_set_id, target_ad_set | target_ad_set |
| `ads_create_ad_set` | create | account_id, campaign_id | status, daily_budget, lifetime_budget, bid_amount, bid_strategy |
| `ads_update_ad_set` | update | ad_set_id | status, daily_budget, lifetime_budget, bid_amount, bid_strategy |
| `ads_delete_ad_set` | delete | ad_set_id |  |
| `ads_get_ads` | read | account_id, campaign_id, ad_set_id |  |
| `ads_get_ad_details` | read | ad_id |  |
| `ads_create_ad` | create | account_id, ad_set_id, creative_id | status |
| `ads_update_ad` | update | ad_id, creative_id | status |
| `ads_update_ad_url_tags` | update | ad_ids |  |
| `ads_delete_ad` | delete | ad_id |  |
| `ads_get_ad_creatives` | read | ad_id, account_id |  |
| `ads_get_creative_details` | read | creative_id |  |
| `ads_create_ad_creative` | create | account_id, page_id, object_story_id, instagram_actor_id, source_instagram_media_id, video_id |  |
| `ads_update_ad_creative` | update | creative_id |  |
| `ads_upload_ad_image` | create | account_id |  |
| `ads_get_ad_images` | read | account_id |  |
| `ads_get_ad_videos` | read | account_id |  |
| `ads_get_video_details` | read | video_id |  |
| `ads_upload_ad_video` | create | account_id, source_instagram_media_id |  |
| `ads_get_creative_ads` | read | creative_id |  |
| `ads_delete_ad_creative` | delete | creative_id |  |
| `ads_get_creative_media` | read | ad_id, creative_id, account_id |  |
| `ads_get_video_media` | read | video_id, ad_id, creative_id, dataset_id, ad_archive_id |  |
| `ads_analyze_video` | read | video_id, ad_id, creative_id, dataset_id, ad_archive_id |  |
| `ads_get_ad_dossier` | read | ad_id |  |
| `ads_get_ad_entities` | read | parent_id |  |
| `ads_update_entity` | update | entity_id, updates | updates |
| `ads_activate_entity` | update | entity_id | status |
| `ads_get_field_context` | read |  |  |
| `ads_get_insights` | read | object_id |  |
| `ads_insights_performance_trend` | read | object_id |  |
| `ads_insights_anomaly_signal` | read | object_id |  |
| `ads_insights_auction_ranking_benchmarks` | read | ad_id |  |
| `ads_insights_industry_benchmark` | read | object_id |  |
| `ads_insights_advertiser_context` | read | account_id |  |
| `ads_search_interests` | read |  |  |
| `ads_get_interest_suggestions` | read |  |  |
| `ads_search_behaviors` | read |  |  |
| `ads_search_demographics` | read |  |  |
| `ads_search_geo_locations` | read |  |  |
| `ads_estimate_audience_size` | read | account_id |  |
| `ads_get_targeting_description` | read | ad_id, account_id |  |
| `ads_search_locales` | read |  |  |
| `ads_create_budget_schedule` | create | campaign_id, ad_set_id | budget_value, budget_value_type |
| `ads_get_budget_schedules` | read | campaign_id, ad_set_id |  |
| `ads_update_budget_schedule` | delete | budget_schedule_id | budget_value, budget_value_type |
| `ads_delete_budget_schedule` | delete | budget_schedule_id |  |
| `ads_get_lead_forms` | read | page_id |  |
| `ads_get_leads` | read | form_id |  |
| `ads_get_ad_leads` | read | ad_id |  |
| `ads_create_lead_form` | create | page_id |  |
| `ads_get_lead_form_details` | read | form_id |  |
| `ads_update_lead_form` | update | form_id | status |
| `ads_get_lead_form_ads` | read | account_id, form_id |  |
| `ads_get_lead_setup` | read | page_id, app_id, user_id |  |
| `ads_create_test_lead` | create | form_id |  |
| `ads_delete_test_lead` | delete | form_id |  |
| `ads_get_custom_audiences` | read | account_id |  |
| `ads_get_audience_details` | read | audience_id |  |
| `ads_create_custom_audience` | create | account_id |  |
| `ads_create_lookalike_audience` | create | account_id, origin_audience_id |  |
| `ads_share_custom_audience` | update | audience_id, ad_account_ids |  |
| `ads_unshare_custom_audience` | update | audience_id, ad_account_ids |  |
| `ads_get_audience_shared_accounts` | read | audience_id |  |
| `ads_delete_custom_audience` | delete | audience_id |  |
| `ads_update_custom_audience` | update | audience_id |  |
| `ads_get_custom_audience_adsets` | read | audience_id, account_id |  |
| `ads_update_custom_audience_users` | delete | audience_id |  |
| `ads_get_ad_preview` | read | ad_id |  |
| `ads_generate_preview` | read | account_id, creative_id, page_id, instagram_actor_id, video_id |  |
| `ads_get_pixels` | read | account_id |  |
| `ads_get_pixel_details` | read | pixel_id |  |
| `ads_get_pixel_events` | read | pixel_id |  |
| `ads_get_custom_conversions` | read | account_id |  |
| `ads_create_custom_conversion` | create | account_id, pixel_id |  |
| `ads_get_ad_comments` | read | ad_id, post_id |  |
| `ads_hide_comment` | update | comment_id |  |
| `ads_reply_comment` | create | comment_id |  |
| `ads_delete_comment` | delete | comment_id |  |
| `ads_get_ad_rules` | read | account_id |  |
| `ads_create_ad_rule` | create | account_id | execution_spec |
| `ads_get_rule_details` | read | rule_id |  |
| `ads_update_ad_rule` | update | rule_id | status, execution_spec |
| `ads_delete_ad_rule` | delete | rule_id |  |
| `ads_get_ad_studies` | read | account_id, entity_id |  |
| `ads_create_ad_study` | create | account_id, business_id |  |
| `ads_get_study_details` | read | study_id |  |
| `ads_experiment_check_eligibility` | read | account_id, business_id |  |
| `ads_experiment_abtest_update_test` | delete | study_id |  |
| `ads_create_async_report` | create | object_id |  |
| `ads_get_report_status` | read | report_run_id |  |
| `ads_get_report_results` | read | report_run_id |  |
| `ads_run_report_and_wait` | create | object_id |  |
| `ads_get_billing_info` | read | account_id |  |
| `ads_get_spend_limit` | read | account_id |  |
| `ads_update_spend_cap` | update | account_id | spend_cap |
| `ads_get_invoices` | read | business_id, account_id, invoice_id |  |
| `ads_rate_status` | read |  |  |
| `ads_get_business_users` | read | business_id |  |
| `ads_get_asset_users` | read | asset_id, business_id |  |
| `ads_assign_user_to_asset` | delete | asset_id, user_id, business_id |  |
| `ads_remove_user_from_asset` | delete | asset_id, user_id, business_id |  |
| `ads_get_opportunity_score` | read | account_id, object_id |  |
| `ads_get_dataset_quality` | read | pixel_id |  |
| `ads_get_errors` | read | account_id |  |
| `ads_get_help_article` | read |  |  |
| `ads_diagnose_underperformance` | read | object_id, pixel_id |  |
| `ads_portfolio_summary` | read | account_ids |  |
| `ads_bulk_create_video_ads` | create | account_id, ad_set_id, page_id, instagram_actor_id | status |
| `ads_update_ad_content` | update | ad_ids, video_id, lead_form_id |  |
| `ads_duplicate_ad` | create | ad_id, ad_set_ids | status |
| `ads_get_ad_social_proof` | read | ad_ids |  |
| `ads_get_instagram_account` | read | page_id |  |
| `ads_get_instagram_media` | read | instagram_account_id |  |
| `ads_boost_ig_post` | create | account_id, ad_set_id, instagram_media_id, instagram_account_id, page_id |  |
| `whatsapp_get_business_accounts` | read | business_id, waba_id |  |
| `whatsapp_get_phone_numbers` | read | waba_id, phone_number_id |  |
| `whatsapp_register_phone` | update | phone_number_id |  |
| `whatsapp_deregister_phone` | update | phone_number_id |  |
| `whatsapp_request_verification_code` | create | phone_number_id |  |
| `whatsapp_verify_code` | update | phone_number_id |  |
| `whatsapp_get_business_profile` | read | phone_number_id |  |
| `whatsapp_update_business_profile` | update | phone_number_id |  |
| `whatsapp_get_templates` | read | waba_id, template_id | status |
| `whatsapp_create_template` | create | waba_id |  |
| `whatsapp_update_template` | update | template_id |  |
| `whatsapp_delete_template` | delete | waba_id, hsm_id |  |
| `whatsapp_get_analytics` | read | waba_id |  |
| `whatsapp_get_template_analytics` | read | waba_id, template_ids |  |
| `whatsapp_get_flows` | read | waba_id, flow_id |  |
| `whatsapp_create_flow` | create | waba_id, clone_flow_id |  |
| `whatsapp_update_flow` | update | flow_id |  |
| `whatsapp_publish_flow` | update | flow_id |  |
| `whatsapp_deprecate_flow` | delete | flow_id |  |
| `whatsapp_delete_flow` | delete | flow_id |  |
| `whatsapp_get_qr_codes` | read | phone_number_id |  |
| `whatsapp_create_qr_code` | create | phone_number_id |  |
| `whatsapp_update_qr_code` | update | phone_number_id |  |
| `whatsapp_delete_qr_code` | delete | phone_number_id |  |
| `whatsapp_get_webhook_subscriptions` | read | waba_id |  |
| `whatsapp_subscribe_webhook` | update | waba_id |  |
| `whatsapp_unsubscribe_webhook` | update | waba_id |  |
| `ads_library_register_apify_token` | update |  |  |
| `ads_library_get_apify_token_status` | read |  |  |
| `ads_library_delete_apify_token` | delete |  |  |
| `ads_library_scrape` | create |  | active_status |
| `ads_library_get_run_status` | read | run_id |  |
| `ads_library_get_results` | read | dataset_id |  |
| `ads_library_abort_run` | update | run_id |  |
| `ads_library_list_runs` | read |  |  |
| `ads_library_get_ad_details` | read | dataset_id, ad_archive_id |  |
| `ads_library_search` | read | search_page_ids |  |
| `ads_account_get_activity_logs` | read | account_id, object_id, user_id |  |
| `ads_register_gemini_key` | update |  |  |
| `ads_get_gemini_key_status` | read |  |  |
| `ads_delete_gemini_key` | delete |  |  |
| `ads_list_tokens` | read |  |  |
| `ads_set_active_token` | update |  |  |
| `ads_register_token` | update |  |  |
| `ads_delete_token` | delete |  |  |

172 tools.
