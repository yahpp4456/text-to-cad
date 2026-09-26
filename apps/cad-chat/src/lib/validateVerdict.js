// 驗證卡標題的純函數:依 checks 覆蓋率決定文案與色調(Message.jsx ValidateCard 消費)。
// skipped 代表「沒檢查」不是「通過」——全 SKIP 不能顯示「全部通過」(審查 F8)。
//   tone: "danger" | "muted" | "ok"
export function verdictFor(it) {
  const checks = Array.isArray(it?.checks) ? it.checks : [];
  if (!it?.ok) return { text: "偵測到問題", tone: "danger" };
  const ran = checks.filter((c) => !c?.skipped).length;
  const skipped = checks.length - ran;
  if (checks.length && ran === 0) return { text: "未執行檢查", tone: "muted" };
  if (skipped > 0) return { text: `${ran} 項通過 · ${skipped} 項未驗證`, tone: "ok" };
  return { text: "全部通過", tone: "ok" };
}

export const VERDICT_COLOR = {
  danger: "var(--danger)",
  muted: "#a3acba", // 與 decorateChecks 的 SKIP 圖示灰一致
  ok: "var(--part)",
};
