import pipeline


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows
        self.sql = None

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def execute(self, sql):
        self.sql = sql

    def fetchall(self):
        return self.rows


class FakeConn:
    def __init__(self, cur):
        self.cur = cur

    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False

    def cursor(self):
        return self.cur


def test_active_accounts_returns_both_rows(monkeypatch):
    cur = FakeCursor([("w-1", "act_111"), ("w-2", "act_222")])
    monkeypatch.setattr(pipeline.psycopg, "connect", lambda url: FakeConn(cur))
    assert pipeline.active_accounts("postgres://x") == [("w-1", "act_111"), ("w-2", "act_222")]
    assert "status = 'active'" in cur.sql


def test_one_account_failing_does_not_stop_the_other():
    seen = []

    def sync_one(ws, meta):
        seen.append(meta)
        if meta == "act_111":
            raise RuntimeError("boom")

    sleeps = []
    code = pipeline.run([("w-1", "act_111"), ("w-2", "act_222")], sync_one, sleeps.append)
    assert seen == ["act_111", "act_222"]
    assert code == 0
    assert sleeps == [pipeline.PAUSE_SECONDS]


def test_exit_1_only_when_all_fail():
    def sync_one(ws, meta):
        raise RuntimeError("boom")

    assert pipeline.run([("w", "act_1"), ("w", "act_2")], sync_one, lambda s: None) == 1
    assert pipeline.run([], sync_one, lambda s: None) == 0


def test_rate_limit_backs_off_60s_then_skips():
    def sync_one(ws, meta):
        if meta == "act_1":
            raise RuntimeError("(#17) User request limit reached")

    sleeps = []
    code = pipeline.run([("w", "act_1"), ("w", "act_2")], sync_one, sleeps.append)
    assert code == 0
    assert sleeps == [pipeline.RATE_LIMIT_BACKOFF_SECONDS, pipeline.PAUSE_SECONDS]


def test_digits_rejects_junk():
    assert pipeline.digits("act_701177416233035") == "701177416233035"
    for bad in ("act_", "act_12x", "701; drop"):
        try:
            pipeline.digits(bad)
        except ValueError:
            continue
        raise AssertionError(bad)


def test_tag_adds_workspace_and_account():
    assert pipeline.tag("w", "act_9")({"id": "1"}) == {"id": "1", "meta_account_id": "act_9", "workspace_id": "w"}
