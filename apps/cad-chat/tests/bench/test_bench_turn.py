# -*- coding: utf-8 -*-
"""bench_turn 的離線單元測試；資料全為 inline，不讀 fixture、不連網。"""

import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import bench_turn as bt


def frame(t, event, **data):
    return {"t": t, "event": event, "data": data}


class ParseSSETests(unittest.TestCase):
    def test_heartbeat_multiline_bad_json_and_mixed_newlines(self):
        raw = (
            ": ping\r\n\r\n"
            "event: session\r\ndata: {\"sessionId\":\"s1\"}\r\n\r\n"
            "event: tool\ndata: {\"id\": \"b1\",\r\ndata: \"status\": \"running\"}\n\n"
            "event: broken\ndata: {bad json}\n\n"
            ": ping\n\n"
            "data: {\"text\":\"你好\"}\r\n\r\n"
        )
        frames = bt.parse_sse_text(raw)
        self.assertEqual(len(frames), 3)
        self.assertEqual([f["t"] for f in frames], [0, 10, 20])
        self.assertEqual([f["event"] for f in frames], ["session", "tool", "message"])
        self.assertEqual(frames[1]["data"], {"id": "b1", "status": "running"})
        self.assertEqual(frames[2]["data"]["text"], "你好")

    def test_empty_and_final_frame_without_blank_line(self):
        self.assertEqual(bt.parse_sse_text(": ping\n\n"), [])
        self.assertEqual(bt.parse_sse_text(""), [])
        self.assertEqual(bt.parse_sse_text('event: done\ndata: {"ok":true}'),
                         [frame(0, "done", ok=True)])


class ToolNameTests(unittest.TestCase):
    def test_all_prefixes_unknown_and_non_string(self):
        cases = [
            ("cad.build(x.py)", "cad_build"),
            ("parts.select_motor", "cad_source_part"),
            ("cad.import(x)", "cad_import"),
            ("cad.measure(a → b)", "cad_measure"),
            ("cad.align(a → b)", "cad_align"),
            ("cad.export(step)", "cad_export"),
            ("unknown", "unknown"), (None, ""), (17, ""),
        ]
        for name, expected in cases:
            with self.subTest(name=name):
                self.assertEqual(bt.normalize_tool_name(name), expected)


class StreamPostTests(unittest.TestCase):
    class Response:
        status = 200

        def __init__(self, lines):
            self.lines = iter(lines)
            self.reads = 0
            self.closed = False

        def __enter__(self):
            return self

        def __exit__(self, *args):
            self.closed = True

        def readline(self):
            self.reads += 1
            return next(self.lines, b"")

    def test_incremental_callback_and_stop_at_done(self):
        # 替身只回傳 inline bytes；callback 須在下一個 frame 被讀取前發生。
        response = self.Response([
            b": ping\r\n", b"\r\n",
            b"event: tool\n", b'data: {"id":"b1",\n', b'data: "status":"running"}\n', b"\n",
            b"event: done\n", b'data: {"ok":true}\n', b"\n",
            b"event: error\n", b'data: {"message":"must not read"}\n', b"\n",
        ])
        calls = []
        original = bt.urllib.request.urlopen

        def fake_open(req, timeout):
            self.assertEqual(req.get_method(), "POST")
            self.assertEqual(req.get_header("Content-type"), "application/json")
            self.assertEqual(bt.json.loads(req.data), {"message": "測試", "mode": "design", "orch": False})
            self.assertEqual(timeout, 60)
            return response

        bt.urllib.request.urlopen = fake_open
        try:
            result = bt.stream_post("/api/chat", {"message": "測試", "mode": "design", "orch": False},
                                    on_frame=lambda t, ev, data: calls.append((t, ev, data, response.reads)))
        finally:
            bt.urllib.request.urlopen = original
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["body"], "")
        self.assertEqual([f["event"] for f in result["frames"]], ["tool", "done"])
        self.assertEqual([c[3] for c in calls], [6, 9])
        self.assertEqual([c[:3] for c in calls], [(f["t"], f["event"], f["data"]) for f in result["frames"]])
        self.assertEqual(response.reads, 9)
        self.assertTrue(response.closed)
        self.assertGreaterEqual(result["wall_ms"], 0)

    def test_http_error_returns_body_without_frames(self):
        class ErrorBody:
            closed = False

            def read(self):
                return b'{"error":"session busy"}'

            def close(self):
                self.closed = True

        original = bt.urllib.request.urlopen

        def fake_open(req, timeout):
            raise bt.urllib.error.HTTPError(req.full_url, 409, "busy", {}, ErrorBody())

        bt.urllib.request.urlopen = fake_open
        try:
            result = bt.stream_post("/api/chat", {})
        finally:
            bt.urllib.request.urlopen = original
        self.assertEqual(result["status"], 409)
        self.assertEqual(result["frames"], [])
        self.assertEqual(result["body"], '{"error":"session busy"}')

    def test_deadline_raises_and_closes_response(self):
        response = self.Response([])
        original_open, original_clock = bt.urllib.request.urlopen, bt.time.perf_counter
        times = iter([0, 2])
        bt.urllib.request.urlopen = lambda req, timeout: response
        bt.time.perf_counter = lambda: next(times)
        try:
            with self.assertRaises(TimeoutError):
                bt.stream_post("/api/chat", {}, deadline_s=1)
        finally:
            bt.urllib.request.urlopen = original_open
            bt.time.perf_counter = original_clock
        self.assertTrue(response.closed)
        self.assertEqual(response.reads, 0)


class ClarifyTests(unittest.TestCase):
    def test_recommended_fullwidth_has_priority(self):
        clarify = {"opts": [{"label": "首項", "value": "first"},
                            {"label": "直驅（建議）", "value": "direct"}], "suggested": "first"}
        self.assertEqual(bt.pick_clarify_answer(clarify), ("direct", "recommended"))

    def test_recommended_ai_halfwidth_and_label_fallback(self):
        label = "直驅 (AI 建議)"
        self.assertEqual(bt.pick_clarify_answer({"opts": [{"label": label, "value": ""}]}),
                         (label, "recommended"))
        self.assertIsNone(bt.RECOMMEND_RE.search("建議選這個"))
        self.assertIsNone(bt.RECOMMEND_RE.search("直驅 (建議) 其他文字"))

    def test_first_recommended_wins(self):
        opts = [{"label": "A (建議)", "value": "a"}, {"label": "B（AI 建議）", "value": "b"}]
        self.assertEqual(bt.pick_clarify_answer({"opts": opts}), ("a", "recommended"))

    def test_suggested_match(self):
        opts = [{"label": "A", "value": "a"}, {"label": "B", "value": "b"}]
        self.assertEqual(bt.pick_clarify_answer({"opts": opts, "suggested": "b"}),
                         ("b", "suggested_match"))

    def test_first_option_before_unmatched_suggestion(self):
        self.assertEqual(bt.pick_clarify_answer({"opts": [{"label": "A", "value": "a"}]}),
                         ("a", "first"))
        self.assertEqual(bt.pick_clarify_answer({"opts": [{"label": "A", "value": None}],
                                                "suggested": "other"}), ("A", "first"))

    def test_suggested_and_fallback_without_options(self):
        self.assertEqual(bt.pick_clarify_answer({"suggested": "direct"}), ("direct", "suggested"))
        self.assertEqual(bt.pick_clarify_answer({}), (bt.CLARIFY_FALLBACK, "fallback"))
        self.assertEqual(bt.pick_clarify_answer({"opts": [], "suggested": ""}),
                         (bt.CLARIFY_FALLBACK, "fallback"))


class TurnStatsTests(unittest.TestCase):
    def test_complete_present_turn(self):
        metrics = {"variant": "single", "sdk": {"durationMs": 5000, "durationApiMs": 4000}}
        frames = [
            frame(0, "session", sessionId="s1", sdkSessionId=None),
            frame(10, "session", sessionId="s1", sdkSessionId="sdk1"),
            frame(20, "stage", name="thinking"),
            frame(100, "tool", id="b1", name="cad.build(x.py)", status="running"),
            frame(2000, "tool", id="b1", status="done", ms=1200),
            frame(2010, "validate", ok=True, attempt=2, partCount=7, ms=10),
            frame(2020, "retry", attempt=2, reason="fix"),
            frame(2030, "version", id=1, name="x", partCount=7),
            frame(2040, "present", ver=1, name="x"),
            frame(2050, "metrics", **metrics),
            frame(2060, "done", ok=True, version=1),
        ]
        st = bt.turn_stats(frames, 5000)
        expected = {"ended_by": "present", "wall_ms": 5000, "t_first_event": 20,
                    "t_first_tool": 100, "t_first_build": 100, "t_first_build_done": 2000,
                    "t_present": 2040, "t_clarify": None, "t_done": 2060,
                    "build_ms_sum": 1200, "validate_ms_sum": 10, "n_validate": 1,
                    "max_attempt": 2, "n_retry": 1, "part_count": 7, "version_id": 1,
                    "name": "x", "validate_ok_last": True, "sdk_api_share": 0.8,
                    "session_id": "s1", "sdk_session_id": "sdk1", "n_events": len(frames),
                    "metrics": metrics, "errors": [], "ai_chars": 0}
        for key, value in expected.items():
            with self.subTest(key=key):
                self.assertEqual(st[key], value)
        self.assertEqual(st["tools"]["cad_build"], {"n": 1, "done": 1, "error": 0, "ms": 1200})

    def test_ending_priority_clarify_present_error_done(self):
        clarify = frame(10, "clarify", q="規格?", opts=[])
        error = frame(20, "error", message="oops")
        present = frame(30, "present", ver=1)
        done = frame(40, "done", ok=False)
        cases = [([clarify], "clarify"), ([error, done], "error"),
                 ([error, present, done], "present"), ([present, clarify, done], "clarify"),
                 ([done], "done"), ([], "done")]
        for frames, expected in cases:
            with self.subTest(expected=expected, frames=frames):
                self.assertEqual(bt.turn_stats(frames, 40)["ended_by"], expected)
        st = bt.turn_stats([clarify], 10)
        self.assertEqual(st["clarify"], clarify["data"])
        self.assertEqual(st["t_clarify"], 10)

    def test_patches_match_id_first_build_and_last_values(self):
        frames = [
            frame(0, "session", sessionId="s1", sdkSessionId="sdk1"),
            frame(5, "session", sdkSessionId=None),
            frame(10, "tool", id="p", name="parts.select_rail", status="running"),
            frame(20, "tool", id="a", name="cad.build(a.py)", status="running"),
            frame(30, "tool", id="b", name="cad.build(b.py)", status="running"),
            frame(40, "tool", id="b", status="done", ms=20),
            frame(50, "tool", id="a", status="error", ms=30),
            frame(60, "tool", id="p", status="done"),
            frame(70, "validate", ok=False, attempt=3, partCount=4, ms=2),
            frame(80, "version", id=1, name="old", partCount=7),
            frame(90, "validate", ok=True, attempt=1, partCount=99, ms=3),
            frame(100, "version", id=2, name="new", partCount=8),
            frame(110, "ai_delta", text="你好"), frame(120, "ai_delta", text="abc"),
            frame(130, "ai", text="不重複計算"), frame(140, "error", message="x" * 250),
        ]
        st = bt.turn_stats(frames, 150)
        self.assertEqual(st["t_first_tool"], 10)
        self.assertEqual(st["t_first_build"], 20)
        self.assertIsNone(st["t_first_build_done"])
        self.assertEqual(st["tools"]["cad_build"], {"n": 2, "done": 1, "error": 1, "ms": 50})
        self.assertEqual(st["tools"]["cad_source_part"]["ms"], 0)
        self.assertEqual(st["build_ms_sum"], 50)
        self.assertEqual(st["validate_ms_sum"], 5)
        self.assertEqual(st["n_validate"], 2)
        self.assertEqual(st["max_attempt"], 3)
        self.assertTrue(st["validate_ok_last"])
        self.assertEqual((st["part_count"], st["version_id"], st["name"]), (8, 2, "new"))
        self.assertEqual(st["sdk_session_id"], "sdk1")
        self.assertEqual(st["ai_chars"], 5)
        self.assertEqual(st["errors"], ["x" * 200])

    def test_validate_part_count_fallback_and_api_share_guards(self):
        st = bt.turn_stats([frame(0, "validate", ok=False, partCount=5),
                            frame(10, "validate", ok=True, partCount=6)], 10)
        self.assertEqual(st["part_count"], 6)
        self.assertEqual(bt.turn_stats([frame(0, "validate", partCount=6),
                                        frame(1, "version", id=1, name="x")], 1)["part_count"], 6)
        for sdk in (None, {}, {"durationMs": 0, "durationApiMs": 1},
                    {"durationMs": 1, "durationApiMs": 0},
                    {"durationMs": -1, "durationApiMs": 1}):
            with self.subTest(sdk=sdk):
                self.assertIsNone(bt.turn_stats([frame(0, "metrics", sdk=sdk)], 0)["sdk_api_share"])
        empty = bt.turn_stats([], 0)
        self.assertIsNone(empty["t_first_event"])
        self.assertIsNone(empty["part_count"])


class TokenDeltaTests(unittest.TestCase):
    @staticmethod
    def turn(cost, output):
        return {"metrics": {"sdk": {"costUsd": cost, "modelUsage": {"main": {"output": output}}}}}

    def test_three_cumulative_turns(self):
        deltas = bt.turn_token_delta([self.turn(0.1, 100), self.turn(0.3, 250), self.turn(0.35, 400)])
        for delta, cost, output in zip(deltas, (0.1, 0.2, 0.05), (100, 150, 150)):
            self.assertAlmostEqual(delta["cost_usd"], cost)
            self.assertEqual(delta["output_tokens"], output)

    def test_missing_metrics_null_sdk_and_negative_reset(self):
        turns = [self.turn(0.3, 250), {"metrics": None}, {"metrics": {"sdk": None}},
                 self.turn(0.05, 20), self.turn(0.08, 30)]
        deltas = bt.turn_token_delta(turns)
        self.assertEqual(deltas[1:3], [{"cost_usd": None, "output_tokens": None}] * 2)
        self.assertEqual(deltas[3], {"cost_usd": 0.05, "output_tokens": 20})
        self.assertAlmostEqual(deltas[4]["cost_usd"], 0.03)
        self.assertEqual(deltas[4]["output_tokens"], 10)

    def test_all_models_include_subagents_and_usage_is_reference(self):
        turns = [
            {"metrics": {"sdk": {"costUsd": 0, "usage": {"output": 9999},
                                  "modelUsage": {"main": {"output": 100}, "sub": {"output": 50}}}}},
            {"metrics": {"sdk": {"costUsd": 0.2, "usage": {"output": 1},
                                  "modelUsage": {"main": {"output": 130}, "sub": {"output": 100}}}}},
            {"metrics": {"sdk": {"costUsd": 0.3, "usage": {"output": 42}, "modelUsage": None}}},
        ]
        deltas = bt.turn_token_delta(turns)
        self.assertEqual([d["output_tokens"] for d in deltas], [150, 80, None])
        self.assertEqual(deltas[0]["cost_usd"], 0)
        self.assertIsNone(bt.turn_token_delta([{}])[0]["cost_usd"])
        self.assertEqual(bt.turn_token_delta([]), [])


class AggregateTests(unittest.TestCase):
    @staticmethod
    def make_run(variant, wall, part_count, presented=True, validate_ok=True, gen_bytes=None):
        return {"variant": variant,
                "totals": {"wall_ms_all_turns": wall, "wall_ms_build_turn": wall,
                           "cost_usd": None, "output_tokens": None},
                "outcome": {"part_count": part_count, "presented": presented,
                            "validate_ok": validate_ok, "clarify_turns": 1},
                "generator": {"bytes": gen_bytes} if gen_bytes is not None else None}

    def test_medians_ranges_rates_and_table_delta(self):
        runs = [self.make_run("single", 10, 3, gen_bytes=100), self.make_run("single", 20, None),
                self.make_run("single", 30, 7, presented=False, validate_ok=None),
                self.make_run("orch", 40, 9), self.make_run("orch", 60, 11, validate_ok=False)]
        agg = bt.aggregate(runs)
        self.assertEqual(agg["single"]["n"], 3)
        self.assertEqual(agg["single"]["wall_ms_build_turn"], {"median": 20, "min": 10, "max": 30})
        self.assertEqual(agg["orch"]["wall_ms_build_turn"], {"median": 50, "min": 40, "max": 60})
        self.assertEqual(agg["single"]["part_count"], {"median": 5, "min": 3, "max": 7})
        self.assertEqual(agg["single"]["gen_bytes"], {"median": 100, "min": 100, "max": 100})
        self.assertEqual(agg["single"]["cost_usd"], {"median": None, "min": None, "max": None})
        self.assertAlmostEqual(agg["single"]["presented_rate"], 2 / 3)
        self.assertAlmostEqual(agg["single"]["validate_ok_rate"], 2 / 3)
        self.assertEqual(agg["orch"]["validate_ok_rate"], 0.5)
        table = bt.format_table(agg)
        self.assertIn("single", table)
        self.assertIn("orch", table)
        row = next(line for line in table.splitlines() if line.startswith("wall_ms_build_turn"))
        cols = [col.strip() for col in row.split("|")]
        self.assertEqual(cols, ["wall_ms_build_turn", "20 / 10 / 30", "50 / 40 / 60", "30"])

    def test_single_only_empty_and_failed_run(self):
        agg = bt.aggregate([self.make_run("single", 10, None)])
        row = next(line for line in bt.format_table(agg).splitlines() if line.startswith("wall_ms_build_turn"))
        self.assertEqual([col.strip() for col in row.split("|")][-2:], ["-", "-"])
        self.assertEqual(bt.aggregate([]), {})
        self.assertIn("wall_ms_build_turn", bt.format_table({}))
        failed = bt.aggregate([{"variant": "orch", "run": 1, "error": "timeout"}])["orch"]
        self.assertEqual(failed["n"], 1)
        self.assertEqual(failed["presented_rate"], 0)
        self.assertEqual(failed["wall_ms_all_turns"], {"median": None, "min": None, "max": None})


if __name__ == "__main__":
    unittest.main()
