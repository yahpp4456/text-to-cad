// Electron 殼的 server 啟動器(ESM;由 main.cjs 動態 import)。
// 職責:算路徑 env(只餵路徑,絕不碰任何憑證——token/key 由 config.loadBakedEnv
// 在子進程內自行載入)→ utilityProcess.fork server → 等 ready 回實際 port/url。
import path from "node:path";
import { fileURLToPath } from "node:url";

const electronDir = path.dirname(fileURLToPath(import.meta.url)); // apps/cad-chat/electron
const APP_ROOT = path.resolve(electronDir, "..");

const READY_TIMEOUT_MS = 45_000; // 冷啟(Vite/GC/大 session 樹)餘裕

// 依打包狀態算 CADCHAT_* 路徑 env:
//   packaged → resources/runtime 佈局(extraResources 規約)+ userData 可寫根
//   dev      → 只設 CADCHAT_DEV=1(全部路徑走 config 的 import.meta.url 恆等式)
// CADCHAT_PORT=0 = 要求 OS 配臨時埠(entry.child 回報實際埠,無先挑再綁競態)。
export function computeRuntimeEnv({ isPackaged, resourcesPath, userDataDir }) {
  const env = { ...process.env, CADCHAT_PORT: "0" };
  if (isPackaged) {
    const rt = path.join(resourcesPath, "runtime");
    env.CADCHAT_RUNTIME_ROOT = rt;
    env.CADCHAT_DATA_ROOT = userDataDir;
    env.CADCHAT_PYTHON_EXE = path.join(rt, "python", "python.exe");
    env.CADCHAT_DIST_ROOT = path.join(rt, "dist");
  } else {
    env.CADCHAT_DEV = "1";
  }
  return env;
}

export async function launchServer({ app, utilityProcess }) {
  const env = computeRuntimeEnv({
    isPackaged: app.isPackaged,
    resourcesPath: process.resourcesPath,
    userDataDir: app.getPath("userData"),
  });
  const entry = path.join(APP_ROOT, "src", "server", "entry.child.mjs");
  const child = utilityProcess.fork(entry, [], {
    env,
    serviceName: "cadchat-server",
    stdio: "pipe",
  });
  // server log 轉發到 Electron 主控台(dev 除錯 / packaged 可攜 log)
  child.stdout?.on("data", (d) => process.stdout.write(d));
  child.stderr?.on("data", (d) => process.stderr.write(d));

  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`server 啟動逾時(${READY_TIMEOUT_MS / 1000}s)`)),
      READY_TIMEOUT_MS,
    );
    child.once("message", (msg) => {
      clearTimeout(timer);
      if (msg?.type === "ready") resolve(msg);
      else reject(new Error(msg?.message || "server 啟動失敗"));
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`server 提前退出(code ${code})`));
    });
  });
  return { url: ready.url, port: ready.port, child };
}
