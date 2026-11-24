// 常駐 CAD worker 池(Node 端 supervisor)。
//
// 每個 worker 是一個已載入 build123d / OCP / cadpy 的 Python 行程
// (py/cadchat_ext/worker/cad_worker.py),以 frame 協定(frames.mjs)收發請求。
// 池的工作:
//   - 可互換:任何閒置 worker 都能接任何請求;同一個 key(session)優先回到上次那個。
//   - 維持一個備用:有請求在跑時,另外保持一個已暖好的閒置 worker(上限 maxWorkers)。
//   - 從外部中止:kernel 呼叫無法從行程內打斷,所以 signal 中止一律殺掉 worker,
//     池再補一個新的。
//   - 依記憶體退休:請求結束時回報的常駐記憶體超過上限,就在請求之間換新。
//   - 程式碼改了就換新:fingerprint() 的值變了,舊 worker 不再接新請求。
//
// run() 的回傳與「起一個 Python 跑腳本」相同:{ code, stdout, stderr }。
// 回 null 表示池目前無法服務(起不來 / 已關閉),呼叫端應退回直接 spawn。
//
// 本檔不 import 專案內其他模組(行程啟動、砍行程、時鐘都可注入),方便單元測試。
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFrameDecoder, encodeFrame } from "./frames.mjs";

const STDERR_TAIL_CHARS = 64 * 1024;
const START_FAILURES_BEFORE_BACKOFF = 2;
const BACKOFF_MS = 60_000;
const RETIRE_GRACE_MS = 5_000;
const CAPTURE_DIR_PREFIX = "cadchat-worker-";

// 預設記憶體上限(MiB):實體記憶體的四分之一,至少 2 GiB。
export function defaultRssCapMb(totalBytes = os.totalmem()) {
  return Math.max(Math.floor(totalBytes / 2 ** 20 / 4), 2048);
}

function defaultKill(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* 已結束 */
  }
}

export function createWorkerPool({
  command,
  args = [],
  cwd,
  env,
  maxWorkers = 3,
  spare = true, // 有請求在跑時是否另外保持一個暖好的備用 worker
  idleMs = 15 * 60_000,
  rssCapMb = defaultRssCapMb(),
  startTimeoutMs = 180_000,
  fingerprint = null, // () => 任意可用 === 比較的值;null = 不檢查
  fingerprintEveryMs = 2_000,
  spawnFn = spawn,
  killFn = defaultKill,
  log = () => {},
  now = Date.now,
} = {}) {
  const workers = new Set(); // starting / idle / busy
  const retiring = new Set(); // 已不接請求、等它自己結束的
  const pending = []; // 尚未派到 worker 的請求(FIFO)
  let nextRequestId = 1;
  let nextWorkerId = 1;
  let closed = false;
  let spareWanted = false;
  let startFailures = 0;
  let disabledUntil = 0;
  let fpValue;
  let fpAt = -Infinity;

  // 砍 worker 並記下「這個行程已經沒救了」:砍行程是非同步的,行程真正消失前可能先
  // 收到它的 done frame;不標記的話它會回到閒置、被派到下一個請求後才死。
  // 外部(interrupt)直接砍行程時,由 killFn 的實作在 child 上標 cadKilled。
  const kill = (worker) => {
    worker.doomed = true;
    killFn(worker.child);
  };
  const isDoomed = (worker) => worker.doomed === true || worker.child?.cadKilled === true;

  const count = (state) => {
    let n = 0;
    for (const w of workers) if (w.state === state) n += 1;
    return n;
  };

  function currentFingerprint(force = false) {
    if (!fingerprint) return undefined;
    const t = now();
    if (force || t - fpAt >= fingerprintEveryMs) {
      try {
        fpValue = fingerprint();
      } catch (err) {
        log(`fingerprint 失敗:${err?.message || err}`);
      }
      fpAt = t;
    }
    return fpValue;
  }

  function readCapture(file) {
    if (!file) return "";
    try {
      return fs.readFileSync(file, "utf8");
    } catch {
      return "";
    }
  }

  // worker 異常結束時它來不及清自己的擷取暫存目錄;只刪名稱符合前綴的目錄。
  function removeCaptureDir(worker) {
    const file = worker.capture?.err || worker.capture?.out;
    if (!file) return;
    const dir = path.dirname(file);
    if (!path.basename(dir).startsWith(CAPTURE_DIR_PREFIX)) return;
    fs.rm(dir, { recursive: true, force: true }, () => {});
  }

  function settle(request, result) {
    if (request.settled) return;
    request.settled = true;
    request.signal?.removeEventListener?.("abort", request.onAbort);
    if (request.worker) {
      try {
        request.onRelease?.(request.worker.child);
      } catch {
        /* 呼叫端的簿記錯誤不影響結果 */
      }
    }
    request.resolve(result);
  }

  function clearTimers(worker) {
    clearTimeout(worker.startTimer);
    clearTimeout(worker.idleTimer);
    clearTimeout(worker.retireTimer);
    worker.startTimer = worker.idleTimer = worker.retireTimer = null;
  }

  function startWorker() {
    const worker = {
      id: nextWorkerId++,
      child: null,
      state: "starting",
      current: null,
      key: null,
      rssMb: null,
      retire: false,
      stderrTail: "",
      capture: null,
      fp: currentFingerprint(true),
      startedAt: now(),
      lastUsed: now(),
      startTimer: null,
      idleTimer: null,
      retireTimer: null,
    };
    let child;
    try {
      child = spawnFn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    } catch (err) {
      log(`worker 啟動失敗:${err?.message || err}`);
      noteStartFailure();
      return null;
    }
    worker.child = child;
    workers.add(worker);
    const decoder = createFrameDecoder(
      (message, payload) => onFrame(worker, message, payload),
      (err, text) => log(`worker#${worker.id} 送來無法解析的行:${String(text).slice(0, 120)}`),
    );
    child.stdout?.on("data", (chunk) => decoder.push(chunk));
    child.stderr?.on("data", (chunk) => {
      worker.stderrTail = (worker.stderrTail + chunk.toString("utf8")).slice(-STDERR_TAIL_CHARS);
    });
    child.stdin?.on("error", () => {}); // worker 已死時寫入會 EPIPE;結束事件會接手處理
    child.on("error", (err) => onExit(worker, -1, err));
    child.on("close", (code) => onExit(worker, code, null));
    worker.startTimer = setTimeout(() => {
      log(`worker#${worker.id} 啟動逾時(${startTimeoutMs} ms),終止`);
      kill(worker);
    }, startTimeoutMs);
    worker.startTimer.unref?.();
    return worker;
  }

  function noteStartFailure() {
    startFailures += 1;
    if (startFailures >= START_FAILURES_BEFORE_BACKOFF) {
      disabledUntil = now() + BACKOFF_MS;
      startFailures = 0;
      log(`worker 連續啟動失敗,暫停使用 ${BACKOFF_MS / 1000} 秒(期間改走一般啟動)`);
      // 沒有 worker 可等的請求全部交還呼叫端改走 spawn。
      if (workers.size === 0) {
        for (const request of pending.splice(0)) settle(request, null);
      }
    }
  }

  function onFrame(worker, message, payload) {
    if (worker.state === "starting") {
      if (message.ready === true) {
        clearTimeout(worker.startTimer);
        worker.startTimer = null;
        worker.state = "idle";
        worker.rssMb = message.rssMb ?? null;
        worker.capture = message.capture || null;
        worker.pid = message.pid ?? worker.child.pid;
        worker.lastUsed = now();
        startFailures = 0;
        for (const warning of message.warnings || []) log(`worker#${worker.id} 預載警告:${warning}`);
        log(`worker#${worker.id} 就緒(pid ${worker.pid},${message.bootMs} ms,${worker.rssMb} MiB)`);
        armIdle(worker);
        pump();
      } else if (message.ready === false) {
        log(`worker#${worker.id} 無法啟動:${message.error}`);
        kill(worker);
      }
      return;
    }
    const request = worker.current;
    if (!request || message.id !== request.id) return; // 過期或不認得的 frame
    if (message.done) {
      const outBytes = Number(message.outBytes) || 0;
      worker.rssMb = message.rssMb ?? worker.rssMb;
      finish(worker, {
        code: Number.isInteger(message.code) ? message.code : -1,
        stdout: payload.subarray(0, outBytes).toString("utf8"),
        stderr: payload.subarray(outBytes).toString("utf8"),
      });
    } else if (message.failed != null) {
      finish(worker, { code: -1, stdout: "", stderr: `[cad-worker] ${message.failed}` });
    }
  }

  function finish(worker, result) {
    const request = worker.current;
    worker.current = null;
    worker.lastUsed = now();
    settle(request, result);
    if (worker.state !== "busy") return; // 已在別處標為結束
    const overCap = rssCapMb > 0 && worker.rssMb != null && worker.rssMb > rssCapMb;
    if (overCap) log(`worker#${worker.id} 記憶體 ${worker.rssMb} MiB 超過上限 ${rssCapMb} MiB,退休`);
    if (overCap || worker.retire || isDoomed(worker)) {
      retire(worker);
    } else {
      worker.state = "idle";
      armIdle(worker);
    }
    pump();
  }

  function armIdle(worker) {
    clearTimeout(worker.idleTimer);
    if (!(idleMs > 0)) return;
    worker.idleTimer = setTimeout(() => {
      if (worker.state !== "idle") return;
      log(`worker#${worker.id} 閒置 ${Math.round(idleMs / 1000)} 秒,回收`);
      retire(worker);
      if (workers.size === 0) spareWanted = false; // 全部回收後,下次有請求或 prewarm 才再起
    }, idleMs);
    worker.idleTimer.unref?.();
  }

  // 讓 worker 不再接請求並結束:關 stdin(它讀到 EOF 會自己收尾),逾時才硬砍。
  function retire(worker) {
    if (worker.state === "dead" || worker.state === "retiring") return;
    clearTimers(worker);
    worker.state = "retiring";
    workers.delete(worker);
    retiring.add(worker);
    try {
      worker.child.stdin?.end();
    } catch {
      /* 已關 */
    }
    worker.retireTimer = setTimeout(() => killFn(worker.child), RETIRE_GRACE_MS);
    worker.retireTimer.unref?.();
  }

  function onExit(worker, code, error) {
    if (worker.state === "dead") return;
    const previous = worker.state;
    clearTimers(worker);
    worker.state = "dead";
    workers.delete(worker);
    retiring.delete(worker);
    const request = worker.current;
    worker.current = null;
    if (request) {
      // 請求進行中行程沒了:被中止(我們砍的)、被 interrupt 砍、或真的崩潰。
      // 輸出取自 worker 的擷取檔(到死前寫了多少算多少),與直接 spawn 被砍時相同。
      const stdout = readCapture(worker.capture?.out);
      let stderr = readCapture(worker.capture?.err);
      if (!request.aborted) {
        const tail = worker.stderrTail.trim();
        stderr += `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${tail ? `${tail}\n` : ""}[cad-worker] 行程在請求進行中結束(exit code ${code ?? "?"}${error ? `,${error.message || error}` : ""})`;
      }
      const exitCode = request.aborted ? 1 : Number.isInteger(code) && code !== 0 ? code : -1;
      settle(request, { code: exitCode, stdout, stderr });
    }
    if (previous !== "retiring" || request) removeCaptureDir(worker);
    if (previous === "starting") {
      log(`worker#${worker.id} 啟動階段結束(exit code ${code ?? "?"}${error ? `,${error.message || error}` : ""})${worker.stderrTail ? `:${worker.stderrTail.trim().slice(-400)}` : ""}`);
      noteStartFailure();
    }
    pump();
  }

  function pickIdle(key) {
    let unclaimed = null;
    let oldest = null;
    for (const worker of workers) {
      if (worker.state !== "idle" || isDoomed(worker)) continue;
      if (key != null && worker.key === key) return worker;
      if (worker.key == null && !unclaimed) unclaimed = worker;
      if (!oldest || worker.lastUsed < oldest.lastUsed) oldest = worker;
    }
    return unclaimed || oldest;
  }

  function assign(worker, request) {
    clearTimeout(worker.idleTimer);
    worker.idleTimer = null;
    worker.state = "busy";
    worker.current = request;
    if (request.key != null) worker.key = request.key;
    request.worker = worker;
    try {
      request.onAcquire?.(worker.child);
    } catch {
      /* 呼叫端的簿記錯誤不影響派送 */
    }
    if (request.aborted) {
      kill(worker);
      return;
    }
    try {
      worker.child.stdin.write(
        encodeFrame({ id: request.id, op: "run", script: request.script, argv: request.argv, cwd: request.cwd }),
      );
    } catch (err) {
      log(`worker#${worker.id} 寫入失敗:${err?.message || err}`);
      kill(worker);
    }
  }

  function retireStale() {
    const fp = currentFingerprint();
    if (fp === undefined) return;
    for (const worker of [...workers]) {
      if (worker.fp === fp) continue;
      if (worker.state === "idle") {
        log(`worker#${worker.id} 載入的程式碼已過期,換新`);
        retire(worker);
      } else {
        worker.retire = true; // 忙碌或啟動中:做完手上這件(或暖好)後換掉
      }
    }
  }

  function pump() {
    if (closed) return;
    retireStale();
    // 啟動中卻已知過期的不必等它暖好
    for (const worker of [...workers]) {
      if (worker.state === "idle" && worker.retire) retire(worker);
    }
    while (pending.length) {
      const worker = pickIdle(pending[0].key);
      if (!worker) break;
      assign(worker, pending.shift());
    }
    const starting = count("starting");
    let want = pending.length - starting;
    // 沒有排隊的請求時要不要多暖一個:spare 關閉時只在「一個 worker 都沒有」才起。
    if (pending.length === 0 && spareWanted && starting === 0 && count("idle") === 0) {
      want = spare || workers.size === 0 ? 1 : 0;
    }
    while (want > 0 && workers.size < maxWorkers && now() >= disabledUntil) {
      if (!startWorker()) break;
      want -= 1;
    }
    if (pending.length && workers.size === 0 && now() < disabledUntil) {
      for (const request of pending.splice(0)) settle(request, null);
    }
  }

  function run({ script, argv = [], cwd: requestCwd, key = null, signal, onAcquire, onRelease } = {}) {
    if (closed || now() < disabledUntil) return Promise.resolve(null);
    if (signal?.aborted) return Promise.resolve({ code: 1, stdout: "", stderr: "" });
    return new Promise((resolve) => {
      const request = {
        id: nextRequestId++,
        script,
        argv: argv.map(String),
        cwd: requestCwd,
        key,
        signal,
        onAcquire,
        onRelease,
        resolve,
        worker: null,
        aborted: false,
        settled: false,
        onAbort: null,
      };
      request.onAbort = () => {
        request.aborted = true;
        if (request.worker) {
          kill(request.worker); // 結果由行程結束事件送出
        } else {
          const index = pending.indexOf(request);
          if (index !== -1) pending.splice(index, 1);
          settle(request, { code: 1, stdout: "", stderr: "" });
        }
      };
      signal?.addEventListener?.("abort", request.onAbort);
      spareWanted = true;
      pending.push(request);
      pump();
    });
  }

  // 預先暖一個 worker(伺服器啟動、每個對話回合開始時呼叫);不等它就緒。
  function prewarm() {
    if (closed || now() < disabledUntil) return;
    spareWanted = true;
    pump();
  }

  // 關閉池:砍掉所有 worker,未完成的請求以失敗收尾。回傳的 Promise 在行程都結束
  // (或等待逾時)後完成。
  function dispose({ timeoutMs = 3_000 } = {}) {
    closed = true;
    for (const request of pending.splice(0)) settle(request, null);
    const all = [...workers, ...retiring];
    if (all.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      let left = all.length;
      const timer = setTimeout(resolve, timeoutMs);
      timer.unref?.();
      for (const worker of all) {
        clearTimers(worker);
        worker.child.once?.("close", () => {
          left -= 1;
          if (left === 0) {
            clearTimeout(timer);
            resolve();
          }
        });
        killFn(worker.child);
      }
    });
  }

  function stats() {
    return {
      closed,
      pending: pending.length,
      disabledForMs: Math.max(0, disabledUntil - now()),
      workers: [...workers, ...retiring].map((w) => ({
        id: w.id,
        pid: w.pid ?? w.child?.pid ?? null,
        state: w.state,
        key: w.key,
        rssMb: w.rssMb,
        ageMs: now() - w.startedAt,
      })),
    };
  }

  return { run, prewarm, dispose, stats };
}

// 目錄樹內所有 .py 的「最新修改時間 + 檔案數」,當作程式碼指紋。目錄不存在視為空。
export function pySourceFingerprint(dirs) {
  let newest = 0;
  let files = 0;
  const walk = (dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".py")) {
        try {
          const { mtimeMs } = fs.statSync(full);
          if (mtimeMs > newest) newest = mtimeMs;
          files += 1;
        } catch {
          /* 檔案剛被刪 */
        }
      }
    }
  };
  for (const dir of dirs) walk(dir);
  return `${files}:${newest}`;
}
