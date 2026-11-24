import assert from "node:assert/strict";
import { test } from "node:test";

import { VERDICT_COLOR, verdictFor } from "./validateVerdict.js";

const P = { skipped: false };
const S = { skipped: true };

const F = { ok: false, skipped: false };

test("verdictFor:ok=false 且有檢查失敗 → 偵測到問題(danger),不看覆蓋", () => {
  assert.deepEqual(verdictFor({ ok: false, checks: [P, F, S] }), { text: "偵測到問題", tone: "danger" });
  assert.deepEqual(verdictFor({ ok: false, checks: [] }), { text: "偵測到問題", tone: "danger" });
  assert.deepEqual(verdictFor({ ok: false }), { text: "偵測到問題", tone: "danger" });
});

test("verdictFor:ok=false 但沒有任何失敗、只是量不到 → 尚未通過(warn),不說成有問題", () => {
  const timedOut = { ok: true, skipped: true, status: "not_checked" };
  assert.deepEqual(
    verdictFor({ ok: false, checks: [{ ok: true, status: "ok" }, { ok: true, status: "ok" }, timedOut] }),
    { text: "1 項未量測 · 尚未通過", tone: "warn" },
  );
  // 同時有失敗與未量測:失敗優先
  assert.equal(verdictFor({ ok: false, checks: [F, timedOut] }).tone, "danger");
  assert.ok(VERDICT_COLOR.warn);
});

test("verdictFor:不適用的列不是檢查項,不計入「未驗證」", () => {
  const na = { ok: true, skipped: true, status: "not_applicable" };
  const ok = { ok: true, status: "ok" };
  // 單一零件的完整驗證:干涉與掃掠都不適用,其餘全過 → 全部通過
  assert.deepEqual(verdictFor({ ok: true, checks: [ok, na, na, ok] }), { text: "全部通過", tone: "ok" });
  // 設計模式:該量的沒量(not_checked)照樣算未驗證,不適用的不算
  const nc = { ok: true, skipped: true, status: "not_checked" };
  assert.deepEqual(verdictFor({ ok: true, checks: [nc, na, na, nc] }), { text: "未執行檢查", tone: "muted" });
  assert.deepEqual(verdictFor({ ok: true, checks: [ok, na, nc] }), { text: "1 項通過 · 1 項未驗證", tone: "ok" });
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
