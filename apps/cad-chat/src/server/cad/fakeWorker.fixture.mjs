// workerPool.test.js 用的假 worker:講同一套 frame 協定,但不載入 Python / kernel。
// 行為由環境變數(啟動階段)與請求的 script 欄位(請求階段)控制:
//   FAKE_BOOT=exit      啟動後直接以 exit code 3 結束(模擬直譯器壞掉)
//   FAKE_BOOT=refuse    送出 {"ready": false}(模擬預載失敗)
//   FAKE_BOOT=never     永遠不送 ready(模擬啟動卡住)
//   script "echo"        回 code 0,stdout = "<pid> <argv…>",stderr = "err <cwd>"
//   script "sleep:<ms>"  等 <ms> 毫秒後同 echo
//   script "exit:<n>"    回 code n
//   script "rss:<mb>"    同 echo,但回報 rssMb = <mb>
//   script "fail"        回 {"failed": "boom"}
//   script "crash:<n>"   先在擷取檔寫幾個字,然後行程以 exit code n 結束(不回應)
//   script "hang"        永遠不回應
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { createFrameDecoder, encodeFrame } from "./frames.mjs";

const boot = process.env.FAKE_BOOT || "";
if (boot === "exit") process.exit(3);

const send = (message, payload) => process.stdout.write(encodeFrame(message, payload));

process.stdout.write("fake worker banner(不是 frame,解碼器要略過)\n");
if (boot === "refuse") {
  send({ ready: false, error: "refused by FAKE_BOOT" });
} else if (boot !== "never") {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cadchat-worker-"));
  const capture = { out: path.join(dir, "stdout.bin"), err: path.join(dir, "stderr.bin") };
  fs.writeFileSync(capture.out, "");
  fs.writeFileSync(capture.err, "");
  process.on("exit", () => {
    if (!process.exitCode) fs.rmSync(dir, { recursive: true, force: true });
  });
  send({ ready: true, pid: process.pid, rssMb: 10, bootMs: 1, capture, warnings: [] });

  const decoder = createFrameDecoder((message) => {
    if (message.op === "exit") process.exit(0);
    if (message.op === "ping") return send({ id: message.id, done: true, rssMb: 10 });
    const [kind, value] = String(message.script).split(":");
    const reply = (extra = {}) => {
      const out = Buffer.from(`${process.pid} ${(message.argv || []).join(" ")}`.trimEnd(), "utf8");
      const err = Buffer.from(`err ${message.cwd ?? ""}`, "utf8");
      send(
        { id: message.id, done: true, code: 0, ms: 1, rssMb: 10, outBytes: out.length, ...extra },
        Buffer.concat([out, err]),
      );
    };
    if (kind === "echo") reply();
    else if (kind === "sleep") setTimeout(reply, Number(value));
    else if (kind === "exit") reply({ code: Number(value) });
    else if (kind === "rss") reply({ rssMb: Number(value) });
    else if (kind === "fail") send({ id: message.id, failed: "boom" });
    else if (kind === "crash") {
      fs.writeFileSync(capture.out, "partial out");
      fs.writeFileSync(capture.err, "Fatal Python error: fake");
      process.exitCode = Number(value) || 1;
      process.exit();
    }
    // "hang":不回應
  });
  process.stdin.on("data", (chunk) => decoder.push(chunk));
  process.stdin.on("end", () => process.exit(0));
}
if (boot === "never") setInterval(() => {}, 1000);
