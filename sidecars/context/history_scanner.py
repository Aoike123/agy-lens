#!/usr/bin/env python3
"""Multi-conversation token-usage scanner for Antigravity conversation databases.

Reads every conversation database (read-only) under the desktop and CLI conversation
folders, sums per-call token usage from the `gen_metadata` table and aggregates it by
time window, model and day. Results per database are cached on disk keyed by the
database's (and its -wal file's) mtime and size, so only changed databases are re-parsed.

Python stdlib only. Never writes to a conversation database.

    python history_scanner.py --json [--cache PATH] [--root DIR[=label]]... [--days 365] [--pricing-file PATH]
"""

import argparse
from datetime import date, datetime, timedelta
import json
import math
import os
from pathlib import Path
import re
import sqlite3
import sys
import time

CACHE_VERSION = 3

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


# --- pricing & pools ---------------------------------------------------------

# Built-in official public list prices in USD per 1M tokens
# (input, output, cache_read), used offline or as fallback when no synced
# pricing file is passed via --pricing-file. Output includes thinking tokens
# (the API's output count already contains them).
PRICES_USD_PER_1M: list[tuple[str, tuple[float, float, float]]] = [
    ("gemini-3.1-pro", (2.00, 12.00, 0.20)),
    ("gemini-3-pro", (2.00, 12.00, 0.20)),
    ("gemini-3-flash", (0.50, 3.00, 0.05)),
    ("gemini-2.5-pro", (1.25, 10.00, 0.3125)),
    ("gemini-2.5-flash", (0.30, 2.50, 0.075)),
    ("gemini-2.0-flash-lite", (0.075, 0.30, 0.075)),
    ("gemini-2.0-flash", (0.10, 0.40, 0.025)),
    ("claude-opus-4-6", (15.00, 75.00, 1.50)),
    ("claude-opus-4-5", (15.00, 75.00, 1.50)),
    ("claude-opus-4-1", (15.00, 75.00, 1.50)),
    ("claude-opus-4", (15.00, 75.00, 1.50)),
    ("claude-sonnet-4-6", (3.00, 15.00, 0.30)),
    ("claude-sonnet-4-5", (3.00, 15.00, 0.30)),
    ("claude-sonnet-4", (3.00, 15.00, 0.30)),
    ("claude-3-7-sonnet", (3.00, 15.00, 0.30)),
    ("claude-3-5-sonnet", (3.00, 15.00, 0.30)),
    ("claude-haiku-4-5", (0.80, 4.00, 0.08)),
    ("claude-3-5-haiku", (0.80, 4.00, 0.08)),
    ("gpt-oss-120b", (0.15, 0.60, 0.075)),
    ("gpt-oss-20b", (0.05, 0.20, 0.025)),
]

# Same-family fallback for preview / unreleased models (marked cost_estimated=True).
# Target model IDs are resolved via custom_prices first, then built-in PRICES_USD_PER_1M.
PREVIEW_FAMILY_FALLBACKS: list[tuple[str, str]] = [
    ("claude-opus-5", "claude-opus-4-6"),
    ("claude-opus", "claude-opus-4-6"),
    ("claude-sonnet-5", "claude-sonnet-4-6"),
    ("claude-sonnet", "claude-sonnet-4-6"),
    ("claude-haiku", "claude-haiku-4-5"),
    ("gemini-3.8-flash", "gemini-2.5-flash"),
    ("gemini-3.5-flash", "gemini-2.5-flash"),
    ("gemini-3.1-flash", "gemini-2.5-flash"),
    ("gemini-2.5-flash-lite", "gemini-2.5-flash"),
    ("gemini-flash-", "gemini-2.5-flash"),
    ("gemini-4-", "gemini-2.5-pro"),
]

POOLS = ("gemini", "claude_gpt", "other")
_VER_DOT_RE = re.compile(r"(?<=\d)\.(?=\d)")


def _norm_ver(s: str) -> str:
    return _VER_DOT_RE.sub("-", s)


def _norm_num(v) -> float | None:
    if isinstance(v, bool) or not isinstance(v, (int, float)):
        return None
    val = float(v)
    return val if math.isfinite(val) and val >= 0.0 else None


def _extract_price(v) -> tuple[float, float, float] | None:
    if isinstance(v, (tuple, list)) and len(v) == 3:
        vals = tuple(_norm_num(x) for x in v)
        return vals if all(x is not None for x in vals) else None
    if isinstance(v, dict):
        inp = _norm_num(v.get("input"))
        out = _norm_num(v.get("output"))
        if inp is None or out is None:
            return None
        raw_cache = v.get("cache_read")
        cache = inp * 0.1 if raw_cache is None else _norm_num(raw_cache)
        if cache is None:
            return None
        return (inp, out, cache)
    return None


def load_pricing_file(path: Path | str | None) -> tuple[dict, str, str | None]:
    """Load normalized pricing cache JSON -> (models_dict, source, fetched_at).

    Missing or invalid files silently fall back to ({}, 'builtin', None).
    """
    if not path:
        return {}, "builtin", None
    try:
        with open(Path(path).expanduser(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError, TypeError):
        return {}, "builtin", None
    if not isinstance(data, dict) or not isinstance(data.get("models"), dict):
        return {}, "builtin", None
    models: dict[str, dict[str, float]] = {}
    for k, v in data["models"].items():
        if not isinstance(k, str):
            continue
        key = k.strip().lower()
        p = _extract_price(v)
        if key and p is not None:
            models[key] = {"input": p[0], "output": p[1], "cache_read": p[2]}
    if not models:
        return {}, "builtin", None
    src = data.get("source")
    source = src.strip() if isinstance(src, str) and src.strip() else "custom"
    fa = data.get("fetched_at")
    fetched_at = fa.strip() if isinstance(fa, str) and fa.strip() else None
    return models, source, fetched_at


def _match_slug(slug: str, key: str) -> int:
    if not key:
        return 0
    if "-lite" in slug and "-lite" not in key:
        return 0
    if slug == key:
        return 10000 + len(key)
    ns, nk = _norm_ver(slug), _norm_ver(key)
    if ns == nk:
        return 5000 + len(key)
    if slug.startswith(key + "-") or slug.startswith(key + ":"):
        return len(key)
    if ns.startswith(nk + "-") or ns.startswith(nk + ":"):
        return len(key)
    return 0


def _lookup_custom(slug: str, custom_prices: dict | None) -> tuple[float, float, float] | None:
    if not custom_prices:
        return None
    best_key: tuple[int, int] = (0, 0)
    best_price: tuple[float, float, float] | None = None
    for orig_k, raw_v in custom_prices.items():
        if not isinstance(orig_k, str):
            continue
        kl = orig_k.strip().lower()
        bare = kl.rsplit("/", 1)[-1]
        sc = _match_slug(slug, bare)
        if sc <= 0:
            continue
        p = _extract_price(raw_v)
        if p is None:
            continue
        rank = (sc, 1 if "/" not in kl else 0)
        if rank > best_key:
            best_key, best_price = rank, p
    return best_price


def _lookup_builtin(slug: str) -> tuple[float, float, float] | None:
    best_score = 0
    best_price: tuple[float, float, float] | None = None
    for prefix, p in PRICES_USD_PER_1M:
        sc = _match_slug(slug, prefix)
        if sc > best_score:
            best_score, best_price = sc, p
    return best_price


def _lookup_direct(slug: str, custom_prices: dict | None = None) -> tuple[float, float, float] | None:
    p = _lookup_custom(slug, custom_prices)
    if p is not None:
        return p
    return _lookup_builtin(slug)


def load_model_catalog(path: Path | str | None) -> dict[str, dict]:
    """Load live model-catalog.json -> {model_id: entry_dict}; missing or invalid returns {}."""
    if not path:
        return {}
    try:
        with open(Path(path).expanduser(), encoding="utf-8") as fh:
            data = json.load(fh)
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(data, dict):
        return {}
    return {k: v for k, v in data.items() if isinstance(k, str) and k and isinstance(v, dict)}


def _catalog_entry(model_id: str, catalog: dict | None) -> dict | None:
    if not isinstance(catalog, dict) or not catalog:
        return None
    raw = (model_id or "").strip()
    if not raw:
        return None
    e = catalog.get(raw)
    if isinstance(e, dict):
        return e
    low = raw.lower()
    e = catalog.get(low)
    if isinstance(e, dict):
        return e
    for k, v in catalog.items():
        if isinstance(k, str) and k.lower() == low and isinstance(v, dict):
            return v
    return None


def _catalog_display(model_id: str, catalog: dict | None) -> str | None:
    e = _catalog_entry(model_id, catalog)
    d = e.get("displayName") if isinstance(e, dict) else None
    return d.strip() if isinstance(d, str) and d.strip() else None


def _preview_target(slug: str) -> str | None:
    if "embedding" in slug:
        return None
    if "claude" in slug:
        if "opus" in slug:
            return "claude-opus-4-6"
        if "sonnet" in slug:
            return "claude-sonnet-4-6"
        if "haiku" in slug:
            return "claude-haiku-4-5"
        return None
    if "gpt-oss" in slug:
        return "gpt-oss-120b"
    if "gemini" in slug:
        return "gemini-2.5-flash" if "flash" in slug else "gemini-2.5-pro"
    if "orchestrator" in slug:
        return "gemini-2.5-pro"
    return None


def price_info(model: str, custom_prices: dict | None = None) -> tuple[tuple[float, float, float] | None, bool]:
    """Return ((in, out, cache_read) USD/1M or None, is_estimated) for a model ID."""
    slug = (model or "").strip().lower().rsplit("/", 1)[-1]
    if not slug or slug == "unknown" or slug.startswith("tab_"):
        return None, False
    p = _lookup_direct(slug, custom_prices)
    if p is not None:
        return p, False
    target = _preview_target(slug)
    if target is not None:
        p = _lookup_direct(target, custom_prices)
        if p is not None:
            return p, True
    return None, False


def price_for(model: str, custom_prices: dict | None = None) -> tuple[float, float, float] | None:
    return price_info(model, custom_prices)[0]


def call_cost_info(model: str, inp: int, out: int, cache_read: int,
                   custom_prices: dict | None = None) -> tuple[float | None, bool]:
    """Return (cost_usd or None, is_estimated) for one call."""
    p, estimated = price_info(model, custom_prices)
    if p is None:
        return None, False
    return (inp * p[0] + out * p[1] + cache_read * p[2]) / 1_000_000.0, estimated


def call_cost(model: str, inp: int, out: int, cache_read: int,
              custom_prices: dict | None = None) -> float | None:
    return call_cost_info(model, inp, out, cache_read, custom_prices)[0]


def model_pool(model_id: str, catalog: dict | None = None) -> str:
    """Map a model ID to its quota pool: 'gemini', 'claude_gpt', or 'other'."""
    entry = _catalog_entry(model_id, catalog)
    if entry is not None:
        epool = entry.get("pool")
        eprov = entry.get("provider")
        if isinstance(epool, str) and epool in POOLS and (epool != "other" or eprov):
            return epool
        if isinstance(eprov, str) and eprov:
            p = eprov.upper()
            if "ANTHROPIC" in p or "OPENAI" in p:
                return "claude_gpt"
            if "GOOGLE" in p:
                return "gemini"
    s = (model_id or "").strip().lower()
    if not s or s == "unknown" or s.startswith("tab_"):
        return "other"
    if "claude" in s or "anthropic" in s or "gpt" in s or "openai" in s:
        return "claude_gpt"
    if "gemini" in s or "orchestrator" in s:
        return "gemini"
    return "other"


# --- per-database parsing ----------------------------------------------------

STEP_PLANNER_RESPONSE = 15
MAX_CONVERSATIONS = 500
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


def open_ro(db: Path) -> sqlite3.Connection:
    """Open a SQLite database strictly read-only."""
    return sqlite3.connect("file:" + Path(db).resolve().as_posix() + "?mode=ro", uri=True, timeout=0.5)


def planner_timestamps(conn: sqlite3.Connection) -> list[float]:
    """created_at (epoch seconds) of every PLANNER_RESPONSE step, in step order."""
    try:
        rows = conn.execute(
            "SELECT metadata FROM steps WHERE step_type = ? ORDER BY idx", (STEP_PLANNER_RESPONSE,)
        ).fetchall()
    except sqlite3.OperationalError:
        return []
    stamps: list[float] = []
    for (md,) in rows:
        created = Msg(md, STEP_MD_FIELDS).msg(1)  # metadata.created_at (Timestamp)
        sec = created.int(1) if created is not None else 0
        if sec > 0:
            stamps.append(float(sec))
    return stamps


def generation_time(stamps: list[float], i: int, fallback_ts: float) -> float:
    """Epoch seconds of the i-th gen_metadata row (0-based, idx order).

    gen_metadata rows carry no timestamp; the i-th generation belongs to the i-th
    PLANNER_RESPONSE step. Extra generations get the last step time; no steps -> fallback (file mtime).
    """
    if not stamps:
        return fallback_ts
    return stamps[i] if i < len(stamps) else stamps[-1]


def generation_timestamps(conn: sqlite3.Connection, count: int, fallback_ts: float) -> list[float]:
    """Per-call epoch timestamps for `count` gen_metadata rows (idx order). Exported for context_report."""
    stamps = planner_timestamps(conn)
    return [generation_time(stamps, i, fallback_ts) for i in range(count)]


def parse_generation(data: bytes | None) -> tuple[str, str, int, int, int, int] | None:
    """(model_id, display_name, input, output, cache_read, thinking) of one gen_metadata blob.

    model_id is planner_config.model_name, else chat.response_model, else "" (display name only).
    Returns None when the row has no usage. Exported for context_report.
    """
    if not data:
        return None
    gen = Msg(data, GEN_FIELDS)
    chat = gen.msg(1, CHAT_FIELDS)
    usage = chat.msg(4, USAGE_FIELDS) if chat is not None else None
    if usage is None:
        return None
    planner = gen.msg(3, PLANNER_FIELDS)
    model = (planner.str(28) if planner is not None else "") or chat.str(19)
    return model, chat.str(21), usage.int(2), usage.int(3), usage.int(5), usage.int(9)


TITLE_MAX = 80


def first_user_text(conn: sqlite3.Connection) -> str | None:
    """First user message of the conversation, whitespace-collapsed and truncated (title fallback)."""
    try:
        row = conn.execute("SELECT step_payload FROM steps WHERE step_type = 14 ORDER BY idx LIMIT 1").fetchone()
    except sqlite3.OperationalError:
        return None
    if not row or not row[0]:
        return None
    ui = Msg(row[0], frozenset((19,))).msg(19, frozenset((2,)))  # user_input.user_response
    text = " ".join(ui.str(2).split()) if ui is not None else ""
    if not text:
        return None
    return text if len(text) <= TITLE_MAX else text[: TITLE_MAX - 1] + "…"


def parse_db(db: Path) -> dict:
    """Read one conversation DB read-only.

    Returns {"calls": [[ts, model, in, out, cache, think]], "names": {model: display}, "first_input": str|None}.
    Raises sqlite3.Error / OSError on unreadable or corrupt databases.
    """
    fallback_ts = db.stat().st_mtime
    conn = open_ro(db)
    try:
        try:
            gens = conn.execute("SELECT data FROM gen_metadata ORDER BY idx").fetchall()
        except sqlite3.OperationalError as e:
            if "no such table" not in str(e):
                raise
            # Fresh conversation (no generation yet): valid, just empty. Real corruption still raises.
            conn.execute("SELECT 1 FROM sqlite_master LIMIT 1").fetchall()
            return {"calls": [], "names": {}, "first_input": None}
        stamps = planner_timestamps(conn)
        first_input = first_user_text(conn)
    finally:
        conn.close()

    calls, names = [], {}
    for i, (data,) in enumerate(gens):
        g = parse_generation(data)
        if g is None:
            continue
        model, display, inp, out, cache, think = g
        if not (inp or out or cache or think):
            continue  # aborted / in-flight generation with no billed usage
        if model:
            if display:
                names[model] = display
        else:
            # Only a display name: resolved to a real model ID at aggregation time if one is known.
            model = DISPLAY_PREFIX + display if display else "unknown"
        calls.append([generation_time(stamps, i, fallback_ts), model, inp, out, cache, think])
    return {"calls": calls, "names": names, "first_input": first_input}


def load_titles(roots: list[tuple[Path, str]]) -> tuple[dict[str, str], dict[str, str]]:
    """({id: title}, {id: agent_name}) from the app's conversation_summaries.db next to each root (read-only)."""
    titles: dict[str, str] = {}
    agents: dict[str, str] = {}
    seen: set[Path] = set()
    for root, _ in roots:
        p = root.parent / "conversation_summaries.db"
        if not p.is_file():
            continue
        rp = p.resolve()
        if rp in seen:
            continue
        seen.add(rp)
        try:
            conn = open_ro(p)
            try:
                cols = {r[1] for r in conn.execute("PRAGMA table_info(conversation_summaries)")}
                sel = ", ".join(c if c in cols else "''" for c in ("conversation_id", "title", "preview", "agent_name"))
                for cid, title, preview, agent in conn.execute(f"SELECT {sel} FROM conversation_summaries"):
                    if not cid:
                        continue
                    t = " ".join(str(title or preview or "").split())
                    if t and cid not in titles:
                        titles[cid] = t if len(t) <= TITLE_MAX else t[: TITLE_MAX - 1] + "…"
                    a = str(agent).strip() if agent is not None else ""
                    if a and cid not in agents:
                        agents[cid] = a
            finally:
                conn.close()
        except sqlite3.Error:
            continue
    return titles, agents


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
    return {"input": 0, "output": 0, "cache_read": 0, "thinking": 0, "calls": 0, "conversations": 0,
            "est_cost_usd": None, "cost_estimated": False}


def _empty_pools() -> dict[str, int]:
    return {p: 0 for p in POOLS}


def _fmt_iso(ts: float | None) -> str | None:
    if ts is None:
        return None
    try:
        return datetime.fromtimestamp(ts).astimezone().isoformat(timespec="seconds")
    except (OverflowError, OSError, ValueError):
        return None


def scan(roots: list[tuple[Path, str]], cache_path: Path | None = None, days: int = 365,
         now: datetime | None = None, stats: dict | None = None,
         pricing_file: Path | str | None = None,
         model_catalog: Path | str | None = None) -> dict:
    t0 = time.perf_counter()
    now = now or datetime.now()
    today = now.date()
    days = max(1, days)
    stats = stats if stats is not None else {}
    stats.update(hits=0, misses=0)
    custom_prices, pricing_source, pricing_fetched_at = load_pricing_file(pricing_file)
    catalog = load_model_catalog(model_catalog)

    old_cache = load_cache(cache_path)
    new_cache: dict = {}
    sources: dict[str, int] = {"desktop": 0, "cli": 0}
    errors = 0
    per_db: list[tuple[str, dict, str, str]] = []

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
            per_db.append((key, entry, label, db.stem))

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
    hourly_today = [[0, 0] for _ in range(24)]
    d7_by_pool = _empty_pools()
    dt_cache: dict[int, tuple[date, int]] = {}
    price_cache: dict[str, tuple[tuple[float, float, float] | None, bool]] = {}
    pool_cache: dict[str, str] = {}

    for _, entry, _, _ in per_db:
        names.update(entry.get("names") or {})
    by_display: dict[str, str] = {}
    for mid, disp in sorted(names.items()):
        by_display.setdefault(disp, mid)
    convs: list[dict] = []

    d7_start = windows["d7"]
    for key, entry, label, stem in per_db:
        conv = None
        if entry["calls"]:
            conv = {"id": stem, "source": label, "title": None, "model": None, "display_name": None,
                    "pool": "other", "first_at": None, "last_at": None, "input": 0, "output": 0, "cache_read": 0,
                    "thinking": 0, "d7_tokens": 0, "d7_by_pool": _empty_pools(), "calls": 0, "est_cost_usd": None,
                    "cost_partial": False, "cost_estimated": False, "is_subagent": False, "by_model": [],
                    "_first": None, "_last": float("-inf"), "_models": {}, "_first_input": entry.get("first_input")}
            convs.append(conv)
        for ts, model, inp, out, cache, think in entry["calls"]:
            if model.startswith(DISPLAY_PREFIX):
                disp = model[len(DISPLAY_PREFIX):]
                model = by_display.get(disp, disp)
                names.setdefault(model, disp)
            sec = int(ts)
            dh = dt_cache.get(sec)
            if dh is None:
                try:
                    dt = datetime.fromtimestamp(ts)
                    dh = (dt.date(), dt.hour)
                except (OverflowError, OSError, ValueError):
                    dh = (today, now.hour)
                dt_cache[sec] = dh
            d, hour = dh
            pinfo = price_cache.get(model)
            if pinfo is None:
                pinfo = price_cache[model] = price_info(model, custom_prices)
            p, is_est = pinfo
            cost = (inp * p[0] + out * p[1] + cache * p[2]) / 1_000_000.0 if p is not None else None
            pool = pool_cache.get(model)
            if pool is None:
                pool = pool_cache[model] = model_pool(model, catalog)
            in_d7 = d7_start <= d <= today
            conv["input"] += inp
            conv["output"] += out
            conv["cache_read"] += cache
            conv["thinking"] += think
            if in_d7:
                d7_tok = inp + out
                conv["d7_tokens"] += d7_tok
                conv["d7_by_pool"][pool] += d7_tok
                d7_by_pool[pool] += d7_tok
            conv["calls"] += 1
            if cost is not None:
                conv["est_cost_usd"] = (conv["est_cost_usd"] or 0.0) + cost
                if is_est:
                    conv["cost_estimated"] = True
            else:
                conv["cost_partial"] = True
            conv["_first"] = ts if conv["_first"] is None else min(conv["_first"], ts)
            conv["_last"] = max(conv["_last"], ts)
            cm = conv["_models"].get(model)
            if cm is None:
                cm = conv["_models"][model] = {"model": model, "display_name": None, "input": 0, "output": 0,
                                               "cache_read": 0, "thinking": 0, "calls": 0, "est_cost_usd": None,
                                               "cost_estimated": False}
            cm["input"] += inp
            cm["output"] += out
            cm["cache_read"] += cache
            cm["thinking"] += think
            cm["calls"] += 1
            if cost is not None:
                cm["est_cost_usd"] = (cm["est_cost_usd"] or 0.0) + cost
                if is_est:
                    cm["cost_estimated"] = True
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
                        if is_est:
                            t["cost_estimated"] = True
                    conv_sets[w].add(key)
            bm = by_model.get(model)
            if bm is None:
                bm = by_model[model] = {"model": model, "display_name": None, "pool": pool, "input": 0, "output": 0,
                                        "cache_read": 0, "thinking": 0, "d7_tokens": 0, "calls": 0,
                                        "est_cost_usd": None, "cost_estimated": False}
            bm["input"] += inp
            bm["output"] += out
            bm["cache_read"] += cache
            bm["thinking"] += think
            if in_d7:
                bm["d7_tokens"] += inp + out
            bm["calls"] += 1
            if cost is not None:
                bm["est_cost_usd"] = (bm["est_cost_usd"] or 0.0) + cost
                if is_est:
                    bm["cost_estimated"] = True
            slot = daily.get(d)
            if slot is not None:
                slot[0] += inp + out + cache
                slot[1] += 1
            if d == today:
                hslot = hourly_today[hour]
                hslot[0] += inp + out + cache
                hslot[1] += 1

    for w, t in totals.items():
        t["conversations"] = len(conv_sets[w])
        if t["est_cost_usd"] is not None:
            t["est_cost_usd"] = round(t["est_cost_usd"], 4)
    models = list(by_model.values())
    for bm in models:
        bm["display_name"] = names.get(bm["model"]) or _catalog_display(bm["model"], catalog)
        if bm["est_cost_usd"] is not None:
            bm["est_cost_usd"] = round(bm["est_cost_usd"], 4)
    models.sort(key=lambda b: (-(b["input"] + b["output"] + b["cache_read"]), b["model"]))

    convs.sort(key=lambda c: (-c["_last"], c["id"]))
    convs = convs[:MAX_CONVERSATIONS]
    titles, agents = load_titles(roots) if convs else ({}, {})
    for c in convs:
        cmodels = list(c["_models"].values())
        for cm in cmodels:
            cm["display_name"] = names.get(cm["model"]) or _catalog_display(cm["model"], catalog)
            if cm["est_cost_usd"] is not None:
                cm["est_cost_usd"] = round(cm["est_cost_usd"], 4)
        # Primary model = the one with the most total tokens in this conversation.
        c["model"] = max(cmodels, key=lambda m: (m["input"] + m["output"] + m["cache_read"], m["model"]))["model"]
        c["display_name"] = names.get(c["model"]) or _catalog_display(c["model"], catalog)
        primary_pool = pool_cache.get(c["model"]) or model_pool(c["model"], catalog)
        if max(c["d7_by_pool"].values()) > 0:
            c["pool"] = max(POOLS, key=lambda p: (c["d7_by_pool"][p], 1 if p == primary_pool else 0, -POOLS.index(p)))
        else:
            c["pool"] = primary_pool
        cmodels.sort(key=lambda m: (-(m["input"] + m["output"]), m["model"]))
        c["by_model"] = cmodels
        # Title: app's summary title -> first user message -> "@<agent name>" (named subagents) -> null.
        # Any non-empty agent_name (including "self") marks is_subagent=True while keeping "self" untitled.
        agent = agents.get(c["id"])
        c["is_subagent"] = bool(agent)
        c["title"] = titles.get(c["id"]) or c["_first_input"] or ("@" + agent if agent and agent != "self" else None)
        c["first_at"] = _fmt_iso(c["_first"])
        c["last_at"] = _fmt_iso(c["_last"])
        if c["est_cost_usd"] is not None:
            c["est_cost_usd"] = round(c["est_cost_usd"], 4)
        for k in ("_first", "_last", "_models", "_first_input"):
            del c[k]

    return {
        "totals": totals,
        "by_model": models,
        "by_conversation": convs,
        "daily": [{"date": d.isoformat(), "tokens": v[0], "calls": v[1]} for d, v in sorted(daily.items())],
        "hourly_today": [{"hour": h, "tokens": v[0], "calls": v[1]} for h, v in enumerate(hourly_today)],
        "d7_by_pool": d7_by_pool,
        "pricing_source": pricing_source,
        "pricing_fetched_at": pricing_fetched_at,
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
    ap.add_argument("--pricing-file", help="Optional normalized pricing cache JSON (overrides built-in list prices)")
    ap.add_argument("--model-catalog", help="Optional live model-catalog.json for dynamic display names and quota pools")
    args = ap.parse_args(argv)

    roots = [parse_root(r) for r in args.root] if args.root else default_roots()
    report = scan(roots, Path(args.cache).expanduser() if args.cache else None, args.days,
                  pricing_file=args.pricing_file, model_catalog=args.model_catalog)
    print(json.dumps(report, separators=(",", ":")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
