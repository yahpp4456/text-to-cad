// DEMO 帳號(展示身分)的前端提示文案:單一真相源。
// 與 server 端 demoGuard 的 403 訊息逐字一致——使用者可能先看到 tooltip、
// 後看到 403(直呼 API / 競態),兩處措辭不同會顯得是兩套規則。
//
// UX 契約(2026-07-21 二版):demo 下入口**照常渲染但禁用**,而不是藏起來。
// 理由是「藏」讓展示者以為產品沒有這些功能;「禁用+提示」才傳達「功能存在,
// 這個身分不開放」。實作沿用 repo 既有慣例:`data-disabled={demo || undefined}`
// + `title={DEMO_TIP}` + onClick 守衛(禁用態的 CSS 刻意不設 pointer-events:none,
// 否則 hover 不到、tooltip 永遠不浮出)。
export const DEMO_TIP = "DEMO 帳號僅供展示,這個功能未開放";
