#!/usr/bin/env python
"""cad-chat 常駐 CAD worker。

Node 伺服器(``src/server/cad/workerPool.mjs``)啟動本行程一次,之後每個請求都在這個
已載入 build123d / OCP / cadpy 的行程裡執行,省掉每次約 8.5 秒的 import 成本。

協定(``frames.py``):stdin 進、原本的 stdout 出,一行 JSON + 可選位元組。

    -> {"id": 1, "op": "run", "script": "<絕對路徑>", "argv": [...], "cwd": "<絕對路徑>"}
    <- {"id": 1, "done": true, "code": 0, "ms": 812, "rssMb": 512.3, "outBytes": 120,
        "reads": ["models/x/x.py", ...], "bytes": 340}
       其後 340 個位元組 = stdout(前 120)+ stderr(其餘)
       reads = 請求期間以「讀」開啟、且位於 cwd 之下的檔案(相對 cwd)
    -> {"id": 2, "op": "ping"}
    <- {"id": 2, "done": true, "rssMb": 512.3}
    -> {"op": "exit"}      # 或 stdin EOF:自行結束

``run`` 的語意等同 ``python <script> <argv...>``:腳本以 ``__main__`` 執行,exit code 與
寫到 fd 1 / fd 2 的所有輸出(含 OCCT 的 C 層輸出)原樣回傳。所以既有入口腳本
(scripts/step、scripts/inspect、validate.py…)不必修改。

每次請求之間會還原的狀態:``sys.path``、``sys.argv``、``os.environ``、工作目錄,以及
請求期間新載入、且不屬於直譯器安裝目錄或 cadpy 的模組(產生器、同目錄零件模組、
各工具自己的 ``cli`` 模組)。請求之間因此不會互相看到對方的程式碼。

本檔只用標準函式庫(重模組在 ``_prewarm`` 裡才載入)。
"""

from __future__ import annotations

import gc
import importlib
import os
import runpy
import shutil
import sys
import tempfile
import time
import traceback
from pathlib import Path

_BOOT_T0 = time.perf_counter()
_HERE = Path(__file__).resolve()
_PY_ROOT = _HERE.parents[2]  # apps/cad-chat/py

# 以腳本方式啟動時 sys.path[0] 是本檔所在目錄;把它換成 py/ 根,避免 worker/ 內的檔名
# (frames.py)以頂層模組名外洩給之後執行的腳本。
sys.path[:] = [p for p in sys.path if p and Path(p).resolve() != _HERE.parent]
if str(_PY_ROOT) not in sys.path:
    sys.path.insert(0, str(_PY_ROOT))

from cadchat_ext.worker import frames  # noqa: E402

# 請求之間保留在 sys.modules 的第一方套件(其餘第一方模組每次請求後清掉)。
_KEEP_TOP = {"cadpy", "cadpy_metadata", "cadchat_ext"}

# 啟動時預先載入的模組。前兩個失敗視為致命(之後每個腳本都會失敗),其餘只記警告。
_PREWARM_FATAL = ("build123d", "cadpy")
_PREWARM = (
    "OCP.TopoDS",
    "cadpy.generation",
    "cadpy.step_scene",
    "cadpy.step_export",
    "cadpy.step_artifacts",
    "cadpy.glb",
    "cadpy.geometry_checks",
    "cadpy.motion_decl",
    "cadpy.analysis",
    "cadpy.lookup",
    "cadpy.parts",
    "ezdxf",
)


def _norm(path: str) -> str:
    return os.path.normcase(os.path.realpath(path))


_KEEP_ROOTS = tuple(
    sorted({_norm(p) for p in (sys.prefix, sys.base_prefix, sys.exec_prefix, sys.base_exec_prefix) if p})
)


def _under_keep_root(file: str) -> bool:
    try:
        norm = _norm(file)
    except (OSError, ValueError):
        return True
    return any(norm == root or norm.startswith(root + os.sep) for root in _KEEP_ROOTS)


def resident_mb() -> float | None:
    """本行程目前佔用的實體記憶體(MiB);量不到回 None。"""
    try:
        if sys.platform == "win32":
            import ctypes
            from ctypes import wintypes

            class _Counters(ctypes.Structure):
                _fields_ = [
                    ("cb", wintypes.DWORD),
                    ("PageFaultCount", wintypes.DWORD),
                    ("PeakWorkingSetSize", ctypes.c_size_t),
                    ("WorkingSetSize", ctypes.c_size_t),
                    ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                    ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                    ("PagefileUsage", ctypes.c_size_t),
                    ("PeakPagefileUsage", ctypes.c_size_t),
                ]

            kernel32 = ctypes.WinDLL("kernel32")
            psapi = ctypes.WinDLL("psapi")
            # GetCurrentProcess 回傳 -1 假 handle;不指定 restype 會被截成 32 位元。
            kernel32.GetCurrentProcess.restype = wintypes.HANDLE
            psapi.GetProcessMemoryInfo.argtypes = [wintypes.HANDLE, ctypes.POINTER(_Counters), wintypes.DWORD]
            psapi.GetProcessMemoryInfo.restype = wintypes.BOOL
            counters = _Counters()
            counters.cb = ctypes.sizeof(_Counters)
            if psapi.GetProcessMemoryInfo(kernel32.GetCurrentProcess(), ctypes.byref(counters), counters.cb):
                return round(counters.WorkingSetSize / 2**20, 1)
            return None
        if sys.platform.startswith("linux"):
            with open("/proc/self/statm", encoding="ascii") as handle:
                pages = int(handle.read().split()[1])
            return round(pages * os.sysconf("SC_PAGE_SIZE") / 2**20, 1)
        import resource

        peak = resource.getrusage(resource.RUSAGE_SELF).ru_maxrss
        return round(peak / (2**20 if sys.platform == "darwin" else 2**10), 1)
    except Exception:  # noqa: BLE001 - 量測失敗不能影響請求
        return None


class _Channels:
    """協定通道與每次請求的輸出擷取。

    啟動時把原本的 stdin / stdout 留給協定,fd 0 改接空裝置、fd 1 改接 stderr。請求期間
    fd 1 / fd 2 改接到兩個暫存檔,結束後讀回——在 fd 層擷取,Python 與 C 層(OCCT)寫的
    都收得到,也沒有「done frame 比 stderr 管線先到」的競態。
    """

    def __init__(self) -> None:
        sys.stdout.flush()
        sys.stderr.flush()
        proto_in_fd = os.dup(0)
        proto_out_fd = os.dup(1)
        self._idle_fd = os.dup(2)
        self._binary(proto_in_fd, proto_out_fd, self._idle_fd)

        null_fd = os.open(os.devnull, os.O_RDONLY)
        os.dup2(null_fd, 0)
        os.close(null_fd)
        os.dup2(self._idle_fd, 1)
        self._binary(1, 2)

        self.proto_in = os.fdopen(proto_in_fd, "rb")
        self.proto_out = os.fdopen(proto_out_fd, "wb")
        sys.stdin = open(0, "r", encoding="utf-8", errors="replace", closefd=False)  # noqa: SIM115
        sys.stdout = open(1, "w", encoding="utf-8", errors="backslashreplace", closefd=False)  # noqa: SIM115
        sys.stderr = open(2, "w", encoding="utf-8", errors="backslashreplace", closefd=False, buffering=1)  # noqa: SIM115
        sys.__stdin__, sys.__stdout__, sys.__stderr__ = sys.stdin, sys.stdout, sys.stderr

        self.tmpdir = tempfile.mkdtemp(prefix="cadchat-worker-")
        self.out_path = os.path.join(self.tmpdir, "stdout.bin")
        self.err_path = os.path.join(self.tmpdir, "stderr.bin")
        flags = os.O_RDWR | os.O_CREAT | os.O_TRUNC | getattr(os, "O_BINARY", 0)
        self._out_fd = os.open(self.out_path, flags)
        self._err_fd = os.open(self.err_path, flags)

    @staticmethod
    def _binary(*fds: int) -> None:
        if os.name != "nt":
            return
        import msvcrt

        for fd in fds:
            try:
                msvcrt.setmode(fd, os.O_BINARY)
            except OSError:
                pass

    @staticmethod
    def _flush_all() -> None:
        for stream in (sys.stdout, sys.stderr):
            try:
                stream.flush()
            except Exception:  # noqa: BLE001
                pass
        # C 執行期自己的緩衝(OCCT 的 printf / iostream)也要沖掉,否則會落到下一個請求。
        try:
            import ctypes

            if os.name == "nt":
                ctypes.CDLL("ucrtbase").fflush(None)
            else:
                ctypes.CDLL(None).fflush(None)
        except Exception:  # noqa: BLE001
            pass

    def begin(self) -> None:
        self._flush_all()
        for fd in (self._out_fd, self._err_fd):
            os.lseek(fd, 0, os.SEEK_SET)
            os.ftruncate(fd, 0)
        os.dup2(self._out_fd, 1)
        os.dup2(self._err_fd, 2)
        self._binary(1, 2)

    def end(self) -> tuple[bytes, bytes]:
        self._flush_all()
        os.dup2(self._idle_fd, 1)
        os.dup2(self._idle_fd, 2)
        self._binary(1, 2)
        return self._read(self._out_fd), self._read(self._err_fd)

    @staticmethod
    def _read(fd: int) -> bytes:
        os.lseek(fd, 0, os.SEEK_SET)
        chunks = []
        while True:
            chunk = os.read(fd, 1 << 20)
            if not chunk:
                break
            chunks.append(chunk)
        return b"".join(chunks)

    def send(self, message: dict, payload: bytes = b"") -> None:
        frames.write(self.proto_out, message, payload)

    def close(self) -> None:
        for fd in (self._out_fd, self._err_fd):
            try:
                os.close(fd)
            except OSError:
                pass
        shutil.rmtree(self.tmpdir, ignore_errors=True)


def _prewarm() -> tuple[str | None, list[str], dict[str, str | None]]:
    """載入重模組。回 (致命錯誤, 警告清單, 版本)。"""
    warnings: list[str] = []
    for name in _PREWARM_FATAL:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001
            return f"{name}: {type(exc).__name__}: {exc}", warnings, {}
    for name in _PREWARM:
        try:
            importlib.import_module(name)
        except Exception as exc:  # noqa: BLE001
            warnings.append(f"{name}: {type(exc).__name__}: {exc}")
    try:
        # 真的跑一次 kernel:第一次建構會載入一批 DLL 並初始化 OCCT。
        from build123d import Box

        Box(1, 1, 1).volume  # noqa: B018
    except Exception as exc:  # noqa: BLE001
        warnings.append(f"kernel: {type(exc).__name__}: {exc}")

    versions: dict[str, str | None] = {"python": sys.version.split()[0]}
    try:
        # 建置順序可重現(cadpy.kernel.determinism):在任何產生器執行前裝好。狀態進 versions,
        # 所以開關它會讓建置憑證失效——同一份輸入在開與關之下,面的編號可能不同。
        from cadpy.kernel import determinism

        determinism.ensure_installed()
        state = determinism.installed()
        full = state["installed"] and state["vertexHash"] and len(state["modules"]) == len(determinism._SHADOWED_MODULES)
        versions["determinism"] = "on" if full else ("partial" if state["installed"] else "off")
        if versions["determinism"] == "partial":
            warnings.append(f"determinism: 只裝上一部分 {state}")
    except Exception as exc:  # noqa: BLE001
        versions["determinism"] = "off"
        warnings.append(f"determinism: {type(exc).__name__}: {exc}")
    try:
        from importlib import metadata

        versions["build123d"] = metadata.version("build123d")
    except Exception:  # noqa: BLE001
        versions["build123d"] = None
    try:
        import OCP

        versions["ocp"] = getattr(OCP, "__version__", None)
    except Exception:  # noqa: BLE001
        versions["ocp"] = None
    # 實際載入的那份 cadpy 的內容摘要:開發時是 vendored 複本、非 editable 安裝時是 site-packages 裡的
    # wheel,位置不同,所以由載入它的行程自己算最準。cadpy 一改,舊的建置憑證全部失效。
    versions["cadpy"] = _package_digest("cadpy")
    return None, warnings, versions


def _package_digest(name: str) -> str | None:
    """已載入套件的原始碼與資料檔內容摘要(sha256 前 16 位);算不出來回 None。"""
    import hashlib

    module = sys.modules.get(name)
    file = getattr(module, "__file__", None)
    if not file:
        return None
    root = Path(file).resolve().parent
    digest = hashlib.sha256()
    try:
        files = sorted(p for p in root.rglob("*") if p.suffix in (".py", ".json") and "__pycache__" not in p.parts)
        for path in files:
            digest.update(path.relative_to(root).as_posix().encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
    except OSError:
        return None
    return digest.hexdigest()[:16]


def _watch_dirs() -> list[str]:
    """Node 端用來判斷「程式碼改了、該換新 worker」的目錄:本行程常駐持有的第一方套件。"""
    dirs = []
    for name in sorted(_KEEP_TOP):
        module = sys.modules.get(name)
        file = getattr(module, "__file__", None)
        if file:
            dirs.append(str(Path(file).resolve().parent))
    return dirs


# ---------------------------------------------------------------------------
# 讀檔紀錄:請求期間 Python 層以「讀」開啟的檔案,隨結果回傳給 Node。Node 用它判斷
# 「這次 build 的輸入是哪些檔」,之後輸入沒變就不必重建(cad/closure.mjs)。
# 只看得到 Python 層的 open(含 import 載入原始碼);OCCT 在 C++ 裡自己開的檔
# (例如 import_step 讀 STEP)看不到,那一類由 Node 端另外補(整個 imported/ 都算輸入)。
# ---------------------------------------------------------------------------
_READS_CAP = 2000
_reads: set[str] | None = None  # None = 目前不記錄
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_APPEND | os.O_CREAT | os.O_TRUNC


def _audit(event: str, args: tuple) -> None:
    # 每個稽核事件都會進來,先擋掉不相干的再做事。
    if event != "open" or _reads is None or len(_reads) >= _READS_CAP:
        return
    try:
        path, mode, flags = args[0], args[1], args[2]
        if isinstance(mode, str):
            if any(ch in mode for ch in "wax+"):
                return
        elif isinstance(flags, int) and flags & _WRITE_FLAGS:
            return
        if isinstance(path, bytes):
            path = os.fsdecode(path)
        elif not isinstance(path, str):
            path = os.fspath(path)  # 整數 fd 會在這裡丟 TypeError,下面接住
        # 當下就轉成絕對路徑:相對路徑是相對「開檔那一刻」的工作目錄,請求結束後工作目錄
        # 已經還原,到那時才解析會指到別的地方。
        _reads.add(os.path.abspath(path))
    except Exception:  # noqa: BLE001 - 稽核 hook 絕不能讓被稽核的操作失敗
        return


def _reads_under(root: str) -> list[str]:
    """本次請求讀過、且位於 ``root`` 之下的檔案(相對 ``root``、正斜線、已排序)。"""
    if not _reads:
        return []
    base = _norm(root)
    found = set()
    for raw in _reads:
        try:
            full = os.path.abspath(raw)
            norm = os.path.normcase(full)
        except (OSError, ValueError):
            continue
        if not norm.startswith(base + os.sep) or "__pycache__" in norm:
            continue
        found.add(os.path.relpath(full, root).replace(os.sep, "/"))
    return sorted(found)


def _exit_code(code: object) -> int:
    if code is None:
        return 0
    if isinstance(code, int):
        return code
    print(code, file=sys.stderr)
    return 1


def _print_traceback(exc: BaseException) -> None:
    """印出與 ``python script.py`` 相同的 traceback:略過 worker 與 runpy 自己的 frame。"""
    own = _norm(__file__)
    tb = exc.__traceback__
    while tb is not None:
        frame = tb.tb_frame
        # runpy 是凍結模組,檔名是 "<frozen runpy>",只能用模組名認。
        if frame.f_globals.get("__name__") != "runpy" and _norm(frame.f_code.co_filename) != own:
            break
        tb = tb.tb_next
    traceback.print_exception(type(exc), exc, tb)


def _purge_modules(before: set[str]) -> None:
    for name in list(sys.modules):
        if name in before or name.partition(".")[0] in _KEEP_TOP:
            continue
        module = sys.modules.get(name)
        file = getattr(module, "__file__", None)
        if file is None:
            # 沒有檔案的:內建/凍結模組保留;命名空間套件(工作目錄的資料夾)清掉。
            if not hasattr(module, "__path__"):
                continue
        elif _under_keep_root(file):
            continue
        del sys.modules[name]


def run_script(script: str, argv: list[str], cwd: str | None) -> int:
    """以 ``python <script> <argv...>`` 的語意執行腳本,回 exit code。"""
    saved_path = list(sys.path)
    saved_argv = sys.argv
    saved_env = dict(os.environ)
    saved_cwd = os.getcwd()
    before = set(sys.modules)
    code = 0
    try:
        if cwd:
            os.chdir(cwd)
        importlib.invalidate_caches()
        sys.argv = [script, *argv]
        if os.path.isfile(script):
            # runpy 對「檔案」不會像直譯器那樣把腳本目錄放進 sys.path[0];補上。
            sys.path.insert(0, os.path.dirname(os.path.abspath(script)))
        runpy.run_path(script, run_name="__main__")
    except SystemExit as exc:
        code = _exit_code(exc.code)
    except BaseException as exc:  # noqa: BLE001 - 等同直譯器對未捕捉例外的處理
        _print_traceback(exc)
        code = 1
    finally:
        sys.argv = saved_argv
        sys.path[:] = saved_path
        os.environ.clear()
        os.environ.update(saved_env)
        try:
            os.chdir(saved_cwd)
        except OSError:
            pass
        _purge_modules(before)
    return code


def main() -> int:
    channels = _Channels()
    try:
        import faulthandler

        faulthandler.enable()  # 寫到 fd 2:請求期間即擷取檔,崩潰時 Node 讀得到
    except Exception:  # noqa: BLE001
        pass

    fatal, warnings, versions = _prewarm()
    if fatal is not None:
        channels.send({"ready": False, "error": fatal})
        channels.close()
        return 3

    sys.addaudithook(_audit)  # 裝一次(稽核 hook 無法移除);平常 _reads 是 None,幾乎零成本

    # 重模組載入完才關掉 .pyc:之後載入的都是產生器與工具腳本。滑桿在同一秒內重寫同長度
    # 的 .py 時,.pyc 以「秒級 mtime + 檔案大小」判斷新舊會拿到舊碼;冷啟動時每次間隔
    # 都超過一秒所以沒事,常駐後必須避開。指到空目錄 = 一律由原始碼編譯。
    sys.dont_write_bytecode = True
    sys.pycache_prefix = os.path.join(channels.tmpdir, "pyc")

    # 預熱留下的幾十萬個物件(模組、類別、函式)會活到行程結束。凍結後,每次請求結束的
    # gc.collect() 只掃該請求新產生的物件;不凍結的話每次都要把它們全部走一遍
    # (實測 125–160 ms,而且是算在「下一個請求」的等待時間裡)。
    gc.collect()
    gc.freeze()

    channels.send(
        {
            "ready": True,
            "pid": os.getpid(),
            "rssMb": resident_mb(),
            "bootMs": round((time.perf_counter() - _BOOT_T0) * 1000),
            "watch": _watch_dirs(),
            "capture": {"out": channels.out_path, "err": channels.err_path},
            "versions": versions,
            "warnings": warnings,
        }
    )

    while True:
        try:
            got = frames.read(channels.proto_in)
        except (EOFError, ValueError, OSError):
            break
        if got is None:
            break
        message, _payload = got
        op = message.get("op")
        request_id = message.get("id")
        try:
            if op == "exit":
                break
            if op == "ping":
                channels.send({"id": request_id, "done": True, "rssMb": resident_mb()})
            elif op == "run":
                global _reads
                started = time.perf_counter()
                request_cwd = message.get("cwd") or None
                channels.begin()
                _reads = set()
                try:
                    code = run_script(
                        str(message["script"]),
                        [str(a) for a in message.get("argv") or []],
                        request_cwd,
                    )
                finally:
                    reads = _reads_under(request_cwd or os.getcwd())
                    _reads = None
                    out, err = channels.end()
                channels.send(
                    {
                        "id": request_id,
                        "done": True,
                        "code": code,
                        "ms": round((time.perf_counter() - started) * 1000),
                        "rssMb": resident_mb(),
                        "outBytes": len(out),
                        "reads": reads,
                    },
                    out + err,
                )
                gc.collect()
            else:
                channels.send({"id": request_id, "failed": f"unknown op: {op!r}"})
        except (BrokenPipeError, OSError):
            break  # 協定通道斷了(父行程已死)
        except Exception as exc:  # noqa: BLE001 - 單一請求的處理錯誤不拖垮 worker
            try:
                channels.send({"id": request_id, "failed": f"{type(exc).__name__}: {exc}", **frames.failed_type(exc)})
            except Exception:  # noqa: BLE001
                break

    channels.close()
    return 0


if __name__ == "__main__":
    # os._exit:跳過直譯器收尾。OCCT 物件在收尾階段解構偶爾很慢,worker 結束不需要它。
    code = main()
    try:
        sys.stdout.flush()
        sys.stderr.flush()
    finally:
        os._exit(code)
