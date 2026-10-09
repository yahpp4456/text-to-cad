// 派工實驗(orch)prompt 分支鎖(node --test):session._orch 未設 → 單人變體 prompt
// 逐字不變;_orch:true → 換紀律句 + 注入「派工流程」段;part_builder 子代理定義的工具面
// 與前景旗標固定(背景子代理 = 2026-07 工具通道死亡事故的根因)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildSystemPrompt } from "./agent/prompt.mjs";
import {
  ORCH_DISCIPLINE,
  ORCH_DISPATCH_SECTION,
  PART_BUILDER_AGENT,
  PART_BUILDER_PROMPT,
  SINGLE_DISCIPLINE,
} from "./agent/prompt.orch.mjs";
import { INTERNAL_TERMS } from "./agent/wording.mjs";

const base = { sessionId: "s_test", workdirRel: "models/.cadchat/s_test", mode: "design" };
const single = buildSystemPrompt({ ...base });
const orch = buildSystemPrompt({ ...base, _orch: true });

test("_orch 未設:含原同步紀律句、無派工段、無 part_builder", () => {
  assert.ok(single.includes(SINGLE_DISCIPLINE));
  assert.ok(single.includes("不得啟動子代理(Agent/Task)"));
  assert.ok(!single.includes("# 派工流程"));
  assert.ok(!single.includes("part_builder"));
  assert.ok(!single.includes(ORCH_DISCIPLINE));
});

test("_orch:true:換紀律句 + 派工段(part_builder / run_in_background:false / 同訊息並行 / name 必明給)", () => {
  assert.ok(!orch.includes(SINGLE_DISCIPLINE));
  assert.ok(orch.includes(ORCH_DISCIPLINE));
  assert.ok(orch.includes("# 派工流程"));
  assert.ok(orch.includes('subagent_type: "part_builder"'));
  assert.ok(orch.includes("run_in_background: false"));
  assert.ok(orch.includes("在同一則訊息裡對每一件各發一次"));
  assert.ok(orch.includes("一律明給 name"));
  assert.ok(orch.includes("模組**頂層**"), "同目錄 import 必在頂層的規則要在");
  assert.equal(orch.split("# 派工流程").length - 1, 1, "派工段重複注入");
});

test("單人變體逐字未動:orch prompt 把派工段換回單人紀律句 === single prompt", () => {
  const swapped = orch.replace(ORCH_DISCIPLINE + ORCH_DISPATCH_SECTION, SINGLE_DISCIPLINE);
  assert.equal(swapped, single);
});

test("part_builder 定義:工具面只有 Read/Glob/Grep + cad_build/cad_validate,前景、inherit、省 CLAUDE.md", () => {
  assert.deepEqual(PART_BUILDER_AGENT.tools, [
    "Read", "Glob", "Grep", "mcp__cadchat__cad_build", "mcp__cadchat__cad_validate",
  ]);
  for (const t of PART_BUILDER_AGENT.tools) {
    assert.ok(!/emit_|cad_present|cad_export|cad_source_part|Agent|Task/.test(t), t);
  }
  assert.equal(PART_BUILDER_AGENT.background, false);
  assert.equal(PART_BUILDER_AGENT.model, "inherit");
  assert.equal(PART_BUILDER_AGENT.omitClaudeMd, true);
  assert.ok(PART_BUILDER_AGENT.maxTurns >= 6);
  assert.equal(PART_BUILDER_AGENT.prompt, PART_BUILDER_PROMPT);
  assert.ok(typeof PART_BUILDER_AGENT.description === "string" && PART_BUILDER_AGENT.description.length > 10);
});

test("part_builder prompt:模組契約齊全(make/gen_step/check_geometry/介面卡 JSON/不寫 MOTION)", () => {
  for (const must of ["def make(P=None)", "def gen_step()", "def check_geometry(shape)", "INTENDED_CONTACT = []",
                      '"module":"<asm>_<part>"', "不寫 MOTION", "局部座標", "最多 3 次"]) {
    assert.ok(PART_BUILDER_PROMPT.includes(must), `缺「${must}」`);
  }
});

test("派工段面向使用者的措辭範例不含內部詞(description 文字)", () => {
  // 「建 <part>」是 Agent 呼叫的 description(UI 進度列會顯示),不得帶內部詞。
  const m = ORCH_DISPATCH_SECTION.match(/`description`:「([^」]+)」/);
  assert.ok(m, "派工段要指定 description 文案");
  const text = m[1].toLowerCase();
  for (const t of INTERNAL_TERMS) assert.ok(!text.includes(t), `description 文案含內部詞 ${t}`);
});
