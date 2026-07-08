// buildSystemPrompt × 累積教訓注入(node --test):digest 有值 → 出「# 累積教訓」段
// 且在條件尾段(rehydrate/imports)之前;空 → 完全不出現。純函式零 I/O。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "./agent/prompt.mjs";

const baseSession = { workdirRel: "models/.cadchat/s_test", imports: [] };

test("有 _lessonsDigest → 系統提示含「# 累積教訓」段與教訓條文", () => {
  const digest =
    "# 累積教訓(由歷史失敗自動蒸餾;若與上方規則衝突,以上方規則為準)\n- [LS-1] 疊層定位常數必須逐層推導(根因:目測魔數;5 例)";
  const out = buildSystemPrompt({ ...baseSession, _lessonsDigest: digest });
  assert.ok(out.includes("# 累積教訓"));
  assert.ok(out.includes("[LS-1]"));
  assert.ok(out.includes("以上方規則為準"), "從屬聲明必在");
});

test("無 _lessonsDigest(未設/空字串)→ 不出現教訓段", () => {
  for (const v of [undefined, ""]) {
    const out = buildSystemPrompt({ ...baseSession, _lessonsDigest: v });
    assert.ok(!out.includes("# 累積教訓"));
    assert.ok(!out.includes("LS-"), "不得殘留教訓痕跡");
  }
});

test("教訓段位於 rehydrate 條件尾段之前(教訓穩定、rehydrate 更動態,利 prompt cache)", () => {
  const out = buildSystemPrompt({
    ...baseSession,
    _lessonsDigest: "# 累積教訓(x)\n- [LS-1] r(根因:rc;1 例)",
    rehydratedFrom: "old_proj",
    lastName: "flange",
  });
  const iLessons = out.indexOf("# 累積教訓");
  const iRehydrate = out.indexOf("# 接續既有專案");
  assert.ok(iLessons !== -1 && iRehydrate !== -1);
  assert.ok(iLessons < iRehydrate);
});
