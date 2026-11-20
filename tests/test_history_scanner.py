"""Tests for the multi-conversation token-usage scanner (sidecars/context/history_scanner.py).

Run with: python -m unittest discover tests
"""

from datetime import datetime, timedelta
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import time
import unittest
from unittest import mock

SCRIPT = Path(__file__).resolve().parent.parent / "sidecars" / "context" / "history_scanner.py"

spec = importlib.util.spec_from_file_location("history_scanner", SCRIPT)
hs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hs)


def varint(n: int) -> bytes:
    n &= 0xFFFFFFFFFFFFFFFF
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        if n:
            out += bytes([b | 0x80])
        else:
            return out + bytes([b])


def f(fn: int, val) -> bytes:
    if isinstance(val, int):
        return varint(fn << 3) + varint(val)
    if isinstance(val, str):
        val = val.encode()
    return varint(fn << 3 | 2) + varint(len(val)) + val


def make_db(path: Path, calls: list[dict], planner_steps: bool = True, first_input: str = "hello") -> None:
    """calls: dicts with ts (epoch s), model, display, input, output, cache, thinking, model_field ('planner'|'response'|'none')."""
    conn = sqlite3.connect(path)
    conn.execute(
        "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, "
        "has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, "
        "task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))"
    )
    conn.execute("CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))")
    step = 0
    for i, c in enumerate(calls):
        usage = f(2, c.get("input", 0)) + f(3, c.get("output", 0)) + f(5, c.get("cache", 0)) + f(9, c.get("thinking", 0))
        where = c.get("model_field", "planner")
        chat = f(4, usage)
        if where == "response":
            chat += f(19, c["model"])
        if c.get("display"):
            chat += f(21, c["display"])
        data = f(1, chat)
        if where == "planner":
            data += f(3, f(28, c["model"]))
        conn.execute("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)", (i, data))
        # A user input step and the planner response step that this generation produced.
        conn.execute("INSERT INTO steps (idx, step_type, metadata, step_payload) VALUES (?, 14, ?, ?)",
                     (step, f(1, f(1, int(c["ts"]))), f(1, 14) + f(19, f(2, first_input if i == 0 else "more"))))
        step += 1
        if planner_steps:
            conn.execute("INSERT INTO steps (idx, step_type, metadata) VALUES (?, 15, ?)",
                         (step, f(1, f(1, int(c["ts"])) + f(2, 5))))
            step += 1
    conn.commit()
    conn.close()


NOW = datetime(2026, 6, 15, 12, 0, 0)


def ts(days_ago: float, hour: int = 10) -> float:
    d = (NOW - timedelta(days=days_ago)).replace(hour=hour, minute=0, second=0)
    return d.timestamp()


def call(days_ago, model="gemini-2.5-pro", inp=100, out=10, cache=1000, think=5, display="Gemini 2.5 Pro", **kw):
    return {"ts": ts(days_ago), "model": model, "display": display, "input": inp, "output": out,
            "cache": cache, "thinking": think, **kw}


class ScannerTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.base = Path(self.tmp.name)
        self.desk = self.base / "desk"
        self.cli = self.base / "cli"
        self.desk.mkdir()
        self.cache = self.base / "cache" / "history.json"

    def tearDown(self):
        self.tmp.cleanup()

    def roots(self):
        return [(self.desk, "desktop"), (self.cli, "cli")]

    def scan(self, days=30, stats=None, cache=True, pricing_file=None):
        return hs.scan(self.roots(), self.cache if cache else None, days, now=NOW, stats=stats,
                       pricing_file=pricing_file)

    def test_windows_and_totals(self):
        make_db(self.desk / "a.db", [call(0), call(3), call(10), call(100)])
        make_db(self.desk / "b.db", [call(0, inp=1, out=2, cache=3, think=1)])
        r = self.scan()
        t = r["totals"]
        self.assertEqual(t["today"]["calls"], 2)
        self.assertEqual(t["today"]["conversations"], 2)
        self.assertEqual(t["today"]["input"], 101)
        self.assertEqual(t["today"]["output"], 12)
        self.assertEqual(t["today"]["cache_read"], 1003)
        self.assertEqual(t["today"]["thinking"], 6)
        self.assertEqual(t["d7"]["calls"], 3)
        self.assertEqual(t["d30"]["calls"], 4)
        self.assertEqual(t["all"]["calls"], 5)
        self.assertEqual(t["all"]["conversations"], 2)
        self.assertEqual(t["d30"]["conversations"], 2)
        self.assertEqual(r["sources"], {"desktop": 2, "cli": 0})
        self.assertEqual(r["errors"], 0)
        # gemini-2.5-pro built-in list price: 1.25 in / 10 out / 0.3125 cache per 1M.
        expected = (100 * 1.25 + 10 * 10 + 1000 * 0.3125) / 1e6
        self.assertAlmostEqual(t["d30"]["est_cost_usd"],
                               round(expected * 3 + (1.25 + 20 + 3 * 0.3125) / 1e6, 4), places=6)
        self.assertFalse(t["d30"]["cost_estimated"])
        self.assertEqual(r["pricing_source"], "builtin")
        self.assertIsNone(r["pricing_fetched_at"])
        self.assertEqual(r["d7_by_pool"], {"gemini": 223, "claude_gpt": 0, "other": 0})

    def test_contract_shape(self):
        make_db(self.desk / "a.db", [call(0)])
        r = self.scan()
        self.assertEqual(set(r), {"totals", "by_model", "by_conversation", "daily", "hourly_today", "d7_by_pool",
                                  "pricing_source", "pricing_fetched_at", "sources", "errors", "scanned_at",
                                  "elapsed_ms"})
        self.assertEqual(set(r["d7_by_pool"]), {"gemini", "claude_gpt", "other"})
        self.assertEqual(set(r["by_conversation"][0]),
                         {"id", "source", "title", "model", "display_name", "pool", "first_at", "last_at", "input",
                          "output", "cache_read", "thinking", "d7_tokens", "d7_by_pool", "calls", "est_cost_usd",
                          "cost_partial", "cost_estimated", "is_subagent", "by_model"})
        self.assertEqual(set(r["by_conversation"][0]["by_model"][0]),
                         {"model", "display_name", "input", "output", "cache_read", "thinking", "calls",
                          "est_cost_usd", "cost_estimated"})
        self.assertEqual(set(r["totals"]), {"today", "d7", "d30", "all"})
        for t in r["totals"].values():
            self.assertEqual(set(t), {"input", "output", "cache_read", "thinking", "calls", "conversations",
                                      "est_cost_usd", "cost_estimated"})
        self.assertEqual(set(r["by_model"][0]),
                         {"model", "display_name", "pool", "input", "output", "cache_read", "thinking", "d7_tokens",
                          "calls", "est_cost_usd", "cost_estimated"})
        self.assertEqual(set(r["daily"][0]), {"date", "tokens", "calls"})
        self.assertEqual(len(r["hourly_today"]), 24)
        self.assertEqual(set(r["hourly_today"][0]), {"hour", "tokens", "calls"})
        datetime.fromisoformat(r["scanned_at"])
        self.assertIsInstance(r["elapsed_ms"], int)

    def test_by_model(self):
        make_db(self.desk / "a.db", [
            call(0, model="claude-sonnet-4-5", display="Claude Sonnet 4.5", inp=10, out=10, cache=10),
            call(1, model="internal-x", display="Internal X", inp=5000, model_field="response"),
            call(2, model="gemini-2.5-pro"),
        ])
        make_db(self.desk / "b.db", [call(0, model="claude-sonnet-4-5", display="Claude Sonnet 4.5", inp=10, out=10, cache=10)])
        r = self.scan()
        models = [m["model"] for m in r["by_model"]]
        self.assertEqual(models, ["internal-x", "gemini-2.5-pro", "claude-sonnet-4-5"])  # by total tokens desc
        bm = {m["model"]: m for m in r["by_model"]}
        self.assertEqual(bm["claude-sonnet-4-5"]["calls"], 2)
        self.assertEqual(bm["claude-sonnet-4-5"]["display_name"], "Claude Sonnet 4.5")
        self.assertEqual(bm["internal-x"]["display_name"], "Internal X")
        self.assertIsNone(bm["internal-x"]["est_cost_usd"])
        self.assertAlmostEqual(bm["claude-sonnet-4-5"]["est_cost_usd"], round(2 * (10 * 3 + 10 * 15 + 10 * 0.3) / 1e6, 4))

    def test_display_only_model_resolves_to_known_id(self):
        make_db(self.desk / "a.db", [
            call(0, model="gemini-2.5-pro", display="Gemini 2.5 Pro"),
            call(0, model="", display="Gemini 2.5 Pro", model_field="none"),
            call(0, model="", display="Mystery", model_field="none"),
        ])
        r = self.scan()
        bm = {m["model"]: m for m in r["by_model"]}
        self.assertEqual(bm["gemini-2.5-pro"]["calls"], 2)
        self.assertEqual(bm["Mystery"]["display_name"], "Mystery")

    def test_by_conversation(self):
        self.cli.mkdir()
        make_db(self.desk / "old.db", [call(5, model="gemini-2.5-pro"), call(4, model="gemini-2.5-pro")],
                first_input="  Fix   the\nlogin bug please  ")
        make_db(self.desk / "new.db", [
            # Higher cache_read (50000) than internal-x, lower input+output (20 vs 9010):
            # verifies by_model sorts by (input + output) desc while primary model tracks total tokens.
            call(1, model="claude-sonnet-4-5", display="Claude Sonnet 4.5", inp=10, out=10, cache=50000, think=2),
            call(0, model="internal-x", display="Internal X", inp=9000, out=10, cache=100, think=3, model_field="response"),
        ], first_input="x" * 200)
        make_db(self.cli / "titled.db", [call(2, model="mystery")], first_input="ignored, official title wins")
        make_db(self.desk / "empty.db", [])
        make_db(self.desk / "worker.db", [call(10)], first_input="")
        make_db(self.desk / "sub.db", [call(11)], first_input="")
        conn = sqlite3.connect(self.base / "conversation_summaries.db")  # sibling of both roots
        conn.execute("CREATE TABLE conversation_summaries (conversation_id text, title text, preview text, agent_name text)")
        conn.execute("INSERT INTO conversation_summaries VALUES ('titled', 'Official Title', '', ''), ('new', '', '', ''),"
                     " ('worker', '', '', 'verifier'), ('sub', '', '', 'self')")
        conn.commit()
        conn.close()
        st = {}
        r = self.scan(stats=st)
        convs = r["by_conversation"]
        self.assertEqual([c["id"] for c in convs], ["new", "titled", "old", "worker", "sub"])  # newest first, empty skipped
        new, titled, old, worker, sub = convs
        self.assertEqual(worker["title"], "@verifier")
        self.assertTrue(worker["is_subagent"])
        self.assertIsNone(sub["title"])
        self.assertTrue(sub["is_subagent"])
        self.assertFalse(new["is_subagent"])
        self.assertFalse(titled["is_subagent"])
        self.assertFalse(old["is_subagent"])
        self.assertEqual(new["source"], "desktop")
        self.assertEqual(titled["source"], "cli")
        self.assertEqual(titled["title"], "Official Title")
        self.assertEqual(old["title"], "Fix the login bug please")
        self.assertEqual(len(new["title"]), hs.TITLE_MAX)
        self.assertTrue(new["title"].endswith("…"))
        self.assertEqual(new["model"], "claude-sonnet-4-5")  # highest total (incl. cache)
        self.assertEqual(new["display_name"], "Claude Sonnet 4.5")
        self.assertEqual(new["calls"], 2)
        self.assertEqual(new["input"], 9010)
        self.assertEqual(new["output"], 20)
        self.assertEqual(new["cache_read"], 50100)
        self.assertEqual(new["thinking"], 5)
        self.assertEqual(new["d7_tokens"], 9030)
        self.assertEqual(worker["d7_tokens"], 0)  # 10 days ago
        self.assertEqual(sub["d7_tokens"], 0)  # 11 days ago
        expected_claude_cost = round((10 * 3 + 10 * 15 + 50000 * 0.3) / 1e6, 4)
        self.assertAlmostEqual(new["est_cost_usd"], expected_claude_cost)
        self.assertTrue(new["cost_partial"])  # mixed priced + unpriced
        self.assertIsNone(titled["est_cost_usd"])
        self.assertTrue(titled["cost_partial"])  # all unpriced
        self.assertFalse(old["cost_partial"])  # all priced
        self.assertEqual(datetime.fromisoformat(new["first_at"]).timestamp(), ts(1))
        self.assertEqual(datetime.fromisoformat(new["last_at"]).timestamp(), ts(0))
        self.assertEqual(datetime.fromisoformat(old["first_at"]).timestamp(), ts(5))
        self.assertEqual(datetime.fromisoformat(old["last_at"]).timestamp(), ts(4))
        self.assertEqual(titled["first_at"], titled["last_at"])
        self.assertEqual(old["model"], "gemini-2.5-pro")
        # Per-conversation by_model sorted by (input + output) desc, tie-break model.
        self.assertEqual([m["model"] for m in new["by_model"]], ["internal-x", "claude-sonnet-4-5"])
        self.assertEqual(new["by_model"][0], {
            "model": "internal-x", "display_name": "Internal X",
            "input": 9000, "output": 10, "cache_read": 100, "thinking": 3, "calls": 1,
            "est_cost_usd": None, "cost_estimated": False,
        })
        self.assertEqual(new["by_model"][1], {
            "model": "claude-sonnet-4-5", "display_name": "Claude Sonnet 4.5",
            "input": 10, "output": 10, "cache_read": 50000, "thinking": 2, "calls": 1,
            "est_cost_usd": expected_claude_cost, "cost_estimated": False,
        })
        # Cached second scan yields the exact same list with zero cache misses.
        r2 = self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (6, 0))
        self.assertEqual(r2["by_conversation"], convs)

    def test_d7_tokens_spanning_window(self):
        # One conversation spanning older-than-7d calls, exact 7-day boundary (days_ago=6),
        # today (days_ago=0), and a future timestamp (days_ago=-1, excluded from d7).
        make_db(self.desk / "span.db", [
            call(10, model="model-a", inp=5000, out=500, cache=90000),   # outside d7
            call(7, model="model-a", inp=4000, out=400, cache=80000),    # 7 days ago = outside d7 ([today-6, today])
            call(6, model="model-a", inp=300, out=30, cache=50000),      # exact d7 start (included)
            call(0, model="model-b", inp=200, out=20, cache=40000),      # today (included)
            call(-1, model="model-b", inp=900, out=90, cache=10000),     # future (excluded from d7)
        ])
        make_db(self.desk / "ancient.db", [
            call(20, model="model-a", inp=8000, out=800, cache=70000),   # outside d7
        ])
        st = {}
        r = self.scan(stats=st)
        d7_total = r["totals"]["d7"]["input"] + r["totals"]["d7"]["output"]
        self.assertEqual(d7_total, 550)  # (300+30) + (200+20), cache_read excluded

        bc = {c["id"]: c for c in r["by_conversation"]}
        self.assertEqual(bc["span"]["d7_tokens"], 550)
        self.assertEqual(bc["ancient"]["d7_tokens"], 0)
        self.assertEqual(sum(c["d7_tokens"] for c in r["by_conversation"]), d7_total)

        bm = {m["model"]: m for m in r["by_model"]}
        self.assertEqual(bm["model-a"]["d7_tokens"], 330)
        self.assertEqual(bm["model-b"]["d7_tokens"], 220)
        self.assertEqual(sum(m["d7_tokens"] for m in r["by_model"]), d7_total)

        # Cache v3 hits on second scan and preserves d7_tokens.
        r2 = self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (2, 0))
        self.assertEqual(hs.CACHE_VERSION, 3)
        self.assertEqual(r2["by_model"], r["by_model"])
        self.assertEqual(r2["by_conversation"], r["by_conversation"])

    def test_by_conversation_by_model_tie_break(self):
        make_db(self.desk / "tie.db", [
            call(0, model="model-b", display="B", inp=50, out=50, cache=10),
            call(0, model="model-a", display="A", inp=60, out=40, cache=10),
        ])
        bm = self.scan()["by_conversation"][0]["by_model"]
        self.assertEqual([m["model"] for m in bm], ["model-a", "model-b"])

    def test_by_conversation_cap(self):
        self.assertEqual(hs.MAX_CONVERSATIONS, 500)
        with mock.patch.object(hs, "MAX_CONVERSATIONS", 10):
            for i in range(15):
                make_db(self.desk / f"c{i:03}.db", [{**call(0), "ts": ts(0) - i}])
            convs = self.scan()["by_conversation"]
            self.assertEqual(len(convs), 10)
            self.assertEqual(convs[0]["id"], "c000")
            self.assertEqual(convs[-1]["id"], "c009")

    def test_exported_helpers(self):
        p = self.desk / "a.db"
        make_db(p, [call(3), call(1)])
        conn = hs.open_ro(p)
        try:
            self.assertEqual(hs.generation_timestamps(conn, 3, 123.0), [ts(3), ts(1), ts(1)])
        finally:
            conn.close()
        self.assertEqual(hs.generation_time([], 0, 5.0), 5.0)
        g = hs.parse_generation(f(1, f(4, f(2, 7) + f(9, 2)) + f(19, "resp-model") + f(21, "Resp")))
        self.assertEqual(g, ("resp-model", "Resp", 7, 0, 0, 2))
        self.assertIsNone(hs.parse_generation(b""))

    def test_zero_usage_calls_ignored(self):
        make_db(self.desk / "a.db", [call(0), call(0, inp=0, out=0, cache=0, think=0)])
        self.assertEqual(self.scan()["totals"]["all"]["calls"], 1)

    def test_unknown_only_cost_is_null(self):
        make_db(self.desk / "a.db", [call(0, model="mystery-model")])
        r = self.scan()
        self.assertIsNone(r["totals"]["all"]["est_cost_usd"])
        self.assertEqual(r["totals"]["all"]["calls"], 1)

    def test_daily_zero_fill(self):
        make_db(self.desk / "a.db", [call(0, inp=1, out=2, cache=3), call(2), call(2), call(40)])
        r = self.scan(days=7)
        daily = r["daily"]
        self.assertEqual(len(daily), 7)
        self.assertEqual(daily[-1]["date"], NOW.date().isoformat())
        self.assertEqual(daily[0]["date"], (NOW.date() - timedelta(days=6)).isoformat())
        self.assertEqual(daily[-1], {"date": NOW.date().isoformat(), "tokens": 6, "calls": 1})
        self.assertEqual(daily[-3]["calls"], 2)
        self.assertEqual(daily[-3]["tokens"], 2 * 1110)
        self.assertEqual(sum(d["calls"] for d in daily), 3)
        self.assertEqual([d["date"] for d in daily], sorted(d["date"] for d in daily))
        self.assertEqual(daily[1]["tokens"], 0)

    def test_hourly_today(self):
        h0 = NOW.replace(hour=0, minute=5, second=0).timestamp()
        h14a = NOW.replace(hour=14, minute=10, second=0).timestamp()
        h14b = NOW.replace(hour=14, minute=55, second=0).timestamp()
        h23 = NOW.replace(hour=23, minute=59, second=30).timestamp()
        yest14 = (NOW - timedelta(days=1)).replace(hour=14, minute=0, second=0).timestamp()
        tmrw14 = (NOW + timedelta(days=1)).replace(hour=14, minute=0, second=0).timestamp()
        make_db(self.desk / "a.db", [
            {**call(0, inp=10, out=5, cache=100), "ts": h0},
            {**call(0, inp=20, out=10, cache=200), "ts": h14a},
            {**call(1, inp=999, out=999, cache=9999), "ts": yest14},  # yesterday: excluded
            {**call(-1, inp=888, out=888, cache=8888), "ts": tmrw14},  # tomorrow: excluded
        ])
        make_db(self.desk / "b.db", [
            {**call(0, inp=30, out=15, cache=300), "ts": h14b},
            {**call(0, inp=40, out=20, cache=400), "ts": h23},
        ])
        st = {}
        r = self.scan(days=7, stats=st)
        ht = r["hourly_today"]
        self.assertEqual(len(ht), 24)
        self.assertEqual([x["hour"] for x in ht], list(range(24)))
        self.assertEqual(ht[0], {"hour": 0, "tokens": 115, "calls": 1})
        self.assertEqual(ht[14], {"hour": 14, "tokens": 575, "calls": 2})  # (20+10+200) + (30+15+300)
        self.assertEqual(ht[23], {"hour": 23, "tokens": 460, "calls": 1})
        # All other hours zero-filled.
        for h in range(24):
            if h not in (0, 14, 23):
                self.assertEqual(ht[h], {"hour": h, "tokens": 0, "calls": 0})
        # Totals match daily[-1] and totals["today"].
        today_tot = r["totals"]["today"]
        self.assertEqual(sum(x["tokens"] for x in ht), r["daily"][-1]["tokens"])
        self.assertEqual(sum(x["tokens"] for x in ht), today_tot["input"] + today_tot["output"] + today_tot["cache_read"])
        self.assertEqual(sum(x["calls"] for x in ht), r["daily"][-1]["calls"])
        self.assertEqual(sum(x["calls"] for x in ht), today_tot["calls"])
        # Cache v3 hits and preserves hourly_today.
        r2 = self.scan(days=7, stats=st)
        self.assertEqual((st["hits"], st["misses"]), (2, 0))
        self.assertEqual(r2["hourly_today"], ht)

    def test_mtime_fallback_without_planner_steps(self):
        p = self.desk / "a.db"
        make_db(p, [call(50)], planner_steps=False)
        old = ts(20)
        os.utime(p, (old, old))
        r = self.scan()
        self.assertEqual(r["totals"]["d30"]["calls"], 1)
        self.assertEqual(r["totals"]["d7"]["calls"], 0)

    def test_cache_hit_miss_invalidation(self):
        make_db(self.desk / "a.db", [call(0)])
        make_db(self.desk / "b.db", [call(0)])
        st = {}
        r1 = self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (0, 2))
        self.assertTrue(self.cache.is_file())
        r2 = self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (2, 0))
        self.assertEqual(r1["totals"], r2["totals"])

        # Change b.db: only it is re-parsed.
        conn = sqlite3.connect(self.desk / "b.db")
        conn.execute("INSERT INTO gen_metadata (idx, data) VALUES (99, ?)",
                     (f(1, f(4, f(2, 7))) + f(3, f(28, "gemini-2.5-pro")),))
        conn.commit()
        conn.close()
        st_b = os.stat(self.desk / "b.db")
        os.utime(self.desk / "b.db", ns=(st_b.st_atime_ns, st_b.st_mtime_ns + 5_000_000_000))
        r3 = self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (1, 1))
        self.assertEqual(r3["totals"]["all"]["calls"], 3)

        # A -wal change also invalidates.
        Path(str(self.desk / "a.db") + "-wal").write_bytes(b"")
        self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (1, 1))

        # Deleted DBs disappear from results and cache.
        (self.desk / "a.db").unlink()
        Path(str(self.desk / "a.db") + "-wal").unlink()
        r4 = self.scan(stats=st)
        self.assertEqual(r4["sources"]["desktop"], 1)
        cached = json.loads(self.cache.read_text(encoding="utf-8"))
        self.assertEqual(len(cached["dbs"]), 1)

    def test_corrupt_cache_file_is_ignored(self):
        make_db(self.desk / "a.db", [call(0)])
        self.cache.parent.mkdir(parents=True)
        self.cache.write_text("{not json", encoding="utf-8")
        st = {}
        r = self.scan(stats=st)
        self.assertEqual(r["totals"]["all"]["calls"], 1)
        self.assertEqual(st["misses"], 1)

    def test_missing_roots(self):
        r = hs.scan([(self.base / "nope", "desktop"), (self.base / "nope2", "cli")], None, 5, now=NOW)
        self.assertEqual(r["sources"], {"desktop": 0, "cli": 0})
        self.assertEqual(r["errors"], 0)
        self.assertEqual(r["totals"]["all"]["calls"], 0)
        self.assertEqual(r["by_model"], [])
        self.assertEqual(len(r["daily"]), 5)
        self.assertEqual(len(r["hourly_today"]), 24)
        self.assertTrue(all(h["tokens"] == 0 and h["calls"] == 0 for h in r["hourly_today"]))

    def test_cli_root_and_labels(self):
        self.cli.mkdir()
        make_db(self.desk / "a.db", [call(0)])
        make_db(self.cli / "c.db", [call(0)])
        other = self.base / "other"
        other.mkdir()
        make_db(other / "o.db", [call(0)])
        r = hs.scan(self.roots() + [(other, "lab")], None, 5, now=NOW)
        self.assertEqual(r["sources"], {"desktop": 1, "cli": 1, "lab": 1})
        self.assertEqual(r["totals"]["today"]["conversations"], 3)

    def test_corrupt_dbs_counted_not_fatal(self):
        make_db(self.desk / "good.db", [call(0)])
        (self.desk / "garbage.db").write_bytes(b"this is not a sqlite database at all" * 100)
        r = self.scan()
        self.assertEqual(r["errors"], 1)
        self.assertEqual(r["totals"]["all"]["calls"], 1)
        self.assertEqual(r["sources"]["desktop"], 1)

    def test_db_without_gen_metadata_is_empty_and_cached(self):
        make_db(self.desk / "good.db", [call(0)])
        conn = sqlite3.connect(self.desk / "fresh.db")
        conn.execute("CREATE TABLE steps (idx integer, step_type integer, metadata blob)")
        conn.commit()
        conn.close()
        (self.desk / "zero.db").write_bytes(b"")
        st = {}
        r = self.scan(stats=st)
        self.assertEqual(r["errors"], 0)
        self.assertEqual(r["sources"]["desktop"], 3)
        self.assertEqual(r["totals"]["all"]["calls"], 1)
        self.assertEqual(r["totals"]["all"]["conversations"], 1)
        self.scan(stats=st)
        self.assertEqual((st["hits"], st["misses"]), (3, 0))

    def test_read_only_access(self):
        p = self.desk / "a.db"
        make_db(p, [call(0)])
        before = p.read_bytes()
        mtime = p.stat().st_mtime_ns
        self.scan()
        self.assertEqual(p.read_bytes(), before)
        self.assertEqual(p.stat().st_mtime_ns, mtime)
        self.assertFalse(Path(str(p) + "-wal").exists())

    def test_parse_root(self):
        self.assertEqual(hs.parse_root("C:\\x\\conv=cli"), (Path("C:\\x\\conv"), "cli"))
        self.assertEqual(hs.parse_root("/tmp/conv"), (Path("/tmp/conv"), "desktop"))

    def test_price_lookup(self):
        # Exact released models -> cost_estimated=False.
        self.assertEqual(hs.price_info("gemini-2.5-pro"), ((1.25, 10.00, 0.3125), False))
        self.assertEqual(hs.price_info("gemini-2.5-flash"), ((0.30, 2.50, 0.075), False))
        self.assertEqual(hs.price_info("gemini-3-flash"), ((0.50, 3.00, 0.05), False))
        self.assertEqual(hs.price_info("claude-opus-4-6-thinking"), ((15.00, 75.00, 1.50), False))
        self.assertEqual(hs.price_info("claude-sonnet-4-6"), ((3.00, 15.00, 0.30), False))
        self.assertEqual(hs.price_info("claude-haiku-4-5"), ((0.80, 4.00, 0.08), False))
        self.assertEqual(hs.price_info("gpt-oss-120b-medium"), ((0.15, 0.60, 0.075), False))
        # Backward-compatible call_cost / price_for.
        self.assertEqual(hs.price_for("gemini-2.5-flash"), (0.30, 2.50, 0.075))
        self.assertAlmostEqual(hs.call_cost("claude-opus-4-6-thinking", 1_000_000, 0, 0), 15.0)
        # Same-family preview fallbacks -> cost_estimated=True.
        self.assertEqual(hs.price_info("claude-opus-5-5-medium"), ((15.00, 75.00, 1.50), True))
        self.assertEqual(hs.price_info("claude-sonnet-5-0"), ((3.00, 15.00, 0.30), True))
        self.assertEqual(hs.price_info("gemini-4-hydrogen-tiered-high"), ((1.25, 10.00, 0.3125), True))
        self.assertEqual(hs.price_info("gemini-pro-orchestrator-neon"), ((1.25, 10.00, 0.3125), True))
        self.assertEqual(hs.price_info("gemini-3.8-flash-n"), ((0.30, 2.50, 0.075), True))
        self.assertEqual(hs.price_info("gemini-3.5-flash-lite"), ((0.30, 2.50, 0.075), True))
        self.assertEqual(hs.price_info("gemini-3.1-flash"), ((0.30, 2.50, 0.075), True))
        self.assertEqual(hs.price_info("gemini-2.5-flash-lite-preview"), ((0.30, 2.50, 0.075), True))
        self.assertEqual(hs.price_info("gemini-flash-worker-agy"), ((0.30, 2.50, 0.075), True))
        # Unpriced / tab / unknown -> (None, False).
        self.assertEqual(hs.call_cost_info("tab_flash_lite_preview", 1000, 100, 0), (None, False))
        self.assertEqual(hs.call_cost_info("unknown", 1000, 100, 0), (None, False))
        self.assertEqual(hs.call_cost_info("internal-x", 1000, 100, 0), (None, False))

    def test_pricing_file_and_custom_override(self):
        # Missing / corrupt / empty pricing files fall back silently to builtin.
        self.assertEqual(hs.load_pricing_file(None), ({}, "builtin", None))
        self.assertEqual(hs.load_pricing_file(self.base / "missing.json"), ({}, "builtin", None))
        bad = self.base / "bad.json"
        bad.write_text("{not json", encoding="utf-8")
        self.assertEqual(hs.load_pricing_file(bad), ({}, "builtin", None))
        empty = self.base / "empty.json"
        empty.write_text(json.dumps({"source": "litellm", "models": {}}), encoding="utf-8")
        self.assertEqual(hs.load_pricing_file(empty), ({}, "builtin", None))

        pf = self.base / "pricing-cache.json"
        pf.write_text(json.dumps({
            "source": "openrouter",
            "fetched_at": "2026-06-15T10:00:00Z",
            "models": {
                "anthropic/claude-opus-4.6": {"input": 5.0, "output": 25.0, "cache_read": 0.5},
                "google/gemini-2.5-pro": {"input": 2.0, "output": 12.0, "cache_read": 0.4},
                "google/gemini-2.5-flash-lite": {"input": 0.1, "output": 0.4, "cache_read": 0.02},
            },
        }), encoding="utf-8")
        models, src, fetched = hs.load_pricing_file(pf)
        self.assertEqual((src, fetched), ("openrouter", "2026-06-15T10:00:00Z"))
        # Exact match strips provider prefix & matches dot/dash version -> estimated=False.
        self.assertEqual(hs.call_cost_info("claude-opus-4-6-thinking", 1_000_000, 0, 0, models), (5.0, False))
        # Direct custom entry promotes gemini-2.5-flash-lite to exact -> estimated=False.
        self.assertEqual(hs.call_cost_info("gemini-2.5-flash-lite", 1_000_000, 0, 0, models), (0.1, False))
        # Preview fallback resolves target against custom_prices -> estimated=True.
        self.assertEqual(hs.call_cost_info("claude-opus-5-5-medium", 1_000_000, 0, 0, models), (5.0, True))
        self.assertEqual(hs.call_cost_info("gemini-4-hydrogen-tiered-high", 1_000_000, 0, 0, models), (2.0, True))

        # End-to-end via scan() and CLI --pricing-file.
        make_db(self.desk / "mix.db", [
            call(0, model="claude-opus-4-6-thinking", inp=1_000_000, out=0, cache=0),
            call(2, model="gemini-4-hydrogen-tiered-high", inp=1_000_000, out=0, cache=0),
        ])
        r = self.scan(pricing_file=pf)
        self.assertEqual(r["pricing_source"], "openrouter")
        self.assertEqual(r["pricing_fetched_at"], "2026-06-15T10:00:00Z")
        # Today has only exact claude-opus-4-6-thinking -> cost_estimated=False.
        self.assertEqual(r["totals"]["today"]["est_cost_usd"], 5.0)
        self.assertFalse(r["totals"]["today"]["cost_estimated"])
        # d7 includes preview gemini-4-hydrogen -> 5.0 + 2.0 = 7.0, cost_estimated=True.
        self.assertEqual(r["totals"]["d7"]["est_cost_usd"], 7.0)
        self.assertTrue(r["totals"]["d7"]["cost_estimated"])
        bm = {m["model"]: m for m in r["by_model"]}
        self.assertFalse(bm["claude-opus-4-6-thinking"]["cost_estimated"])
        self.assertTrue(bm["gemini-4-hydrogen-tiered-high"]["cost_estimated"])
        self.assertTrue(r["by_conversation"][0]["cost_estimated"])

        out = subprocess.run(
            [sys.executable, str(SCRIPT), "--json", "--cache", str(self.cache), "--root", f"{self.desk}=desktop",
             "--pricing-file", str(pf)],
            capture_output=True, text=True, check=True,
        ).stdout
        cli_r = json.loads(out)
        self.assertEqual(cli_r["pricing_source"], "openrouter")
        self.assertEqual(cli_r["pricing_fetched_at"], "2026-06-15T10:00:00Z")
        self.assertEqual(cli_r["totals"]["all"]["est_cost_usd"], 7.0)

    def test_model_pool_and_d7_by_pool(self):
        self.assertEqual(hs.model_pool("gemini-4-hydrogen-tiered-high"), "gemini")
        self.assertEqual(hs.model_pool("gemini-pro-orchestrator-neon"), "gemini")
        self.assertEqual(hs.model_pool("Orchestrator (Neon)"), "gemini")
        self.assertEqual(hs.model_pool("claude-opus-5-5-medium"), "claude_gpt")
        self.assertEqual(hs.model_pool("gpt-oss-120b-medium"), "claude_gpt")
        self.assertEqual(hs.model_pool("openai/gpt-4o"), "claude_gpt")
        self.assertEqual(hs.model_pool("tab_flash_lite_preview"), "other")
        self.assertEqual(hs.model_pool("unknown"), "other")
        self.assertEqual(hs.model_pool("internal-x"), "other")

        make_db(self.desk / "multi.db", [
            call(0, model="gemini-4-hydrogen-tiered-high", inp=1000, out=200, cache=9000),  # gemini d7 = 1200
            call(1, model="claude-opus-5-5-medium", inp=400, out=100, cache=5000),          # claude_gpt d7 = 500
            call(10, model="claude-opus-5-5-medium", inp=9000, out=900, cache=5000),        # >7d excluded from d7
        ])
        make_db(self.desk / "other.db", [
            call(2, model="internal-x", inp=300, out=50, cache=1000),                       # other d7 = 350
            call(3, model="gpt-oss-120b-medium", inp=200, out=50, cache=1000),              # claude_gpt d7 = 250
        ])
        r = self.scan()
        self.assertEqual(r["d7_by_pool"], {"gemini": 1200, "claude_gpt": 750, "other": 350})
        self.assertEqual(sum(r["d7_by_pool"].values()),
                         r["totals"]["d7"]["input"] + r["totals"]["d7"]["output"])
        bc = {c["id"]: c for c in r["by_conversation"]}
        self.assertEqual(bc["multi"]["pool"], "gemini")  # highest d7 pool (1200 > 500)
        self.assertEqual(bc["multi"]["d7_by_pool"], {"gemini": 1200, "claude_gpt": 500, "other": 0})
        self.assertEqual(bc["other"]["pool"], "other")   # highest d7 pool (350 > 250)
        self.assertEqual(bc["other"]["d7_by_pool"], {"gemini": 0, "claude_gpt": 250, "other": 350})
        for p in ("gemini", "claude_gpt", "other"):
            self.assertEqual(sum(c["d7_by_pool"][p] for c in r["by_conversation"]), r["d7_by_pool"][p])
            self.assertEqual(sum(m["d7_tokens"] for m in r["by_model"] if m["pool"] == p), r["d7_by_pool"][p])

    def test_perf_200_dbs(self):
        for i in range(200):
            make_db(self.desk / f"c{i:03}.db", [call(i % 40, inp=i), call(i % 7)])
        st = {}
        t0 = time.perf_counter()
        r = self.scan(days=365, stats=st)
        cold = time.perf_counter() - t0
        self.assertEqual(r["totals"]["all"]["calls"], 400)
        self.assertEqual(len(r["by_conversation"]), 200)
        self.assertEqual(len(r["daily"]), 365)
        t0 = time.perf_counter()
        self.scan(days=365, stats=st)
        warm = time.perf_counter() - t0
        self.assertEqual(st["hits"], 200)
        self.assertLess(cold, 5.0)
        self.assertLess(warm, 2.0)

    def test_cli_json(self):
        make_db(self.desk / "a.db", [call(0)])
        self.cli.mkdir()
        make_db(self.cli / "b.db", [call(0)])
        out = subprocess.run(
            [sys.executable, str(SCRIPT), "--json", "--cache", str(self.cache), "--root", f"{self.desk}=desktop",
             "--root", f"{self.cli}=cli", "--days", "10"],
            capture_output=True, text=True, check=True,
        ).stdout
        r = json.loads(out)
        self.assertEqual(r["sources"], {"desktop": 1, "cli": 1})
        self.assertEqual(len(r["daily"]), 10)
        self.assertEqual(r["totals"]["all"]["calls"], 2)
        self.assertTrue(self.cache.is_file())


if __name__ == "__main__":
    unittest.main()
