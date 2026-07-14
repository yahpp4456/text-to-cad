// Electron utilityProcess.fork 目標:起 server 後把實際 port/url 用 parentPort 回報。
// launch.mjs 慣例:CADCHAT_PORT=0 → OS 配臨時埠(startServer 回傳實際埠)。
// 失敗誠實回報再退出(fail loud;Electron main 據此顯示錯誤而非白畫面)。
import { startServer } from "./start.mjs";

const dev = process.env.CADCHAT_DEV === "1";
const raw = String(process.env.CADCHAT_PORT ?? "").trim();
const parsed = raw === "" ? NaN : Number.parseInt(raw, 10);

try {
  const { port, url } = await startServer({
    dev,
    port: Number.isFinite(parsed) ? parsed : undefined,
  });
  process.parentPort?.postMessage({ type: "ready", port, url });
} catch (err) {
  process.parentPort?.postMessage({ type: "error", message: String(err?.message || err) });
  process.exit(1);
}
