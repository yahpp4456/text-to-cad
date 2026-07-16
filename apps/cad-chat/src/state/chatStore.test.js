// chatStore reducer 單元測(node --test)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { latestSpecItem, pendingLessonOffer } from "../lib/clarifyText.js";
import { initialState, reducer } from "./chatStore.js";

// ── 人工記教訓「是/否卡」──

test("ADD_ITEM(lesson_offer):mint id、無 answered;ANSWER_LESSON_OFFER 標記該卡", () => {
  let s = reducer(initialState, {
    type: "ADD_ITEM",
    item: { type: "lesson_offer", symptom: "s", fix: "f", tag: "t" },
  });
  const id = s.items[0].id;
  assert.ok(id && s.items[0].answered === undefined);
  s = reducer(s, { type: "ANSWER_LESSON_OFFER", id, outcome: "added" });
  assert.equal(s.items[0].answered, "added");
  // 冪等/純函式:再答覆寫成新結果
  s = reducer(s, { type: "ANSWER_LESSON_OFFER", id, outcome: "skipped" });
  assert.equal(s.items[0].answered, "skipped");
});

test("ANSWER_LESSON_OFFER:不存在 id / 非 lesson_offer 型別 → no-op", () => {
  let s = reducer(initialState, { type: "ADD_ITEM", item: { type: "ai", text: "x" } });
  const aiId = s.items[0].id;
  const before = s.items;
  // 打到 AI 卡的 id(型別不符)→ 不動
  s = reducer(s, { type: "ANSWER_LESSON_OFFER", id: aiId, outcome: "added" });
  assert.deepEqual(s.items, before);
  // 不存在的 id → 不動
  s = reducer(s, { type: "ANSWER_LESSON_OFFER", id: "m999", outcome: "added" });
  assert.deepEqual(s.items, before);
});

// ── 版本 verified stamp(server versionStamp 發;badge / 匯出閘依賴)──
// mode 欄位是雙模式時代遺留:reducer 對未知欄位原樣透傳,不特別處理。

test("ADD_VERSION:保留 verified stamp 原樣", () => {
  const s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "x", verified: false },
  });
  assert.equal(s.versions[0].verified, false);
});

test("ADD_VERSION:撞 id 取代舊物件(對話中途 open-project 的 v1 撞號,伺服端 stamp 不得被吃)", () => {
  let s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "old", verified: false, glbUrl: "a" },
  });
  s = reducer(s, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "projX", verified: true, glbUrl: "b" },
  });
  assert.equal(s.versions.length, 1); // 仍去重(不長出兩個 v1)
  assert.equal(s.versions[0].name, "projX"); // 但以新物件為準
  assert.equal(s.versions[0].verified, true);
  assert.equal(s.versions[0].glbUrl, "b");
  assert.equal(s.activeVer, "v1");
});

test("MARK_VERSION_VERIFIED:標中目標、不動旁人;id 不存在 → no-op", () => {
  let s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "x", verified: false },
  });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "v2", name: "x", verified: false } });
  const marked = reducer(s, { type: "MARK_VERSION_VERIFIED", id: "v2" });
  assert.equal(marked.versions.find((v) => v.id === "v2").verified, true);
  assert.equal(marked.versions.find((v) => v.id === "v1").verified, false); // 旁人不動
  const noop = reducer(s, { type: "MARK_VERSION_VERIFIED", id: "v99" });
  assert.deepEqual(noop.versions, s.versions); // 不存在 → 無變化
});

test("RESTORE:versions 的 verified 三態 normalize(舊快照 → undefined,絕不是 false)", () => {
  const r = reducer(initialState, {
    type: "RESTORE",
    snapshot: {
      sessionId: "s1",
      versions: [
        { id: "v1", name: "old" }, // 舊快照無欄位
        { id: "v2", name: "d", verified: false },
        { id: "v3", name: "a", verified: true },
        { id: "v4", name: "bad", verified: "yes" }, // 非法值
      ],
    },
  });
  // 關鍵:undefined(未知)≠ false(確定未驗證)——預設 false 會讓舊資料全掛琥珀誤報
  assert.equal(r.versions[0].verified, undefined);
  assert.equal(r.versions[1].verified, false);
  assert.equal(r.versions[2].verified, true);
  assert.equal(r.versions[3].verified, undefined); // 非法值收斂成未知
});

test("RESET:versions 清空(verified stamp 不殘留)", () => {
  let s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "x", verified: true },
  });
  s = reducer(s, { type: "RESET" });
  assert.equal(s.versions.length, 0);
});

// ── 同 glbUrl 不重載 → status 必須保留(useCadViewport 只依賴 glbUrl,URL 沒變
//    不會重跑 effect;設 "loading" 就永遠等不到 ready,覆蓋層卡死)──

test("SELECT_VERSION:同 glbUrl 保留 status(點已啟用 chip / 同檔檢視版不卡 loading)", () => {
  let s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "o1", name: "m", glbUrl: "/api/asset?file=a.glb&v=1", source: "opened" },
  });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "o2", name: "m", glbUrl: "/api/asset?file=a.glb&v=1", source: "opened" } });
  s = reducer(s, { type: "SELECT_VERSION", id: "o1" });
  s = reducer(s, { type: "SET_CANVAS_STATUS", status: "ready" }); // viewport 載完
  const same = reducer(s, { type: "SELECT_VERSION", id: "o2" }); // 同 URL 的另一版
  assert.equal(same.canvas.status, "ready"); // 不重載 → 不得退回 loading
  const self = reducer(same, { type: "SELECT_VERSION", id: "o2" }); // 點已啟用 chip
  assert.equal(self.canvas.status, "ready");
  // 守衛語意=「保留現狀不論其值」:error 也要留住(同 URL 不重載,設 loading 一樣卡死)
  const err = reducer(s, { type: "SET_CANVAS_STATUS", status: "error" });
  assert.equal(reducer(err, { type: "SELECT_VERSION", id: "o2" }).canvas.status, "error");
  assert.equal(
    reducer(err, {
      type: "PRESENT", glbUrl: "/api/asset?file=a.glb&v=1", name: "m", code: "m", ver: "o1",
    }).canvas.status,
    "error",
  );
});

test("SELECT_VERSION:換 glbUrl 才設 loading;canvas.code 跟著新版(不繼承舊模型)", () => {
  let s = reducer(initialState, {
    type: "PRESENT",
    glbUrl: "/api/asset?file=a.glb&v=1",
    name: "modelA",
    code: "modelA",
    ver: "v1",
  });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "v1", name: "modelA", glbUrl: "/api/asset?file=a.glb&v=1" } });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "o1", name: "modelB", glbUrl: "/api/asset?file=b.glb&v=9", source: "opened" } });
  s = reducer(s, { type: "SET_CANVAS_STATUS", status: "ready" });
  const sw = reducer(s, { type: "SELECT_VERSION", id: "o1" });
  assert.equal(sw.canvas.status, "loading"); // URL 變了 → 真重載
  assert.equal(sw.canvas.code, "modelB"); // code 不殘留 modelA
});

test("CLEAR_WORKSPACE:版本/運動/參數歸零,對話與 session 保留(對話中途 open-project 換 session 用)", () => {
  let s = reducer(initialState, { type: "SET_SESSION", sessionId: "s1" });
  s = reducer(s, { type: "ADD_ITEM", item: { type: "ai", text: "hi" } });
  s = reducer(s, { type: "ADD_ITEM", item: { type: "spec", chips: [{ k: "外徑", v: "20mm" }] } });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "v1", name: "old", glbUrl: "a" } });
  s = reducer(s, { type: "ADD_VERSION", version: { id: "v2", name: "old", glbUrl: "b" } });
  s = reducer(s, { type: "SET_MOTION", motion: { name: "old", dofs: [{ id: "d" }] } });
  s = reducer(s, { type: "SET_PARAMS", defs: [{ key: "k", value: 1 }] });
  const c = reducer(s, { type: "CLEAR_WORKSPACE" });
  assert.equal(c.versions.length, 0); // 舊 session 的 v* chip 全清(latestGen 不再指死引用)
  assert.equal(c.activeVer, null);
  assert.equal(c.motion, null);
  assert.equal(c.params.defs.length, 0);
  assert.equal(c.items.length, 2); // 對話保留
  assert.equal(c.sessionId, "s1"); // session 由 SET_SESSION 管,這裡不動
  // 換 session=換設計:舊 spec 卡標 stale → latestSpecItem 跳過,視圖 SpecPanel
  // 不再拿舊設計的規格當作答面(否則「套用修正」把無關鍵值打進新 session)
  assert.equal(c.items[1].stale, true);
  assert.equal(latestSpecItem(c.items), null);
  assert.equal(c.items[0].stale, undefined); // 非 spec item 不動
});

test("RESTORE:lesson_offer 樂觀暫態 answered:'pending' 收斂回未答(佇列死鎖防護)", () => {
  // POST 在途時關頁/崩潰 → "pending" 落盤;原樣回灌則視圖面板只渲染「加入中…」
  // 無按鈕,且佇列語意令它永遠擋在最前(聊天卡已是被動紀錄,無任何解鎖路徑)。
  const s = reducer(initialState, {
    type: "RESTORE",
    snapshot: {
      items: [
        { id: "m1", type: "lesson_offer", symptom: "x", answered: "pending" },
        { id: "m2", type: "lesson_offer", symptom: "y", answered: "added" },
      ],
    },
  });
  assert.equal(s.items[0].answered, null); // 收斂回未答 → 按鈕恢復可重試
  assert.equal(s.items[1].answered, "added"); // 已定案的不動
  assert.equal(pendingLessonOffer(s.items)?.id, "m1");
});

test("SET_PARAM_VALUES:只 merge defs 已知鍵、清 dirty;defs 空 no-op(regen 回滾滑桿拉回)", () => {
  let s = reducer(initialState, {
    type: "SET_PARAMS",
    defs: [
      { key: "w", value: 20 },
      { key: "h", value: 10 },
    ],
  });
  s = reducer(s, { type: "SET_PARAM_VALUE", key: "w", value: 5 }); // 使用者拉壞值
  assert.equal(s.params.dirty, true);
  const back = reducer(s, { type: "SET_PARAM_VALUES", values: { w: 20, ghost: 99, bad: NaN } });
  assert.equal(back.params.values.w, 20); // 拉回磁碟真相
  assert.equal(back.params.values.h, 10); // 未提及鍵不動
  assert.ok(!("ghost" in back.params.values)); // 未知鍵不長新滑桿值
  assert.equal(back.params.dirty, false); // 目前值=磁碟值,無未套用調整
  assert.deepEqual(back.params.defs, s.params.defs); // defs 不動(emit_params 品質保留)

  // defs 空(尚無滑桿)→ no-op
  const empty = reducer(initialState, { type: "SET_PARAM_VALUES", values: { w: 1 } });
  assert.equal(empty, initialState);
});

test("PRESENT:同 glbUrl 保留 status(重複開同一檔 re-present 不卡 loading)", () => {
  const URL = "/api/asset?file=a.glb&v=1";
  let s = reducer(initialState, { type: "PRESENT", glbUrl: URL, name: "m", code: "m", ver: "o1" });
  assert.equal(s.canvas.status, "loading"); // 首載照常 loading
  s = reducer(s, { type: "SET_CANVAS_STATUS", status: "ready" });
  const again = reducer(s, { type: "PRESENT", glbUrl: URL, name: "m", code: "m", ver: "o1" });
  assert.equal(again.canvas.status, "ready");
  const changed = reducer(s, { type: "PRESENT", glbUrl: `${URL.split("&v=")[0]}&v=2`, name: "m", code: "m", ver: "o1" });
  assert.equal(changed.canvas.status, "loading"); // mtime buster 變了 → 真重載
});

test("canvas.flatGlbUrl:PRESENT 帶入、切版本沿用、非鈑金版歸 null(摺疊/攤平切換依據)", () => {
  let s = reducer(initialState, {
    type: "PRESENT", glbUrl: "/f.glb", name: "u", code: "u", ver: "v1",
    flatGlbUrl: "/f.flat.glb", flatLinesUrl: "/f.lines.json",
  });
  assert.equal(s.canvas.flatGlbUrl, "/f.flat.glb");
  assert.equal(s.canvas.flatLinesUrl, "/f.lines.json"); // 折彎線 sidecar 同路透傳
  // 一般產出無 flatGlbUrl → null(不繼承)
  const gen = reducer(s, { type: "PRESENT", glbUrl: "/g.glb", name: "g", code: "g", ver: "v2" });
  assert.equal(gen.canvas.flatGlbUrl, null);
  // 切版帶回該版 flatGlbUrl
  let s2 = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "u", glbUrl: "/f.glb", flatGlbUrl: "/f.flat.glb" },
  });
  s2 = reducer(s2, { type: "ADD_VERSION", version: { id: "v2", name: "g", glbUrl: "/g.glb" } });
  assert.equal(reducer(s2, { type: "SELECT_VERSION", id: "v1" }).canvas.flatGlbUrl, "/f.flat.glb");
  assert.equal(reducer(s2, { type: "SELECT_VERSION", id: "v2" }).canvas.flatGlbUrl, null);
});

test("canvas.sweepPathsUrl:PRESENT 帶入、切版帶回該版、無掃出版歸 null(路徑 overlay 依據)", () => {
  let s = reducer(initialState, {
    type: "PRESENT", glbUrl: "/s.glb", name: "sl", code: "sl", ver: "v1",
    sweepPathsUrl: "/s.sweep.json",
  });
  assert.equal(s.canvas.sweepPathsUrl, "/s.sweep.json");
  // 一般產出無 sweepPathsUrl → null(不繼承,chip 不誤亮)
  const gen = reducer(s, { type: "PRESENT", glbUrl: "/g.glb", name: "g", code: "g", ver: "v2" });
  assert.equal(gen.canvas.sweepPathsUrl, null);
  // 切版帶回該版 sweepPathsUrl(RESTORE 走 spread 自動存活)
  let s2 = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "sl", glbUrl: "/s.glb", sweepPathsUrl: "/s.sweep.json" },
  });
  s2 = reducer(s2, { type: "ADD_VERSION", version: { id: "v2", name: "g", glbUrl: "/g.glb" } });
  assert.equal(reducer(s2, { type: "SELECT_VERSION", id: "v1" }).canvas.sweepPathsUrl, "/s.sweep.json");
  assert.equal(reducer(s2, { type: "SELECT_VERSION", id: "v2" }).canvas.sweepPathsUrl, null);
});

test("canvas.projectDir:openFile 唯讀檢視帶入、切版本沿用、一般產出歸 null", () => {
  // openFile PRESENT 帶 projectDir(唯讀但屬可編輯專案)→ submitText 據此自動帶入編輯
  let s = reducer(initialState, {
    type: "PRESENT", glbUrl: "/a.glb", name: "u_bracket", code: "u_bracket",
    ver: "o1", source: "opened", projectDir: "sheet_u_bracket",
  });
  assert.equal(s.canvas.projectDir, "sheet_u_bracket");
  assert.equal(s.canvas.source, "opened");
  // 一般 SSE 產出 present 無 projectDir → null(不繼承)
  const gen = reducer(s, { type: "PRESENT", glbUrl: "/b.glb", name: "g", code: "g", ver: "v1" });
  assert.equal(gen.canvas.projectDir, null);
  // 切回唯讀檢視版:版本物件的 projectDir 帶回 canvas
  let s2 = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "o1", name: "u", glbUrl: "/a.glb", source: "opened", projectDir: "sheet_u_bracket" },
  });
  s2 = reducer(s2, { type: "ADD_VERSION", version: { id: "v1", name: "g", glbUrl: "/b.glb", source: "generated" } });
  const back = reducer(s2, { type: "SELECT_VERSION", id: "o1" });
  assert.equal(back.canvas.projectDir, "sheet_u_bracket");
  const fwd = reducer(back, { type: "SELECT_VERSION", id: "v1" });
  assert.equal(fwd.canvas.projectDir, null); // 生成版無 projectDir
});

// ── 兩步澄清精靈:turnSpec / SET_CLARIFY(mint id + 併 specs)/ RESTORE re-arm ──

const CHIPS = [{ k: "導軌", v: "HGR15", assumed: true }];

test("SET_TURN_SPEC 寫入;START_RUN 清空(精靈只信本回合的規格快照)", () => {
  let s = reducer(initialState, { type: "SET_TURN_SPEC", chips: CHIPS });
  assert.deepEqual(s.turnSpec, CHIPS);
  s = reducer(s, { type: "START_RUN" });
  assert.equal(s.turnSpec, null);
});

test("SET_CLARIFY:mint 遞增 id + 併 turnSpec 成 specs;連兩次 id 不同(remount key)", () => {
  let s = reducer(initialState, { type: "SET_TURN_SPEC", chips: CHIPS });
  s = reducer(s, { type: "SET_CLARIFY", clarify: { q: "q1", opts: [], suggested: "" } });
  assert.ok(s.clarify.id);
  assert.deepEqual(s.clarify.specs, CHIPS);
  const firstId = s.clarify.id;
  s = reducer(s, { type: "SET_CLARIFY", clarify: { q: "q2", opts: [], suggested: "" } });
  assert.notEqual(s.clarify.id, firstId); // 跨回合連續 clarify → 精靈 remount
  // 煙測注入可覆寫 specs(action.clarify 的 specs 蓋掉 turnSpec)
  const injected = reducer(initialState, {
    type: "SET_CLARIFY",
    clarify: { q: "q", opts: [], suggested: "", specs: CHIPS },
  });
  assert.deepEqual(injected.clarify.specs, CHIPS);
  // 無 turnSpec 的回合 → specs null(精靈退化單步)
  const noSpec = reducer(initialState, {
    type: "SET_CLARIFY",
    clarify: { q: "q", opts: [], suggested: "" },
  });
  assert.equal(noSpec.clarify.specs, null);
});

test("ADD_USER:清 clarify(任何送出=已回答;精靈 unmount)+ images 欄位保留", () => {
  let s = reducer(initialState, {
    type: "SET_CLARIFY",
    clarify: { q: "q", opts: [], suggested: "" },
  });
  s = reducer(s, {
    type: "ADD_USER",
    text: "答案",
    images: [{ url: "/api/asset?file=x.png", name: "x.png" }],
  });
  assert.equal(s.clarify, null);
  const user = s.items[s.items.length - 1];
  assert.equal(user.images.length, 1);
  assert.equal(user.images[0].name, "x.png");
  // 無 images 的送出 → 空陣列(渲染端不需 null guard)
  const plain = reducer(initialState, { type: "ADD_USER", text: "hi" });
  assert.deepEqual(plain.items[0].images, []);
});

test("RESTORE:未答 clarify → re-arm 精靈(含同段 specs);已答 → 不 re-arm", () => {
  const spec = { type: "spec", id: "m1", chips: CHIPS };
  const clarify = { type: "clarify", id: "m2", q: "選?", opts: [{ label: "A", value: "a" }], suggested: "s" };
  const pendingSnap = {
    sessionId: "s1",
    items: [{ type: "user", id: "m0", text: "hi" }, spec, clarify],
  };
  const r = reducer(initialState, { type: "RESTORE", snapshot: pendingSnap });
  assert.ok(r.clarify); // 重整後精靈+凍結一致重現
  assert.equal(r.clarify.q, "選?");
  assert.deepEqual(r.clarify.specs, CHIPS);
  assert.ok(r.clarify.id);

  const answeredSnap = {
    sessionId: "s1",
    items: [spec, clarify, { type: "user", id: "m3", text: "A" }],
  };
  const r2 = reducer(initialState, { type: "RESTORE", snapshot: answeredSnap });
  assert.equal(r2.clarify, null);
});

test("RESET:clarify / turnSpec 全清", () => {
  let s = reducer(initialState, { type: "SET_TURN_SPEC", chips: CHIPS });
  s = reducer(s, { type: "SET_CLARIFY", clarify: { q: "q", opts: [], suggested: "" } });
  s = reducer(s, { type: "RESET" });
  assert.equal(s.clarify, null);
  assert.equal(s.turnSpec, null);
});

// ── 草模模式(mode / canvas.sceneUrl)──

test("SET_MODE:sketch/design 正常切;非法值收斂 design;RESET 保留 mode", () => {
  let s = reducer(initialState, { type: "SET_MODE", mode: "sketch" });
  assert.equal(s.mode, "sketch");
  s = reducer(s, { type: "SET_MODE", mode: "bogus" });
  assert.equal(s.mode, "design");
  s = reducer(s, { type: "SET_MODE", mode: "sketch" });
  s = reducer(s, { type: "RESET" });
  assert.equal(s.mode, "sketch"); // 新對話沿用當前模式
  assert.equal(s.items.length, 0);
});

test("PRESENT(sketch):canvas 帶 sceneUrl、glbUrl 空、type sketch、status loading", () => {
  const s = reducer(initialState, {
    type: "PRESENT",
    glbUrl: "",
    sceneUrl: "su1",
    name: "mech",
    ver: "v1",
    fileType: "sketch",
  });
  assert.equal(s.canvas.sceneUrl, "su1");
  assert.equal(s.canvas.glbUrl, "");
  assert.equal(s.canvas.type, "sketch");
  assert.equal(s.canvas.status, "loading");
  // 同 sceneUrl re-present → status 保留(SketchCanvas3D 只依賴 sceneUrl,URL 沒變不重載)
  const ready = { ...s, canvas: { ...s.canvas, status: "ready" } };
  const again = reducer(ready, {
    type: "PRESENT",
    sceneUrl: "su1",
    name: "mech",
    ver: "v1",
    fileType: "sketch",
  });
  assert.equal(again.canvas.status, "ready");
});

test("SELECT_VERSION:草模↔CAD 版互切,sceneUrl/glbUrl 正確帶回;同 sceneUrl 保留 status", () => {
  let s = reducer(initialState, {
    type: "ADD_VERSION",
    version: { id: "v1", name: "mech", sceneUrl: "su1", type: "sketch" },
  });
  s = reducer(s, {
    type: "ADD_VERSION",
    version: { id: "v2", name: "part", glbUrl: "gu2", type: "part" },
  });
  // 切回草模版
  s = reducer(s, { type: "SELECT_VERSION", id: "v1" });
  assert.equal(s.canvas.sceneUrl, "su1");
  assert.equal(s.canvas.glbUrl, "");
  assert.equal(s.canvas.type, "sketch");
  assert.equal(s.canvas.status, "loading");
  // 同 sceneUrl 再點 → status 保留
  s = { ...s, canvas: { ...s.canvas, status: "ready" } };
  s = reducer(s, { type: "SELECT_VERSION", id: "v1" });
  assert.equal(s.canvas.status, "ready");
  // 切到 CAD 版:sceneUrl 歸 null、glbUrl 帶回
  s = reducer(s, { type: "SELECT_VERSION", id: "v2" });
  assert.equal(s.canvas.sceneUrl, null);
  assert.equal(s.canvas.glbUrl, "gu2");
  assert.equal(s.canvas.status, "loading");
});

test("RESTORE:mode normalize(舊快照無欄位 → design);canvas 只有 sceneUrl 也算有內容", () => {
  const legacy = reducer(initialState, { type: "RESTORE", snapshot: { sessionId: "s1" } });
  assert.equal(legacy.mode, "design");
  const sk = reducer(initialState, {
    type: "RESTORE",
    snapshot: {
      sessionId: "s2",
      mode: "sketch",
      canvas: { sceneUrl: "su1", name: "mech", ver: "v1", type: "sketch" },
      versions: [{ id: "v1", name: "mech", sceneUrl: "su1", type: "sketch" }],
    },
  });
  assert.equal(sk.mode, "sketch");
  assert.equal(sk.canvas.sceneUrl, "su1");
  assert.equal(sk.canvas.status, "loading"); // 回灌走重載
  assert.equal(sk.versions[0].sceneUrl, "su1");
});
