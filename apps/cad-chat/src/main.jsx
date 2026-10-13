import React from "react";
import { createRoot } from "react-dom/client";

import App from "./App.jsx";
import { installDomConverter } from "./lib/domConvert.js";
import { applyLocale, getLocale } from "./lib/localeStore.js";
import { loadConverter } from "./lib/zhConvert.js";
import "./styles/tokens.css";
import "./styles/app.css";

// 介面文字系統:zh-Hant(預設)走原路,零改變;zh-Hans 才 dynamic import OpenCC(~40KB gzip)
// 並在 #root 掛 DOM 層繁→簡轉換。與 render 並行,首屏可能有數百 ms 繁中閃現(接受)。
const rootEl = document.getElementById("root");
const locale = getLocale();
applyLocale(locale);
if (locale === "zh-Hans") {
  loadConverter()
    .then(() => {
      applyLocale(locale); // title 現在能轉了
      installDomConverter(rootEl);
    })
    .catch((err) => console.warn("[cadchat] 簡中轉換器載入失敗,維持繁中:", err));
}

createRoot(rootEl).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
