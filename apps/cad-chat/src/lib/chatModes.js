// mode 白名單的單一真相源,供前後端共用。
// normalizeMode 將垃圾值收斂為 design,供 reducer/持久化使用;
// isMode 嚴格判別,供事件校正/API 白名單使用,垃圾值不放行、不收斂。
// isDesignLike:cable(無塵電纜)是設計模式的特化——完整設計鏈(PARAMS 滑桿/
// 版本/匯出/精算)全開;所有「只有設計模式才有」的判斷一律用它,不要
// 逐處硬寫 === "design"。
export const MODES = ["design", "sketch", "library", "cable"];
// 模式的中文名(單一真相源:切換器分段、錯誤訊息、確認框都引用它)。
export const MODE_LABELS = {
  design: "設計",
  sketch: "草模",
  cable: "無塵電纜",
  library: "零件庫",
};
export const modeLabel = (v) => MODE_LABELS[v] || String(v || "");
export const isMode = (v) => MODES.includes(v);
export const normalizeMode = (v) => (isMode(v) ? v : "design");
export const isDesignLike = (v) => v === "design" || v === "cable";
