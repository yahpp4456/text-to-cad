// 瀏覽器端的 locale 偏好:localStorage(cadchat.locale)優先,沒有就看 navigator.language。
// 讀寫照 App.jsx MODE_KEY 的慣例(try/catch,壞掉就當沒設)。切換後由呼叫端 reload——
// DOM 轉換不做還原,重整續聊是現有能力(cadchat.session.v1 快照)。
import { DEFAULT_LOCALE, LOCALE_KEY, detectLocale, isLocale } from "./locale.js";
import { convertText } from "./zhConvert.js";

const EVENT = "cadchat:locale";
let baseTitle = null;

export function getLocale() {
  try {
    const v = window.localStorage.getItem(LOCALE_KEY);
    if (isLocale(v)) return v;
  } catch {
    /* 私密視窗/停用儲存 */
  }
  try {
    const langs = [navigator.language, ...(navigator.languages || [])];
    return detectLocale(langs);
  } catch {
    return DEFAULT_LOCALE;
  }
}

export function setLocale(next) {
  if (!isLocale(next)) return;
  try {
    window.localStorage.setItem(LOCALE_KEY, next);
  } catch {
    /* 無法持久化:本次仍生效(呼叫端會 reload,之後再回到偵測值) */
  }
  applyLocale(next);
  try {
    window.dispatchEvent(new CustomEvent(EVENT, { detail: next }));
  } catch {
    /* ignore */
  }
}

// 套到文件層:html lang、body data-locale、title(簡中時轉一次;converter 尚未載入就先原樣,
// 等 main.jsx 載完再 applyLocale 一次)。
export function applyLocale(l) {
  if (typeof document === "undefined") return;
  if (baseTitle == null) baseTitle = document.title;
  document.documentElement.lang = l;
  document.body.dataset.locale = l;
  document.title = l === "zh-Hans" ? convertText(baseTitle) : baseTitle;
}

export function subscribe(fn) {
  const h = () => fn(getLocale());
  window.addEventListener(EVENT, h);
  return () => window.removeEventListener(EVENT, h);
}
