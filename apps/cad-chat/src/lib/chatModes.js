// mode 白名單的單一真相源，供前後端共用。
// normalizeMode 將垃圾值收斂為 design，供 reducer／持久化使用；
// isMode 嚴格判別，供事件校正／API 白名單使用，垃圾值不放行、不收斂。
export const MODES = ["design", "sketch", "library"];
export const isMode = (v) => MODES.includes(v);
export const normalizeMode = (v) => (isMode(v) ? v : "design");
