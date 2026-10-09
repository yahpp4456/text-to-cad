# -*- coding: utf-8 -*-
"""量測 cad-chat 單代理與派工回合的 SSE 時序、工具、成本及輸出 token。

離線跑法（不需要 server 或 LLM）：
  PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/bench/bench_turn.py --stub FILE
實際量測需先啟動 cad-chat，設 CADCHAT_BENCH_LLM=1，再指定 --runs 3 --record。
可用 CADCHAT_BASE 覆蓋網址、--prompt 覆蓋題目；結果預設寫到 smoke/.out/。
純 SSE 文字重播的時間為合成毫秒；JSONL 重播保留錄製的逐事件時間。
"""

import argparse
import json
import os
import re
import statistics
import sys
import time
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, "..", "smoke"))
from _util import BASE, REPO, OUT, out_path, server_alive  # noqa: E402

PROMPT = "行程 100mm 的電動線性滑台:底板、線軌滑塊、滾珠螺桿與步進馬達"
RECOMMEND_RE = re.compile(r"\s*[(（]\s*(?:AI\s*)?建議\s*[)）]\s*$")
CLARIFY_FALLBACK = "依你的建議值繼續,不必再確認。"
TOOL_NAME_MAP = [
    ("cad.build(", "cad_build"), ("parts.select_", "cad_source_part"),
    ("cad.import(", "cad_import"), ("cad.measure(", "cad_measure"),
    ("cad.align(", "cad_align"), ("cad.export(", "cad_export"),
]
AGG_METRICS = (
    "wall_ms_all_turns", "wall_ms_build_turn", "t_first_build_ms", "build_ms_sum",
    "validate_ms_sum", "retries", "cost_usd", "output_tokens", "part_count",
    "gen_bytes", "sub_tools", "clarify_turns",
)


def _decode_frame(lines):
    event, data = "message", []
    for line in lines:
        field, sep, value = line.partition(":")
        if not sep:
            continue
        if value.startswith(" "):
            value = value[1:]
        if field == "event":
            event = value or "message"
        elif field == "data":
            data.append(value)
    if not data:
        return None
    try:
        return event, json.loads("\n".join(data))
    except (ValueError, TypeError):
        return None


def parse_sse_text(raw: str) -> list[dict]:
    frames, lines = [], []
    for line in raw.splitlines() + [""]:
        if line:
            lines.append(line)
            continue
        decoded = _decode_frame(lines)
        lines = []
        if decoded is not None:
            ev, data = decoded
            frames.append({"t": len(frames) * 10, "event": ev, "data": data})
    return frames


def stream_post(path: str, body: dict, *, deadline_s: float = 900,
                read_timeout_s: float = 60, on_frame=None) -> dict:
    t0 = time.perf_counter()
    req = urllib.request.Request(
        BASE.rstrip("/") + path, data=json.dumps(body, ensure_ascii=False).encode("utf-8"),
        headers={"content-type": "application/json"}, method="POST",
    )
    frames = []
    try:
        with urllib.request.urlopen(req, timeout=read_timeout_s) as resp:
            if not 200 <= resp.status < 300:
                return {"status": resp.status, "frames": [],
                        "wall_ms": round((time.perf_counter() - t0) * 1000),
                        "body": resp.read().decode("utf-8", "replace")}
            lines = []
            while True:
                remaining = deadline_s - (time.perf_counter() - t0)
                if remaining <= 0:
                    raise TimeoutError("SSE turn deadline exceeded")
                # HTTPResponse 的 socket 讀取也須受整回合期限限制。
                raw = getattr(getattr(resp, "fp", None), "raw", None)
                sock = getattr(raw, "_sock", None)
                if sock is not None:
                    sock.settimeout(min(read_timeout_s, remaining))
                line = resp.readline()
                if time.perf_counter() - t0 > deadline_s:
                    raise TimeoutError("SSE turn deadline exceeded")
                if not line:
                    break
                line = line.decode("utf-8", "replace").rstrip("\r\n")
                if line:
                    lines.append(line)
                    continue
                decoded = _decode_frame(lines)
                lines = []
                if decoded is None:
                    continue
                ev, data = decoded
                t = round((time.perf_counter() - t0) * 1000)
                frames.append({"t": t, "event": ev, "data": data})
                if on_frame is not None:
                    on_frame(t, ev, data)
                if ev == "done":
                    break
            return {"status": resp.status, "frames": frames,
                    "wall_ms": round((time.perf_counter() - t0) * 1000), "body": ""}
    except urllib.error.HTTPError as exc:
        with exc:
            response_body = exc.read().decode("utf-8", "replace")
        return {"status": exc.code, "frames": [],
                "wall_ms": round((time.perf_counter() - t0) * 1000), "body": response_body}


def normalize_tool_name(name: str) -> str:
    if not isinstance(name, str):
        return ""
    for prefix, normalized in TOOL_NAME_MAP:
        if name.startswith(prefix):
            return normalized
    return name


def pick_clarify_answer(clarify: dict) -> tuple[str, str]:
    opts = clarify.get("opts") or []
    suggested = clarify.get("suggested")
    for op in opts:
        if RECOMMEND_RE.search(op.get("label") or ""):
            return op.get("value") or op.get("label"), "recommended"
    if suggested:
        for op in opts:
            if op.get("value") == suggested:
                return op["value"], "suggested_match"
    if opts:
        return opts[0].get("value") or opts[0].get("label"), "first"
    if suggested:
        return suggested, "suggested"
    return CLARIFY_FALLBACK, "fallback"


def turn_stats(frames: list[dict], wall_ms: int) -> dict:
    st = {
        "wall_ms": wall_ms, "ended_by": "done", "t_first_event": None,
        "t_first_tool": None, "t_first_build": None, "t_first_build_done": None,
        "t_present": None, "t_clarify": None, "t_done": None, "tools": {},
        "build_ms_sum": 0, "validate_ms_sum": 0, "n_validate": 0,
        "max_attempt": 0, "n_retry": 0, "validate_ok_last": None,
        "part_count": None, "version_id": None, "name": None, "errors": [],
        "n_events": len(frames), "ai_chars": 0, "session_id": None,
        "sdk_session_id": None, "clarify": None, "metrics": None, "sdk_api_share": None,
    }
    tool_names = {}
    first_build_id = None
    validate_parts = None
    for frame in frames:
        ev, data, t = frame["event"], frame["data"], frame["t"]
        if ev != "session" and st["t_first_event"] is None:
            st["t_first_event"] = t
        if ev == "session":
            if data.get("sessionId"):
                st["session_id"] = data["sessionId"]
            if data.get("sdkSessionId"):
                st["sdk_session_id"] = data["sdkSessionId"]
        elif ev == "tool":
            tool_id, status = data.get("id"), data.get("status")
            if status == "running":
                name = normalize_tool_name(data.get("name"))
                tool_names[tool_id] = name
                counts = st["tools"].setdefault(name, {"n": 0, "done": 0, "error": 0, "ms": 0})
                counts["n"] += 1
                if st["t_first_tool"] is None:
                    st["t_first_tool"] = t
                if name == "cad_build" and st["t_first_build"] is None:
                    st["t_first_build"], first_build_id = t, tool_id
            else:
                name = tool_names.get(tool_id, normalize_tool_name(data.get("name")))
                counts = st["tools"].setdefault(name, {"n": 0, "done": 0, "error": 0, "ms": 0})
                if status in ("done", "error"):
                    counts[status] += 1
                if data.get("ms") is not None:
                    counts["ms"] += data["ms"]
                if (st["t_first_build"] is not None and tool_id == first_build_id
                        and status == "done" and st["t_first_build_done"] is None):
                    st["t_first_build_done"] = t
        elif ev == "validate":
            st["n_validate"] += 1
            st["validate_ms_sum"] += data.get("ms") or 0
            st["max_attempt"] = max(st["max_attempt"], data.get("attempt") or 0)
            st["validate_ok_last"] = data.get("ok")
            validate_parts = data.get("partCount")
        elif ev == "retry":
            st["n_retry"] += 1
        elif ev == "version":
            st["part_count"] = data.get("partCount")
            st["version_id"], st["name"] = data.get("id"), data.get("name")
        elif ev == "present":
            if st["t_present"] is None:
                st["t_present"] = t
        elif ev == "clarify":
            if st["t_clarify"] is None:
                st["t_clarify"] = t
            st["clarify"] = data
        elif ev == "done":
            if st["t_done"] is None:
                st["t_done"] = t
        elif ev == "error":
            st["errors"].append((data.get("message") or "")[:200])
        elif ev == "ai_delta":
            st["ai_chars"] += len(data.get("text") or "")
        elif ev == "metrics":
            st["metrics"] = data
    if st["part_count"] is None:
        st["part_count"] = validate_parts
    st["build_ms_sum"] = st["tools"].get("cad_build", {}).get("ms", 0)
    events = {frame["event"] for frame in frames}
    st["ended_by"] = ("clarify" if "clarify" in events else "present" if "present" in events
                      else "error" if "error" in events else "done")
    sdk = (st["metrics"] or {}).get("sdk") or {}
    duration, api = sdk.get("durationMs"), sdk.get("durationApiMs")
    if duration is not None and duration > 0 and api is not None and api > 0:
        st["sdk_api_share"] = api / duration
    return st


def turn_token_delta(turns: list[dict]) -> list[dict]:
    deltas = []
    prev_cost = prev_output = None
    for turn in turns:
        sdk = (turn.get("metrics") or {}).get("sdk") or {}
        cost = sdk.get("costUsd")
        models = sdk.get("modelUsage")
        output = (sum(model.get("output") or 0 for model in models.values())
                  if models is not None else None)
        delta = {}
        for key, current, previous in (("cost_usd", cost, prev_cost),
                                       ("output_tokens", output, prev_output)):
            value = None if current is None else current if previous is None else current - previous
            delta[key] = current if value is not None and value < 0 else value
        deltas.append(delta)
        # 缺 metrics 的回合不抹去已知的 session 累積基準。
        if cost is not None:
            prev_cost = cost
        if output is not None:
            prev_output = output
    return deltas


def read_generator_stats(session_id: str, name: str) -> dict | None:
    try:
        if not session_id or not name:
            return None
        root = os.path.join(REPO, "models", ".cadchat", session_id)
        with open(os.path.join(root, name + ".py"), "rb") as source:
            content = source.read()
        lines = content.decode("utf-8-sig").splitlines()
        result = {"bytes": len(content), "lines": len(lines),
                  "defs": sum(line.startswith("def ") for line in lines)}
        asm_path = os.path.join(root, name + ".asm.json")
        if os.path.exists(asm_path):
            with open(asm_path, encoding="utf-8-sig") as source:
                asm = json.load(source)
            result["asm_parts"] = len(asm["parts"]) if asm.get("parts") is not None else asm.get("partCount")
        return result
    except Exception:
        return None


def _last_value(turns, key):
    return next((turn[key] for turn in reversed(turns) if turn.get(key) is not None), None)


def _sum_known(values):
    known = [value for value in values if value is not None]
    return sum(known) if known else None


def _run_record(variant, run_idx, turns, busy_retries=0):
    session_id = _last_value(turns, "session_id")
    name = _last_value(turns, "name")
    delta = turn_token_delta(turns)
    build_turn = next((turn for turn in reversed(turns) if turn["ended_by"] != "clarify"), None)
    sub = (((build_turn or {}).get("metrics") or {}).get("tools") or {}).get("sub") or {}
    return {
        "variant": variant, "run": run_idx, "sessionId": session_id,
        "sdkSessionId": _last_value(turns, "sdk_session_id"), "turns": turns, "token_delta": delta,
        "outcome": {
            "presented": any(turn["ended_by"] == "present" for turn in turns),
            "ended_by": turns[-1]["ended_by"] if turns else "done",
            "validate_ok": _last_value(turns, "validate_ok_last"),
            "part_count": _last_value(turns, "part_count"), "version": _last_value(turns, "version_id"),
            "name": name, "clarify_turns": sum(turn["ended_by"] == "clarify" for turn in turns),
        },
        "generator": read_generator_stats(session_id, name),
        "totals": {
            "wall_ms_all_turns": sum(turn["wall_ms"] for turn in turns),
            "wall_ms_build_turn": build_turn["wall_ms"] if build_turn else None,
            "cost_usd": _sum_known(d["cost_usd"] for d in delta),
            "output_tokens": _sum_known(d["output_tokens"] for d in delta),
            "t_first_build_ms": build_turn["t_first_build"] if build_turn else None,
            "build_ms_sum": sum(turn["build_ms_sum"] for turn in turns),
            "validate_ms_sum": sum(turn["validate_ms_sum"] for turn in turns),
            "retries": sum(turn["n_retry"] for turn in turns),
            "sub_tools": sub.get("n") or 0, "busy_retries": busy_retries,
        },
    }


def _warn_metrics(st, variant):
    if st["metrics"] is None:
        print("警告: server 未發 metrics(舊 server?)")
    elif st["metrics"].get("variant") != variant:
        raise RuntimeError("server ignored body.orch")


def run_once(variant: str, run_idx: int, args) -> dict:
    turns, busy_retries, session_id = [], 0, None
    text = getattr(args, "prompt", PROMPT)
    for turn_idx in range(1, args.max_turns + 1):
        body = {"message": text, "mode": "design", "orch": variant == "orch"}
        if turn_idx > 1 and session_id:
            body["sessionId"] = session_id
        for retry_idx in range(6):
            r = stream_post("/api/chat", body, deadline_s=args.turn_timeout)
            if r["status"] != 409 or retry_idx == 5:
                break
            busy_retries += 1
            time.sleep(2 ** retry_idx)
        st = turn_stats(r["frames"], r["wall_ms"])
        if args.record:
            path = out_path(f"bench_{args.ts}_{variant}_r{run_idx}_t{turn_idx}.sse.jsonl")
            with open(path, "w", encoding="utf-8") as output:
                for frame in r["frames"]:
                    output.write(json.dumps(frame, ensure_ascii=False) + "\n")
        if r["status"] != 200:
            st.update(ended_by=f"http_{r['status']}", http_status=r["status"], http_body=r["body"])
            turns.append(st)
            print(f"{variant} run {run_idx}: HTTP {r['status']}: {r['body'][:200]}")
            break
        _warn_metrics(st, variant)
        turns.append(st)
        session_id = st["session_id"] or session_id
        if st["ended_by"] != "clarify":
            break
        text, how = pick_clarify_answer(st["clarify"])
        print(f"clarify 回答({how}): {text}")
    return _run_record(variant, run_idx, turns, busy_retries)


def aggregate(runs: list[dict]) -> dict:
    groups = {}
    for run in runs:
        groups.setdefault(run["variant"], []).append(run)
    agg = {}
    for variant, group in groups.items():
        n = len(group)
        stats = {
            "n": n,
            "presented_rate": sum(bool(run.get("outcome", {}).get("presented")) for run in group) / n,
            "validate_ok_rate": sum(run.get("outcome", {}).get("validate_ok") is True for run in group) / n,
        }
        for metric in AGG_METRICS:
            if metric in ("part_count", "clarify_turns"):
                values = [run.get("outcome", {}).get(metric) for run in group]
            elif metric == "gen_bytes":
                values = [(run.get("generator") or {}).get("bytes") for run in group]
            else:
                values = [run.get("totals", {}).get(metric) for run in group]
            values = [value for value in values if value is not None]
            stats[metric] = {"median": statistics.median(values) if values else None,
                             "min": min(values) if values else None, "max": max(values) if values else None}
        agg[variant] = stats
    return agg


def format_table(agg: dict) -> str:
    def fmt(value):
        return "-" if value is None else f"{value:.6g}"

    lines = [f"{'metric':<24} | {'single med/min/max':>26} | {'orch med/min/max':>26} | {'Δmed':>12}"]
    lines.append("-" * len(lines[0]))
    for metric in ("n", "presented_rate", "validate_ok_rate") + AGG_METRICS:
        cols, medians = [], []
        for variant in ("single", "orch"):
            value = agg.get(variant, {}).get(metric)
            if isinstance(value, dict):
                cols.append(" / ".join(fmt(value.get(key)) for key in ("median", "min", "max")))
                medians.append(value.get("median"))
            else:
                cols.append(fmt(value))
                medians.append(value)
        delta = medians[1] - medians[0] if all(v is not None for v in medians) else None
        lines.append(f"{metric:<24} | {cols[0]:>26} | {cols[1]:>26} | {fmt(delta):>12}")
    return "\n".join(lines)


def _health():
    """GET /api/health(model/effort/authMode 等 server 端設定)→ 記進 meta 供報告對照。"""
    try:
        with urllib.request.urlopen(BASE.rstrip("/") + "/api/health", timeout=5) as resp:
            return json.loads(resp.read().decode("utf-8", "replace"))
    except Exception:
        return None


def _write_results(args, started, runs):
    serializable_args = {}
    for key, value in vars(args).items():
        try:
            json.dumps(value)
        except (TypeError, ValueError):
            continue
        serializable_args[key] = value
    payload = {"meta": {"prompt": args.prompt, "base": BASE, "started": started,
                        "args": serializable_args, "health": getattr(args, "health", None)},
               "runs": runs, "aggregate": aggregate(runs)}
    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    with open(args.out, "w", encoding="utf-8") as output:
        json.dump(payload, output, ensure_ascii=False, indent=1)
        output.write("\n")
    return payload["aggregate"]


def _print_exception_summary(exc):
    print("Traceback 摘要:")
    tb = exc.__traceback__
    locations = []
    while tb is not None:
        code = tb.tb_frame.f_code
        locations.append(f"  {code.co_filename}:{tb.tb_lineno} in {code.co_name}")
        tb = tb.tb_next
    print("\n".join(locations[-3:]))
    print(f"{type(exc).__name__}: {exc}")


def main(argv=None) -> int:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--variant", choices=("single", "orch", "both"), default="both")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--out")
    parser.add_argument("--record", action="store_true")
    parser.add_argument("--stub", nargs="+", metavar="FILE")
    parser.add_argument("--transcript", action="store_true")
    parser.add_argument("--max-turns", type=int, default=3)
    parser.add_argument("--turn-timeout", type=float, default=900)
    parser.add_argument("--warmup", action="store_true")
    parser.add_argument("--prompt", default=PROMPT)
    args = parser.parse_args(argv)
    if args.runs < 1 or args.max_turns < 1 or args.turn_timeout <= 0:
        parser.error("--runs、--max-turns、--turn-timeout 必須大於 0")
    args.ts = time.strftime("%Y%m%d_%H%M%S")
    args.out = args.out or out_path(f"bench_{args.ts}.json")
    started = time.strftime("%Y-%m-%dT%H:%M:%S%z")
    if args.transcript:
        print("--transcript 尚未實作")
    runs = []
    if args.stub:
        indexes = {"single": 0, "orch": 0}
        for path in args.stub:
            with open(path, encoding="utf-8-sig") as source:
                frames = ([json.loads(line) for line in source if line.strip()]
                          if path.lower().endswith(".jsonl") else parse_sse_text(source.read()))
            variant = "orch" if "_orch_" in os.path.basename(path) else "single"
            indexes[variant] += 1
            wall_ms = max((frame["t"] for frame in frames), default=0)
            st = turn_stats(frames, wall_ms)
            _warn_metrics(st, variant)
            runs.append(_run_record(variant, indexes[variant], [st]))
        agg = aggregate(runs)
        print(format_table(agg))
        _write_results(args, started, runs)
        print(f"JSON: {args.out}")
        return 0
    if os.environ.get("CADCHAT_BENCH_LLM") != "1":
        print("需設 CADCHAT_BENCH_LLM=1 才會量測真 LLM 回合；離線請用 --stub FILE。")
        sys.exit(0)
    if not server_alive():
        print(f"server 不可達: {BASE}；請先啟動 cad-chat，或以 CADCHAT_BASE 指定網址。")
        return 1
    args.health = _health()
    print(f"server: {BASE} health={json.dumps(args.health, ensure_ascii=False)[:300]}")
    if args.warmup:
        print("warmup: single（不計入結果）")
        try:
            run_once("single", 0, args)
        except Exception as exc:
            _print_exception_summary(exc)
    variants = ("single", "orch") if args.variant == "both" else (args.variant,)
    for run_idx in range(1, args.runs + 1):
        for variant in variants:
            print(f"{variant} run {run_idx}/{args.runs}")
            try:
                runs.append(run_once(variant, run_idx, args))
            except Exception as exc:
                _print_exception_summary(exc)
                runs.append({"variant": variant, "run": run_idx,
                             "error": f"{type(exc).__name__}: {exc}"})
            _write_results(args, started, runs)
    print(format_table(aggregate(runs)))
    print(f"JSON: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
