import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

import { buildPromoteText } from "./promoteText.js";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "sketch", "fixtures");
const load = (name) => JSON.parse(readFileSync(join(FIX, name), "utf8"));

// 審查 F6 的驗收:轉正式設計後仍拿得到桿長、鉸點、缸軸線、樞軸、角度範圍與缸行程。
// 數字直接在文字裡——不依賴 design agent 去 Read 草模對話的檔(讀取範圍硬閘會擋)。
test("buildPromoteText:缸推擺臂 → 文字內含樞軸/定長連桿/滑銷導線/致動器行程", () => {
  const t = buildPromoteText({ doc: load("cylinder_tilt.json"), fallbackName: "mech" });
  assert.ok(t.startsWith("照機構草模「汽缸驅動平台前傾(滑塊曲柄→搖桿)」做正式設計。"));
  assert.ok(t.includes("- 驅動:前傾角 θ 0~30°"));
  assert.ok(t.includes("繞軸 (0, 1, 0) 旋轉,樞軸 (110, 25, 12)"));
  assert.ok(t.includes("滑銷 pinC:沿直線(過 (50, 25, 54)、方向 (1, 0, 0))滑動"));
  assert.ok(t.includes("保持定長 35 mm;基準位置 (75, 25, 54)"));
  assert.ok(t.includes("剛性連桿 連桿 coupler:長 35 mm"));
  // 行程 = 閉式解(獨立重推):42·sin30° + 35 − √(35² − (42(1−cos30°))²)
  const dz = 42 * (1 - Math.cos(Math.PI / 6));
  const stroke = 42 * 0.5 + 35 - Math.sqrt(35 * 35 - dz * dz);
  assert.ok(t.includes(`(行程 ${(Math.round(stroke * 100) / 100).toString()} mm)`), t);
  assert.ok(t.endsWith("先列規格再動工。"));
});

test("buildPromoteText:不帶其他對話的檔案路徑、不叫 agent 去 Read(讀取範圍硬閘會拒絕)", () => {
  for (const f of ["cylinder_tilt.json", "gripper_pickplace.json", "belt_drive.json", "steering_rack.json"]) {
    const t = buildPromoteText({ doc: load(f) });
    assert.ok(!t.includes(".cadchat"), f);
    assert.ok(!t.includes(".sketch.json"), f);
    assert.ok(!/Read/.test(t), f);
  }
});

test("buildPromoteText:耦合關節帶比例(齒條 scale、鏡像夾爪 ×-1)、工件狀態、主要外形", () => {
  const rack = buildPromoteText({ doc: load("steering_rack.json") });
  assert.match(rack, /齒條\(輸出\) 沿 \(0, 1, 0\) 平移,基準點 .*跟隨 轉向角 θ×-0\.31/);
  assert.ok(rack.includes("齒輪 模數 2.5、14 齒"));
  const grip = buildPromoteText({ doc: load("gripper_pickplace.json") });
  assert.ok(grip.includes("跟隨 指開半距×-1"));
  assert.ok(grip.includes("工件 工件:狀態 seated → held → placed(起始 seated)"));
  const belt = buildPromoteText({ doc: load("belt_drive.json") });
  assert.ok(belt.includes("皮帶輪 ø30×12"));
});

test("buildPromoteText:無 doc / 壞 doc → 明講沒帶到,要求先確認(不假裝有規格)", () => {
  for (const doc of [null, { schemaVersion: 1, bodies: [] }]) {
    const t = buildPromoteText({ doc, fallbackName: "mech" });
    assert.ok(t.startsWith("照機構草模「mech」做正式設計。草模的機構定義沒能自動帶入"), t);
    assert.ok(t.includes("不要憑名稱推測"));
    assert.ok(!t.includes("關節:"));
  }
});
