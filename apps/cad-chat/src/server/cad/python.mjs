// Windows-aware Python 子程序 spawn helper(用 .venv 的 python,cwd=REPO_ROOT)。
import { spawn } from "node:child_process";
import os from "node:os";

import { PYTHON_EXE, REPO_ROOT, sandboxEnv } from "../config.mjs";

// ---------------------------------------------------------------------------
// 路徑消毒:把子程序輸出(Python traceback / JSON)裡的本機絕對路徑收斂成相對/
// 佔位符,避免在 UI 錯誤卡、LOG、回給 agent 的文字裡洩漏使用者的機器路徑。
// 例:C:\Users\Sam\Desktop\VS\text-to-cad\skills\cad\...\geometry_checks.py
//   → skills\cad\...\geometry_checks.py(仍看得出檔案/行號,只是不含使用者路徑)。
// 分隔符寫成 [\/]+ 以同時吃 traceback(單反斜線)與 JSON 字串(逸出的雙反斜線)。
// ---------------------------------------------------------------------------
function looseRootRe(p) {
  const segs = p
    .split(/[\\/]+/)
    .filter(Boolean)
    .map((s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  // 結尾錨定:根路徑之後必須是分隔符(吃掉)或非檔名字元——否則只是「前綴相同的
  // 兄弟路徑」(text-to-cad-main、C:\Users\Samantha),咬掉一段會產生指錯位置的
  // 毀損路徑,比洩漏更糟。檔名延續字元取 [\w.-](Windows 檔名常見集)。
  // 已知取捨:類別刻意不含空格/CJK/括號——含了會讓「路徑後接一般文句」(如
  // "cwd is C:\Users\Sam 已滿")整段漏掉不消毒;代價是 "text-to-cad (2)"、
  // "text-to-cad備份" 這類複本命名的兄弟目錄仍會被誤咬(罕見,接受)。
  return new RegExp(segs.join("[\\\\/]+") + "(?:[\\\\/]+|(?![\\w.-]))", "gi");
}
const REPO_RE = looseRootRe(REPO_ROOT);
const HOME_RE = looseRootRe(os.homedir());

// repo 根先收斂(它在 home 之下,必須先於 home 匹配),其餘 home 內路徑收成 ~/。
export function scrubPaths(text) {
  if (text == null) return text;
  return String(text).replace(REPO_RE, "").replace(HOME_RE, "~/");
}

// scriptDir 為 REPO_ROOT 相對路徑(如 "skills/cad/scripts/step"),以 `python <dir> ...` 執行。
export function spawnPython(scriptDir, args, { session, onLog, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_EXE, [scriptDir, ...args], {
      cwd: REPO_ROOT,
      // 強制 Python 子程序以 UTF-8 輸出(否則 Windows 預設 code page 會讓繁中亂碼)。
      env: { ...sandboxEnv(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
      windowsHide: true,
    });
    session?.childProcs?.add(child);

    // 原始累積(scrub 在 resolve 時對完整字串做,避免路徑跨 chunk 邊界漏網);
    // onLog 即時串流做逐 chunk best-effort scrub。
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      onLog?.(scrubPaths(s));
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      onLog?.(scrubPaths(s));
    });

    const onAbort = () => killTree(child);
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener("abort", onAbort);
    }

    const cleanup = () => {
      session?.childProcs?.delete(child);
      signal?.removeEventListener?.("abort", onAbort);
    };
    child.on("close", (code) => {
      cleanup();
      resolve({ code, stdout: scrubPaths(stdout), stderr: scrubPaths(stderr) });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ code: -1, stdout: scrubPaths(stdout), stderr: scrubPaths(`${stderr}\n${String(err)}`) });
    });
  });
}

// 殺整棵程序樹(Windows 用 taskkill /T,否則 SIGKILL)。
export function killTree(child) {
  if (!child || child.killed || child.exitCode != null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        windowsHide: true,
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill("SIGKILL");
  } catch {
    /* already gone */
  }
}

export { REPO_ROOT };
