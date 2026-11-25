// 設計 prompt 的「怎麼驗」規則(上游借鏡藍圖 B7 / B9):使用者給的數字要在 check_geometry 裡
// 對做出來的形狀驗;改了什麼用什麼檢查;略過或未量測不等於通過。
// 這些規則只有真 LLM 回合才驗得了「agent 會不會照做」(L4);這裡只鎖文字還在、範例碼是
// 合法的 Python 形狀、而且與伺服器實際的行為一致(狀態名稱、哪些檢查在回合內不跑)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildLibrarySystemPrompt } from "./agent/prompt.library.mjs";
import { buildSystemPrompt } from "./agent/prompt.mjs";
import { buildSketchSystemPrompt } from "./agent/prompt.sketch.mjs";

const design = buildSystemPrompt({ sessionId: "s_test", workdirRel: "models/.cadchat/s_test", mode: "design" });

test("產生器格式:輸入用 _check_params 擋、輸出用 check_geometry 裡的 assert 驗,兩者都在", () => {
  assert.match(design, /_check_params\(\)/);
  assert.match(design, /使用者給的數字,在 check_geometry 裡對做出來的形狀驗/);
  // 範例是「量幾何再與 PARAMS 比」,而且訊息寫出量到多少、應為多少
  assert.match(design, /size = shape\.bounding_box\(\)\.size/);
  assert.match(design, /assert abs\(size\.X - PARAMS\["od"\]\) < 0\.01, f"外徑量到 \{size\.X:\.2f\},應為 \{PARAMS\['od'\]\}"/);
  assert.match(design, /不要把常數再抄一遍互比/);
});

test("範例與既有契約不衝突:gen_step 無參數、check_geometry(shape) 簽章、assert_valid_solid 仍在", () => {
  assert.match(design, /def gen_step\(\):/);
  const signatures = design.match(/def check_geometry\(shape\):/g) || [];
  assert.ok(signatures.length >= 2, "骨架與數字驗證範例各有一個 check_geometry(shape)");
  assert.ok((design.match(/assert_valid_solid\(shape\)/g) || []).length >= 2);
});

test("改了什麼用什麼檢查:四種改動各對到一種驗法,且引用的是真的存在的工具/契約", () => {
  const section = design.slice(design.indexOf("# 改了什麼,用什麼檢查"), design.indexOf("# 紀律"));
  assert.ok(section.length > 100, "對照表在「紀律」之前");
  for (const needle of ["check_geometry", "cad_measure", "INTENDED_CONTACT", "assert_no_interference", "MOTION", "cad_align"]) {
    assert.ok(section.includes(needle), `對照表應提到 ${needle}`);
  }
  // 掃掠在回合內不跑(快路徑):prompt 不可宣稱回合內會驗掃掠
  assert.match(section, /掃掠在使用者精算或匯出時才跑,回合內顯示未量測/);
});

test("三條原則:數字用量的;失敗、略過、未量測都不算證明;不可靠縮小需求讓檢查變綠", () => {
  assert.match(design, /數字用量的,不從畫面或印象讀/);
  assert.match(design, /檢查失敗、被略過、或顯示未量測,都等於什麼也沒證明/);
  assert.match(design, /重試時把指定的特徵拿掉或縮小,是做了另一個設計/);
  assert.match(design, /修不好就回報哪一項做不到,不要默默改需求/);
});

test("與既有紀律一致:SKIP 不是失敗、不要為 SKIP 重試(未量測同理,不是幾何錯誤)", () => {
  assert.match(design, /SKIP 不是失敗,不要為 SKIP 重試/);
  assert.match(design, /任一非 skipped 檢查 fail → emit_retry/);
});

test("草模與零件庫模式不帶這些建模規則(它們不寫產生器)", () => {
  const session = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test" };
  const others = {
    sketch: buildSketchSystemPrompt({ ...session, mode: "sketch" }),
    library: buildLibrarySystemPrompt({ ...session, mode: "library" }),
  };
  for (const [mode, other] of Object.entries(others)) {
    assert.ok(other.length > 200, `${mode} prompt 有內容`);
    assert.ok(!other.includes("# 改了什麼,用什麼檢查"), mode);
    assert.ok(!other.includes("使用者給的數字,在 check_geometry 裡對做出來的形狀驗"), mode);
  }
});

test("建置差異摘要:prompt 交代 cad_build 回傳的 delta 是什麼、對不上時要先查原因", () => {
  assert.match(design, /回傳的 `delta` 是一行字/);
  assert.match(design, /與你打算做的修改不符時.*先查原因並修正,不要直接呈現/);
});

test("檢查列的具體發現:prompt 交代 findings 裡有什麼、要照它點名的零件修", () => {
  assert.match(design, /沒過或沒量到的列帶 `findings`/);
  for (const field of ["refs", "value", "limit", "where"]) assert.ok(design.includes("`" + field + "`"), field);
  assert.match(design, /照它點名的零件與數值修最小責任段/);
});

test("平板件的切割圖:prompt 教 plate_dxf,並說明不是等厚平板時不要硬出", () => {
  assert.match(design, /def gen_dxf\(\): from cadpy\.flatten import plate_dxf; return plate_dxf\(gen_step\(\)\)/);
  assert.match(design, /不是等厚平板\)它會報錯/);
  assert.match(design, /dxf=鈑金展開圖或平板件的切割輪廓/);
});

test("具名姿態與動作序列:prompt 教 states / sequences 的寫法與為什麼要寫", () => {
  assert.match(design, /具名姿態與動作序列\(兩個以上獨立運動軸的機構必寫\)/);
  assert.match(design, /"states": \{"open": \{"grip": 0\.0\}/);
  assert.match(design, /"sequences": \{"pick": \["open", "closed", "raised"\]\}/);
  assert.match(design, /帶 couple 的從動 dof 不能寫/);
  assert.match(design, /掃掠一次只動一個軸/);
});

test("看圖紀律:什麼時候看、怎麼看、看什麼、不能拿來讀數字;放在「紀律」之前", () => {
  const section = design.slice(design.indexOf("# 看圖紀律"), design.indexOf("\n# 紀律"));
  assert.ok(section.length > 200, "有「看圖紀律」一段");
  assert.match(section, /組合件\(兩件以上\)在 cad_present 之前看一次/);
  assert.match(section, /同一版最多看兩次/);
  assert.match(section, /圖不能拿來讀數字/);
  assert.match(section, /這一版沒有看過圖/);
  // 工具說明裡的參數與伺服器的工具定義一致
  for (const word of ["cad_snapshot", "views", "ghost", "hide", "clip", "pose", "iso_back"]) assert.ok(design.includes(word), word);
});

test("看圖工具只在設計類模式:草模與零件庫的提示不提它", () => {
  const session = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test" };
  for (const other of [buildSketchSystemPrompt({ ...session, mode: "sketch" }), buildLibrarySystemPrompt({ ...session, mode: "library" })]) {
    assert.ok(!other.includes("cad_snapshot"));
  }
});

test("鈑金可製造性建議:prompt 說明它不是錯誤、不要為它重試、收尾要告訴使用者", () => {
  assert.match(design, /鈑金可製造性\(建議\)/);
  assert.match(design, /不要為它重試/);
  assert.match(design, /在收尾用一句話告訴使用者有哪幾項/);
});
