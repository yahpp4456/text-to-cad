"""常駐 CAD worker(py/cadchat_ext/worker/cad_worker.py)整合測試。

起一個真的 worker(會載入 build123d,約 10 秒),用 frame 協定送請求,驗:
  - `run` 的語意等同 `python <script> <argv...>`(exit code、stdout、stderr、traceback)
  - 請求之間不殘留狀態(sys.path / os.environ / cwd / 第一方模組)
  - 同一秒內重寫同長度的 .py 也會載到新碼(.pyc 的秒級 mtime 判斷會拿到舊碼)
  - 不同工具各自的 `cli` 模組不互相汙染(scripts/step 與 scripts/inspect 都有 cli.py)
  - 真的產生器經 worker 與冷啟動的結果相同

直跑:PYTHONUTF8=1 .venv/Scripts/python.exe apps/cad-chat/tests/test_worker.py
"""
from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import tempfile
import textwrap
import unittest
from pathlib import Path

REPO = Path(__file__).resolve().parents[3]
PY_ROOT = REPO / "apps" / "cad-chat" / "py"
WORKER = PY_ROOT / "cadchat_ext" / "worker" / "cad_worker.py"
VALIDATE = REPO / "apps" / "cad-chat" / "src" / "server" / "cad" / "validate.py"
STEP_CLI = REPO / "skills" / "cad" / "scripts" / "step"

sys.path.insert(0, str(PY_ROOT))
from cadchat_ext.worker import frames  # noqa: E402

ENV = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8", "PYTHON_COLORS": "0"}


class Worker:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [sys.executable, str(WORKER)],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            cwd=str(REPO),
            env=ENV,
        )
        got = frames.read(self.proc.stdout)
        if got is None:
            raise RuntimeError("worker 沒送出 ready 就結束")
        self.ready = got[0]
        self._next = 0

    def run(self, script, argv=(), cwd=None, raw=False):
        """回 (code, stdout, stderr, message)。

        預設把 CRLF 正規化成 LF 方便比對內容(Windows 上 Python 的文字層本來就把 \\n 寫成
        \\r\\n,冷啟動也一樣);raw=True 回原始位元組,給「與冷啟動逐位相同」的測試用。
        """
        self._next += 1
        frames.write(
            self.proc.stdin,
            {"id": self._next, "op": "run", "script": str(script), "argv": [str(a) for a in argv], "cwd": str(cwd or REPO)},
        )
        message, payload = frames.read(self.proc.stdout)
        assert message["id"] == self._next, message
        n = message.get("outBytes", 0)
        out, err = payload[:n], payload[n:]
        if raw:
            return message.get("code"), out, err, message
        return (
            message.get("code"),
            out.decode("utf-8").replace("\r\n", "\n"),
            err.decode("utf-8").replace("\r\n", "\n"),
            message,
        )

    def close(self) -> int:
        if self.proc.poll() is None:
            self.proc.stdin.close()
            try:
                return self.proc.wait(timeout=30)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                raise
        return self.proc.returncode


def write(path: Path, source: str) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(textwrap.dedent(source), encoding="utf-8", newline="\n")
    return path


def last_json(text: str) -> dict:
    line = next(s for s in reversed(text.splitlines()) if s.startswith("{"))
    return json.loads(line)


class WorkerProtocolTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.tmp = Path(tempfile.mkdtemp(prefix="cadchat-worker-test-"))
        cls.worker = Worker()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.exit_code = cls.worker.close()
        finally:
            shutil.rmtree(cls.tmp, ignore_errors=True)

    def script(self, name: str, source: str) -> Path:
        return write(self.tmp / self.id().rsplit(".", 1)[-1] / name, source)

    def test_ready_frame(self) -> None:
        ready = self.worker.ready
        self.assertIs(ready["ready"], True)
        # 不與 Popen 的 pid 比:Windows venv 的 python.exe 是轉接器,真正的直譯器是它的子行程。
        self.assertGreater(ready["pid"], 0)
        self.assertEqual(ready["warnings"], [], "預載模組都應該載得起來")
        self.assertGreater(ready["rssMb"], 50)
        self.assertTrue(ready["versions"]["build123d"])
        self.assertTrue(any(Path(d).name == "cadpy" for d in ready["watch"]), ready["watch"])
        self.assertTrue(Path(ready["capture"]["err"]).parent.name.startswith("cadchat-worker-"))

    def test_stdout_stderr_and_exit_code(self) -> None:
        script = self.script(
            "io.py",
            """
            import os, sys
            print("py-out 繁中✓")
            print("py-err", file=sys.stderr)
            sys.stdout.flush(); sys.stderr.flush()
            os.write(1, b"fd-out\\n")   # C 層 / 直接寫 fd 的輸出也要收到
            os.write(2, b"fd-err\\n")
            print("argv=" + "|".join(sys.argv[1:]))
            print("name=" + __name__)
            sys.exit(3)
            """,
        )
        code, out, err, message = self.worker.run(script, ["a", "b c"])
        self.assertEqual(code, 3)
        self.assertEqual(out.splitlines(), ["py-out 繁中✓", "fd-out", "argv=a|b c", "name=__main__"])
        self.assertEqual(err.splitlines(), ["py-err", "fd-err"])
        self.assertGreater(message["rssMb"], 50)

    def test_output_is_byte_identical_to_cold_run(self) -> None:
        """同一支腳本:worker 回的 stdout / stderr / exit code 與 `python script.py` 逐位元組相同。"""
        script = self.script(
            "same.py",
            """
            import os, sys
            print("py-out 繁中✓")
            print("py-err ✗", file=sys.stderr)
            sys.stdout.flush(); sys.stderr.flush()
            os.write(1, b"fd-out\\n")
            os.write(2, b"fd-err\\n")
            def inner():
                raise ValueError("炸了")
            inner()
            """,
        )
        cold = subprocess.run([sys.executable, str(script)], cwd=str(REPO), env=ENV, capture_output=True)
        code, out, err, _ = self.worker.run(script, raw=True)
        self.assertEqual(code, cold.returncode)
        self.assertEqual(out, cold.stdout)
        self.assertEqual(err, cold.stderr)

    def test_output_does_not_leak_into_next_request(self) -> None:
        loud = self.script("loud.py", 'print("x" * 200000)')
        quiet = self.script("quiet.py", 'print("only this")')
        _, out, _, _ = self.worker.run(loud)
        self.assertEqual(len(out.strip()), 200000)
        _, out, err, _ = self.worker.run(quiet)
        self.assertEqual(out, "only this\n")
        self.assertEqual(err, "")

    def test_exit_variants(self) -> None:
        self.assertEqual(self.worker.run(self.script("ok.py", "x = 1"))[0], 0)
        self.assertEqual(self.worker.run(self.script("zero.py", "import sys; sys.exit(0)"))[0], 0)
        self.assertEqual(self.worker.run(self.script("none.py", "import sys; sys.exit()"))[0], 0)
        code, _, err, _ = self.worker.run(self.script("msg.py", 'import sys; sys.exit("壞參數")'))
        self.assertEqual(code, 1)
        self.assertEqual(err.strip(), "壞參數")

    def test_uncaught_exception_prints_plain_traceback(self) -> None:
        script = self.script(
            "boom.py",
            """
            def inner():
                raise ValueError("炸了")
            inner()
            """,
        )
        code, out, err, _ = self.worker.run(script)
        self.assertEqual(code, 1)
        self.assertEqual(out, "")
        lines = err.strip().splitlines()
        self.assertEqual(lines[0], "Traceback (most recent call last):")
        self.assertEqual(lines[-1], "ValueError: 炸了")
        self.assertIn(f'File "{script}", line 4, in <module>', err)
        self.assertIn("in inner", err)
        # 與直譯器相同:不含 worker / runpy 自己的 frame
        self.assertNotIn("cad_worker", err)
        self.assertNotIn("runpy", err)
        # worker 沒被拖垮
        self.assertEqual(self.worker.run(self.script("after.py", 'print("alive")'))[1], "alive\n")

    def test_missing_script_is_reported_not_fatal(self) -> None:
        code, _, err, _ = self.worker.run(self.tmp / "does_not_exist.py")
        self.assertNotEqual(code, 0)
        self.assertTrue(err.strip())
        self.assertEqual(self.worker.run(self.script("after.py", 'print("alive")'))[1], "alive\n")

    def test_state_is_restored_between_requests(self) -> None:
        workdir = self.tmp / "state"
        dirty = write(
            workdir / "dirty.py",
            """
            import os, sys
            sys.path.insert(0, "Z:/polluted")
            os.environ["CADCHAT_TEST_POLLUTION"] = "1"
            os.chdir(os.path.dirname(os.path.abspath(__file__)))
            import builtins
            """,
        )
        probe = write(
            workdir / "probe.py",
            """
            import json, os, sys
            print(json.dumps({
                "path": "Z:/polluted" in sys.path,
                "env": os.environ.get("CADCHAT_TEST_POLLUTION"),
                "cwd": os.getcwd(),
                "stdin": sys.stdin.read(),
            }))
            """,
        )
        self.assertEqual(self.worker.run(dirty)[0], 0)
        code, out, err, _ = self.worker.run(probe)
        self.assertEqual(code, 0, err)
        state = json.loads(out)
        self.assertFalse(state["path"])
        self.assertIsNone(state["env"])
        self.assertEqual(Path(state["cwd"]), REPO)
        self.assertEqual(state["stdin"], "", "腳本讀 stdin 立刻 EOF,不會吃掉協定")

    def test_cwd_is_applied_per_request(self) -> None:
        script = self.script("cwd.py", "import os; print(os.getcwd())")
        _, out, _, _ = self.worker.run(script, cwd=self.tmp)
        self.assertEqual(Path(out.strip()).resolve(), self.tmp.resolve())

    def test_script_dir_is_on_sys_path_like_the_interpreter(self) -> None:
        workdir = self.tmp / "sibling"
        write(workdir / "helper_mod.py", 'VALUE = "from sibling"')
        script = write(workdir / "main.py", "import helper_mod; print(helper_mod.VALUE)")
        code, out, err, _ = self.worker.run(script)
        self.assertEqual((code, out), (0, "from sibling\n"), err)

    def test_same_second_same_size_rewrite_loads_new_code(self) -> None:
        """滑桿重生的最壞情況:同一秒、同長度改寫。.pyc 以秒級 mtime + 大小判新舊會拿到舊碼。"""
        workdir = self.tmp / "regen"
        module = write(workdir / "params_mod.py", "VALUE = 100\n")
        script = write(workdir / "gen.py", "import params_mod; print(params_mod.VALUE)")
        stat = module.stat()
        self.assertEqual(self.worker.run(script)[1], "100\n")
        module.write_text("VALUE = 250\n", encoding="utf-8", newline="\n")  # 同長度
        os.utime(module, ns=(stat.st_atime_ns, stat.st_mtime_ns))  # 同 mtime
        self.assertEqual(module.stat().st_size, stat.st_size)
        self.assertEqual(self.worker.run(script)[1], "250\n")
        # 主腳本自己被同秒改寫也一樣
        main_stat = script.stat()
        script.write_text("import params_mod; print(params_mod.VALUE+1)", encoding="utf-8", newline="\n")
        os.utime(script, ns=(main_stat.st_atime_ns, main_stat.st_mtime_ns))
        self.assertEqual(self.worker.run(script)[1], "251\n")
        self.assertFalse((workdir / "__pycache__").exists(), "worker 不在工作目錄留 .pyc")

    def test_reads_reports_files_opened_for_reading_under_cwd(self) -> None:
        """done frame 的 reads:腳本讀了哪些檔(Node 用它判斷輸入沒變就不重建)。"""
        workdir = self.tmp / "reads"
        write(workdir / "helper_mod.py", "VALUE = 1\n")
        write(workdir / "data" / "spec.json", '{"w": 10}')
        write(workdir / "unused.json", "{}")
        outside = write(self.tmp / "outside-reads.txt", "elsewhere")
        script = write(
            workdir / "main.py",
            f"""
            import json, os
            import helper_mod                                   # import 也是讀檔
            json.load(open("data/spec.json", encoding="utf-8"))  # 相對路徑(相對 cwd)
            open({str(outside)!r}).read()                        # cwd 之外:不回報
            with open("out.txt", "w") as handle:                 # 寫檔:不回報
                handle.write("x")
            fd = os.open("out2.bin", os.O_WRONLY | os.O_CREAT)   # os.open 寫:不回報
            os.close(fd)
            fd = os.open("data/spec.json", os.O_RDONLY)          # os.open 讀:回報(已在清單內)
            os.close(fd)
            """,
        )
        code, _, err, message = self.worker.run(script, cwd=workdir)
        self.assertEqual(code, 0, err)
        self.assertEqual(message["reads"], ["data/spec.json", "helper_mod.py", "main.py"])
        # 下一個請求的清單是全新的,不帶上一個請求讀過的檔
        other = write(workdir / "other.py", "x = 1\n")
        _, _, _, message = self.worker.run(other, cwd=workdir)
        self.assertEqual(message["reads"], ["other.py"])

    def test_reads_of_a_real_build_include_the_generator(self) -> None:
        work = REPO / "tmp" / "worker-test" / f"reads-{os.getpid()}"
        shutil.copytree(REPO / "models" / "sheet_u_bracket", work, ignore=shutil.ignore_patterns("__pycache__", ".*"))
        try:
            gen = (work / "sheet_u_bracket.py").relative_to(REPO).as_posix()
            code, _, err, message = self.worker.run(STEP_CLI, [gen, "--force"])
            self.assertEqual(code, 0, err)
            self.assertIn(gen, message["reads"])
        finally:
            shutil.rmtree(work, ignore_errors=True)

    def test_ready_frame_reports_a_cadpy_content_digest(self) -> None:
        digest = self.worker.ready["versions"]["cadpy"]
        self.assertRegex(digest, r"^[0-9a-f]{16}$")

    def test_ready_frame_reports_determinism_is_on(self) -> None:
        """建置順序可重現(cadpy.kernel.determinism)在預熱時就裝好,而且是「全部裝上」。

        狀態進 versions → 進建置憑證的環境:開與關之下同一份輸入的面號可能不同,不能互相沿用。
        只裝上一部分(build123d 改版後某個模組讓開了)會是 "partial" 並帶警告,這條就會紅。
        """
        self.assertEqual(self.worker.ready["versions"]["determinism"], "on", self.worker.ready.get("warnings"))

    def test_tools_with_same_module_name_do_not_collide(self) -> None:
        """scripts/step 與 scripts/inspect 各有一個頂層 cli.py;常駐行程裡不能互相拿錯。"""
        for name in ("tool_a", "tool_b"):
            write(self.tmp / "tools" / name / "cli.py", f'def main():\n    print("{name}")\n    return 0\n')
            write(
                self.tmp / "tools" / name / "__main__.py",
                """
                import sys
                from pathlib import Path
                tool_dir = str(Path(__file__).resolve().parent)
                if tool_dir not in sys.path:
                    sys.path.insert(0, tool_dir)
                from cli import main
                if __name__ == "__main__":
                    raise SystemExit(main())
                """,
            )
        for name in ("tool_a", "tool_b", "tool_a"):
            code, out, err, _ = self.worker.run(self.tmp / "tools" / name)  # 目錄 = python <dir>
            self.assertEqual((code, out), (0, f"{name}\n"), err)

    def test_heavy_modules_stay_loaded(self) -> None:
        script = self.script(
            "warm.py",
            """
            import sys, time
            t = time.perf_counter()
            import build123d, cadpy.generation, cadpy.geometry_checks
            print(round(time.perf_counter() - t, 3))
            print("build123d" in sys.modules)
            """,
        )
        self.worker.run(script)
        _, out, _, _ = self.worker.run(script)
        seconds, loaded = out.split()
        self.assertEqual(loaded, "True")
        self.assertLess(float(seconds), 0.5, "重模組已在行程內,第二次 import 不該再花時間")


class WorkerGeometryTests(unittest.TestCase):
    """真的產生器:worker 與冷啟動結果相同,重複執行結果不變。"""

    @classmethod
    def setUpClass(cls) -> None:
        # scripts/step 以 cwd 為 repo 根解析路徑,工作副本要放在 repo 內(tmp/ 已 gitignore)。
        cls.work = REPO / "tmp" / "worker-test" / f"run-{os.getpid()}"
        cls.work.mkdir(parents=True, exist_ok=True)
        cls.worker = Worker()

    @classmethod
    def tearDownClass(cls) -> None:
        try:
            cls.worker.close()
        finally:
            shutil.rmtree(cls.work, ignore_errors=True)

    def copy_fixture(self, name: str, tag: str) -> Path:
        dst = self.work / tag / name
        shutil.copytree(REPO / "models" / name, dst, ignore=shutil.ignore_patterns("__pycache__", ".*", "*.step", "*.glb"))
        return dst / f"{name}.py"

    def cold(self, script, argv) -> subprocess.CompletedProcess:
        return subprocess.run(
            [sys.executable, str(script), *map(str, argv)],
            cwd=str(REPO), env=ENV, capture_output=True, encoding="utf-8", errors="replace",
        )

    def test_validate_matches_cold_and_is_repeatable(self) -> None:
        gen = "models/linear_stage/linear_stage.py"
        first = self.worker.run(VALIDATE, [gen])
        second = self.worker.run(VALIDATE, [gen])
        cold = self.cold(VALIDATE, [gen])
        self.assertEqual(first[0], 0, first[2])
        self.assertEqual(cold.returncode, 0, cold.stderr)
        self.assertEqual(last_json(first[1]), last_json(cold.stdout))
        self.assertEqual(last_json(first[1]), last_json(second[1]))
        self.assertTrue(last_json(first[1])["ok"])

    def test_validate_generator_error_matches_cold(self) -> None:
        bad = write(self.work / "bad" / "bad_gen.py", 'def gen_step():\n    raise ValueError("寬度必須大於 0")\n')
        warm = self.worker.run(VALIDATE, [bad])
        cold = self.cold(VALIDATE, [bad])
        self.assertEqual((warm[0], cold.returncode), (1, 1))
        self.assertEqual(last_json(warm[1]), last_json(cold.stdout))
        self.assertEqual(last_json(warm[1])["error"], "ValueError: 寬度必須大於 0")

    def test_step_build_matches_cold(self) -> None:
        warm_gen = self.copy_fixture("linear_stage", "warm")
        cold_gen = self.copy_fixture("linear_stage", "cold")
        warm = self.worker.run(STEP_CLI, [warm_gen.relative_to(REPO).as_posix(), "--force"])
        self.assertEqual(warm[0], 0, warm[2])
        cold = self.cold(STEP_CLI, [cold_gen.relative_to(REPO).as_posix(), "--force"])
        self.assertEqual(cold.returncode, 0, cold.stderr)
        for produced in ("linear_stage.step", ".linear_stage.step.glb", ".linear_stage.step.meta.json"):
            self.assertTrue((warm_gen.parent / produced).is_file(), produced)
        warm_meta = json.loads((warm_gen.parent / ".linear_stage.step.meta.json").read_text(encoding="utf-8"))
        cold_meta = json.loads((cold_gen.parent / ".linear_stage.step.meta.json").read_text(encoding="utf-8"))
        self.assertEqual(warm_meta, cold_meta)
        self.assertGreater(warm_meta["partCount"], 1)
        # 再建一次(同一個常駐行程):結果不變
        again = self.worker.run(STEP_CLI, [warm_gen.relative_to(REPO).as_posix(), "--force"])
        self.assertEqual(again[0], 0, again[2])
        self.assertEqual(
            json.loads((warm_gen.parent / ".linear_stage.step.meta.json").read_text(encoding="utf-8")), cold_meta
        )

    def test_step_build_failure_reports_generator_traceback(self) -> None:
        bad = write(
            self.work / "fail" / "fail_gen.py",
            """
            from build123d import Box

            def _check_params():
                raise ValueError("行程必須小於導軌長度")

            def gen_step():
                _check_params()
                return Box(1, 1, 1)
            """,
        )
        warm = self.worker.run(STEP_CLI, [bad.relative_to(REPO).as_posix(), "--force"])
        cold = self.cold(STEP_CLI, [bad.relative_to(REPO).as_posix(), "--force"])
        self.assertNotEqual(warm[0], 0)
        self.assertEqual(warm[0], cold.returncode)
        self.assertIn("ValueError: 行程必須小於導軌長度", warm[2])
        self.assertIn("fail_gen.py", warm[2])
        # 例外行(lessons 的 signature 與 condenseTraceback 都靠它)與冷啟動相同
        self.assertEqual(warm[2].strip().splitlines()[-1], cold.stderr.strip().splitlines()[-1])


class WorkerLifecycleTests(unittest.TestCase):
    def test_exits_on_stdin_eof_and_cleans_capture_dir(self) -> None:
        worker = Worker()
        capture_dir = Path(worker.ready["capture"]["err"]).parent
        self.assertTrue(capture_dir.is_dir())
        self.assertEqual(worker.close(), 0)
        self.assertFalse(capture_dir.exists())


if __name__ == "__main__":
    unittest.main(verbosity=2)
