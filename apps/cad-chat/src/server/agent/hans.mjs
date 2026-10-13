// 伺服端繁→簡(node):給 chat.mjs 把注入使用者訊息的系統括註轉成簡體(locale=zh-Hans),
// 免得繁中括註干擾模型判斷使用者的文字系統。用同一個 opencc-js/t2cn 與同一份術語表
// (lib/zhConvert + lib/zhTerms),同步載入(node ESM 可直接 import)。
// 載入失敗 → 原樣回傳(括註維持繁中,只影響語言判斷,不擋回合)。
import { convertText, loadConverter } from "../../lib/zhConvert.js";

let ready = null;
export function warmHans() {
  if (!ready) ready = loadConverter().catch(() => null);
  return ready;
}

// 同步介面:converter 尚未載好時原樣回傳(第一個 zh-Hans 回合前 chat.mjs 會 await warmHans)。
export function toHans(s) {
  return convertText(s);
}
