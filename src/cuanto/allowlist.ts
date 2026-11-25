/**
 * Tenant guard policy (v1). Names come from FORK.md. A tool missing here is
 * denied, so a tool added upstream stays off until it is reviewed and listed.
 */

export type ToolKind = "read" | "create" | "update" | "delete";

export interface ToolPolicy {
  kind: ToolKind;
  /** Read tools that touch no ad account or object (taxonomy search, help). */
  unscoped?: boolean;
  /** Create tools whose `status` arg is forced to PAUSED. */
  forcePaused?: boolean;
}

const read = (unscoped = false): ToolPolicy => ({ kind: "read", ...(unscoped ? { unscoped } : {}) });
const create = (forcePaused = false): ToolPolicy => ({ kind: "create", ...(forcePaused ? { forcePaused } : {}) });
const update: ToolPolicy = { kind: "update" };
const del: ToolPolicy = { kind: "delete" };

export const TOOL_POLICY: Readonly<Record<string, ToolPolicy>> = {
  // accounts, campaigns, ad sets, ads
  ads_get_account_info: read(),
  ads_get_ad_account_pages: read(),
  ads_get_campaigns: read(),
  ads_get_campaign_details: read(),
  ads_create_campaign: create(true),
  ads_update_campaign: update,
  ads_delete_campaign: del,
  ads_get_ad_sets: read(),
  ads_get_ad_set_details: read(),
  ads_create_ad_set: create(true),
  ads_update_ad_set: update,
  ads_delete_ad_set: del,
  ads_get_ads: read(),
  ads_get_ad_details: read(),
  ads_create_ad: create(true),
  ads_update_ad: update,
  ads_update_ad_url_tags: update,
  ads_delete_ad: del,
  ads_duplicate_ad: create(true),
  ads_get_ad_entities: read(),
  ads_update_entity: update,
  // creatives and images
  ads_get_ad_creatives: read(),
  ads_get_creative_details: read(),
  ads_create_ad_creative: create(),
  ads_update_ad_creative: update,
  ads_upload_ad_image: create(),
  ads_get_ad_images: read(),
  ads_get_ad_videos: read(),
  ads_get_creative_ads: read(),
  ads_get_creative_media: read(),
  ads_get_ad_dossier: read(),
  ads_get_ad_preview: read(),
  ads_generate_preview: read(),
  ads_get_ad_social_proof: read(),
  // insights and reports
  ads_get_insights: read(),
  ads_insights_performance_trend: read(),
  ads_insights_anomaly_signal: read(),
  ads_insights_auction_ranking_benchmarks: read(),
  ads_insights_industry_benchmark: read(),
  ads_insights_advertiser_context: read(),
  ads_create_async_report: create(),
  ads_run_report_and_wait: create(),
  ads_get_report_status: read(),
  ads_get_report_results: read(),
  ads_portfolio_summary: read(),
  ads_get_opportunity_score: read(),
  ads_get_errors: read(),
  ads_diagnose_underperformance: read(),
  ads_account_get_activity_logs: read(),
  ads_get_billing_info: read(),
  ads_get_spend_limit: read(),
  // targeting
  ads_search_interests: read(true),
  ads_get_interest_suggestions: read(true),
  ads_search_behaviors: read(true),
  ads_search_demographics: read(true),
  ads_search_geo_locations: read(true),
  ads_search_locales: read(true),
  ads_estimate_audience_size: read(),
  ads_get_targeting_description: read(),
  // audiences (owned by one ad account)
  ads_get_custom_audiences: read(),
  ads_get_audience_details: read(),
  ads_get_custom_audience_adsets: read(),
  ads_create_custom_audience: create(),
  ads_create_lookalike_audience: create(),
  ads_update_custom_audience: update,
  // no Meta object
  ads_get_field_context: read(true),
  ads_get_help_article: read(true),
  ads_rate_status: read(true),
};

/** How an argument (top level or nested) is checked. */
export type ArgRole =
  | "account" // act_<digits> or digits; must be in the tenant's set
  | "object" // Graph object id resolved with ?fields=account_id
  | "object_or_account" // act_<digits> is an account, anything else an object
  | "page" // must be a promote_page of an allowed account
  | "story" // <page>_<post>; the page part is checked
  | "audience_list" // [{id}] or [id], each resolved as an object
  | "deny"; // unresolvable in this version

export const ARG_ROLES: Readonly<Record<string, ArgRole>> = {
  account_id: "account",
  account_ids: "account",
  ad_account_ids: "account",
  campaign_id: "object",
  ad_set_id: "object",
  adset_id: "object",
  ad_set_ids: "object",
  source_ad_set_id: "object",
  ad_id: "object",
  ad_ids: "object",
  creative_id: "object",
  audience_id: "object",
  origin_audience_id: "object",
  report_run_id: "object",
  object_id: "object_or_account",
  entity_id: "object_or_account",
  parent_id: "object_or_account",
  page_id: "page",
  object_story_id: "story",
  effective_object_story_id: "story",
  custom_audiences: "audience_list",
  excluded_custom_audiences: "audience_list",
  // catalogs, pixels/datasets, business-level, Instagram, video, lead forms: denied in v1
  pixel_id: "deny",
  fb_pixel: "deny",
  dataset_id: "deny",
  product_catalog_id: "deny",
  catalog_id: "deny",
  product_set_id: "deny",
  application_id: "deny",
  app_id: "deny",
  business_id: "deny",
  user_id: "deny",
  asset_id: "deny",
  instagram_actor_id: "deny",
  instagram_user_id: "deny",
  instagram_account_id: "deny",
  instagram_media_id: "deny",
  source_instagram_media_id: "deny",
  video_id: "deny",
  lead_gen_form_id: "deny",
  lead_form_id: "deny",
  form_id: "deny",
  custom_conversion_id: "deny",
  offline_conversion_data_set_id: "deny",
};

/** Any other argument named like an id is unknown and denied. */
export const ID_LIKE_ARG = /_ids?$/;

export const STATUS_ARGS = new Set(["status", "configured_status"]);

export const BUDGET_ARGS = new Set([
  "daily_budget",
  "lifetime_budget",
  "bid_amount",
  "bid_strategy",
  "bid_constraints",
  "spend_cap",
  "daily_spend_cap",
  "lifetime_spend_cap",
  "budget_value",
  "budget_value_type",
  "is_adset_budget_sharing_enabled",
]);

export const DASHBOARD_ONLY = "activate or change budget from the Cuanto Ads dashboard";
