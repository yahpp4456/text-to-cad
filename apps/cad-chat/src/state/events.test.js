// events.js 事件→action 映射單元測(node --test,fake dispatch 收集 actions):
// spec/clarify 的字面 \n 防禦正規化與 assumed 透傳、clarify 雙 dispatch。
import assert from "node:assert/strict";
import { test } from "node:test";

import { handleEvent } from "./events.js";

function collect(type, data) {
  const actions = [];
  handleEvent((a) => actions.push(a), type, data);
  return actions;
}

test("spec 事件:ADD_ITEM + SET_TURN_SPEC 雙 dispatch,chips 字面 \\n 已正規化", () => {
  const actions = collect("spec", {
    chips: [{ k: "導軌", v: "HGR15\\n雙軌", assumed: true }],
  });
  assert.equal(actions.length, 2);
  const [add, turn] = actions;
  assert.equal(add.type, "ADD_ITEM");
  assert.equal(add.item.type, "spec");
  assert.equal(add.item.chips[0].v, "HGR15\n雙軌"); // 字面 \n → 真換行
  assert.equal(add.item.chips[0].assumed, true);
  assert.equal(turn.type, "SET_TURN_SPEC");
  assert.deepEqual(turn.chips, add.item.chips); // 兩路吃同一份正規化資料
});

test("lesson_offer 事件:單一 ADD_ITEM、字面 \\n 正規化、不帶 id 鍵(讓 reducer mint)", () => {
  const actions = collect("lesson_offer", {
    symptom: "肋錯位\\n右肋內縮",
    rootCause: "繞向破壞對稱",
    fix: "extrude(..., both=True)",
    tag: "mirror-symmetry",
  });
  assert.equal(actions.length, 1);
  const [add] = actions;
  assert.equal(add.type, "ADD_ITEM");
  assert.equal(add.item.type, "lesson_offer");
  assert.equal(add.item.symptom, "肋錯位\n右肋內縮"); // 字面 \n → 真換行
  assert.equal(add.item.rootCause, "繞向破壞對稱");
  assert.equal(add.item.tag, "mirror-symmetry");
  assert.ok(!("id" in add.item), "不帶 id 鍵,否則覆蓋 chatStore ADD_ITEM mint 的 id");
});

test("version 事件:hasDxf 嚴格 === true 透傳(鈑金 DXF 鈕依據;舊事件無欄位 → false)", () => {
  const on = collect("version", { id: "v1", name: "x", glbUrl: "u", hasDxf: true });
  assert.equal(on[0].version.hasDxf, true);
  const off = collect("version", { id: "v2", name: "x", glbUrl: "u" });
  assert.equal(off[0].version.hasDxf, false);
});

test("version/present 事件:projectDir + flatGlbUrl 透傳(缺 → null)", () => {
  const v = collect("version", { id: "v1", name: "x", glbUrl: "u", projectDir: "d", flatGlbUrl: "f", flatLinesUrl: "ln" });
  assert.equal(v[0].version.projectDir, "d");
  assert.equal(v[0].version.flatGlbUrl, "f");
  assert.equal(v[0].version.flatLinesUrl, "ln");
  const v0 = collect("version", { id: "v2", name: "x", glbUrl: "u" });
  assert.equal(v0[0].version.projectDir, null);
  assert.equal(v0[0].version.flatGlbUrl, null);
  const p = collect("present", { glbUrl: "u", name: "x", code: "x", ver: "o1", projectDir: "d", flatGlbUrl: "f" });
  assert.equal(p[0].projectDir, "d");
  assert.equal(p[0].flatGlbUrl, "f");
});

test("version/present 事件:sweepPathsUrl 透傳(掃出路徑 overlay;缺 → null)", () => {
  const v = collect("version", { id: "v1", name: "x", glbUrl: "u", sweepPathsUrl: "sw" });
  assert.equal(v[0].version.sweepPathsUrl, "sw");
  const v0 = collect("version", { id: "v2", name: "x", glbUrl: "u" });
  assert.equal(v0[0].version.sweepPathsUrl, null);
  const p = collect("present", { glbUrl: "u", name: "x", code: "x", ver: "o1", sweepPathsUrl: "sw" });
  assert.equal(p[0].sweepPathsUrl, "sw");
  const p0 = collect("present", { glbUrl: "u", name: "x", code: "x", ver: "o2" });
  assert.equal(p0[0].sweepPathsUrl, null);
});

test("params_values 事件:SET_PARAM_VALUES 單 dispatch(regen 回滾滑桿拉回);缺 values 給空物件", () => {
  const actions = collect("params_values", { values: { w: 20, h: 10 } });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].type, "SET_PARAM_VALUES");
  assert.deepEqual(actions[0].values, { w: 20, h: 10 });
  const bare = collect("params_values", {});
  assert.deepEqual(bare[0].values, {});
});

test("spec 事件:assumed 只在嚴格 === true 透傳(亂型別不擴散)", () => {
  const actions = collect("spec", {
    chips: [
      { k: "a", v: "1", assumed: "yes" },
      { k: "b", v: "2" },
    ],
  });
  assert.equal("assumed" in actions[0].item.chips[0], false);
  assert.equal("assumed" in actions[0].item.chips[1], false);
});

test("clarify 事件:ADD_ITEM(左欄紀錄)+ SET_CLARIFY(精靈)雙 dispatch,全欄位正規化", () => {
  const actions = collect("clarify", {
    q: "行程已明確\\n・負載:中載", // 使用者截圖的實際症狀
    opts: [{ label: "中載\\n標準", value: "採用中載\\n標準" }],
    suggested: "全部\\n建議值",
  });
  assert.equal(actions.length, 2);
  const [add, set] = actions;
  assert.equal(add.type, "ADD_ITEM");
  assert.equal(add.item.q, "行程已明確\n・負載:中載");
  assert.equal(add.item.opts[0].label, "中載\n標準");
  assert.equal(add.item.opts[0].value, "採用中載\n標準"); // value 會被原樣送回,必須乾淨
  assert.equal(set.type, "SET_CLARIFY");
  assert.equal(set.clarify.q, add.item.q);
  assert.equal(set.clarify.suggested, "全部\n建議值");
});

// ── 草模模式(sketch):session mode 校正、sceneUrl/dofs 透傳、SketchCard 欄位 ──

test("session 事件:帶 mode → SET_SESSION + SET_MODE;無 mode(舊 server)→ 只 SET_SESSION", () => {
  const withMode = collect("session", { sessionId: "s1", mode: "sketch" });
  assert.equal(withMode.length, 2);
  assert.equal(withMode[0].type, "SET_SESSION");
  assert.deepEqual(withMode[1], { type: "SET_MODE", mode: "sketch" });
  const noMode = collect("session", { sessionId: "s1" });
  assert.equal(noMode.length, 1);
  // 非法 mode 值不 dispatch(不讓垃圾進 reducer)
  const bad = collect("session", { sessionId: "s1", mode: "bogus" });
  assert.equal(bad.length, 1);
});

test("version 事件:sceneUrl/dofs/title 透傳(草模);CAD 事件無欄位 → sceneUrl null、dofs undefined", () => {
  const sk = collect("version", {
    id: "v1",
    name: "mech",
    type: "sketch",
    sceneUrl: "/api/asset?file=x.sketch.json&v=1",
    dofs: [{ id: "theta", label: "θ", min: 0, max: 30, unit: "°" }],
    title: "汽缸傾斜",
  })[0].version;
  assert.equal(sk.type, "sketch");
  assert.equal(sk.sceneUrl, "/api/asset?file=x.sketch.json&v=1");
  assert.equal(sk.dofs.length, 1);
  assert.equal(sk.title, "汽缸傾斜");
  assert.equal(sk.glbUrl, undefined); // 草模版無 glbUrl
  const cad = collect("version", { id: "v2", name: "p", glbUrl: "u" })[0].version;
  assert.equal(cad.sceneUrl, null);
  assert.equal(cad.dofs, undefined);
});

test("present 事件:sceneUrl 透傳;artifact 事件:sketch 摘要欄位(title/dofs/joints)進卡片 item", () => {
  const pres = collect("present", { ver: "v1", name: "mech", type: "sketch", sceneUrl: "su" })[0];
  assert.equal(pres.sceneUrl, "su");
  assert.equal(pres.fileType, "sketch");
  const art = collect("artifact", {
    ver: "v1",
    name: "mech",
    type: "sketch",
    partCount: 3,
    title: "汽缸傾斜",
    dofs: [{ id: "theta" }],
    joints: { revolute: 1, prismatic: 0 },
  })[0];
  assert.equal(art.item.fileType, "sketch");
  assert.equal(art.item.title, "汽缸傾斜");
  assert.equal(art.item.dofs.length, 1);
  assert.equal(art.item.joints.revolute, 1);
});

test("session 事件:library mode dispatch SET_MODE", () => {
  const actions = collect("session", { sessionId: "s_library", mode: "library" });
  assert.deepEqual(actions[1], { type: "SET_MODE", mode: "library" });
});
