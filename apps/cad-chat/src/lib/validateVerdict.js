// 驗證卡標題的純函數:依 checks 覆蓋率決定文案與色調(Message.jsx ValidateCard 消費)。
// skipped 代表「沒檢查」不是「通過」——全 SKIP 不能顯示「全部通過」(審查 F8)。
//   tone: "danger" | "muted" | "ok"
//   tone 另有 "warn"。
// 每列的 status(server decorateChecks 一律帶):ok / failed / not_checked / not_applicable。
// not_applicable(單一零件沒有干涉可查…)不是檢查項,不計入「未驗證」。舊資料沒有 status
// 時,skipped 一律當 not_checked(從嚴)。
export function checkStatusOf(c) {
  if (c?.status) return c.status;
  if (c?.skipped) return "not_checked";
  return c?.ok === false ? "failed" : "ok";
}

export function verdictFor(it) {
  const checks = Array.isArray(it?.checks) ? it.checks : [];
  const count = (status) => checks.filter((c) => checkStatusOf(c) === status).length;
  const unchecked = count("not_checked");
  if (!it?.ok) {
    // 沒有任何一項失敗、只是有項目量不到:不是「有問題」,是「還不能說通過」。
    if (count("failed") === 0 && unchecked > 0) {
      return { text: `${unchecked} 項未量測 · 尚未通過`, tone: "warn" };
    }
    return { text: "偵測到問題", tone: "danger" };
  }
  const ran = count("ok");
  // 建議列(advisory,例:鈑金可製造性)不是檢查項:不算通過、不算未驗證,有的話在標題尾端提一句。
  const advised = checks
    .filter((c) => checkStatusOf(c) === "advisory")
    .reduce((n, c) => n + (c.findingCount || (Array.isArray(c.findings) ? c.findings.length : 0) || 1), 0);
  const tail = advised > 0 ? ` · ${advised} 項建議` : "";
  if (checks.length && ran === 0) return { text: `未執行檢查${tail}`, tone: "muted" };
  if (unchecked > 0) return { text: `${ran} 項通過 · ${unchecked} 項未驗證${tail}`, tone: "ok" };
  return { text: `全部通過${tail}`, tone: "ok" };
}

export const VERDICT_COLOR = {
  danger: "var(--danger)",
  warn: "#c98a1b", // 與 decorateChecks 的「未量測」問號同色
  muted: "#a3acba", // 與 decorateChecks 的 SKIP 圖示灰一致
  ok: "var(--part)",
};
