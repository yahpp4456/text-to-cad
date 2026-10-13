// 繁→簡執行期轉換核心(純函式層;瀏覽器與 node 共用)。
// 轉換器來自 opencc-js 的 t2cn 子入口(約 109KB,gzip 約 40KB),只在需要時 dynamic import,
// 繁中使用者永遠不會載到。from:"twp" = 台灣字形+台灣詞彙 → 大陸簡體;術語例外見 zhTerms。
import { OVERRIDE, termList } from "./zhTerms.js";

const CJK_RE = /[㐀-䶿一-鿿豈-﫿]/;
const PUA_BASE = 0xe000; // 私用區:OpenCC 字典不含這段,佔位字元不會被切詞跨越
const CACHE_MAX = 2000;
const CACHE_MAX_LEN = 200; // 串流中的長段文字不快取(每 delta 都不同)

let converter = null; // (text) => text
let loading = null;
const cache = new Map();
const TERM_RE = new RegExp(termList().map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");

export const hasCjk = (s) => CJK_RE.test(s);

// 載入 opencc-js(idempotent;回傳 converter)。失敗時 converter 維持 null,convertText 原樣回傳。
export async function loadConverter() {
  if (converter) return converter;
  if (!loading) {
    loading = import("opencc-js/t2cn")
      .then((m) => {
        const OpenCC = m.Converter ? m : m.default;
        converter = OpenCC.Converter({ from: "twp", to: "cn" });
        return converter;
      })
      .catch((err) => {
        loading = null;
        throw err;
      });
  }
  return loading;
}

// 測試/伺服端可直接注入已建好的 converter。
export function setConverter(fn) {
  converter = typeof fn === "function" ? fn : null;
  cache.clear();
}

export const converterReady = () => !!converter;

// 一段文字繁→簡。無 converter、無 CJK、或空字串 → 原樣。術語先以 PUA 佔位再還原。
export function convertText(s, conv = converter) {
  if (!conv || typeof s !== "string" || !s || !CJK_RE.test(s)) return s;
  const cacheable = s.length <= CACHE_MAX_LEN;
  if (cacheable) {
    const hit = cache.get(s);
    if (hit !== undefined) return hit;
  }
  const slots = [];
  const guarded = s.replace(TERM_RE, (m) => {
    slots.push(OVERRIDE[m] ?? m);
    return String.fromCharCode(PUA_BASE + slots.length - 1);
  });
  let out = conv(guarded);
  if (slots.length) {
    out = out.replace(/[-]/g, (c) => slots[c.charCodeAt(0) - PUA_BASE] ?? c);
  }
  if (cacheable) {
    if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(s, out);
  }
  return out;
}
