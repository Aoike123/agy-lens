#!/usr/bin/env python3
"""Multi-conversation token-usage scanner for Antigravity conversation databases.

Reads every conversation database (read-only) under the desktop and CLI conversation
folders, sums per-call token usage from the `gen_metadata` table and aggregates it by
time window, model and day. Results per database are cached on disk keyed by the
database's (and its -wal file's) mtime and size, so only changed databases are re-parsed.

Python stdlib only. Never writes to a conversation database.

    python history_scanner.py --json [--cache PATH] [--root DIR[=label]]... [--days 365]
"""

import argparse
from datetime import date, datetime, timedelta
import json
import os
from pathlib import Path
import sqlite3
import sys
import time

CACHE_VERSION = 2

# --- protobuf (minimal reader, same wire decoding as context_report.Msg) ------


def _varint(buf: bytes, pos: int) -> tuple[int, int]:
    val = shift = 0
    while pos < len(buf):
        b = buf[pos]
        pos += 1
        val |= (b & 0x7F) << shift
        if not b & 0x80:
            return val, pos
        shift += 7
    raise ValueError("Truncated varint")


class Msg:
    """Protobuf message decoded one level deep: field number -> list of raw values."""

    __slots__ = ("fields",)

    def __init__(self, buf: bytes | None, want: frozenset | None = None):
        self.fields: dict[int, list] = {}
        buf = buf or b""
        pos, n = 0, len(buf)
        while pos < n:
            try:
                tag, pos = _varint(buf, pos)
                fn, wt = tag >> 3, tag & 7
                if wt == 0:
                    val, pos = _varint(buf, pos)
                elif wt == 2:
                    ln, pos = _varint(buf, pos)
                    val = buf[pos : pos + ln] if want is None or fn in want else None
                    pos += ln
                elif wt == 1:
                    val, pos = buf[pos : pos + 8], pos + 8
                elif wt == 5:
                    val, pos = buf[pos : pos + 4], pos + 4
                else:
                    break
            except ValueError:
                break
            if want is None or fn in want:
                self.fields.setdefault(fn, []).append(val)

    def int(self, fn: int) -> int:
        v = self.fields.get(fn, [0])[-1]
        return v if isinstance(v, int) else 0

    def bytes(self, fn: int) -> bytes:
        v = self.fields.get(fn, [b""])[-1]
        return v if isinstance(v, bytes) else b""

    def str(self, fn: int) -> str:
        return self.bytes(fn).decode("utf-8", errors="replace")

    def msg(self, fn: int, want: frozenset | None = None) -> "Msg | None":
        return Msg(self.bytes(fn), want) if fn in self.fields else None


GEN_FIELDS = frozenset((1, 3))  # chat_model, planner_config
CHAT_FIELDS = frozenset((4, 19, 21))  # usage, response_model, model_display_name
PLANNER_FIELDS = frozenset((28,))  # model_name
USAGE_FIELDS = frozenset((2, 3, 5, 9))  # input, output, cache_read, thinking
STEP_MD_FIELDS = frozenset((1,))  # created_at


# --- pricing -----------------------------------------------------------------

# REFERENCE ONLY: approximate public list prices in USD per 1M tokens
# (input, output, cache_read), matched by model-ID prefix, first match wins.
# Output includes thinking tokens (the API's output count already contains them).
# Not your bill: plans, tiers, long-context surcharges and discounts are ignored.
# Internal / unreleased model IDs are deliberately absent and price as null.
PRICES_USD_PER_1M: list[tuple[str, tuple[float, float, float]]] = [
    ("gemini-3.1-pro", (2.00, 12.00, 0.20)),
    ("gemini-3-pro", (2.00, 12.00, 0.20)),
    ("gemini-3-flash", (0.50, 3.00, 0.05)),
    ("gemini-2.5-pro", (1.25, 10.00, 0.125)),
    ("gemini-2.5-flash-lite", (0.10, 0.40, 0.01)),
    ("gemini-2.5-flash", (0.30, 2.50, 0.03)),
    ("gemini-2.0-flash-lite", (0.075, 0.30, 0.075)),
    ("gemini-2.0-flash", (0.10, 0.40, 0.025)),
    ("claude-opus-4-6", (5.00, 25.00, 0.50)),
    ("claude-opus-4-5", (5.00, 25.00, 0.50)),
    ("claude-opus-4-1", (15.00, 75.00, 1.50)),
    ("claude-opus-4", (15.00, 75.00, 1.50)),
    ("claude-sonnet-4", (3.00, 15.00, 0.30)),
    ("claude-3-7-sonnet", (3.00, 15.00, 0.30)),
    ("claude-haiku-4-5", (1.00, 5.00, 0.10)),
    ("claude-3-5-haiku", (0.80, 4.00, 0.08)),
    ("gpt-oss-120b", (0.15, 0.60, 0.15)),
    ("gpt-oss-20b", (0.05, 0.20, 0.05)),
]


def price_for(model: str) -> tuple[float, float, float] | None:
    for prefix, p in PRICES_USD_PER_1M:
        if model.startswith(prefix):
            return p
    return None


def call_cost(model: str, inp: int, out: int, cache_read: int) -> float | None:
    p = price_for(model)
    if p is None:
        return None
    return (inp * p[0] + out * p[1] + cache_read * p[2]) / 1_000_000.0


# --- per-database parsing ----------------------------------------------------

STEP_PLANNER_RESPONSE = 15
DISPLAY_PREFIX = "display:"


def fingerprint(db: Path) -> list[int] | None:
    try:
        st = db.stat()
    except OSError:
        return None
    fp = [st.st_mtime_ns, st.st_size, 0, 0]
    try:
        wst = Path(str(db) + "-wal").stat()
        fp[2], fp[3] = wst.st_mtime_ns, wst.st_size
    except OSError:
        pass
    return fp


def parse_db(db: Path) -> dict:
    """Read one conversation DB read-only. Returns {"calls": [[ts, model, in, out, cache, think]], "names": {}}.

    Raises sqlite3.Error / OSError on unreadable or corrupt databases.
    """
    fallback_ts = db.stat().st_mtime
    uri = "file:" + db.resolve().as_posix() + "?mode=ro"
    conn = sqlite3.connect(uri, uri=True, timeout=0.5)
    try:
        try:
            gens = conn.execute("SELECT data FROM gen_metadata ORDER BY idx").fetchall()
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e):
                raise
            # Fresh conversation (no generation yet): valid, just empty. Real corruption still raises.
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
            return {"calls": [], "names": {}}
        try:
            planner_md = conn.execute(
                "SELECT metadata FROM steps WHERE step_type = ? ORDER BY idx", (STEP_PLANNER_RESPONSE,)
            ).fetchall()
        except sqlite3.OperationalError:
            planner_md = []
    finally:
        conn.close()

    # gen_metadata rows carry no timestamp; the i-th generation belongs to the i-th
    # PLANNER_RESPONSE step, whose metadata.created_at (field 1, Timestamp.seconds) we use.
    stamps: list[float] = []
    for (md,) in planner_md:
        created = Msg(md, STEP_MD_FIELDS).msg(1)
        sec = created.int(1) if created is not None else 0
        if sec > 0:
            stamps.append(float(sec))

    calls, names = [], {}
    for i, (data,) in enumerate(gens):
        if not data:
            continue
        gen = Msg(data, GEN_FIELDS)
        chat = gen.msg(1, CHAT_FIELDS)
        if chat is None:
            continue
        usage = chat.msg(4, USAGE_FIELDS)
        if usage is None:
            continue
        inp, out, cache, think = usage.int(2), usage.int(3), usage.int(5), usage.int(9)
        if not (inp or out or cache or think):
            continue  # aborted / in-flight generation with no billed usage
        planner = gen.msg(3, PLANNER_FIELDS)
        display = chat.str(21)
        model = (planner.str(28) if planner is not None else "") or chat.str(19)
        if model:
            if display:
                names[model] = display
        else:
            # Only a display name: resolved to a real model ID at aggregation time if one is known.
            model = DISPLAY_PREFIX + display if display else "unknown"
        if stamps:
            ts = stamps[i] if i < len(stamps) else stamps[-1]
        else:
            ts = fallback_ts
        calls.append([ts, model, inp, out, cache, think])
    return {"calls": calls, "names": names}


# --- cache -------------------------------------------------------------------


def load_cache(path: Path | None) -> dict:
    if path is None:
        return {}
    try:
        with open(path, encoding="utf-8") as fh:
            data = json.load(fh)
        if isinstance(data, dict) and data.get("version") == CACHE_VERSION and isinstance(data.get("dbs"), dict):
            return data["dbs"]
    except (OSError, ValueError):
        pass
    return {}


def save_cache(path: Path | None, dbs: dict) -> None:
    if path is None:
        return
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(path.name + f".{os.getpid()}.tmp")
        with open(tmp, "w", encoding="utf-8") as fh:
            json.dump({"version": CACHE_VERSION, "dbs": dbs}, fh, separators=(",", ":"))
        os.replace(tmp, path)
    except OSError:
        pass


# --- aggregation -------------------------------------------------------------


def default_roots() -> list[tuple[Path, str]]:
    base = Path.home() / ".gemini"
    return [(base / "antigravity" / "conversations", "desktop"), (base / "antigravity-cli" / "conversations", "cli")]


def parse_root(spec: str) -> tuple[Path, str]:
    # Split on the last "=" so Windows drive letters and odd paths survive; label is optional.
    if "=" in spec:
        d, label = spec.rsplit("=", 1)
        if label and "/" not in label and "\\" not in label:
            return Path(d).expanduser(), label
    return Path(spec).expanduser(), "desktop"


def _empty_totals() -> dict:
    return {"input": 0, "output": 0, "cache_read": 0, "thinking": 0, "calls": 0, "conversations": 0, "est_cost_usd": None}


def scan(roots: list[tuple[Path, str]], cache_path: Path | None = None, days: int = 365,
         now: datetime | None = None, stats: dict | None = None) -> dict:
    t0 = time.perf_counter()
    now = now or datetime.now()
    today = now.date()
    days = max(1, days)
    stats = stats if stats is not None else {}
    stats.update(hits=0, misses=0)

    old_cache = load_cache(cache_path)
    new_cache: dict = {}
    sources: dict[str, int] = {"desktop": 0, "cli": 0}
    errors = 0
    per_db: list[tuple[str, dict]] = []

    for root, label in roots:
        sources.setdefault(label, 0)
        try:
            dbs = sorted(p for p in root.glob("*.db") if p.is_file())
        except OSError:
            continue
        for db in dbs:
            key = str(db.resolve())
            fp = fingerprint(db)
            if fp is None:
                errors += 1
                continue
            entry = old_cache.get(key)
            if isinstance(entry, dict) and entry.get("fp") == fp and isinstance(entry.get("calls"), list):
                stats["hits"] += 1
            else:
                stats["misses"] += 1
                try:
                    parsed = parse_db(db)
                except (sqlite3.Error, OSError, ValueError, MemoryError):
                    errors += 1
                    continue
                entry = {"fp": fp, **parsed}
            new_cache[key] = entry
            sources[label] += 1
            per_db.append((key, entry))

    save_cache(cache_path, new_cache)

    windows = {
        "today": today,
        "d7": today - timedelta(days=6),
        "d30": today - timedelta(days=29),
        "all": date.min,
    }
    totals = {k: _empty_totals() for k in windows}
    conv_sets: dict[str, set] = {k: set() for k in windows}
    by_model: dict[str, dict] = {}
    names: dict[str, str] = {}
    first_day = today - timedelta(days=days - 1)
    daily = {first_day + timedelta(days=i): [0, 0] for i in range(days)}
    day_cache: dict[int, date] = {}

    for _, entry in per_db:
        names.update(entry.get("names") or {})
    by_display: dict[str, str] = {}
    for mid, disp in sorted(names.items()):
        by_display.setdefault(disp, mid)

    for key, entry in per_db:
        for ts, model, inp, out, cache, think in entry["calls"]:
            if model.startswith(DISPLAY_PREFIX):
                disp = model[len(DISPLAY_PREFIX):]
                model = by_display.get(disp, disp)
                names.setdefault(model, disp)
            sec = int(ts)
            d = day_cache.get(sec)
            if d is None:
                try:
                    d = datetime.fromtimestamp(ts).date()
                except (OverflowError, OSError, ValueError):
                    d = today
                day_cache[sec] = d
            cost = call_cost(model, inp, out, cache)
            for w, start in windows.items():
                if d >= start and (w == "all" or d <= today):
                    t = totals[w]
                    t["input"] += inp
                    t["output"] += out
                    t["cache_read"] += cache
                    t["thinking"] += think
                    t["calls"] += 1
                    if cost is not None:
                        t["est_cost_usd"] = (t["est_cost_usd"] or 0.0) + cost
                    conv_sets[w].add(key)
            bm = by_model.get(model)
            if bm is None:
                bm = by_model[model] = {"model": model, "display_name": None, "input": 0, "output": 0,
                                        "cache_read": 0, "thinking": 0, "calls": 0, "est_cost_usd": None}
            bm["input"] += inp
            bm["output"] += out
            bm["cache_read"] += cache
            bm["thinking"] += think
            bm["calls"] += 1
            if cost is not None:
                bm["est_cost_usd"] = (bm["est_cost_usd"] or 0.0) + cost
            slot = daily.get(d)
            if slot is not None:
                slot[0] += inp + out + cache
                slot[1] += 1

    for w, t in totals.items():
        t["conversations"] = len(conv_sets[w])
        if t["est_cost_usd"] is not None:
            t["est_cost_usd"] = round(t["est_cost_usd"], 4)
    models = list(by_model.values())
    for bm in models:
        bm["display_name"] = names.get(bm["model"])
        if bm["est_cost_usd"] is not None:
            bm["est_cost_usd"] = round(bm["est_cost_usd"], 4)
    models.sort(key=lambda b: (-(b["input"] + b["output"] + b["cache_read"]), b["model"]))

    return {
        "totals": totals,
        "by_model": models,
        "daily": [{"date": d.isoformat(), "tokens": v[0], "calls": v[1]} for d, v in sorted(daily.items())],
        "sources": sources,
        "errors": errors,
        "scanned_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "elapsed_ms": int((time.perf_counter() - t0) * 1000),
    }


def main(argv: list[str] | None = None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    ap = argparse.ArgumentParser(description="Aggregate token usage across Antigravity conversation databases.")
    ap.add_argument("--json", action="store_true", help="Print the JSON report (default output)")
    ap.add_argument("--cache", help="Path of the incremental JSON cache file")
    ap.add_argument("--root", action="append", default=[], metavar="DIR[=label]",
                    help="Conversation folder to scan (repeatable); replaces the default desktop/cli roots")
    ap.add_argument("--days", type=int, default=365, help="Number of days in the daily series (default 365)")
    args = ap.parse_args(argv)

    roots = [parse_root(r) for r in args.root] if args.root else default_roots()
    report = scan(roots, Path(args.cache).expanduser() if args.cache else None, args.days)
    print(json.dumps(report, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
