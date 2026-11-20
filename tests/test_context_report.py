"""End-to-end tests for the panel's parser (sidecars/context/context_report.py) on synthetic conversation databases.

Run with: python -m unittest discover tests
"""

import importlib.util
from datetime import datetime
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parent.parent / "sidecars" / "context" / "context_report.py"

spec = importlib.util.spec_from_file_location("context_report", SCRIPT)
context_report = importlib.util.module_from_spec(spec)
spec.loader.exec_module(context_report)

# --- protobuf encoding -------------------------------------------------------


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


def m(*parts: bytes) -> bytes:
    return b"".join(parts)


# --- database builder --------------------------------------------------------


class ConversationDB:
    def __init__(self, path: Path, gen_table: bool = True):
        self.conn = sqlite3.connect(path)
        self.conn.execute(
            "CREATE TABLE steps (idx integer, step_type integer NOT NULL DEFAULT 0, status integer NOT NULL DEFAULT 0, "
            "has_subtrajectory numeric NOT NULL DEFAULT false, metadata blob, error_details blob, permissions blob, "
            "task_details blob, render_info blob, step_payload blob, step_format integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))"
        )
        if gen_table:
            self.conn.execute("CREATE TABLE gen_metadata (idx integer, data blob, size integer NOT NULL DEFAULT 0, PRIMARY KEY (idx))")
        self.n = 0

    def step(self, step_type: int, metadata: bytes = b"", payload_field: int | None = None, payload: bytes = b"", status: int = 3):
        pb = m(f(1, step_type), f(4, status), f(5, metadata), f(payload_field, payload) if payload_field else b"")
        self.conn.execute(
            "INSERT INTO steps (idx, step_type, status, metadata, step_payload) VALUES (?, ?, ?, ?, ?)",
            (self.n, step_type, status, metadata, pb),
        )
        self.n += 1

    def generation(self, groups: list[bytes], max_context: int = 1_000_000, usage: bytes = b"", checkpoint_index: int = -1,
                   model: str = "test-model", display_name: str = "Test Model", timing: bytes = b""):
        cwm = m(f(1, 0), f(3, m(*[f(1, g) for g in groups])), f(4, max_context))
        chat = m(f(4, usage), f(9, m(f(2, checkpoint_index), f(10, cwm))), f(21, display_name) if display_name else b"", timing)
        data = m(f(1, chat), f(3, f(28, model)))
        self.conn.execute("INSERT INTO gen_metadata (idx, data) VALUES ((SELECT COUNT(*) FROM gen_metadata), ?)", (data,))

    def close(self):
        if self.conn is not None:
            self.conn.commit()
            self.conn.close()
            self.conn = None


def group(token_type: int, tokens: int, *children: tuple[str, int], name: str = "group") -> bytes:
    return m(f(1, name), f(2, token_type), f(4, tokens), *[f(5, m(f(1, n), f(3, t))) for n, t in children])


def user_input(text: str) -> bytes:
    return f(2, text)


def planner(text: str) -> bytes:
    return f(1, text)


def usage(input_tokens: int = 0, output: int = 0, cache_read: int = 0, thinking: int = 0, response: int = 0) -> bytes:
    return m(f(2, input_tokens), f(3, output), f(5, cache_read), f(9, thinking) if thinking else b"",
             f(10, response) if response else b"")


def duration(sec: int | None = None, nanos: int | None = None) -> bytes:
    """google.protobuf.Duration: seconds=1, nanos=2 (negative ints encode as 64-bit two's complement)."""
    return m(f(1, sec) if sec is not None else b"", f(2, nanos) if nanos is not None else b"")


def timing(ttft: bytes | None = None, streaming: bytes | None = None) -> bytes:
    """ChatModelMetadata time_to_first_token=11, streaming_duration=12."""
    return m(f(11, ttft) if ttft is not None else b"", f(12, streaming) if streaming is not None else b"")


def speed_gen(output: int = 0, ttft: bytes | None = None, streaming: bytes | None = None, response_model: str = "",
              display: str = "", planner_model: str = "", **usage_kw) -> "context_report.Msg":
    chat = m(f(4, usage(output=output, **usage_kw)), timing(ttft, streaming),
             f(19, response_model) if response_model else b"", f(21, display) if display else b"")
    return context_report.Msg(m(f(1, chat), f(3, f(28, planner_model)) if planner_model else b""))


def tool_call(args: str) -> bytes:
    return f(4, m(f(2, "tool"), f(3, args)))


# Step types and payload fields used below.
USER_INPUT, PLANNER_RESPONSE, CHECKPOINT, FINISH, VIEW_FILE, CODE_ACTION, GENERIC = 14, 15, 23, 2, 8, 5, 132
P_USER, P_PLANNER, P_CHECKPOINT, P_VIEW_FILE, P_CODE_ACTION = 19, 20, 30, 14, 10


class ReportTest(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Path(self.tmp.name)
        self.db_path = self.home / "conv.db"
        self.db = ConversationDB(self.db_path)

    def tearDown(self):
        self.tmp.cleanup()

    def run_report(self, *args: str) -> str:
        self.db.close()
        env = dict(os.environ, HOME=str(self.home), USERPROFILE=str(self.home), PYTHONIOENCODING="utf-8")
        res = subprocess.run(
            [sys.executable, str(SCRIPT), "--db", str(self.db_path), *args],
            capture_output=True, env=env, text=True, encoding="utf-8", check=True,
        )
        return res.stdout

    def report(self, *args: str) -> dict:
        data = json.loads(self.run_report("--json", *args))
        data["by_name"] = {c["name"]: c["tokens"] for c in data["categories"]}
        return data

    def basic_steps(self):
        self.db.step(USER_INPUT, payload_field=P_USER, payload=user_input("hello world!!"))  # 13 bytes -> 3
        self.db.step(PLANNER_RESPONSE, metadata=f(9, usage(900, 50)), payload_field=P_PLANNER, payload=planner("r" * 400))
        self.db.step(GENERIC, metadata=tool_call("a" * 40))  # 40 bytes -> 10

    # --- breakdown from the latest generation ---

    def test_exact_breakdown_from_chat_items(self):
        self.basic_steps()
        self.db.generation([
            group(1, 1000, ("skills", 200), ("user_rules", 50), ("subagents", 30), ("flows", 20)),
            group(2, 500),
            group(3, 30),
            group(4, 40),
            group(7, 370, ("0: USER_INPUT", 20), ("1: PLANNER_RESPONSE", 200), ("2: GENERIC", 80),
                  ("3: FINISH", 30), ("4: CHECKPOINT", 40)),
            group(8, 11),
            group(9, 12),
            group(10, 13),
        ])
        r = self.report()
        c = r["by_name"]
        self.assertEqual(c["User messages"], 20)
        self.assertEqual(c["Agent responses"], 240)  # planner + checkpoint
        self.assertEqual(c["Tool calls"], 80)
        self.assertEqual(c["System messages"], 30)  # FINISH
        self.assertEqual(c["System prompt"], 750)  # user_rules stays in the system prompt
        self.assertEqual(c["Skills"], 200)
        self.assertEqual(c["Subagents"], 30)
        self.assertEqual(c["Workflows"], 33)  # flows item + FLOWS group
        self.assertEqual(c["Legacy workflows"], 11)
        self.assertEqual(c["Plugins"], 12)
        self.assertEqual(c["Rules"], 30)
        self.assertEqual(c["MCP tools"], 40)
        self.assertNotIn("System overhead", c)
        self.assertEqual(r["used_tokens"], sum(v for v in c.values()))
        self.assertEqual(r["limit_tokens"], 1_000_000)
        self.assertTrue(r["has_breakdown"])

    def test_latest_generation_wins_over_larger_one(self):
        self.basic_steps()
        self.db.generation([group(1, 90000), group(7, 10, ("0: USER_INPUT", 10))])
        self.db.generation([group(1, 100), group(7, 10, ("0: USER_INPUT", 10))])
        self.assertEqual(self.report()["by_name"]["System prompt"], 100)

    def test_unknown_item_scales_step_estimates(self):
        self.basic_steps()
        self.db.generation([group(7, 315, ("0: USER_INPUT", 20), ("1: NOT_A_STEP_TYPE", 1))])
        c = self.report()["by_name"]
        # Step estimates 3 / 50 / 10 scaled by 315 / 63 = 5.
        self.assertEqual((c["User messages"], c["Agent responses"], c["Tool calls"]), (15, 250, 50))

    def test_overhead_only_without_prompt_or_tools(self):
        self.basic_steps()
        self.db.generation([group(7, 300, ("0: USER_INPUT", 300))], usage=usage(1000, 0, 500))
        self.assertEqual(self.report()["by_name"]["System overhead"], 1200)

    def test_no_overhead_with_system_prompt(self):
        self.basic_steps()
        self.db.generation([group(1, 100), group(7, 300, ("0: USER_INPUT", 300))], usage=usage(1000, 0, 500))
        self.assertNotIn("System overhead", self.report()["by_name"])

    # --- estimates without a breakdown ---

    def test_awaiting_generation_uses_step_estimates(self):
        self.basic_steps()
        self.db.step(FINISH, metadata=tool_call("b" * 8))
        r = self.report()
        c = r["by_name"]
        self.assertFalse(r["has_breakdown"])
        self.assertEqual((c["User messages"], c["Agent responses"], c["Tool calls"], c["System messages"]), (3, 50, 10, 2))
        self.assertEqual(r["limit_tokens"], 0)
        self.assertIn("Estimated usage (awaiting generation)", self.run_report())

    def test_tool_call_output_tokens_take_precedence(self):
        self.db.step(GENERIC, metadata=m(tool_call("a" * 400), f(23, 7)))
        self.assertEqual(self.report()["by_name"]["Tool calls"], 7)

    # --- compaction ---

    def test_compaction_zeroes_summarized_steps(self):
        self.basic_steps()
        self.db.step(CHECKPOINT, payload_field=P_CHECKPOINT,
                     payload=m(f(1, 0), f(11, 0), f(12, 2), f(4, "Fix the login bug"), f(5, "s" * 383)))
        self.db.step(USER_INPUT, payload_field=P_USER, payload=user_input("next question please"))  # 20 -> 5
        self.db.generation([group(1, 800), group(7, 370, ("0: USER_INPUT", 370))])
        r = self.report()
        c = r["by_name"]
        self.assertTrue(r["compacted"])
        self.assertEqual(c["User messages"], 5)
        self.assertEqual(c["Agent responses"], 100)  # (17 + 383) / 4 summary estimate
        self.assertEqual(c["Tool calls"], 0)
        self.assertEqual(c["System prompt"], 800)
        self.assertEqual(r["active_checkpoint"], 0)
        out = self.run_report()
        self.assertIn("Estimated after compaction · updates next turn", out)
        self.assertIn("Checkpoints (1) · /rewind", out)
        self.assertIn("└ Checkpoint 1 (active, in context): Fix the login bug", out)

    def test_checkpoint_already_in_generation_is_not_newer(self):
        self.basic_steps()
        self.db.step(CHECKPOINT, payload_field=P_CHECKPOINT, payload=m(f(1, 0), f(11, 0), f(12, 2)))
        self.db.generation([group(7, 10, ("0: USER_INPUT", 10))], checkpoint_index=0)
        r = self.report()
        self.assertFalse(r["compacted"])
        self.assertIn("steps 0–2", self.run_report())

    def test_checkpoint_buffer_counts_checkpoint_steps(self):
        self.db.step(CHECKPOINT, metadata=tool_call("c" * 80), payload_field=P_CHECKPOINT, payload=f(1, 0))
        self.db.step(PLANNER_RESPONSE, metadata=f(9, usage(0, 5)), payload_field=P_PLANNER, payload=planner("x"))
        r = self.report()
        self.assertEqual(r["checkpoint_buffer"], 20)
        self.assertNotIn(20, [v for k, v in r["by_name"].items()])

    # --- files ---

    def test_file_sections(self):
        home_uri = "file:///" + str(self.home).replace("\\", "/").lstrip("/")
        self.db.step(VIEW_FILE, metadata=tool_call("v" * 40), payload_field=P_VIEW_FILE,
                     payload=m(f(1, home_uri + "/.gemini/skills/foo/SKILL.md"), f(17, 1)))
        edit = lambda path: f(2, f(1, f(8, home_uri + path)))  # noqa: E731
        self.db.step(CODE_ACTION, metadata=tool_call("w" * 80), payload_field=P_CODE_ACTION, payload=m(edit("/brain/task.md"), f(21, 1)))
        self.db.step(CODE_ACTION, metadata=tool_call("w" * 80), payload_field=P_CODE_ACTION, payload=m(edit("/brain/task.md"), f(21, 1)))
        self.db.step(CODE_ACTION, metadata=tool_call("k" * 40), payload_field=P_CODE_ACTION, payload=m(edit("/knowledge/a.md"), f(24, 1)))
        (self.home / ".gemini" / "skills").mkdir(parents=True)
        (self.home / ".gemini" / "GEMINI.md").write_text("x")
        (self.home / ".gemini" / "antigravity" / "skills").mkdir(parents=True)
        (self.home / ".gemini" / "config" / "skills").mkdir(parents=True)  # not an auto-loaded folder
        (self.home / "ws" / ".agents" / "rules").mkdir(parents=True)
        (self.home / "ws" / ".agents" / "hooks.json").write_text("{}")
        r = self.report("--workspace", str(self.home / "ws"))
        self.assertEqual(r["skill_files"], [{"path": "~/.gemini/skills/foo/SKILL.md", "tokens": 10}])
        self.assertEqual(r["artifact_files"], [{"path": "~/brain/task.md", "tokens": 20}])
        self.assertEqual(r["knowledge_files"], [{"path": "~/knowledge/a.md", "tokens": 10}])
        self.assertEqual([s["path"] for s in r["system_files"]],
                         ["~/.gemini/GEMINI.md", "~/.gemini/skills/", "~/.gemini/antigravity/skills/",
                          ".agents/rules/", ".agents/hooks.json"])
        out = self.run_report("--workspace", str(self.home / "ws"))
        self.assertIn("Knowledge files · /rules\n └ ~/knowledge/a.md: 10 tokens", out)
        self.assertIn("System files · auto-loaded\n └ ~/.gemini/GEMINI.md\n", out)

    def test_generic_steps_are_rehydrated(self):
        home_uri = "file:///" + str(self.home).replace("\\", "/").lstrip("/")
        # Desktop app: a write wrapped in a GENERIC step that packs the original code_action step.
        original = m(f(1, CODE_ACTION), f(4, 3), f(5, tool_call("w" * 80)),
                     f(P_CODE_ACTION, m(f(2, f(1, f(8, home_uri + "/brain/plan.md"))), f(21, 1))))
        packed = m(f(1, "type.googleapis.com/gemini_coder.Step"), f(2, original))
        self.db.step(GENERIC, metadata=tool_call("ignored"), payload_field=140, payload=f(2, f(6, packed)))
        # A GENERIC view_file with no packed original: rebuilt from the tool call arguments.
        args = json.dumps({"AbsolutePath": str(self.home / "skills" / "x" / "SKILL.md")})
        self.db.step(GENERIC, metadata=f(4, m(f(2, "view_file"), f(3, args))), payload_field=140, payload=f(2, b""))
        r = self.report()
        self.assertEqual(r["artifact_files"], [{"path": "~/brain/plan.md", "tokens": 20}])
        self.assertEqual(r["skill_files"], [{"path": "~/skills/x/SKILL.md", "tokens": len(args) // 4}])

    # --- model label and context limit ---

    def test_native_window_and_label_from_model_id(self):
        self.basic_steps()
        self.db.generation([group(7, 300, ("0: USER_INPUT", 300))], max_context=256_000,
                           model="gemini-3.8-flash-medium", display_name="")
        r = self.report()
        self.assertEqual(r["model"], "Gemini 3.8 Flash (Medium)")
        self.assertEqual(r["limit_tokens"], 1_048_576)
        self.assertEqual(r["request_budget_tokens"], 256_000)
        self.assertIn("Gemini 3.8 Flash (Medium) · 300/1.0M tokens", self.run_report())

    def test_model_catalog_overrides_table(self):
        self.basic_steps()
        self.db.generation([group(1, 100), group(7, 300, ("0: USER_INPUT", 300))],
                           model="gemini-9-test-high", display_name="")
        catalog = self.home / "catalog.json"
        catalog.write_text(json.dumps({"gemini-9-test-high": {"maxTokens": 2_000_000, "displayName": "Gemini 9 Test (High)"}}))
        r = self.report("--model-catalog", str(catalog))
        self.assertEqual((r["model"], r["limit_tokens"]), ("Gemini 9 Test (High)", 2_000_000))
        self.assertEqual(r["heading"], "Token usage by category")
        self.assertEqual(r["grid_segments"], [100, 300, 0, 0, 0])
        self.assertTrue(r["text"].startswith("└ Context Usage"))
        self.assertIn("Gemini 9 Test (High) · 400/2M tokens", r["text"])

    def test_unknown_model_falls_back_to_request_budget(self):
        self.basic_steps()
        self.db.generation([group(7, 300, ("0: USER_INPUT", 300))], max_context=256_000, model="new-model-x", display_name="")
        r = self.report()
        self.assertEqual((r["model"], r["limit_tokens"]), ("New Model X", 256_000))

    # --- rendering ---

    def test_text_layout(self):
        self.basic_steps()
        self.db.generation([group(1, 1000), group(7, 300, ("0: USER_INPUT", 300))], max_context=256_000)
        out = self.run_report()
        lines = out.splitlines()
        self.assertEqual(lines[0], "└ Context Usage")
        self.assertTrue(lines[2].endswith("Test Model · 1.3k/256.0k tokens"))
        self.assertIn("◉ Agent responses: 0 tokens (0.0%)", out)  # always shown
        self.assertNotIn("Plugins", out)  # zero, hidden
        self.assertTrue(out.rstrip().endswith("Related: /artifact · /skill · /rewind"))
        grid_rows = [l for l in lines if l.startswith(("◉", "□"))]
        self.assertEqual(len(grid_rows[0].split("   ")[0].split(" ")), 20)  # 20 columns at width 100

    def test_limit_override_and_narrow_layout(self):
        self.basic_steps()
        self.db.generation([group(7, 300, ("0: USER_INPUT", 300))])
        out = self.run_report("--limit", "200000", "--width", "60")
        lines = out.splitlines()
        self.assertEqual(lines[2], "Test Model · 300/200.0k tokens")  # stats above the grid
        self.assertTrue(lines[-3].startswith("□"))

    # --- generation speed ---

    def test_json_speed_from_generations(self):
        self.basic_steps()
        self.db.generation([group(7, 10, ("0: USER_INPUT", 10))], usage=usage(100, 200, 300),
                           timing=timing(duration(1), duration(4)))
        self.db.generation([group(7, 10, ("0: USER_INPUT", 10))], usage=usage(0, 100),
                           timing=timing(duration(0, 500_000_000), duration(2)))
        s = self.report()["speed"]
        self.assertEqual(set(s), {"latest", "calls", "avg_streaming_tps", "median_streaming_tps", "avg_e2e_tps",
                                  "avg_ttft_sec", "total_output_tokens", "recent", "by_model"})
        self.assertEqual(s["calls"], 2)
        self.assertEqual(s["latest"]["output_tokens"], 100)  # newest row
        self.assertEqual(s["latest"]["streaming_tps"], 50.0)
        self.assertFalse(s["latest"]["buffered"])
        self.assertEqual(s["avg_streaming_tps"], 50.0)  # 300 / 6
        self.assertEqual(s["median_streaming_tps"], 50.0)
        self.assertEqual(s["avg_e2e_tps"], 40.0)  # 300 / 7.5
        self.assertEqual(s["avg_ttft_sec"], 0.75)
        self.assertEqual(s["total_output_tokens"], 300)
        self.assertEqual([r["output_tokens"] for r in s["recent"]], [200, 100])  # oldest-first
        self.assertTrue(all(r["buffered"] is False for r in s["recent"]))
        self.assertFalse(any(k.startswith("_") for k in s["latest"]))
        self.assertEqual(len(s["by_model"]), 1)
        bm = s["by_model"][0]
        self.assertEqual((bm["model"], bm["display_name"], bm["calls"], bm["output_tokens"]), ("test-model", "Test Model", 2, 300))
        self.assertEqual((bm["avg_streaming_tps"], bm["median_streaming_tps"], bm["avg_e2e_tps"], bm["avg_ttft_sec"]),
                         (50.0, 50.0, 40.0, 0.75))
        self.assertEqual((bm["latest"], bm["recent"]), (s["latest"], s["recent"]))

    def test_json_speed_null_without_timing_rows(self):
        self.basic_steps()
        self.db.generation([group(7, 10, ("0: USER_INPUT", 10))], usage=usage(100, 200))  # no timing fields
        self.assertIsNone(self.report()["speed"])

    def test_json_speed_null_without_gen_rows(self):
        self.basic_steps()
        self.assertIsNone(self.report()["speed"])

    def test_json_without_gen_metadata_table(self):
        self.db.close()
        self.db_path.unlink()
        self.db = ConversationDB(self.db_path, gen_table=False)
        self.basic_steps()
        r = self.report()
        self.assertIsNone(r["speed"])
        self.assertFalse(r["has_breakdown"])
        self.assertEqual(r["by_name"]["User messages"], 3)
        self.assertIn("Context Usage", self.run_report())

    # --- per-conversation session usage ---

    def planner_at(self, sec: int):
        self.db.step(PLANNER_RESPONSE, metadata=f(1, f(1, sec)), payload_field=P_PLANNER, payload=planner("x"))

    def test_json_session_sums_all_generations(self):
        self.planner_at(1_700_000_000)
        self.planner_at(1_700_000_100)
        self.planner_at(1_700_000_200)
        self.planner_at(1_700_000_300)
        g = [group(7, 10, ("0: USER_INPUT", 10))]
        self.db.generation(g, usage=usage(1000, 200, 3000), model="claude-opus-4-6-thinking", display_name="Opus")
        self.db.generation(g, usage=usage(500, 100, 500), model="test-model", display_name="Test Model")
        self.db.generation(g, usage=b"", model="test-model")  # aborted: no billed usage, skipped
        self.db.generation(g, usage=usage(500, 100, 500), model="", display_name="Test Model")  # display-only
        for _ in range(60):  # more than the 50 rows speed reads
            self.db.generation(g, usage=usage(1, 1, 0), model="test-model")
        s = self.report()["session"]
        self.assertEqual(s["calls"], 63)
        self.assertEqual((s["input"], s["output"], s["cache_read"], s["thinking"]), (2060, 460, 4000, 0))
        self.assertEqual(s["total_tokens"], 2520)
        self.assertEqual(s["cache_hit_pct"], round(4000 / 6060 * 100, 1))
        self.assertEqual(s["est_cost_usd"], 0.0345)  # (1000*15 + 200*75 + 3000*1.5) / 1M; test-model unpriced
        self.assertTrue(s["cost_partial"])
        self.assertFalse(s["cost_estimated"])
        self.assertEqual(s["pricing_source"], "builtin")
        self.assertEqual(datetime.fromisoformat(s["first_at"]).timestamp(), 1_700_000_000)
        self.assertEqual(datetime.fromisoformat(s["last_at"]).timestamp(), 1_700_000_300)  # extra calls reuse last stamp
        self.assertEqual([b["model"] for b in s["by_model"]], ["claude-opus-4-6-thinking", "test-model"])
        opus, test = s["by_model"]
        self.assertEqual(opus, {"model": "claude-opus-4-6-thinking", "display_name": "Opus", "input": 1000, "output": 200,
                                "cache_read": 3000, "calls": 1, "est_cost_usd": 0.0345, "cost_estimated": False})
        self.assertEqual((test["display_name"], test["calls"], test["input"], test["est_cost_usd"], test["cost_estimated"]),
                         ("Test Model", 62, 1060, None, False))

    def test_json_session_fully_priced_and_mtime_fallback(self):
        self.db.generation([], usage=usage(1_000_000, 0, 0), model="gemini-2.5-pro-x", display_name="")
        s = self.report()["session"]
        self.assertEqual((s["est_cost_usd"], s["cost_partial"], s["cost_estimated"], s["pricing_source"], s["cache_hit_pct"]),
                         (1.25, False, False, "builtin", 0.0))
        self.assertIsNotNone(s["first_at"])  # no PLANNER_RESPONSE stamps: DB mtime
        self.assertEqual((s["by_model"][0]["display_name"], s["by_model"][0]["cost_estimated"]), (None, False))

    def test_json_session_pricing_file_and_preview_estimate(self):
        g = [group(7, 10, ("0: USER_INPUT", 10))]
        self.db.generation(g, usage=usage(100_000, 10_000, 0), model="claude-opus-4-6-thinking", display_name="Opus 4.6")
        self.db.generation(g, usage=usage(200_000, 20_000, 0), model="claude-opus-5-5-medium", display_name="Opus 5.5")

        # Built-in: opus 4.6 exact (15/75), opus 5.5 same-family estimated (15/75)
        s0 = self.report()["session"]
        self.assertEqual((s0["pricing_source"], s0["cost_partial"], s0["cost_estimated"]), ("builtin", False, True))
        self.assertEqual(s0["est_cost_usd"], 6.75)  # (1.5 + 0.75) + (3.0 + 1.5)
        bm0 = {b["model"]: b for b in s0["by_model"]}
        self.assertEqual((bm0["claude-opus-4-6-thinking"]["est_cost_usd"], bm0["claude-opus-4-6-thinking"]["cost_estimated"]), (2.25, False))
        self.assertEqual((bm0["claude-opus-5-5-medium"]["est_cost_usd"], bm0["claude-opus-5-5-medium"]["cost_estimated"]), (4.5, True))

        # Synced pricing file overrides both the released model and the preview family target
        pricing = self.home / "pricing-cache.json"
        pricing.write_text(json.dumps({
            "source": "litellm",
            "fetched_at": "2026-11-20T12:00:00Z",
            "models": {"anthropic/claude-opus-4-6": {"input": 10.0, "output": 50.0, "cache_read": 1.0}},
        }), encoding="utf-8")
        s1 = self.report("--pricing-file", str(pricing))["session"]
        self.assertEqual((s1["pricing_source"], s1["cost_partial"], s1["cost_estimated"]), ("litellm", False, True))
        self.assertEqual(s1["est_cost_usd"], 4.5)  # (1.0 + 0.5) + (2.0 + 1.0)
        bm1 = {b["model"]: b for b in s1["by_model"]}
        self.assertEqual((bm1["claude-opus-4-6-thinking"]["est_cost_usd"], bm1["claude-opus-4-6-thinking"]["cost_estimated"]), (1.5, False))
        self.assertEqual((bm1["claude-opus-5-5-medium"]["est_cost_usd"], bm1["claude-opus-5-5-medium"]["cost_estimated"]), (3.0, True))

        # Missing pricing file silently falls back to builtin
        s2 = self.report("--pricing-file", str(self.home / "nope.json"))["session"]
        self.assertEqual((s2["pricing_source"], s2["est_cost_usd"]), ("builtin", 6.75))

    def test_json_session_null_without_usage(self):
        self.basic_steps()
        self.db.generation([group(7, 10, ("0: USER_INPUT", 10))])  # zero usage
        self.assertIsNone(self.report()["session"])

    def test_json_session_null_without_gen_table(self):
        self.db.close()
        self.db_path.unlink()
        self.db = ConversationDB(self.db_path, gen_table=False)
        self.basic_steps()
        self.assertIsNone(self.report()["session"])

    def test_session_without_history_scanner(self):
        self.db.generation([], usage=usage(1, 1, 1))
        self.db.close()
        broken = type("HS", (), {"parse_db": staticmethod(lambda p: (_ for _ in ()).throw(sqlite3.DatabaseError("x")))})
        self.assertIsNone(context_report.collect_session(self.db_path, broken))
        self.assertEqual(context_report.collect_session(self.db_path)["calls"], 1)


class SpeedTest(unittest.TestCase):
    def dur(self, raw: bytes):
        return context_report.pb_duration_sec(context_report.Msg(raw))

    def test_duration_decoding(self):
        self.assertEqual(self.dur(duration(3, 250_000_000)), 3.25)
        self.assertEqual(self.dur(duration(nanos=400_000_000)), 0.4)
        self.assertEqual(self.dur(duration(12)), 12.0)
        self.assertEqual(self.dur(duration(0, 0)), 0.0)

    def test_duration_invalid(self):
        self.assertIsNone(context_report.pb_duration_sec(None))
        self.assertIsNone(self.dur(b""))  # no fields
        self.assertIsNone(self.dur(duration(-1)))
        self.assertIsNone(self.dur(duration(1, -5)))
        self.assertIsNone(self.dur(duration(nanos=1_000_000_000)))
        self.assertIsNone(self.dur(duration(86_401)))
        self.assertEqual(self.dur(duration(86_400)), 86_400.0)

    def test_parse_no_timing(self):
        self.assertIsNone(context_report.parse_generation_speed(None))
        self.assertIsNone(context_report.parse_generation_speed(context_report.Msg(b"")))
        self.assertIsNone(context_report.parse_generation_speed(speed_gen(output=100)))
        self.assertIsNone(context_report.parse_generation_speed(speed_gen(output=100, ttft=b"", streaming=duration(-3))))

    def test_parse_full(self):
        e = context_report.parse_generation_speed(speed_gen(
            output=300, thinking=100, input_tokens=250, cache_read=750,
            ttft=duration(1, 500_000_000), streaming=duration(3)))
        self.assertEqual(e["output_tokens"], 300)
        self.assertEqual(e["thinking_tokens"], 100)
        self.assertEqual(e["response_tokens"], 200)  # inferred from output - thinking
        self.assertEqual(e["ttft_sec"], 1.5)
        self.assertEqual(e["streaming_sec"], 3.0)
        self.assertEqual(e["total_sec"], 4.5)
        self.assertEqual(e["streaming_tps"], 100.0)
        self.assertEqual(e["e2e_tps"], 66.7)
        self.assertEqual(e["cache_hit_pct"], 75.0)

    def test_parse_explicit_response_tokens_and_no_input(self):
        e = context_report.parse_generation_speed(speed_gen(output=300, thinking=100, response=150, ttft=duration(1)))
        self.assertEqual(e["response_tokens"], 150)
        self.assertIsNone(e["cache_hit_pct"])
        self.assertIsNone(e["streaming_sec"])
        self.assertIsNone(e["streaming_tps"])
        self.assertEqual((e["total_sec"], e["e2e_tps"]), (1.0, 300.0))

    def test_parse_short_streaming(self):
        # Under 0.5s streaming: excluded from streaming_tps, keeps e2e and timing fields.
        e = context_report.parse_generation_speed(speed_gen(output=300, ttft=duration(1), streaming=duration(0, 490_000_000)))
        self.assertIsNone(e["streaming_tps"])
        self.assertEqual(e["streaming_sec"], 0.49)
        self.assertEqual(e["total_sec"], 1.49)
        self.assertEqual(e["output_tokens"], 300)
        self.assertEqual(e["e2e_tps"], round(300 / 1.49, 1))
        # Under 20 output tokens: excluded from streaming_tps even when streaming >= 0.5s.
        e = context_report.parse_generation_speed(speed_gen(output=19, ttft=duration(1), streaming=duration(1)))
        self.assertIsNone(e["streaming_tps"])
        self.assertEqual(e["streaming_sec"], 1.0)
        self.assertEqual(e["e2e_tps"], 9.5)
        # Exact threshold: 20 tokens in 0.5s counts as valid streaming.
        e = context_report.parse_generation_speed(speed_gen(output=20, ttft=duration(1), streaming=duration(0, 500_000_000)))
        self.assertEqual(e["streaming_tps"], 40.0)
        # Zero output tokens: neither streaming_tps nor e2e_tps.
        e = context_report.parse_generation_speed(speed_gen(output=0, streaming=duration(2)))
        self.assertIsNone(e["streaming_tps"])
        self.assertIsNone(e["e2e_tps"])

    def test_collect_empty(self):
        self.assertIsNone(context_report.collect_speed([]))
        self.assertIsNone(context_report.collect_speed([speed_gen(output=5), context_report.Msg(b"")]))

    def test_collect_weighted_and_order(self):
        gens = [  # newest-first
            speed_gen(output=100, ttft=duration(1), streaming=duration(1)),
            speed_gen(output=5),  # no timing: skipped entirely
            speed_gen(output=900, ttft=duration(3), streaming=duration(9)),
            speed_gen(output=50, ttft=duration(2), streaming=duration(0, 200_000_000)),  # < 0.5s: buffered
        ]
        s = context_report.collect_speed(gens)
        self.assertEqual(s["calls"], 3)
        self.assertEqual(s["latest"]["output_tokens"], 100)
        self.assertFalse(s["latest"]["buffered"])
        self.assertEqual(s["avg_streaming_tps"], 100.0)  # (100 + 900) / (1 + 9), not mean of rates
        self.assertEqual(s["median_streaming_tps"], 100.0)
        self.assertEqual(s["avg_e2e_tps"], round(1050 / (2 + 12 + 2.2), 1))
        self.assertEqual(s["avg_ttft_sec"], 2.0)
        self.assertEqual(s["total_output_tokens"], 1050)
        self.assertEqual([r["output_tokens"] for r in s["recent"]], [50, 900, 100])
        self.assertEqual([r["buffered"] for r in s["recent"]], [True, False, False])
        self.assertIsNone(s["recent"][0]["streaming_tps"])
        self.assertEqual(set(s["recent"][0]), {"streaming_tps", "e2e_tps", "ttft_sec", "streaming_sec", "total_sec",
                                               "output_tokens", "buffered"})

    def test_collect_outlier_filtering_and_buffered_flag(self):
        # Newest call is a buffered flush (> 3x median); next 3 are normal ~100 tok/s; plus a 3x boundary call and a short burst.
        gens = [  # newest-first
            speed_gen(output=855, ttft=duration(30), streaming=duration(0, 510_000_000)),  # 1676.5 tok/s -> outlier
            speed_gen(output=300, ttft=duration(2), streaming=duration(1)),                # 300.0 == 3x raw_med (100) -> kept
            speed_gen(output=100, ttft=duration(2), streaming=duration(1)),                # 100.0
            speed_gen(output=100, ttft=duration(2), streaming=duration(1)),                # 100.0
            speed_gen(output=100, ttft=duration(2), streaming=duration(1)),                # 100.0
            speed_gen(output=295, ttft=duration(10), streaming=duration(0, 190_000_000)),  # < 0.5s -> buffered
        ]
        s = context_report.collect_speed(gens)
        self.assertEqual(s["calls"], 6)
        # Valid raw rates: [1676.5, 300.0, 100.0, 100.0, 100.0], raw_med = 100.0; only 1676.5 > 300.0 is filtered.
        self.assertEqual(s["avg_streaming_tps"], 150.0)  # (300 + 100 + 100 + 100) / 4
        self.assertEqual(s["median_streaming_tps"], 100.0)
        # Latest (index 0) was flagged as outlier: streaming_tps cleared, buffered=True, e2e preserved.
        self.assertIsNone(s["latest"]["streaming_tps"])
        self.assertTrue(s["latest"]["buffered"])
        self.assertEqual(s["latest"]["e2e_tps"], round(855 / 30.51, 1))
        # Recent is oldest-first: short burst (True), 3x100 (False), 300 (False), 1676.5 outlier (True).
        self.assertEqual([r["buffered"] for r in s["recent"]], [True, False, False, False, False, True])
        self.assertEqual([r["streaming_tps"] for r in s["recent"]], [None, 100.0, 100.0, 100.0, 300.0, None])

        # With fewer than 3 valid entries, outlier filtering does not trigger.
        small = context_report.collect_speed([
            speed_gen(output=1000, ttft=duration(1), streaming=duration(1)),  # 1000 tok/s
            speed_gen(output=100, ttft=duration(1), streaming=duration(1)),   # 100 tok/s
        ])
        self.assertEqual(small["latest"]["streaming_tps"], 1000.0)
        self.assertFalse(small["latest"]["buffered"])
        self.assertEqual(small["median_streaming_tps"], 550.0)

    def test_collect_by_model_outlier_isolation(self):
        # Case 1: fast Gemini (400 tok/s) alongside many slower Claude calls (100 tok/s).
        # Overall median is 100 (3x=300), so overall filters 400; Gemini's own scope keeps 400 untouched.
        gens = [
            speed_gen(output=400, ttft=duration(1), streaming=duration(1), response_model="gemini-fast", display="Gemini"),
            speed_gen(output=400, ttft=duration(1), streaming=duration(1), response_model="gemini-fast", display="Gemini"),
            speed_gen(output=400, ttft=duration(1), streaming=duration(1), response_model="gemini-fast", display="Gemini"),
            *[speed_gen(output=100, ttft=duration(1), streaming=duration(1), response_model="claude-std", display="Claude")
              for _ in range(5)],
        ]
        s = context_report.collect_speed(gens)
        self.assertEqual(s["avg_streaming_tps"], 100.0)
        self.assertTrue(s["latest"]["buffered"])
        self.assertIsNone(s["latest"]["streaming_tps"])
        by_id = {b["model"]: b for b in s["by_model"]}
        gem, cla = by_id["gemini-fast"], by_id["claude-std"]
        self.assertEqual((gem["avg_streaming_tps"], gem["median_streaming_tps"]), (400.0, 400.0))
        self.assertEqual(gem["latest"]["streaming_tps"], 400.0)
        self.assertFalse(gem["latest"]["buffered"])
        self.assertTrue(all(r["buffered"] is False and r["streaming_tps"] == 400.0 for r in gem["recent"]))
        self.assertEqual((cla["avg_streaming_tps"], cla["median_streaming_tps"]), (100.0, 100.0))

        # Case 2: many fast Gemini calls (400 tok/s) + Claude (80 tok/s) with one Claude buffered burst (350 tok/s).
        # Overall doesn't flag 350 (<= 3*400), but Claude's own scope flags 350 (> 3*80=240).
        gens2 = [
            speed_gen(output=350, ttft=duration(5), streaming=duration(1), response_model="claude-std", display="Claude"),
            *[speed_gen(output=80, ttft=duration(1), streaming=duration(1), response_model="claude-std", display="Claude")
              for _ in range(3)],
            *[speed_gen(output=400, ttft=duration(1), streaming=duration(1), response_model="gemini-fast", display="Gemini")
              for _ in range(5)],
        ]
        s2 = context_report.collect_speed(gens2)
        self.assertFalse(s2["latest"]["buffered"])
        self.assertEqual(s2["latest"]["streaming_tps"], 350.0)
        cla2 = {b["model"]: b for b in s2["by_model"]}["claude-std"]
        self.assertTrue(cla2["latest"]["buffered"])
        self.assertIsNone(cla2["latest"]["streaming_tps"])
        self.assertEqual((cla2["avg_streaming_tps"], cla2["median_streaming_tps"]), (80.0, 80.0))
        self.assertEqual([r["buffered"] for r in cla2["recent"]], [False, False, False, True])

    def test_collect_by_model(self):
        gens = [  # newest-first: a subagent-style flash call, then opus, flash, a display-only opus, and an unknown
            speed_gen(output=200, streaming=duration(1), ttft=duration(1), response_model="gemini-flash", display="Flash"),
            speed_gen(output=300, streaming=duration(3), ttft=duration(2), response_model="claude-opus", display="Opus"),
            speed_gen(output=100, streaming=duration(1), ttft=duration(3), planner_model="gemini-flash",
                      response_model="ignored-when-planner-set"),
            speed_gen(output=100, streaming=duration(2), ttft=duration(4), display="Opus"),
            speed_gen(output=50, streaming=duration(1)),
            speed_gen(output=10, streaming=duration(1), display="Mystery"),  # < 20 tok -> buffered
            speed_gen(output=999, response_model="claude-opus"),  # no timing: skipped
        ]
        s = context_report.collect_speed(gens)
        self.assertEqual(s["calls"], 6)
        self.assertEqual(s["total_output_tokens"], 760)
        bms = s["by_model"]
        self.assertEqual([b["model"] for b in bms], ["gemini-flash", "claude-opus", "unknown", "Mystery"])
        flash, opus, unknown, mystery = bms
        self.assertEqual((flash["display_name"], flash["calls"], flash["output_tokens"]), ("Flash", 2, 300))
        self.assertEqual((flash["avg_streaming_tps"], flash["median_streaming_tps"], flash["avg_ttft_sec"]), (150.0, 150.0, 2.0))
        self.assertEqual(flash["latest"]["output_tokens"], 200)
        self.assertEqual([r["output_tokens"] for r in flash["recent"]], [100, 200])
        self.assertEqual((opus["display_name"], opus["calls"], opus["output_tokens"]), ("Opus", 2, 400))
        self.assertEqual((opus["avg_streaming_tps"], opus["median_streaming_tps"], opus["avg_e2e_tps"], opus["avg_ttft_sec"]),
                         (80.0, 75.0, round(400 / 11, 1), 3.0))
        self.assertEqual((unknown["display_name"], unknown["calls"], unknown["avg_ttft_sec"]), (None, 1, None))
        self.assertEqual((mystery["display_name"], mystery["calls"], mystery["avg_streaming_tps"], mystery["median_streaming_tps"]),
                         ("Mystery", 1, None, None))
        self.assertTrue(mystery["latest"]["buffered"])
        self.assertEqual(set(flash), {"model", "display_name", "latest", "calls", "avg_streaming_tps", "median_streaming_tps",
                                      "avg_e2e_tps", "avg_ttft_sec", "output_tokens", "recent"})
        self.assertEqual(set(flash["latest"]), set(s["latest"]))

    def test_collect_by_model_recent_capped(self):
        gens = [speed_gen(output=n, streaming=duration(1), response_model="m") for n in range(12, 0, -1)]
        bm = context_report.collect_speed(gens)["by_model"][0]
        self.assertEqual([r["output_tokens"] for r in bm["recent"]], [5, 6, 7, 8, 9, 10, 11, 12])
        self.assertEqual(bm["display_name"], None)

    def test_collect_recent_capped(self):
        gens = [speed_gen(output=n, streaming=duration(1)) for n in range(20, 0, -1)]  # newest = 20
        s = context_report.collect_speed(gens)
        self.assertEqual(s["calls"], 20)
        self.assertEqual([r["output_tokens"] for r in s["recent"]], [13, 14, 15, 16, 17, 18, 19, 20])

    def test_load_generations_newest_first_and_missing_table(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "a.db"
            db = ConversationDB(path)
            db.generation([], model="old")
            db.generation([], model="new")
            db.close()
            gens = context_report.load_generations(path)
            self.assertEqual([context_report.model_id(g) for g in gens], ["new", "old"])
            self.assertEqual(len(context_report.load_generations(path, limit=1)), 1)
            path2 = Path(tmp) / "b.db"
            ConversationDB(path2, gen_table=False).close()
            self.assertEqual(context_report.load_generations(path2), [])


class FormatTest(unittest.TestCase):
    def test_model_label(self):
        cases = {
            "gemini-4-argon-medium": "Gemini 4 Argon (Medium)",
            "gemini-3.8-flash-low": "Gemini 3.8 Flash (Low)",
            "claude-opus-5-5-high": "Claude Opus 5.5 (High)",
            "gpt-oss-120b-medium": "GPT-OSS 120B (Medium)",
        }
        for slug, label in cases.items():
            self.assertEqual(context_report.model_label(slug), label)

    def test_native_windows(self):
        for slug, tokens in {"claude-sonnet-5-5-low": 1_000_000, "claude-opus-4-6-thinking": 250_000,
                             "gpt-oss-120b-medium": 131_072, "gemini-4-argon-high": 1_048_576}.items():
            gen = context_report.Msg(f(3, f(28, slug)))
            self.assertEqual(context_report.context_limit(gen), tokens)

    def test_fmt_tok(self):
        self.assertEqual(context_report.fmt_tok(999), "999")
        self.assertEqual(context_report.fmt_tok(1500), "1.5k")
        self.assertEqual(context_report.fmt_tok(1_000_000), "1M")
        self.assertEqual(context_report.fmt_tok(1_250_000), "1.2M")


if __name__ == "__main__":
    unittest.main()
