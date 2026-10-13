// 介面文字系統(locale)白名單:單一真相源,前後端共用(純函式、無瀏覽器依賴)。
// 目前只有兩個值:zh-Hant(繁體,預設)與 zh-Hans(簡體)。不是完整 i18n——UI 字串仍是
// 繁中硬編,zh-Hans 靠執行期 OpenCC 轉換(lib/zhConvert + lib/domConvert);server 端用
// 它決定 prompt 的語言規則與括註文字系統(agent/localeRules、agent/hans)。
export const LOCALES = ["zh-Hant", "zh-Hans"];
export const DEFAULT_LOCALE = "zh-Hant";
export const LOCALE_KEY = "cadchat.locale"; // localStorage 鍵(照 cadchat.mode 慣例)

export const isLocale = (v) => LOCALES.includes(v);
export const normalizeLocale = (v) => (isLocale(v) ? v : DEFAULT_LOCALE);

// 從瀏覽器語言清單(navigator.language / navigator.languages)推文字系統:
// 取第一個 zh 開頭的 tag;帶 Hans/CN/SG/MY 子標 → 簡體,其餘(TW/HK/MO/Hant/裸 zh)→ 繁體;
// 沒有 zh → 繁體(產品預設)。
export function detectLocale(languages = []) {
  const list = Array.isArray(languages) ? languages : [languages];
  for (const raw of list) {
    const tag = String(raw || "").trim();
    if (!/^zh(?:[-_]|$)/i.test(tag)) continue;
    return /[-_](?:Hans|CN|SG|MY)(?:[-_]|$)/i.test(tag) ? "zh-Hans" : "zh-Hant";
  }
  return DEFAULT_LOCALE;
}
