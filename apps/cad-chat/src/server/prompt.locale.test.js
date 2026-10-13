import assert from "node:assert/strict";
import test from "node:test";

import { HANS_DEFAULT, SCRIPT_RULE, buildLanguageRules } from "./agent/localeRules.mjs";
import { buildCableSystemPrompt } from "./agent/prompt.cable.mjs";
import { buildLibrarySystemPrompt } from "./agent/prompt.library.mjs";
import { buildSystemPrompt } from "./agent/prompt.mjs";
import { buildSketchSystemPrompt } from "./agent/prompt.sketch.mjs";
import { WORDING_SECTION_TITLE } from "./agent/wording.mjs";

const hant = { mode: "design" };
const hans = { mode: "design", _locale: "zh-Hans" };
const builders = {
  design: buildSystemPrompt,
  cable: buildCableSystemPrompt,
  sketch: buildSketchSystemPrompt,
  library: buildLibrarySystemPrompt,
};

test("buildLanguageRules:恆含文字系統規則;zh-Hans 再加簡體預設", () => {
  assert.equal(buildLanguageRules(hant), SCRIPT_RULE);
  assert.equal(buildLanguageRules(undefined), SCRIPT_RULE);
  assert.equal(buildLanguageRules(hans), `${SCRIPT_RULE}\n${HANS_DEFAULT}`);
  assert.ok(SCRIPT_RULE.includes("簡體與繁體是不同的書寫系統"));
});

for (const [name, build] of Object.entries(builders)) {
  test(`${name} prompt:語言段緊接「預設繁體中文。」後含文字系統規則;zh-Hans 才含簡體預設;措辭段仍只一次`, () => {
    const a = build(hant);
    const b = build(hans);
    // 規則緊接在「預設繁體中文。」那一句之後(library 那句後面還有 meta 欄位說明,同句)
    const i = a.indexOf("預設繁體中文。");
    const j = a.indexOf(SCRIPT_RULE);
    assert.ok(i > 0 && j > i && j - i < 120, `${name} 規則位置 i=${i} j=${j}`);
    assert.ok(!a.includes(HANS_DEFAULT), `${name} zh-Hant 不該有簡體預設`);
    assert.ok(b.includes(`${SCRIPT_RULE}\n${HANS_DEFAULT}`), `${name} zh-Hans 要有簡體預設`);
    assert.equal(a.split(WORDING_SECTION_TITLE).length - 1, 1, `${name} 措辭段次數`);
    assert.equal(b.split(WORDING_SECTION_TITLE).length - 1, 1);
  });
}

test("sketch/library 無參數呼叫仍可(舊測試相容)", () => {
  assert.ok(buildSketchSystemPrompt().includes(SCRIPT_RULE));
  assert.ok(buildLibrarySystemPrompt().includes(SCRIPT_RULE));
});
