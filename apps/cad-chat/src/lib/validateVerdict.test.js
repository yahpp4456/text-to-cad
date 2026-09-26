import assert from "node:assert/strict";
import { test } from "node:test";

import { VERDICT_COLOR, verdictFor } from "./validateVerdict.js";

const P = { skipped: false };
const S = { skipped: true };

test("verdictFor:ok=false → 偵測到問題(danger),不看覆蓋", () => {
  assert.deepEqual(verdictFor({ ok: false, checks: [P, S] }), { text: "偵測到問題", tone: "danger" });
});

test("verdictFor:全 SKIP → 未執行檢查(muted),不再顯示全部通過", () => {
  assert.deepEqual(verdictFor({ ok: true, checks: [S, S, S] }), { text: "未執行檢查", tone: "muted" });
});

test("verdictFor:部分跑 → N 項通過 · M 項未驗證", () => {
  assert.deepEqual(
    verdictFor({ ok: true, checks: [P, P, P, P, S, S] }),
    { text: "4 項通過 · 2 項未驗證", tone: "ok" },
  );
});

test("verdictFor:全跑全過 → 全部通過;checks 缺省也不炸", () => {
  assert.deepEqual(verdictFor({ ok: true, checks: [P, P] }), { text: "全部通過", tone: "ok" });
  assert.deepEqual(verdictFor({ ok: true }), { text: "全部通過", tone: "ok" });
  assert.ok(VERDICT_COLOR.muted && VERDICT_COLOR.ok && VERDICT_COLOR.danger);
});
