// Electron main(CJS;鎖定 Electron 版本前不冒 ESM main 的險——launch.mjs 走動態 import)。
// 職責:single-instance lock → fork server(launch.mjs)→ BrowserWindow 載 loopback URL
// → 退出時 taskkill /T /F 連根清 server 子樹(node → python.exe / claude.exe 孫程序)。
// 安全基線:contextIsolation + sandbox + 無 nodeIntegration + 無 preload——渲染層就是
// 個純瀏覽器,一切能力都在 server 端(與瀏覽器版同一信任模型)。
const { app, BrowserWindow, dialog, utilityProcess } = require("electron");
const { spawn } = require("node:child_process");

let serverChild = null;
let win = null;

// 連根清 server 程序樹。Windows 用 taskkill /T /F(SIGKILL 不會帶走孫程序:
// 進行中 turn 的 claude.exe / python.exe 掛在 server 之下,漏殺=殭屍吃資源)。
function killServerTree() {
  const child = serverChild;
  serverChild = null;
  if (!child || child.pid == null) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true });
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    /* 已死 = 目的已達 */
  }
}

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    try {
      const { launchServer } = await import("./launch.mjs");
      const { url, child } = await launchServer({ app, utilityProcess });
      serverChild = child;
      // server 意外死亡(非退出流程)→ 誠實告知並收攤,不留白畫面殭屍殼
      child.on("exit", (code) => {
        if (serverChild === child) {
          serverChild = null;
          if (!app.isQuittingByUser) {
            dialog.showErrorBox("cad-chat", `伺服器程序意外結束(code ${code})。`);
            app.quit();
          }
        }
      });
      win = new BrowserWindow({
        width: 1440,
        height: 900,
        show: false, // ready-to-show 才亮,避免白閃
        webPreferences: {
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.once("ready-to-show", () => win.show());
      win.on("closed", () => {
        win = null;
      });
      await win.loadURL(url);
      console.log(`[electron] window loaded ${url}`);
    } catch (err) {
      dialog.showErrorBox("cad-chat 啟動失敗", String(err?.message || err));
      app.quit();
    }
  });

  app.on("window-all-closed", () => app.quit());
  // before-quit 就殺(不等 will-quit):taskkill 是 fire-and-forget spawn,
  // 越早發越不會被 Electron 主程序自身的退出搶先。
  app.on("before-quit", () => {
    app.isQuittingByUser = true;
    killServerTree();
  });
  app.on("will-quit", killServerTree); // 雙保險(冪等:serverChild 已 null 即 no-op)
}
