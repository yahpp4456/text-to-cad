#!/usr/bin/env node
// 薄 CLI wrapper:npm run dev / serve 介面不變(--dev 或 CADCHAT_DEV=1 = dev 模式)。
// 伺服器組裝(env 載入/GC/middleware/Vite/listen)在 start.mjs 的 startServer(),
// 與 Electron 殼(electron/launch.mjs → entry.child.mjs)共用同一份。
import { startServer } from "./start.mjs";

const dev = process.argv.includes("--dev") || process.env.CADCHAT_DEV === "1";
await startServer({ dev });
