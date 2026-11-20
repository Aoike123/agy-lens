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


def make_db(path: Path, calls: list[dict], planner_steps: bool = True) -> None:
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
        conn.execute("INSERT INTO steps (idx, step_type, metadata) VALUES (?, 14, ?)", (step, f(1, f(1, int(c["ts"])))))
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

    def scan(self, days=30, stats=None, cache=True):
        return hs.scan(self.roots(), self.cache if cache else None, days, now=NOW, stats=stats)

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
        # gemini-2.5-pro reference price: 1.25 in / 10 out / 0.125 cache per 1M.
        expected = (100 * 1.25 + 10 * 10 + 1000 * 0.125) / 1e6
        self.assertAlmostEqual(t["d30"]["est_cost_usd"], round(expected * 3 + (1.25 + 20 + 0.375) / 1e6, 4), places=6)

    def test_contract_shape(self):
        make_db(self.desk / "a.db", [call(0)])
        r = self.scan()
        self.assertEqual(set(r), {"totals", "by_model", "daily", "sources", "errors", "scanned_at", "elapsed_ms"})
        self.assertEqual(set(r["totals"]), {"today", "d7", "d30", "all"})
        for t in r["totals"].values():
            self.assertEqual(set(t), {"input", "output", "cache_read", "thinking", "calls", "conversations", "est_cost_usd"})
        self.assertEqual(set(r["by_model"][0]),
                         {"model", "display_name", "input", "output", "cache_read", "thinking", "calls", "est_cost_usd"})
        self.assertEqual(set(r["daily"][0]), {"date", "tokens", "calls"})
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
        self.assertEqual(hs.price_for("gemini-2.5-flash-lite-preview"), (0.10, 0.40, 0.01))
        self.assertEqual(hs.price_for("gemini-2.5-flash"), (0.30, 2.50, 0.03))
        self.assertIsNotNone(hs.price_for("gpt-oss-120b-medium"))
        self.assertIsNone(hs.price_for("gemini-pro-orchestrator"))

    def test_perf_200_dbs(self):
        for i in range(200):
            make_db(self.desk / f"c{i:03}.db", [call(i % 40, inp=i), call(i % 7)])
        st = {}
        t0 = time.perf_counter()
        r = self.scan(days=365, stats=st)
        cold = time.perf_counter() - t0
        self.assertEqual(r["totals"]["all"]["calls"], 400)
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
