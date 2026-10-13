import { useSyncExternalStore } from "react";

import { getLocale, subscribe } from "../lib/localeStore.js";

// 目前介面文字系統(zh-Hant / zh-Hans)。切換走 localeStore.setLocale → 事件 → 重算。
export function useLocale() {
  return useSyncExternalStore(subscribe, getLocale, () => "zh-Hant");
}
