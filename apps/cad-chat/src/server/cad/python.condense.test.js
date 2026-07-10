// condenseTraceback 單元測(node --test):Python traceback → 一~兩行人讀摘要
// (tool card / notify 的 note 用)。合成 stderr 字串、不 spawn。
import assert from "node:assert/strict";
import { test } from "node:test";

import { condenseTraceback } from "./python.mjs";

// 模擬 scrubPaths 後的真實 build 失敗(本案例:負長度 Box → OCP DomainError)。
// 產生器 frame 出現兩層(gen_step → _motor_group),摘要必須取「最深」那層。
const OCP_TB = [
  "Traceback (most recent call last):",
  '  File "models\\.cadchat\\s_abc\\linear_stage.py", line 256, in <module>',
  "    s = gen_step()",
  '  File "models\\.cadchat\\s_abc\\linear_stage.py", line 239, in gen_step',
  "    body, mshaft, mount, coup = _motor_group(L)",
  '  File "models\\.cadchat\\s_abc\\linear_stage.py", line 170, in _motor_group',
  '    foot = _box(0.0, L["foot_x1"], -MOUNT_HY, MOUNT_HY, ...)',
  '  File ".venv\\Lib\\site-packages\\build123d\\objects_part.py", line 162, in __init__',
  "    solid = Solid.make_box(length, width, height)",
  '  File ".venv\\Lib\\site-packages\\build123d\\topology\\three_d.py", line 1338, in make_box',
  "    ).Shape()",
  "OCP.OCP.Standard.Standard_DomainError",
].join("\n");

test("OCP 裸例外 + 產生器多層 frame:類名直出、取最深 frame(反斜線路徑)", () => {
  const out = condenseTraceback(OCP_TB, { generatorName: "linear_stage" });
  assert.equal(out, "OCP.OCP.Standard.Standard_DomainError\n於 linear_stage.py 第 170 行(_motor_group)");
});

test("ValueError 且有訊息(產生器防呆的繁中人話)→ 訊息直出不帶類名", () => {
  const tb = [
    "Traceback (most recent call last):",
    '  File "models/.cadchat/s_abc/stage.py", line 40, in gen_step',
    "    _check_params()",
    '  File "models/.cadchat/s_abc/stage.py", line 36, in _check_params',
    '    raise ValueError(f"rail_len(305)不可大於 base_len(300):導軌會超出底板")',
    "ValueError: rail_len(305)不可大於 base_len(300):導軌會超出底板",
  ].join("\n");
  const out = condenseTraceback(tb, { generatorName: "stage" });
  assert.equal(out, "rail_len(305)不可大於 base_len(300):導軌會超出底板\n於 stage.py 第 36 行(_check_params)");
});

test("一般例外有訊息 → 類名(取限定名末段): 訊息", () => {
  const tb = [
    "Traceback (most recent call last):",
    '  File "models/.cadchat/s_abc/stage.py", line 92, in _layout',
    '    rail_len = float(p["rail_len"])',
    "KeyError: 'rail_len'",
  ].join("\n");
  const out = condenseTraceback(tb, { generatorName: "stage" });
  assert.equal(out, "KeyError: 'rail_len'\n於 stage.py 第 92 行(_layout)");
});

test("chained exception(During handling…)取最終例外", () => {
  const tb = [
    "Traceback (most recent call last):",
    '  File "models/.cadchat/s_abc/stage.py", line 10, in gen_step',
    "KeyError: 'x'",
    "",
    "During handling of the above exception, another exception occurred:",
    "",
    "Traceback (most recent call last):",
    '  File "models/.cadchat/s_abc/stage.py", line 14, in gen_step',
    "RuntimeError: rebuild failed",
  ].join("\n");
  const out = condenseTraceback(tb, { generatorName: "stage" });
  assert.match(out, /^RuntimeError: rebuild failed/);
  assert.match(out, /第 14 行/); // frame 取最後命中 = 最終例外的 frame
});

test("generatorName 未給 → 只出例外行,不出 frame 行", () => {
  const out = condenseTraceback(OCP_TB, {});
  assert.equal(out, "OCP.OCP.Standard.Standard_DomainError");
});

test("非 traceback(spawn 錯誤等)→ fallback 等值舊 slice(-maxLen) 行為", () => {
  const s = "x".repeat(500) + " spawn ENOENT something went wrong";
  const out = condenseTraceback(s, { generatorName: "stage", maxLen: 300 });
  assert.equal(out, s.slice(-300));
});

test("空 / null 安全通過", () => {
  assert.equal(condenseTraceback("", { generatorName: "a" }), "");
  assert.equal(condenseTraceback(null, {}), "");
  assert.equal(condenseTraceback(undefined), "");
});

test("同名尾綴的別檔不誤認產生器 frame(my_stage.py ≠ stage.py)", () => {
  const tb = [
    "Traceback (most recent call last):",
    '  File "models/.cadchat/s_abc/my_stage.py", line 5, in gen_step',
    "ValueError: boom",
  ].join("\n");
  const out = condenseTraceback(tb, { generatorName: "stage" });
  assert.equal(out, "boom"); // 有例外行但無產生器 frame(endsWith "/stage.py" 不吃 my_stage.py)
});
