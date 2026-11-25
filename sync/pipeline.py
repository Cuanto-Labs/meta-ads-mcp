"""Daily Meta Ads warehouse sync (Task 3.1).

Reads the active ad accounts from the cuanto-ads app db (read-only role `mcp_reader`), then loads
campaigns, ad sets, ads, creatives and daily ad-level insights per account into dataset `meta_ads`
of the warehouse db with dlt. One account at a time, one dlt pipeline per account (the incremental
cursor on `date_start` is per pipeline), 2 s pause between accounts.

Env: CUANTO_ADS_READER_URL, WAREHOUSE_URL, META_SYSTEM_USER_TOKEN, META_APP_SECRET.
Optional: META_API_VERSION (default v27.0), SYNC_ONLY (comma list of act_ ids), SYNC_PAST_DAYS (30),
SYNC_CHUNK_DAYS (30: days per async insights job; raise it for a big backfill, the Limited tier throttles per call).
Exit 0 when at least one account loaded (or there is nothing to do), 1 when every account failed.
"""

from __future__ import annotations

import logging
import os
import sys
import time
from typing import Callable

import psycopg

log = logging.getLogger("meta_ads_sync")

META_API_VERSION = os.environ.get("META_API_VERSION", "v27.0")
DATASET = "meta_ads"
PAUSE_SECONDS = 2
RATE_LIMIT_BACKOFF_SECONDS = 60

# Meta throttling codes: 4 app, 17 user, 32 page, 341 app limit, 613 custom, 80000-80014 BUC, 800008/9.
RATE_LIMIT_CODES = {4, 17, 32, 341, 613, 800008, 800009, *range(80000, 80015)}
RATE_LIMIT_WORDS = ("rate limit", "too many calls", "request limit reached", "(#4)", "(#17)", "(#80004)")

# Insight fields on top of the dlt defaults: names and currency, so the BI layer needs no joins.
EXTRA_INSIGHT_FIELDS = (
    "account_id",
    "account_currency",
    "campaign_name",
    "adset_name",
    "ad_name",
)

ACTIVE_SQL = (
    "select account_id::text, meta_account_id from ad_accounts "
    "where status = 'active' order by created_at, meta_account_id"
)


def active_accounts(reader_url: str) -> list[tuple[str, str]]:
    """(account_id = workspace uuid, meta_account_id = act_<digits>) for every active ad account."""
    with psycopg.connect(reader_url) as conn:
        with conn.cursor() as cur:
            cur.execute(ACTIVE_SQL)
            return [(str(a), str(m)) for a, m in cur.fetchall()]


def digits(meta_account_id: str) -> str:
    d = meta_account_id.removeprefix("act_")
    if not d.isdigit():
        raise ValueError(f"bad meta_account_id {meta_account_id!r}")
    return d


def is_rate_limit(exc: BaseException) -> bool:
    code = getattr(exc, "api_error_code", None)
    if callable(code):
        try:
            code = code()
        except Exception:
            code = None
    if isinstance(code, int) and code in RATE_LIMIT_CODES:
        return True
    text = str(exc).lower()
    return any(w in text for w in RATE_LIMIT_WORDS)


def tag(workspace_id: str, meta_account_id: str) -> Callable[[dict], dict]:
    def _tag(item: dict) -> dict:
        item["meta_account_id"] = meta_account_id
        item["workspace_id"] = workspace_id
        return item

    return _tag


def sync_account(workspace_id: str, meta_account_id: str) -> dict:
    """Load one account. Returns dlt's load info as a string for the log."""
    import dlt
    from facebook_ads import DEFAULT_INSIGHT_FIELDS, facebook_ads_source, facebook_insights_source

    num = digits(meta_account_id)
    token = os.environ["META_SYSTEM_USER_TOKEN"]
    secret = os.environ["META_APP_SECRET"]
    common = dict(account_id=num, access_token=token, app_api_version=META_API_VERSION, app_secret=secret)

    objects = facebook_ads_source(**common).with_resources("campaigns", "ad_sets", "ads", "ad_creatives")
    for res in objects.resources.values():
        # every account shares the tables, so never `replace` (it would wipe the other accounts)
        res.apply_hints(write_disposition="merge")
        res.add_map(tag(workspace_id, meta_account_id))

    insights = facebook_insights_source(
        **common,
        initial_load_past_days=int(os.environ.get("SYNC_PAST_DAYS", "30")),
        fields=tuple(DEFAULT_INSIGHT_FIELDS) + EXTRA_INSIGHT_FIELDS,
        chunk_days=int(os.environ.get("SYNC_CHUNK_DAYS", "30")),
    )
    for res in insights.resources.values():
        res.add_map(tag(workspace_id, meta_account_id))

    pipeline = dlt.pipeline(
        pipeline_name=f"meta_ads_{num}",
        destination=dlt.destinations.postgres(credentials=os.environ["WAREHOUSE_URL"]),
        dataset_name=DATASET,
    )
    info = pipeline.run([objects, insights])
    return {"account": meta_account_id, "info": str(info)}


def run(
    accounts: list[tuple[str, str]],
    sync_one: Callable[[str, str], object] = sync_account,
    sleep: Callable[[float], None] = time.sleep,
) -> int:
    ok = failed = 0
    for i, (workspace_id, meta_account_id) in enumerate(accounts):
        if i:
            sleep(PAUSE_SECONDS)
        try:
            sync_one(workspace_id, meta_account_id)
            ok += 1
            log.info("synced %s", meta_account_id)
        except Exception as exc:  # noqa: BLE001 - one bad account must not stop the rest
            failed += 1
            if is_rate_limit(exc):
                log.warning("rate limited on %s, backing off %ss and skipping it this run", meta_account_id, RATE_LIMIT_BACKOFF_SECONDS)
                sleep(RATE_LIMIT_BACKOFF_SECONDS)
            else:
                log.error("sync failed for %s: %s", meta_account_id, str(exc)[:300])
    log.info("done: %d ok, %d failed, %d total", ok, failed, len(accounts))
    return 1 if accounts and ok == 0 else 0


def main() -> int:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    accounts = active_accounts(os.environ["CUANTO_ADS_READER_URL"])
    only = {x.strip() for x in os.environ.get("SYNC_ONLY", "").split(",") if x.strip()}
    if only:
        accounts = [a for a in accounts if a[1] in only]
    log.info("%d active ad accounts", len(accounts))
    return run(accounts)


if __name__ == "__main__":
    sys.exit(main())
