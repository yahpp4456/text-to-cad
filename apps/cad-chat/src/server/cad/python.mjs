// Windows-aware Python 子程序 spawn helper(腳本絕對化到 RUNTIME_ROOT,cwd=DATA_ROOT)。
// dev 下 RUNTIME_ROOT === DATA_ROOT === repo root,行為與舊版(cwd=REPO_ROOT)一致。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { DATA_ROOT, PACKAGED, PYTHON_EXE, REPO_ROOT, RUNTIME_ROOT, sandboxEnv } from "../config.mjs";
import { createWorkerPool, defaultRssCapMb, pySourceFingerprint } from "./workerPool.mjs";

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
const REPO_RE = looseRootRe(RUNTIME_ROOT);
// packaged 雙根:可寫資料根(session 產物路徑)與唯讀程式根分離,兩者都要遮。
// dev 同根 → null(單根行為與舊版完全一致)。
const DATA_RE = DATA_ROOT === RUNTIME_ROOT ? null : looseRootRe(DATA_ROOT);
const HOME_RE = looseRootRe(os.homedir());

// 兩個根先收斂(常在 home 之下,必須先於 home 匹配),其餘 home 內路徑收成 ~/。
export function scrubPaths(text) {
  if (text == null) return text;
  let s = String(text).replace(REPO_RE, "");
  if (DATA_RE) s = s.replace(DATA_RE, "");
  return s.replace(HOME_RE, "~/");
}

// ---------------------------------------------------------------------------
// Python traceback → 一~兩行人讀摘要(tool card / notify 的 note 用;回 agent 的
// 完整 stderr 不經此函式——agent 修碼需要整段上下文)。輸入應已過 scrubPaths。
//   ① 由下而上抓最後例外行(chained exception 自然取最終例外);
//   ② 產生器檔內最深 frame(File "…<name>.py", line N, in fn → 取最後一個命中,
//      traceback 由外而內排列,最後命中即最深)。
// ValueError 且有訊息 = 產生器 _check_params 的繁中人話(見 prompt「參數防呆」)
// → 訊息直出不帶類名。全抓不到 → 原樣尾段 fallback(對齊舊 slice 行為)。
// 例外行 regex 準則同 lessons.mjs 的 EXC_LINE_RE/EXC_BARE_RE(不 import:lessons
// 已依賴本檔,反向引用成環;兩處若調整準則要一起改)。
// ---------------------------------------------------------------------------
const TB_EXC_RE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))\s*:\s*(.*)$/;
const TB_EXC_BARE_RE = /^([A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception))$/;
const TB_FRAME_RE = /^\s*File "([^"]+)", line (\d+), in (.+)$/;

export function condenseTraceback(stderr, { generatorName, maxLen = 300 } = {}) {
  const text = String(stderr || "").trim();
  if (!text) return "";
  const lines = text.split(/\r?\n/);

  let exc = null; // { cls, msg }
  for (let i = lines.length - 1; i >= 0; i--) {
    const t = lines[i].trim();
    const m = t.match(TB_EXC_RE) || t.match(TB_EXC_BARE_RE);
    if (m) {
      exc = { cls: m[1], msg: (m[2] || "").trim() };
      break;
    }
  }

  // 產生器檔內最深 frame;路徑正規化成 / 再比對(scrubPaths 後仍可能是反斜線)
  let frame = null;
  const gen = generatorName ? `${generatorName}.py` : null;
  if (gen) {
    for (const l of lines) {
      const m = l.match(TB_FRAME_RE);
      if (!m) continue;
      const p = m[1].replace(/\\/g, "/");
      if (p === gen || p.endsWith(`/${gen}`)) frame = m;
    }
  }

  if (!exc && !frame) return text.slice(-maxLen); // 非 traceback(spawn 錯誤等)

  const parts = [];
  if (exc) {
    const cls = exc.cls.split(".").pop(); // 完整限定名(OCP.OCP.Standard.X)取類名
    if (cls === "ValueError" && exc.msg) parts.push(exc.msg);
    else parts.push(exc.msg ? `${cls}: ${exc.msg}` : exc.cls);
  }
  if (frame) parts.push(`於 ${gen} 第 ${frame[2]} 行(${frame[3].trim()})`);
  return parts.join("\n").slice(0, maxLen * 2);
}

// 強制 Python 子程序以 UTF-8 輸出(否則 Windows 預設 code page 會讓繁中亂碼)。
// PYTHON_COLORS=0:server 若從帶 FORCE_COLOR 的終端啟動,Python 3.13+ 會吐
// ANSI 彩色 traceback——condenseTraceback 的行號 regex 抓不到、UI note 滿是
// 逃逸碼(PYTHON_COLORS 優先權高於 FORCE_COLOR/NO_COLOR,關這根就夠)。
function pythonEnv() {
  return { ...sandboxEnv(), PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8", PYTHON_COLORS: "0" };
}

// ---------------------------------------------------------------------------
// 常駐 worker(workerPool.mjs):載入 build123d 的腳本改在已暖好的行程裡執行,
// 省掉每次約 8.5 秒的 import。呼叫端看到的契約不變({code, stdout, stderr})。
//   CADCHAT_WORKER=0          全部退回每次 spawn(也是出問題時的開關)
//   CADCHAT_MAX_WORKERS       worker 上限(預設 3)
//   CADCHAT_WORKER_SPARE=0    不保持備用 worker(省一份約 400 MiB 的常駐記憶體)
//   CADCHAT_WORKER_IDLE_MS    閒置多久回收(預設 15 分鐘;0 = 不回收)
//   CADCHAT_WORKER_RSS_MB     記憶體退休上限(預設實體記憶體 1/4、至少 2048;0 = 不設限)
// ---------------------------------------------------------------------------
const WORKER_SCRIPT = path.resolve(RUNTIME_ROOT, "apps/cad-chat/py/cadchat_ext/worker/cad_worker.py");
// 走 worker 的腳本(RUNTIME_ROOT 相對、正斜線)。不在清單內的維持每次 spawn:
//   drawing_pdf.py  精確 HLR 可能以 0xC0000005 帶走整個行程,必須隔離
//   select_part.py / cable_check.py  不載入 OCP,冷啟動只要 0.2 秒
const WORKER_SCRIPTS = new Set([
  "skills/cad/scripts/step",
  "skills/cad/scripts/inspect",
  "skills/dxf/scripts/dxf",
  "apps/cad-chat/src/server/cad/validate.py",
  "apps/cad-chat/src/server/cad/flat_glb.py",
  "apps/cad-chat/src/server/cad/export_parts.py",
]);
// 開發時這些目錄的 .py 改了,就把已載入舊模組的 worker 換掉(打包版程式碼不會變,不檢查)。
const WORKER_WATCH_DIRS = [
  path.resolve(RUNTIME_ROOT, "skills/cad/scripts/packages"),
  path.resolve(RUNTIME_ROOT, "apps/cad-chat/py"),
];

function envInt(key, fallback) {
  const raw = String(process.env[key] ?? "").trim();
  if (!raw) return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

export function workerEligible(scriptAbs) {
  const rel = path.relative(RUNTIME_ROOT, scriptAbs).split(path.sep).join("/");
  return WORKER_SCRIPTS.has(rel);
}

let pool = null;
let workerScriptOk = null;

function workerEnabled() {
  if (process.env.CADCHAT_WORKER === "0") return false;
  if (workerScriptOk == null) workerScriptOk = fs.existsSync(WORKER_SCRIPT);
  return workerScriptOk;
}

function getPool() {
  if (!pool) {
    pool = createWorkerPool({
      command: PYTHON_EXE,
      args: [WORKER_SCRIPT],
      cwd: DATA_ROOT,
      env: pythonEnv(),
      maxWorkers: Math.max(1, envInt("CADCHAT_MAX_WORKERS", 3)),
      spare: process.env.CADCHAT_WORKER_SPARE !== "0",
      idleMs: envInt("CADCHAT_WORKER_IDLE_MS", 15 * 60_000),
      rssCapMb: envInt("CADCHAT_WORKER_RSS_MB", defaultRssCapMb()),
      fingerprint: PACKAGED ? null : () => pySourceFingerprint(WORKER_WATCH_DIRS),
      killFn: killTree,
      log: (line) => console.log(`[cad-chat] ${scrubPaths(line)}`),
    });
  }
  return pool;
}

// 預先暖一個 worker(伺服器啟動、對話回合開始時呼叫);立即返回,不等它就緒。
export function prewarmPython() {
  if (workerEnabled()) getPool().prewarm();
}

// 伺服器關閉時呼叫:砍掉所有 worker。之後若再有請求會重新建池。
export async function disposePython() {
  const closing = pool;
  pool = null;
  if (closing) await closing.dispose();
}

export function pythonWorkerStats() {
  return pool ? pool.stats() : null;
}

// 目前 worker 的 kernel 版本({python, build123d, ocp});還沒有 worker 就緒過(或已停用)回 null。
export function pythonKernelVersions() {
  return pool ? pool.versions() : null;
}

// 會影響建模結果的第一方 Python 程式所在目錄(cadpy 複本、cad-chat 自己的 Python、入口腳本)。
export const PYTHON_CODE_DIRS = [
  ...WORKER_WATCH_DIRS,
  path.resolve(RUNTIME_ROOT, "apps/cad-chat/src/server/cad"),
  path.resolve(RUNTIME_ROOT, "skills/cad/scripts/step"),
  path.resolve(RUNTIME_ROOT, "skills/cad/scripts/inspect"),
  path.resolve(RUNTIME_ROOT, "skills/dxf/scripts/dxf"),
];

// scriptDir 為 RUNTIME_ROOT 相對路徑(如 "skills/cad/scripts/step"),以 `python <dir> ...`
// 執行。腳本在這裡統一絕對化(唯讀程式資產根);cwd=DATA_ROOT(可寫資料根)是產物
// 相對路徑的基準——打包後兩根分離,cwd 只能當產物基準,腳本必須走絕對路徑。
// 永不 reject;回 {code, stdout, stderr}。
export async function spawnPython(scriptDir, args, { session, onLog, signal } = {}) {
  const scriptAbs = path.isAbsolute(scriptDir)
    ? scriptDir
    : path.resolve(RUNTIME_ROOT, scriptDir);
  if (workerEnabled() && workerEligible(scriptAbs)) {
    const result = await getPool().run({
      script: scriptAbs,
      argv: args,
      cwd: DATA_ROOT,
      key: session ? `${session.user || ""}\n${session.sessionId}` : null,
      signal,
      // 進行中的 worker 行程記在 session 上:interrupt 砍得到、sessionsBusy 看得到。
      onAcquire: (child) => session?.childProcs?.add(child),
      onRelease: (child) => session?.childProcs?.delete(child),
    });
    if (result) {
      const stdout = scrubPaths(result.stdout);
      const stderr = scrubPaths(result.stderr);
      if (stdout) onLog?.(stdout);
      if (stderr) onLog?.(stderr);
      // reads / versions 只有 worker 路徑有:腳本讀了哪些檔(相對 DATA_ROOT)與 kernel 版本,
      // 給 cad/closure.mjs 判斷「輸入沒變就不重建」。直接 spawn 的結果沒有這兩欄。
      return { code: result.code, stdout, stderr, reads: result.reads, versions: result.versions };
    }
    // null = 池目前無法服務(起不來 / 正在關閉)→ 照舊每次 spawn
  }
  return spawnCold(scriptAbs, args, { session, onLog, signal });
}

function spawnCold(scriptAbs, args, { session, onLog, signal } = {}) {
  return new Promise((resolve) => {
    const child = spawn(PYTHON_EXE, [scriptAbs, ...args], {
      cwd: DATA_ROOT,
      env: pythonEnv(),
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
  // 給 worker 池看的記號:taskkill 是非同步的,這個行程在真正消失前不可再接請求。
  child.cadKilled = true;
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
