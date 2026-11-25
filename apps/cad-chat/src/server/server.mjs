#!/usr/bin/env node
// 薄 CLI wrapper:npm run dev / serve 介面不變(--dev 或 CADCHAT_DEV=1 = dev 模式)。
// 伺服器組裝(env 載入/GC/middleware/Vite/listen)在 start.mjs 的 startServer()。
import { prewarmPython } from "./cad/python.mjs";
import { startServer } from "./start.mjs";

const dev = process.argv.includes("--dev") || process.env.CADCHAT_DEV === "1";
await startServer({ dev });
// 伺服器起來後先暖一個 CAD worker(背景進行,不擋啟動)。放在真正的進入點而不是
// startServer 裡:測試會反覆 startServer({port:0}),不該每次都起一個 Python。
prewarmPython();
