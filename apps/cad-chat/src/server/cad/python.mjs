// Windows-aware Python 子程序 spawn helper(用 .venv 的 python,cwd=REPO_ROOT)。
import { spawn } from "node:child_process";

import { PYTHON_EXE, REPO_ROOT, sandboxEnv } from "../config.mjs";

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

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => {
      const s = d.toString();
      stdout += s;
      onLog?.(s);
    });
    child.stderr.on("data", (d) => {
      const s = d.toString();
      stderr += s;
      onLog?.(s);
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
      resolve({ code, stdout, stderr });
    });
    child.on("error", (err) => {
      cleanup();
      resolve({ code: -1, stdout, stderr: `${stderr}\n${String(err)}` });
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
