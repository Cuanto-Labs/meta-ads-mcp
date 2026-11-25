#!/usr/bin/env python3
"""Idempotently builds the "Meta Ads: Account Overview" dashboard in Metabase over its API.

Usage: MB_URL=http://127.0.0.1:14420 MB_USER=... MB_PASS=... python3 build_dashboard.py
(MB_URL is usually an ssh tunnel to deb:4420.) Prints the dashboard id. Re-running replaces the cards of the
dashboard of the same name, so layout edits belong in this file.
"""
import json, os, sys, urllib.error, urllib.request

BASE = os.environ["MB_URL"]
DB_NAME = "Cuanto Ads Warehouse"
ACT_DB_NAME = "Ads commands (write)"
DASH = "Meta Ads: Account Overview"
COLLECTION = "Cuanto Ads"
_tok = [None]


def call(method, path, body=None):
    h = {"Content-Type": "application/json"}
    if _tok[0]:
        h["X-Metabase-Session"] = _tok[0]
    req = urllib.request.Request(BASE + path, method=method, headers=h,
                                 data=json.dumps(body).encode() if body is not None else None)
    try:
        raw = urllib.request.urlopen(req, timeout=180).read()
    except urllib.error.HTTPError as e:
        raise SystemExit(f"HTTP {e.code} {method} {path}: {e.read()[:400]!r}")
    return json.loads(raw) if raw else None


_tok[0] = call("POST", "/api/session", {"username": os.environ["MB_USER"], "password": os.environ["MB_PASS"]})["id"]
dbs = {d["name"]: d for d in call("GET", "/api/database")["data"]}
db, adb = dbs[DB_NAME], dbs[ACT_DB_NAME]
call("POST", f"/api/database/{db['id']}/sync_schema")
call("POST", f"/api/database/{adb['id']}/sync_schema")


def field_id(database, schema, table, field):
    meta = call("GET", f"/api/database/{database['id']}/metadata?include_hidden=true")
    t = next(t for t in meta["tables"] if t["name"] == table and t["schema"] == schema)
    return next(f["id"] for f in t["fields"] if f["name"] == field)


FID = {t: field_id(db, "meta_ads", t, "meta_account_id") for t in ("facebook_insights", "campaigns", "ad_sets")}

colls = call("GET", "/api/collection")
coll = next((c for c in colls if c.get("name") == COLLECTION and not c.get("archived")), None)
coll = coll or call("POST", "/api/collection", {"name": COLLECTION})


def items(model):
    return call("GET", f"/api/collection/{coll['id']}/items?models={model}")["data"]


def upsert_card(name, query, display, viz=None, kind="question"):
    body = {"name": name, "display": display, "collection_id": coll["id"], "visualization_settings": viz or {},
            "type": "model" if kind == "model" else "question", "dataset_query": query}
    old = next((c for c in items("dataset" if kind == "model" else "card") if c["name"] == name), None)
    return call("PUT", f"/api/card/{old['id']}", body) if old else call("POST", "/api/card", body)


def card(name, sql, display, viz=None, table="facebook_insights"):
    tags = {"meta_account_id": {"id": "ma-1", "name": "meta_account_id", "display-name": "Meta account id", "type": "dimension",
            "dimension": ["field", FID[table], None], "widget-type": "string/=", "required": False}}
    return upsert_card(name, {"type": "native", "database": db["id"], "native": {"query": sql, "template-tags": tags}}, display, viz)


F = "meta_ads.facebook_insights"
W = "where {{meta_account_id}}"
USD = lambda col: {"column_settings": {f'["name","{col}"]': {"prefix": "$", "decimals": 2}}}
cards = {}
cards["spend_total"] = card("Spend (total)", f"select coalesce(sum(spend::numeric),0) as spend from {F} {W}", "scalar", {"scalar.field": "spend", **USD("spend")})
cards["imp_total"] = card("Impressions (total)", f"select coalesce(sum(impressions),0) as impressions from {F} {W}", "scalar")
cards["clk_total"] = card("Clicks (total)", f"select coalesce(sum(clicks),0) as clicks from {F} {W}", "scalar")
cards["ctr_total"] = card("CTR (total)", f"select round(100.0*sum(clicks)/nullif(sum(impressions),0),2) as ctr_pct from {F} {W}", "scalar",
                          {"column_settings": {'["name","ctr_pct"]': {"suffix": "%"}}})
cards["cpc_total"] = card("CPC (total)", f"select round(sum(spend::numeric)/nullif(sum(clicks),0),2) as cpc from {F} {W}", "scalar", USD("cpc"))
cards["cpm_total"] = card("CPM (total)", f"select round(1000*sum(spend::numeric)/nullif(sum(impressions),0),2) as cpm from {F} {W}", "scalar", USD("cpm"))
day = "date_start::date as day"
cards["daily_spend"] = card("Daily spend", f"select {day}, sum(spend::numeric) as spend from {F} {W} group by 1 order by 1", "bar",
                            {"graph.dimensions": ["day"], "graph.metrics": ["spend"]})
cards["daily_imp_clk"] = card("Daily impressions and clicks", f"select {day}, sum(impressions) as impressions, sum(clicks) as clicks from {F} {W} group by 1 order by 1", "line",
                              {"graph.dimensions": ["day"], "graph.metrics": ["impressions", "clicks"]})
cards["daily_ctr"] = card("Daily CTR (%)", f"select {day}, round(100.0*sum(clicks)/nullif(sum(impressions),0),2) as ctr_pct from {F} {W} group by 1 order by 1", "line",
                          {"graph.dimensions": ["day"], "graph.metrics": ["ctr_pct"]})
cards["daily_cpc"] = card("Daily CPC", f"select {day}, round(sum(spend::numeric)/nullif(sum(clicks),0),2) as cpc from {F} {W} group by 1 order by 1", "line",
                          {"graph.dimensions": ["day"], "graph.metrics": ["cpc"]})
cards["daily_cpm"] = card("Daily CPM", f"select {day}, round(1000*sum(spend::numeric)/nullif(sum(impressions),0),2) as cpm from {F} {W} group by 1 order by 1", "line",
                          {"graph.dimensions": ["day"], "graph.metrics": ["cpm"]})
cards["top_campaigns"] = card("Top campaigns by spend",
    f"select campaign_id::text as campaign_id, max(campaign_name) as campaign, round(sum(spend::numeric),2) as spend, sum(impressions) as impressions, sum(clicks) as clicks, "
    f"round(100.0*sum(clicks)/nullif(sum(impressions),0),2) as ctr_pct, round(sum(spend::numeric)/nullif(sum(clicks),0),2) as cpc "
    f"from {F} {W} group by campaign_id order by sum(spend::numeric) desc nulls last limit 10", "table")
cards["top_ads"] = card("Top ads by spend",
    f"select ad_id::text as ad_id, max(ad_name) as ad, max(campaign_name) as campaign, round(sum(spend::numeric),2) as spend, sum(impressions) as impressions, sum(clicks) as clicks, "
    f"round(100.0*sum(clicks)/nullif(sum(impressions),0),2) as ctr_pct, round(sum(spend::numeric)/nullif(sum(clicks),0),2) as cpc "
    f"from {F} {W} group by ad_id order by sum(spend::numeric) desc nulls last limit 10", "table")
# control tables: current state from the synced objects; click a row to select it for the buttons
cards["campaigns"] = card("Campaigns (click a row to select)",
    "select id as campaign_id, name as campaign, effective_status as status, daily_budget as daily_budget_minor, objective from meta_ads.campaigns "
    "where {{meta_account_id}} order by (effective_status = 'ACTIVE') desc, name limit 50", "table", table="campaigns")
cards["ad_sets"] = card("Ad sets (click a row to select)",
    "select id as adset_id, name as ad_set, effective_status as status, campaign_id from meta_ads.ad_sets "
    "where {{meta_account_id}} order by (effective_status = 'ACTIVE') desc, name limit 50", "table", table="ad_sets")

# ---- commands: model + actions on the write-only database
model = upsert_card("Meta commands", {"type": "native", "database": adb["id"], "native": {"query":
    "select id, created_at, kind, target_id, meta_account_id, value, state, result from ops.meta_commands order by id desc", "template-tags": {}}},
    "table", kind="model")
cards["recent"] = upsert_card("Recent commands", {"type": "native", "database": adb["id"], "native": {"query":
    "select id, created_at, kind, target_id, meta_account_id, value, state, result from ops.meta_commands order by id desc limit 15", "template-tags": {}}}, "table")


def action(name, kind, value, target_label, budget=False):
    """INSERT-only action: the fork worker validates and executes the queued row against Meta."""
    val = "{{value}}" if budget else f"'{value}'"
    sql = (f"insert into ops.meta_commands (kind, target_id, meta_account_id, value, created_by) "
           f"values ('{kind}', {{{{target_id}}}}, {{{{meta_account_id}}}}, {val}, 'metabase')")
    tags = {"target_id": {"id": "target_id", "name": "target_id", "display-name": target_label, "type": "text"},
            "meta_account_id": {"id": "meta_account_id", "name": "meta_account_id", "display-name": "Meta account id", "type": "text"}}
    params = [{"id": "target_id", "name": target_label, "type": "string/=", "target": ["variable", ["template-tag", "target_id"]]},
              {"id": "meta_account_id", "name": "Meta account id", "type": "string/=", "target": ["variable", ["template-tag", "meta_account_id"]]}]
    fields = {"target_id": {"id": "target_id", "fieldType": "string", "inputType": "string", "required": True, "hidden": False, "order": 0, "title": target_label},
              "meta_account_id": {"id": "meta_account_id", "fieldType": "string", "inputType": "string", "required": True, "hidden": False, "order": 1, "title": "Meta account id"}}
    if budget:
        tags["value"] = {"id": "value", "name": "value", "display-name": "Daily budget (minor units, e.g. 2000 = $20.00)", "type": "text"}
        params.append({"id": "value", "name": "Daily budget (minor units, e.g. 2000 = $20.00)", "type": "string/=", "target": ["variable", ["template-tag", "value"]]})
        fields["value"] = {"id": "value", "fieldType": "string", "inputType": "string", "required": True, "hidden": False, "order": 2, "title": "Daily budget (minor units, e.g. 2000 = $20.00)"}
    body = {"name": name, "model_id": model["id"], "type": "query", "database_id": adb["id"], "parameters": params,
            "dataset_query": {"type": "native", "database": adb["id"], "native": {"query": sql, "template-tags": tags}},
            "visualization_settings": {"type": "button", "fields": fields}}
    old = next((a for a in call("GET", "/api/action") if a["name"] == name and a["model_id"] == model["id"] and not a.get("archived")), None)
    return call("PUT", f"/api/action/{old['id']}", body) if old else call("POST", "/api/action", body)


acts = {
    "pause_c": action("Pause campaign", "campaign_status", "PAUSED", "Campaign id"),
    "activate_c": action("Activate campaign", "campaign_status", "ACTIVE", "Campaign id"),
    "pause_s": action("Pause ad set", "adset_status", "PAUSED", "Ad set id"),
    "activate_s": action("Activate ad set", "adset_status", "ACTIVE", "Ad set id"),
    "budget_s": action("Set ad set daily budget", "adset_daily_budget", None, "Ad set id", budget=True),
}
for old in call("GET", "/api/action"):  # remove leftovers from experiments
    if old["name"].startswith("TEST ") and not old.get("archived"):
        call("DELETE", f"/api/action/{old['id']}")

dash = next((d for d in items("dashboard") if d["name"] == DASH), None)
dash = dash or call("POST", "/api/dashboard", {"name": DASH, "collection_id": coll["id"]})
params = [
    {"id": "meta_account_id", "name": "Meta account id", "slug": "meta_account_id", "type": "string/=", "sectionId": "string",
     "default": [os.environ.get("MB_DEFAULT_ACCOUNT", "act_72126376")]},
    {"id": "campaign_sel", "name": "Selected campaign id", "slug": "campaign_sel", "type": "string/=", "sectionId": "string"},
    {"id": "adset_sel", "name": "Selected ad set id", "slug": "adset_sel", "type": "string/=", "sectionId": "string"},
]


def acct_map(card_id):
    return [{"parameter_id": "meta_account_id", "card_id": card_id, "target": ["dimension", ["template-tag", "meta_account_id"]]}]


def click(col, param, cols):
    cb = {"click_behavior": {"type": "crossfilter", "parameterMapping": {
        param: {"id": param, "source": {"type": "column", "id": col, "name": col}, "target": {"type": "parameter", "id": param}}}}}
    return {"column_settings": {f'["name","{c}"]': cb for c in cols}}


def button(a, label, sel_param):
    maps = [{"parameter_id": sel_param, "target": ["variable", ["template-tag", "target_id"]]},
            {"parameter_id": "meta_account_id", "target": ["variable", ["template-tag", "meta_account_id"]]}]
    return {"action_id": a["id"], "card_id": model["id"], "parameter_mappings": maps,
            "visualization_settings": {"actionDisplayType": "button", "button.label": label, "button.variant": "primary",
                                       "virtual_card": {"name": None, "display": "action", "visualization_settings": {}, "dataset_query": {}, "archived": False}}}


layout = [("spend_total", 0, 0, 4, 3), ("imp_total", 4, 0, 4, 3), ("clk_total", 8, 0, 4, 3),
          ("ctr_total", 12, 0, 4, 3), ("cpc_total", 16, 0, 4, 3), ("cpm_total", 20, 0, 4, 3),
          ("daily_spend", 0, 3, 12, 6), ("daily_imp_clk", 12, 3, 12, 6),
          ("daily_ctr", 0, 9, 8, 5), ("daily_cpc", 8, 9, 8, 5), ("daily_cpm", 16, 9, 8, 5),
          ("top_campaigns", 0, 14, 24, 6), ("top_ads", 0, 20, 24, 6)]
dashcards = []
n = 0
for k, x, y, w, h in layout:
    n += 1
    dashcards.append({"id": -n, "card_id": cards[k]["id"], "col": x, "row": y, "size_x": w, "size_y": h,
                      "parameter_mappings": acct_map(cards[k]["id"]), "visualization_settings": {}})
# control block: tables 16 wide, buttons 8 wide beside them
for k, y, sel, col, cols in (("campaigns", 26, "campaign_sel", "campaign_id", ["campaign_id", "campaign", "status", "daily_budget_minor", "objective"]),
                         ("ad_sets", 34, "adset_sel", "adset_id", ["adset_id", "ad_set", "status", "campaign_id"])):
    n += 1
    dashcards.append({"id": -n, "card_id": cards[k]["id"], "col": 0, "row": y, "size_x": 16, "size_y": 8,
                      "parameter_mappings": acct_map(cards[k]["id"]), "visualization_settings": click(col, sel, cols)})
btns = [("pause_c", "Pause selected campaign", "campaign_sel", 26), ("activate_c", "Activate selected campaign", "campaign_sel", 28),
        ("pause_s", "Pause selected ad set", "adset_sel", 34), ("activate_s", "Activate selected ad set", "adset_sel", 36),
        ("budget_s", "Set ad set daily budget", "adset_sel", 38)]
for key, label, sel, y in btns:
    n += 1
    b = button(acts[key], label, sel)
    dashcards.append({"id": -n, "col": 16, "row": y, "size_x": 8, "size_y": 2, **b})
n += 1
dashcards.append({"id": -n, "card_id": cards["recent"]["id"], "col": 0, "row": 42, "size_x": 24, "size_y": 6,
                  "parameter_mappings": [], "visualization_settings": {}})
call("PUT", f"/api/dashboard/{dash['id']}", {"parameters": params, "dashcards": dashcards})
print(dash["id"])
