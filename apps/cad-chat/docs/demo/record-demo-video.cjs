// cad-chat 功能介紹影片錄製腳本(Playwright,免 LLM:agent 回合由腳本以 store action 重演,
// 3D 幾何是 models/ 下的真實 GLB)。產出 1920×1080 webm,再用 ffmpeg 轉 mp4。
//
// 以 DEMO 身分錄(頁面帶 X-Remote-User: demo → 切換器無「無塵電纜」分頁、受限入口反灰)。
//
// 前置:
//   - dev server 跑在 8788,env 帶 ANTHROPIC_API_KEY 與 CADCHAT_DEMO_API_KEY(值可假,/api/chat 全程被 stub)
//   - LFS GLB 為實體檔:models/flip_gripper、models/sheet_box_flat_test、models/stewart_platform
//     (stewart 由 `.venv/bin/python skills/cad/scripts/step models/stewart_platform/stewart_platform.py --force` 產)
//   - models/.cadchat/demo_video/gripper.sketch.json = src/lib/sketch/fixtures/gripper_pickplace.json 的複本
//   - models/.cadchat/demo_video/fg_v2、fg_v3:flip_gripper.py 複本改 PARAMS(v2 finger_len=50/finger_t=10;
//     v3 再加 grip_open=40)後各跑一次 scripts/step —— v2/v3 的畫布幾何是真重生的
//   - models/.cadchat/demo_video/box/:sheet_box_flat_test/box.py 複本,用修復後的 flat_glb.py 重產攤平 GLB
//     (`.venv/bin/python apps/cad-chat/src/server/cad/flat_glb.py <box.py> <.box.flat.step.glb>`;tracked fixture 的攤平 GLB 無拓撲)
// 用法:NODE_PATH=$(npm root -g) node apps/cad-chat/docs/demo/record-demo-video.cjs <outDir>
//       (需要全域 playwright + chromium;DEMO_SPEED=8 可快轉做除錯;DEMO_USER 可換 header 帳號)
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require("playwright");

const BASE = process.env.CADCHAT_BASE || "http://127.0.0.1:8788";
const OUT = process.argv[2] || path.join(__dirname, "video-out");
fs.mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080;
const SPEED = Number(process.env.DEMO_SPEED || 1); // >1 = 快轉(除錯用)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms / SPEED));
const glb = (rel, v) => `/api/asset?file=${encodeURIComponent(rel)}${v ? `&v=${v}` : ""}`;

// ---------- 事件資料 ----------
const FLIP_DOFS = [
  { id: "jl", label: "左爪夾合", type: "linear", axis: [1, 0, 0], travel: 8, moving: ["jaw_left", "finger_left"], pairs: [["jaw_left", "gripper_body"]], samples: 8 },
  { id: "jr", label: "右爪夾合", type: "linear", axis: [-1, 0, 0], travel: 8, moving: ["jaw_right", "finger_right"], pairs: [["jaw_right", "gripper_body"]], samples: 8 },
  { id: "flip", label: "90° 前傾翻轉", type: "revolute", axis: [0, 1, 0], pivot: [0, 0, -31], angle_deg: 90,
    moving: ["rotary_hub", "swing_bracket", "gripper_body", "jaw_left", "jaw_right", "finger_left", "finger_right"],
    pairs: [["swing_bracket", "rotary_body"], ["gripper_body", "rotary_body"], ["finger_left", "rotary_body"], ["finger_right", "rotary_body"]], samples: 24 },
];
const FLIP_PARAMS = [
  { key: "flip_deg", label: "翻轉角 flip_deg", min: 0, max: 180, step: 1, value: 90, unit: "°" },
  { key: "jaw_stroke", label: "爪行程 jaw_stroke", min: 2, max: 16, step: 0.5, value: 8, unit: "mm" },
  { key: "grip_open", label: "開口 grip_open", min: 20, max: 60, step: 1, value: 34, unit: "mm" },
  { key: "finger_len", label: "指長 finger_len", min: 20, max: 80, step: 1, value: 40, unit: "mm" },
  { key: "flange_d", label: "法蘭徑 flange_d", min: 40, max: 80, step: 1, value: 50, unit: "mm" },
];
const STEWART_MOVING = ["platform", "leg0_rod", "leg1_rod", "leg2_rod", "leg3_rod", "leg4_rod", "leg5_rod"];
const STEWART_DOFS = [
  { id: "heave", label: "平台升降", type: "linear", axis: [0, 0, 1], travel: 20, moving: STEWART_MOVING, samples: 8 },
  { id: "tilt", label: "平台俯仰", type: "revolute", axis: [1, 0, 0], pivot: [0, 0, 235], angle_deg: 6, moving: STEWART_MOVING, samples: 12 },
];
const CHECK = (label, state, note) => ({
  label,
  icon: state === "ok" ? "✓" : state === "skip" ? "–" : "✗",
  color: state === "ok" ? "#34ab86" : state === "skip" ? "#a3acba" : "#d64848",
  note,
  skipped: state === "skip",
});
const QUICK_CHECKS_FOR = (partCount, dofs) => [
  CHECK("封閉性 / 有效實體 (watertight)", "skip", "設計模式:略過驗證(未驗證)"),
  CHECK("自交 self-intersection", "skip", "未支援獨立檢查"),
  CHECK("零件干涉 interference", "skip", partCount >= 2 ? "設計模式:略過驗證(未驗證)" : "單一零件,無需檢查"),
  CHECK("運動掃掠干涉 motion-sweep", "skip", dofs ? "設計模式:略過掃掠(未驗證)" : "未提供運動學"),
  CHECK("壁厚 wall-thickness", "skip", "pipeline 未支援"),
  CHECK("拓撲 / 尺寸 topology", "skip", "設計模式:略過檢查(未驗證)"),
];
const QUICK_CHECKS = QUICK_CHECKS_FOR(9, true);
const FULL_CHECKS = [
  CHECK("封閉性 / 有效實體 (watertight)", "ok", "BRepCheck valid"),
  CHECK("自交 self-intersection", "skip", "未支援獨立檢查"),
  CHECK("零件干涉 interference", "ok", "0 undeclared overlaps · 8 對宣告接觸(allowed)"),
  CHECK("運動掃掠干涉 motion-sweep", "ok", "掃 3 DOF · 8 對 · 40/40 幀 · 0 穿透(baseline=seated)"),
  CHECK("壁厚 wall-thickness", "skip", "pipeline 未支援"),
  CHECK("拓撲 / 尺寸 topology", "ok", "9 件 · 包絡 68 × 46 × 136 mm"),
];
const BUILD_CODE = `# flip_gripper.py — 機械臂末端 90° 翻轉夾爪(cadpy.assembly)
PARAMS = {
    "flange_d": 50.0,     # ISO 9409-1 法蘭外徑
    "rotary_h": 46.0,     # 旋轉缸本體高
    "grip_open": 34.0,    # 指內面開口
    "jaw_stroke": 8.0,    # 單爪夾合行程
    "finger_len": 40.0,
    "flip_deg": 90.0,     # 翻轉角
}

MOTION = {
    "schemaVersion": 1,
    "dofs": [
        {"id": "jl", "type": "linear", "axis": [1, 0, 0],
         "travel": PARAMS["jaw_stroke"], "moving": ["jaw_left", "finger_left"]},
        {"id": "flip", "type": "revolute", "axis": [0, 1, 0],
         "pivot": [0, 0, -31.0], "angle_deg": PARAMS["flip_deg"],
         "moving": ["rotary_hub", "swing_bracket", "gripper_body", ...]},
    ],
}

def gen_step():
    asm = AssemblyHelper()
    asm.add(_flange(), "arm_flange")
    asm.add(_rotary_body(), "rotary_body")
    asm.add(_swing_bracket(), "swing_bracket")
    asm.add(_gripper_body(), "gripper_body")
    asm.add(_jaw(-1), "jaw_left"); asm.add(_jaw(1), "jaw_right")
    ...`;
const SHEET_CODE = `# sheet_box.py — 鈑金四邊立邊盒(cadpy.parts.SheetMetal)
PARAMS = {"box_w": 120.0, "box_d": 80.0, "box_h": 40.0, "thick": 1.5,
          "bend_r": 2.0, "k_factor": 0.44, "hole_d": 20.0}

def _check_params():
    p = PARAMS
    inset = p["bend_r"] + p["thick"]
    if p["box_w"] <= 4 * inset or p["box_d"] <= 4 * inset:
        raise ValueError("外形太小:四邊 inside 折彎各吃掉 R+t,底板會退化")

def _sheet():
    s = SheetMetal(thickness=PARAMS["thick"], bend_radius=PARAMS["bend_r"],
                   k_factor=PARAMS["k_factor"])
    s.base(PARAMS["box_w"], PARAMS["box_d"], placement="inside")
    for edge in ("+x", "-x", "+y", "-y"):
        s.fold(edge, length=PARAMS["box_h"], angle=90)   # 自動角隅避讓
    s.hole((PARAMS["box_w"] / 2, PARAMS["box_d"] / 2), d=PARAMS["hole_d"])
    return s

def gen_step(): return _sheet().folded()
def gen_flat(): return _sheet().flat()
def gen_dxf():  return _sheet().dxf()   # CUT / BEND_UP_90 分層`;
const STEWART_CODE = `# stewart_platform.py — 六軸並聯史都華平台(6-UPS,cadpy.assembly)
PARAMS = {
    "base_r": 170.0, "base_joint_r": 150.0,   # 底座板 / 球鉸分佈半徑
    "plat_r": 120.0, "plat_joint_r": 100.0,   # 動平台 / 球鉸分佈半徑
    "height": 230.0,                           # 平台底面高度(home)
    "pair_half_deg": 15.0,                     # 每對球鉸半夾角
    "cyl_r": 18.0, "bore_r": 8.0, "rod_r": 7.0, "ball_r": 14.0,
    "heave": 20.0, "tilt_deg": 6.0,
}
# 六腿交錯相連成三組「八」字(標準 6-6 構型)
_BASE_DEG = [15, 105, 135, 225, 255, 345]
_PLAT_DEG = [45, 75, 165, 195, 285, 315]

def _leg_cyl(a, b):                     # 底座球鉸 + 缸筒(一體)
    u, L = _unit(a, b)
    barrel = _along(a, u, PARAMS["cyl_r"], 0.55 * L)
    barrel -= _along(a + 22 * u, u, PARAMS["bore_r"], 0.55 * L)
    return Pos(*a) * Sphere(PARAMS["ball_r"]) + barrel

def _leg_rod(a, b):                     # 活塞桿 + 平台球鉸(一體)
    u, L = _unit(a, b)
    return _along(b, -u, PARAMS["rod_r"], 0.62 * L) + Pos(*b) * Sphere(12)

MOTION = {"schemaVersion": 1, "dofs": [
    {"id": "heave", "type": "linear", "axis": [0, 0, 1], "travel": PARAMS["heave"],
     "moving": ["platform", *[f"leg{k}_rod" for k in range(6)]]},
    {"id": "tilt", "type": "revolute", "axis": [1, 0, 0], "pivot": [0, 0, 235],
     "angle_deg": PARAMS["tilt_deg"], "moving": [...]},
]}

def gen_step():
    asm = AssemblyHelper("stewart_platform")
    asm.add(_base(), "base"); asm.add(_platform(), "platform")
    for k, (a, b) in enumerate(_legs()):
        asm.add(_leg_cyl(a, b), f"leg{k}_cyl")
        asm.add(_leg_rod(a, b), f"leg{k}_rod")
    return asm.build()`;

// ---------- 頁面內 overlay + 事件重演 ----------
const INSTALL = () => {
  if (window.__demo) return;
  const root = document.createElement("div");
  root.id = "demo-overlay";
  root.innerHTML = `
  <style>
    #demo-overlay{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:"Noto Sans TC","PingFang TC","Microsoft JhengHei","WenQuanYi Zen Hei",sans-serif}
    #demo-cap{position:absolute;left:50%;bottom:176px;transform:translateX(-50%);max-width:1180px;padding:12px 26px;border-radius:14px;
      background:rgba(17,20,28,.86);color:#fff;font-size:27px;line-height:1.35;letter-spacing:.02em;opacity:0;transition:opacity .28s;text-align:center;
      box-shadow:0 8px 30px rgba(0,0,0,.25);white-space:pre-line}
    #demo-cap[data-on="1"]{opacity:1}
    #demo-cap b{color:#ffd166;font-weight:700}
    #demo-card{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;
      background:radial-gradient(1200px 700px at 30% 20%,#243b5a 0%,#0f172a 60%,#0b1220 100%);color:#fff;opacity:0;transition:opacity .55s}
    #demo-card[data-on="1"]{opacity:1}
    #demo-card .k{font-size:22px;letter-spacing:.35em;color:#8ab4f8;text-transform:uppercase}
    #demo-card .t{font-size:84px;font-weight:800;letter-spacing:.04em;text-shadow:0 6px 30px rgba(0,0,0,.4)}
    #demo-card .s{font-size:36px;color:#dbe4f3;font-weight:400}
    #demo-card .l{margin-top:18px;font-size:30px;color:#dbe4f3;line-height:1.75;text-align:left}
    #demo-card .l div::before{content:"◆";color:#ffd166;margin-right:14px;font-size:20px}
    #demo-cursor{position:absolute;left:0;top:0;width:34px;height:34px;transform:translate(-4px,-3px);transition:left .38s cubic-bezier(.2,.7,.2,1),top .38s cubic-bezier(.2,.7,.2,1);
      filter:drop-shadow(0 2px 3px rgba(0,0,0,.45))}
    .demo-ripple{position:absolute;width:14px;height:14px;border-radius:50%;border:3px solid #ffd166;transform:translate(-50%,-50%);animation:demo-rip .5s ease-out forwards}
    @keyframes demo-rip{from{opacity:.95;width:14px;height:14px}to{opacity:0;width:70px;height:70px}}
    .demo-hl{position:absolute;border:4px solid #ffd166;border-radius:12px;box-shadow:0 0 0 6px rgba(255,209,102,.18),0 0 40px rgba(255,209,102,.35);opacity:0;transition:opacity .25s}
    .demo-hl[data-on="1"]{opacity:1}
    .demo-hl span{position:absolute;left:-4px;top:-46px;background:#ffd166;color:#1a1a1a;font-size:24px;font-weight:700;padding:4px 14px;border-radius:8px;white-space:nowrap}
  </style>
  <div id="demo-card"><div class="k"></div><div class="t"></div><div class="s"></div><div class="l"></div></div>
  <div id="demo-cap"></div>
  <svg id="demo-cursor" viewBox="0 0 24 24"><path d="M4 2 L4 19 L8.5 15 L11.5 22 L14.5 20.5 L11.5 13.8 L17.5 13.6 Z" fill="#fff" stroke="#111" stroke-width="1.6" stroke-linejoin="round"/></svg>`;
  document.body.appendChild(root);
  const cap = root.querySelector("#demo-cap");
  const card = root.querySelector("#demo-card");
  const cur = root.querySelector("#demo-cursor");
  cur.style.left = "960px"; cur.style.top = "600px";
  const hls = [];
  const D = (a) => window.__cadDispatch(a);
  window.__demo = {
    caption(html) { if (!html) { cap.dataset.on = "0"; return; } cap.innerHTML = html; cap.dataset.on = "1"; },
    card(o) {
      if (!o) { card.dataset.on = "0"; return; }
      card.querySelector(".k").textContent = o.kicker || "";
      card.querySelector(".t").textContent = o.title || "";
      card.querySelector(".s").textContent = o.sub || "";
      card.querySelector(".l").innerHTML = (o.lines || []).map((l) => `<div>${l}</div>`).join("");
      card.dataset.on = "1";
    },
    cursor(x, y) { cur.style.left = x + "px"; cur.style.top = y + "px"; },
    click(x, y) { const r = document.createElement("div"); r.className = "demo-ripple"; r.style.left = x + "px"; r.style.top = y + "px"; root.appendChild(r); setTimeout(() => r.remove(), 600); },
    highlight(sel, label) {
      const el = document.querySelector(sel); if (!el) return false;
      const b = el.getBoundingClientRect();
      const h = document.createElement("div"); h.className = "demo-hl";
      h.style.left = (b.left - 6) + "px"; h.style.top = (b.top - 6) + "px"; h.style.width = (b.width + 4) + "px"; h.style.height = (b.height + 4) + "px";
      if (label) { const s = document.createElement("span"); s.textContent = label; h.appendChild(s); }
      root.appendChild(h); hls.push(h); requestAnimationFrame(() => (h.dataset.on = "1")); return true;
    },
    clearHighlights() { for (const h of hls.splice(0)) { h.dataset.on = "0"; setTimeout(() => h.remove(), 300); } },
    // SSE 事件 → store action(鏡射 src/state/events.js)
    ev(type, d = {}) {
      switch (type) {
        case "stage": return D({ type: "SET_STAGE", index: d.index });
        case "ai_start": return D({ type: "AI_STREAM_START" });
        case "ai_delta": return D({ type: "AI_STREAM_DELTA", text: d.text || "" });
        case "busy": return D({ type: "SET_LIVE", live: { text: d.text } });
        case "ai": return D({ type: "AI_FINALIZE", text: d.text });
        case "spec": { D({ type: "ADD_ITEM", item: { type: "spec", chips: d.chips } }); return D({ type: "SET_TURN_SPEC", chips: d.chips }); }
        case "plan": return D({ type: "ADD_ITEM", item: { type: "plan", steps: d.steps, count: d.steps.length, open: true } });
        case "clarify": { D({ type: "ADD_ITEM", item: { type: "clarify", q: d.q, opts: d.opts, suggested: d.suggested } }); return D({ type: "SET_CLARIFY", clarify: { q: d.q, opts: d.opts, suggested: d.suggested } }); }
        case "tool": return D({ type: "UPSERT_TOOL", id: d.id, patch: d });
        case "validate": return D({ type: "ADD_ITEM", item: { type: "validate", ok: d.ok, attempt: d.attempt, ms: d.ms, partCount: d.partCount, checks: d.checks } });
        case "artifact": return D({ type: "ADD_ITEM", item: { type: "artifact", ver: d.ver, name: d.name, code: d.code, ghost: d.ghost, formats: d.formats || [], fileType: d.type || "", partCount: d.partCount, title: d.title, dofs: d.dofs, joints: d.joints } });
        case "version": return D({ type: "ADD_VERSION", version: { id: d.id, name: d.name, glbUrl: d.glbUrl, file: d.file, formats: d.formats || [], type: d.type || "", partCount: d.partCount, source: d.source || "generated", snapshot: d.snapshot, hasDxf: d.hasDxf === true, flatGlbUrl: d.flatGlbUrl ?? null, flatLinesUrl: d.flatLinesUrl ?? null, sweepPathsUrl: null, projectDir: null, sceneUrl: d.sceneUrl ?? null, dofs: d.dofs, title: d.title, mode: d.mode === "design" ? "design" : undefined, verified: typeof d.verified === "boolean" ? d.verified : undefined } });
        case "present": return D({ type: "PRESENT", glbUrl: d.glbUrl, name: d.name, code: d.code, ver: d.ver, fileType: d.type || "", source: d.source || undefined, projectDir: null, flatGlbUrl: d.flatGlbUrl ?? null, flatLinesUrl: d.flatLinesUrl ?? null, sweepPathsUrl: null, sceneUrl: d.sceneUrl ?? null });
        case "params": return D({ type: "SET_PARAMS", defs: d.defs });
        case "motion": return D({ type: "SET_MOTION", motion: d });
        default: return null;
      }
    },
  };
};

(async () => {
  const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--font-render-hinting=none"] });
  const ctx = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: OUT, size: { width: W, height: H } },
    locale: "zh-TW",
    // DEMO 身分(反代注入的 header):切換器不渲染無塵電纜分頁、受限入口反灰。
    extraHTTPHeaders: { "X-Remote-User": process.env.DEMO_USER || "demo" },
  });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errs.push("console: " + m.text()); });

  // ---- /api/chat:攔住 POST,等腳本把回合「演」完才回 session 事件(期間 UI 維持 running) ----
  let chatWaiters = [];
  let pendingRoute = null;
  await page.route("**/api/chat", (route) => {
    pendingRoute = route;
    const w = chatWaiters.splice(0); w.forEach((r) => r(route));
  });
  const waitChat = () => (pendingRoute ? Promise.resolve(pendingRoute) : new Promise((r) => chatWaiters.push(r)));
  const finishChat = async (sessionId) => {
    const r = pendingRoute; pendingRoute = null;
    await r.fulfill({ status: 200, headers: { "content-type": "text/event-stream" }, body: `event: session\ndata: ${JSON.stringify({ sessionId })}\n\n` });
  };
  await page.route("**/api/interrupt", (r) => r.fulfill({ status: 200, contentType: "application/json", body: "{}" }));
  await page.route("**/api/validate", async (r) => {
    await sleep(2600);
    r.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ ok: true, validateOk: true, partCount: 9, checks: FULL_CHECKS, motion: { dofs: FLIP_DOFS } }) });
  });

  // ---- helpers ----
  const $ = (sel) => page.locator(sel).first();
  const bbox = async (sel) => { const b = await $(sel).boundingBox(); if (!b) throw new Error("no bbox: " + sel); return b; };
  const demo = (fn, ...args) => page.evaluate(({ fn, args }) => window.__demo[fn](...args), { fn, args });
  const ev = (type, d) => page.evaluate(({ type, d }) => window.__demo.ev(type, d), { type, d });
  const cap = async (html, ms = 0) => { await demo("caption", html); if (ms) await sleep(ms); };
  const capOff = () => demo("caption", "");
  const card = async (o, ms) => { await demo("card", o); await sleep(ms); await demo("card", null); await sleep(600); };
  let cx = 960, cy = 600;
  const moveTo = async (x, y, ms = 450) => { cx = x; cy = y; await demo("cursor", x, y); await page.mouse.move(x, y, { steps: 10 }); await sleep(ms); };
  const clickAt = async (x, y, after = 500) => { await moveTo(x, y); await demo("click", x, y); await page.mouse.click(x, y); await sleep(after); };
  const clickSel = async (sel, after = 500, fx = 0.5, fy = 0.5) => { const b = await bbox(sel); await clickAt(b.x + b.width * fx, b.y + b.height * fy, after); };
  const hoverSel = async (sel, ms = 600) => { const b = await bbox(sel); await moveTo(b.x + b.width / 2, b.y + b.height / 2, ms); };
  const typeInto = async (sel, text, perChar = 38) => { await clickSel(sel, 200); await page.keyboard.type(text, { delay: perChar / SPEED }); await sleep(400); };
  const streamAi = async (text, perChunk = 55) => {
    await ev("ai_start");
    for (let i = 0; i < text.length; i += 3) { await ev("ai_delta", { text: text.slice(i, i + 3) }); await sleep(perChunk); }
    await ev("ai", { text });
  };
  const tool = async (id, patch) => ev("tool", { id, ...patch });
  const waitCanvasReady = async () => {
    await page.waitForFunction(() => !document.querySelector(".canvas-loading"), null, { timeout: 60000 });
    await sleep(600);
  };
  const dragOrbit = async (dx, dy, ms = 900) => {
    const b = await bbox("canvas.cad-canvas, .viewport canvas");
    const x0 = b.x + b.width * 0.55, y0 = b.y + b.height * 0.5;
    await moveTo(x0, y0, 200);
    await page.mouse.down();
    const steps = 24;
    for (let i = 1; i <= steps; i++) { const x = x0 + (dx * i) / steps, y = y0 + (dy * i) / steps; await demo("cursor", x, y); await page.mouse.move(x, y); await sleep(ms / steps); }
    await page.mouse.up();
    await sleep(300);
  };
  const SID = (n) => `demo_video_${n}`;

  // ================= 開場 =================
  await page.goto(BASE + "/");
  await page.waitForSelector(".canvas-empty", { timeout: 30000 });
  await page.evaluate(() => { localStorage.clear(); });
  await page.evaluate(INSTALL);
  await page.waitForFunction(() => !!window.__cadDispatch);
  await sleep(300);
  await card({ kicker: "SUIYAO · CONVERSATIONAL CAD", title: "對話式 CAD", sub: "用「講的」做 CAD:從一句話,到可製造的模型", lines: ["功能介紹 · 草模模式 × 設計模式"] }, 5200);

  // ================= 0. 介面總覽 =================
  await cap("這是 <b>對話式 CAD</b> 的工作畫面。介面分成六大區,先認得它們。", 1800);
  const regions = [
    [".hdr", "① 頂部列:模式切換 · 功能鈕 · 狀態", 1700],
    [".stepper", "② 階段列:理解 → 規劃 → 生成 → 驗證 → 呈現", 1700],
    [".conv-col", "③ 對話欄:用工程語言描述與追加需求", 1700],
    [".canvas", "④ 3D 視圖:真實 STEP/GLB 幾何即時長出", 1700],
    [".paramsbar", "⑤ 參數列:改尺寸即時重生", 1500],
    [".versions", "⑥ 版本時間軸:切換 · 回退 · 匯出", 1500],
  ];
  for (const [sel, label, ms] of regions) { await demo("clearHighlights"); await demo("highlight", sel, label); await sleep(ms); }
  await demo("clearHighlights");
  await cap("每個對話一出生就決定模式:<b>草模</b> 幾秒搭出會動的機構示意;<b>設計</b> 產出精確、可匯出的真實 CAD。", 2600);
  await hoverSel(".mode-switch", 900);
  await capOff();

  // ================= 1. 草模模式 =================
  await card({ kicker: "01 · MOTION SKETCH", title: "草模模式", sub: "幾秒搭出會動的機構示意,先驗證「動不動」", lines: ["零 Python、零 STEP:宣告式場景即時播放剛體運動", "拖驅動滑桿定格姿態 · 傳動角讀數 · 一鍵升級為正式設計"] }, 5200);
  await cap("切到 <b>草模</b> 模式,描述一個機構構想。", 600);
  await clickSel('.mode-seg[data-mode="sketch"]', 700);
  await typeInto(".composer-input", "旋轉臂夾爪 90° 翻轉取放:馬達直驅旋轉臂,平行夾指夾住工件後翻轉 90° 放到另一側。");
  await cap("送出後,代理先<b>理解</b>需求,再<b>搭建</b>宣告式場景,最後<b>演示</b>——三個階段都看得到。", 300);
  await clickSel(".composer-btn.send", 300);
  await waitChat();
  await ev("stage", { index: 0 });
  await streamAi("理解:這是一個 2 DOF 的取放機構——旋轉臂(θ,0→90°)+ 平行夾指(開合)。驅動已指明為馬達直驅,不需再問。我直接搭建草模。", 45);
  await ev("stage", { index: 1 });
  await tool("sk1", { name: "sketch_present(gripper)", label: "搭建機構草模", status: "running", code: '{"bodies":["frame","arm","jaw1","jaw2","seat","dropoff"],\n "drives":[{"id":"theta","min":0,"max":90},{"id":"gap","min":4,"max":12}],\n "program":{"mode":"timeline","cycleS":12,"phases":["待機","夾取","夾緊","翻轉搬運","釋放","返程","歸位"]}}' });
  await ev("busy", { text: "搭建機構草模 · 已寫 1.8k 字元…" });
  await sleep(2600);
  await tool("sk1", { status: "done", ms: 2400, note: "6 件 · 2 DOF · 可達性預檢通過" });
  await ev("stage", { index: 2 });
  const SCENE = "/api/asset?file=models%2F.cadchat%2Fdemo_video%2Fgripper.sketch.json&v=1";
  const skDofs = [{ id: "theta", label: "旋轉角 θ", min: 0, max: 90, unit: "°" }, { id: "gap", label: "指開半距", min: 4, max: 12, unit: "mm" }];
  await ev("artifact", { ver: "v1", name: "gripper", code: "gripper", ghost: "GRIP", formats: [], type: "sketch", partCount: 6, sceneUrl: SCENE, dofs: skDofs, joints: { revolute: 1, prismatic: 2 }, title: "旋轉臂夾爪 90° 翻轉取放" });
  await ev("version", { id: "v1", name: "gripper", file: "models/.cadchat/demo_video/versions/v1/gripper.sketch.json", sceneUrl: SCENE, formats: [], type: "sketch", partCount: 6, source: "generated", snapshot: true, dofs: skDofs, title: "旋轉臂夾爪 90° 翻轉取放" });
  await ev("present", { ver: "v1", name: "gripper", code: "gripper", sceneUrl: SCENE, type: "sketch" });
  await streamAi("草模 v1 完成:旋轉臂繞 Y 軸 0→90°,雙夾指對稱開合(4~12 mm),工件在「夾緊」階段附著於臂、「釋放」階段落到對側座。底部可拖驅動滑桿定格姿態。", 30);
  await finishChat(SID("sk"));
  await page.waitForFunction(() => window.__cadSketch && window.__cadSketch.scene(), null, { timeout: 30000 });
  await sleep(800);
  await cap("草模立刻<b>自動播放</b>:夾取 → 夾緊 → 翻轉搬運 → 釋放 → 返程,整個流程循環演示。", 5500);
  await cap("右下讀數即時顯示旋轉角、指距開口與<b>流程階段</b>;圖例標出各構件。", 300);
  await clickSel('.canvas-tools .tool-chip:has-text("圖例")', 3200);
  await cap("拖底部 <b>DOF 滑桿</b> 可以手動 scrub 姿態——拖曳自動暫停,改數字的成本極低。", 300);
  {
    const b = await bbox('.paramsbar[data-sketch] input[type=range]');
    const y = b.y + b.height / 2;
    await moveTo(b.x + b.width * 0.5, y, 300);
    await page.mouse.down();
    for (let i = 0; i <= 20; i++) { const x = b.x + b.width * (0.5 + 0.45 * i / 20); await demo("cursor", x, y); await page.mouse.move(x, y); await sleep(45); }
    for (let i = 0; i <= 20; i++) { const x = b.x + b.width * (0.95 - 0.75 * i / 20); await demo("cursor", x, y); await page.mouse.move(x, y); await sleep(45); }
    await page.mouse.up();
    await sleep(900);
  }
  await cap("按 <b>▶ 播放</b> 繼續,還可切 2× 速度、回原位、重設視角。", 300);
  await clickSel(".sketch-play .fold-seg.main", 500);
  await clickSel('.sketch-play .fold-seg.spd:has-text("2")', 2600);
  await cap("想法確認可行後,版本卡上的「<b>⇪ 轉為正式設計</b>」是草模的升級出口。", 400);
  await clickSel(".version-promote", 700);
  await cap("它會切到設計模式開新對話,並把已確認的規格(機構件、驅動範圍、原始場景檔)<b>預填進輸入框</b>,不自動送出。", 400);
  await clickSel(".confirm-dialog .save-btn", 1200);
  await page.waitForFunction(() => (document.querySelector(".composer-input") || {}).value?.length > 10, null, { timeout: 15000 });
  await hoverSel(".composer-input", 2200);
  await capOff();

  // ================= 2. 設計模式 =================
  await card({ kicker: "02 · DESIGN", title: "設計模式", sub: "產出真實 STEP / GLB,精確、可製造、可匯出", lines: ["代理先想再做:解析規格 → 兩步澄清精靈 → 生成 → 驗證 → 呈現", "每一步都看得到,不是黑箱"] }, 5000);
  await cap("規格已預填,直接送出。", 300);
  await clickSel(".composer-btn.send", 300);
  await waitChat();
  await ev("stage", { index: 0 });
  await streamAi("我先從草模取回鉸點與行程,再把需求解析成規格卡。夾爪型式與夾持力你沒指定,我先標為假設;翻轉軸的驅動方式屬拓撲級決定,先問你再動手。", 40);
  await ev("spec", { chips: [
    { k: "機構型式", v: "機械臂末端 90° 翻轉夾爪" }, { k: "翻轉角", v: "90°" }, { k: "安裝介面", v: "ISO 9409-1 法蘭 Ø50" },
    { k: "夾爪型式", v: "平行氣爪", assumed: true }, { k: "夾持力", v: "20 N", assumed: true }, { k: "開口", v: "34 mm", assumed: true }, { k: "翻轉驅動", v: "未指明" },
  ] });
  await sleep(1200);
  await ev("clarify", {
    q: "翻轉軸的驅動方式會決定整體配置(猜錯整台重做),請選一個整機配置組合:",
    opts: [
      { label: "氣壓旋轉缸直驅(建議)", value: "SMC 旋轉缸(90° 擺動)直驅翻轉軸 + 平行氣爪型錄選型,全氣壓、結構最精簡" },
      { label: "步進馬達 + 減速機", value: "NEMA17 步進馬達經 1:10 減速機驅動翻轉軸 + 平行氣爪,可任意角度停止" },
    ],
    suggested: "SMC 旋轉缸(90° 擺動)直驅翻轉軸 + 平行氣爪型錄選型,全氣壓、結構最精簡",
  });
  await streamAi("需要你決定翻轉軸的驅動方式——請在視圖的精靈作答。", 30);
  await finishChat(SID("ds"));
  await page.waitForSelector(".canvas-clarify", { timeout: 15000 });
  await sleep(600);
  await cap("代理<b>先問再做</b>:視圖中央浮出兩步精靈,左欄反灰,作答重心讓給視圖。", 2600);
  await cap("步驟 1/2:確認解析規格。標「<b>假設</b>」的琥珀 chip 可以點開直接改。", 500);
  await clickSel('.canvas-clarify .cw-chip[data-assumed]:has-text("夾持力")', 500);
  await page.keyboard.type("30 N", { delay: 60 / SPEED });
  await sleep(300);
  await page.keyboard.press("Enter");
  await sleep(900);
  await clickSel(".canvas-clarify .cw-confirm", 900);
  await cap("步驟 2/2:選整機配置組合。驅動/傳動猜錯要整台重做,所以刻意在動手前<b>一次問清</b>。", 2600);
  await cap("你改過的值優先套用;也可以直接採用 <b>AI 建議組合</b>。", 400);
  await hoverSel(".canvas-clarify-opt", 700);
  await clickSel(".canvas-clarify-suggest", 300);
  await waitChat();
  await cap("生成中:空畫布顯示<b>五階段</b>直列、即時活動與工具卡,看得到代理正在做什麼。", 200);
  await ev("stage", { index: 1 });
  await streamAi("採用:SMC 旋轉缸直驅 + 平行氣爪,夾持力 30 N。規劃組裝順序後開始建模。", 35);
  await ev("spec", { chips: [
    { k: "機構型式", v: "機械臂末端 90° 翻轉夾爪" }, { k: "翻轉角", v: "90°" }, { k: "安裝介面", v: "ISO 9409-1 法蘭 Ø50" },
    { k: "翻轉驅動", v: "SMC 旋轉缸直驅" }, { k: "夾爪型式", v: "平行氣爪" }, { k: "夾持力", v: "30 N" }, { k: "開口", v: "34 mm", assumed: true },
  ] });
  await ev("plan", { steps: ["法蘭(ISO 9409-1 Ø50,4×M6 PCD31.5)", "旋轉缸本體 + 輸出轂(翻轉軸沿 Y)", "擺架:讓 0→90° 全程淨空缸體包絡", "平行夾爪本體 + 雙爪 + 手指(行程 8 mm)", "運動宣告:左右爪夾合(直線)、翻轉(迴轉)", "建模 → 幾何驗證 → 呈現到 3D 視圖"].map((t, i) => ({ n: i + 1, t })) });
  await sleep(1400);
  await ev("stage", { index: 2 });
  await tool("t1", { name: "parts.select_cylinder", label: "選用標準件", status: "running" });
  await ev("busy", { text: "選用標準件…" });
  await sleep(1500);
  await tool("t1", { status: "done", ms: 1300, note: "旋轉缸 CRB1BW30-90S(90°)· 氣爪 MHZ2-16D(夾持力 45 N ≥ 30 N,餘裕 1.5×)" });
  await tool("t2", { name: "cad.build(flip_gripper.py)", label: "撰寫幾何 → 執行 → 產出", status: "running", code: BUILD_CODE });
  for (let k = 2; k <= 9; k++) { await ev("busy", { text: `撰寫產生器原始碼 · 已寫 ${(k * 0.6).toFixed(1)}k 字元…` }); await sleep(380); }
  await cap("代理實際建出<b>參數化模型</b>,執行後產出真 STEP 與 3D 幾何。工具卡可展開建模內容。", 200);
  await ev("busy", { text: "執行產生器 · 建模中…" });
  await sleep(3200);
  await tool("t2", { status: "done", ms: 14200, outputs: [{ path: "flip_gripper.step", kind: "step" }, { path: ".flip_gripper.step.glb", kind: "glb" }] });
  await ev("stage", { index: 3 });
  await ev("busy", { text: "幾何驗證中…" });
  await sleep(900);
  await ev("validate", { ok: true, attempt: 1, ms: 640, partCount: 9, checks: QUICK_CHECKS });
  await ev("motion", { name: "flip_gripper", schemaVersion: 1, dofs: FLIP_DOFS });
  await cap("驗證只報「真的有跑」的檢查:產圖回合走快路徑,六項細檢先誠實標 <b>未驗證</b>,留給精算,不假裝通過。", 1800);
  await ev("stage", { index: 4 });
  const GLB1 = glb("models/flip_gripper/.flip_gripper.step.glb", 1);
  await ev("artifact", { ver: "v1", name: "flip_gripper", code: "flip_gripper", ghost: "FLIP", formats: ["STEP", "GLB"], type: "assembly", partCount: 9 });
  await ev("version", { id: "v1", name: "flip_gripper", file: "models/.cadchat/demo_video/versions/v1/.flip_gripper.step.glb", glbUrl: GLB1, formats: ["STEP", "GLB"], type: "assembly", partCount: 9, source: "generated", snapshot: true, verified: false });
  await ev("present", { ver: "v1", name: "flip_gripper", code: "flip_gripper", glbUrl: GLB1, type: "assembly" });
  await ev("params", { defs: FLIP_PARAMS });
  await streamAi("完成 v1:9 件組合件。旋轉缸直驅翻轉軸,擺架幾何已讓 0→90° 全程淨空;運動宣告了雙爪夾合與 90° 翻轉三個自由度。底部可調參數可直接調整重生。", 30);
  await finishChat(SID("ds"));
  await waitCanvasReady();
  await cap("模型載入右側畫布:<b>真實 STEP/GLB 幾何</b>。底部長出可調參數,右下出現版本 v1。", 500);
  await dragOrbit(-260, 90, 1300);
  await sleep(1000);
  await capOff();

  // ================= 3. 檢視與挑選幾何 =================
  await card({ kicker: "03 · INSPECT & ITERATE", title: "檢視與迭代", sub: "拖曳旋轉、圈選零件、運動示意,三種迭代方式", lines: ["單擊圈選 → 帶入對話,代理就能量測、對齊", "物件樹眼睛三態:實體 → 半透 → 隱藏", "文字追加 · 規格修正面板 · 參數重生"] }, 4800);
  await cap("拖曳旋轉、滾輪縮放;視圖右上有網格、座標軸、環繞、量測、面標記等工具。", 300);
  await hoverSel(".canvas-tools", 600);
  await clickSel('.canvas-tools .tool-chip:has-text("環繞")', 2400);
  await clickSel('.canvas-tools .tool-chip:has-text("環繞")', 300);
  await cap("<b>單擊圈選零件</b>:選中高亮、其餘半透,出現名牌。「帶入對話」後代理就能對它量測、對齊。", 300);
  {
    const b = await bbox("canvas.cad-canvas");
    const pts = [[0.5, 0.5], [0.56, 0.42], [0.46, 0.58], [0.6, 0.55], [0.42, 0.45], [0.52, 0.66]];
    let hit = false;
    for (const [fx, fy] of pts) {
      await clickAt(b.x + b.width * fx, b.y + b.height * fy, 650);
      if (await page.locator(".sel-nameplate").count()) { hit = true; break; }
    }
    if (hit) {
      await sleep(600);
      await clickSel(".sel-nameplate .sel-action:not(.sel-clear)", 1200);
      const chips = await page.locator(".pick-chips").waitFor({ timeout: 3000 }).then(() => true).catch(() => false);
      if (chips) await hoverSel(".pick-chips", 900);
    }
  }
  await cap("「<b>物件屬性</b>」抽屜:拓撲樹逐層展開;眼睛三態 實體 → 半透 → 隱藏,把外殼轉半透就能看內部。", 300);
  // 圈選零件時抽屜可能已連動開啟;沒開才點 toggle,開著就直接用。
  if (!(await page.locator(".props").count())) await clickSel(".props-toggle", 900);
  await page.waitForSelector(".props", { timeout: 5000 }).catch(() => {});
  await hoverSel(".tree", 700);
  {
    const rows = page.locator(".tree-node");
    const n = await rows.count();
    if (n > 2) {
      const eye = page.locator(".tree-node .tree-eye").nth(1);
      const eb = await eye.boundingBox();
      if (eb) { await clickAt(eb.x + eb.width / 2, eb.y + eb.height / 2, 900); await clickAt(eb.x + eb.width / 2, eb.y + eb.height / 2, 900); await clickAt(eb.x + eb.width / 2, eb.y + eb.height / 2, 600); }
    }
  }
  if (await page.locator(".props-close").count()) await clickSel(".props-close", 600);
  else await clickSel(".props-toggle", 600);
  await page.waitForFunction(() => !document.querySelector(".props"), null, { timeout: 5000 }).catch(() => {});
  await page.locator(".sel-clear").count().then(async (c) => { if (c) await clickSel(".sel-clear", 300); });
  await capOff();

  // ---- 運動示意 ----
  await cap("會動的東西,畫布能動給你看:模型帶一份<b>運動宣告</b>,「▶ 運動示意」播放往復動作。", 300);
  await clickSel(".motion-toggle", 300);
  await cap("同一份運動宣告:前端播放、精算運動掃掠、參數改行程三者同步;這裡是雙爪夾合 + 90° 前傾翻轉。", 6500);
  await clickSel(".motion-toggle", 500);
  await capOff();

  // ---- 三種迭代 ----
  await cap("改東西不必重講整段需求。① <b>文字追加</b>:直接補一句。", 300);
  await typeInto(".composer-input", "手指加長到 50mm,指厚改 10mm");
  await clickSel(".composer-btn.send", 200);
  await waitChat();
  await ev("stage", { index: 2 });
  await tool("t3", { name: "cad.build(flip_gripper.py)", label: "精修重生", status: "running", code: "# 精修 2 段\n# - \"finger_len\": 40.0 → 50.0\n# - \"finger_t\": 8.0 → 10.0" });
  await ev("busy", { text: "撰寫產生器原始碼…" });
  await sleep(2600);
  await tool("t3", { status: "done", ms: 9800 });
  await ev("stage", { index: 3 });
  await ev("validate", { ok: true, attempt: 1, ms: 520, partCount: 9, checks: QUICK_CHECKS });
  await ev("motion", { name: "flip_gripper", schemaVersion: 1, dofs: FLIP_DOFS });
  await ev("stage", { index: 4 });
  const GLB2 = glb("models/.cadchat/demo_video/fg_v2/.flip_gripper.step.glb", 2);
  await ev("artifact", { ver: "v2", name: "flip_gripper", code: "flip_gripper", ghost: "FLIP", formats: ["STEP", "GLB"], type: "assembly", partCount: 9 });
  await ev("version", { id: "v2", name: "flip_gripper", file: "models/.cadchat/demo_video/versions/v2/.flip_gripper.step.glb", glbUrl: GLB2, formats: ["STEP", "GLB"], type: "assembly", partCount: 9, source: "generated", snapshot: true, verified: false });
  await ev("present", { ver: "v2", name: "flip_gripper", code: "flip_gripper", glbUrl: GLB2, type: "assembly" });
  await ev("params", { defs: FLIP_PARAMS.map((d) => (d.key === "finger_len" ? { ...d, value: 50 } : d)) });
  await streamAi("已調整:手指長 50 mm、厚 10 mm,其餘不動 → v2(畫布已換成新幾何)。", 30);
  await finishChat(SID("ds"));
  await waitCanvasReady();
  await cap("② <b>規格修正面板</b>:視圖左上的「解析規格」,點任一 chip 改值,走「規格修正:」契約精準只改那一項。", 300);
  await hoverSel(".canvas-spec", 2600);
  await cap("③ <b>參數列</b>:模型的可調尺寸。改數字走決定性路徑重跑(免 LLM),每次套用都是新版本。", 300);
  {
    const field = page.locator('.param:has-text("開口") .numfield-btn').last();
    const fb = await field.boundingBox();
    if (fb) { for (let i = 0; i < 6; i++) await clickAt(fb.x + fb.width / 2, fb.y + fb.height / 2, 160); }
    await sleep(600);
  }
  await cap("有改動就出現「<b>套用 · 重生</b>」;拉到非法組合會顯示繁中錯誤並自動回滾,不會弄壞檔案。", 400);
  await clickSel(".paramsbar-apply", 200);
  await waitChat();
  await tool("t4", { name: "cad.build(flip_gripper.py)", label: "參數重生", status: "running", code: '# PARAMS → {"grip_open": 40, "finger_len": 50, ...}' });
  await ev("busy", { text: "參數重生 · 執行產生器…" });
  await ev("stage", { index: 2 });
  await sleep(2400);
  await tool("t4", { status: "done", ms: 7600 });
  await ev("stage", { index: 3 });
  await ev("validate", { ok: true, attempt: 1, ms: 480, partCount: 9, checks: QUICK_CHECKS });
  await ev("motion", { name: "flip_gripper", schemaVersion: 1, dofs: FLIP_DOFS });
  await ev("stage", { index: 4 });
  const GLB3 = glb("models/.cadchat/demo_video/fg_v3/.flip_gripper.step.glb", 3);
  await ev("artifact", { ver: "v3", name: "flip_gripper", code: "flip_gripper", ghost: "FLIP", formats: ["STEP", "GLB"], type: "assembly", partCount: 9 });
  await ev("version", { id: "v3", name: "flip_gripper", file: "models/.cadchat/demo_video/versions/v3/.flip_gripper.step.glb", glbUrl: GLB3, formats: ["STEP", "GLB"], type: "assembly", partCount: 9, source: "generated", snapshot: true, verified: false });
  await ev("present", { ver: "v3", name: "flip_gripper", code: "flip_gripper", glbUrl: GLB3, type: "assembly" });
  await ev("params", { defs: FLIP_PARAMS.map((d) => (d.key === "finger_len" ? { ...d, value: 50 } : d.key === "grip_open" ? { ...d, value: 40 } : d)) });
  await finishChat(SID("ds"));
  await waitCanvasReady();
  await cap("v3:開口從 34 變 40 mm,兩指張開——決定性重生,不經 LLM。", 1800);
  await capOff();

  // ================= 4. 版本、精算、匯出 =================
  await card({ kicker: "04 · VERSIONS & EXPORT", title: "版本、回退與匯出", sub: "每一次生成或套用都凍結成一個版本", lines: ["琥珀 = 尚未精算(平常迭代快,不等驗證)", "「✓ 精算此版」跑完整驗證:有效實體 / 干涉 / 運動掃掠", "匯出閘:未驗證版匯出前自動補驗,通過才出檔"] }, 5000);
  await cap("右下時間軸列出全部版本:v1 → v2 → v3,每版都標著驗證狀態。", 300);
  await hoverSel(".versions-track", 1500);
  await cap("切到舊版會出現「<b>⟲ 回到 v1 繼續</b>」做真回退——看到的是真舊檔,後續對話從那版接著改。", 300);
  await clickSel('.version-chip:has-text("v1")', 1800);
  await hoverSel(".version-revert", 1400);
  await clickSel('.version-chip:has-text("v3")', 900);
  await cap("交出去前把關一次:「<b>✓ 精算此版</b>」跑完整幾何驗證(含運動掃掠)。", 300);
  await clickSel('.version-dl:has-text("精算此版")', 300);
  await page.waitForSelector('.ver-verify[data-state="verified"]', { timeout: 20000 });
  await sleep(800);
  await cap("全部通過 → 版本轉為「<b>✓ 已驗證</b>」,驗證卡逐項列出掃掠幀數與最小間隙。", 2600);
  await cap("匯出 <b>STEP / STL / 3MF / PDF 工程圖</b>;組合件還能「零件包」逐件拆檔。未驗證版匯出會先自動補驗(匯出閘)。", 300);
  await hoverSel('.version-dl:has-text("STEP")', 700);
  await hoverSel('.version-dl:has-text("3MF")', 700);
  await hoverSel('.version-dl:has-text("PDF")', 700);
  await hoverSel('.version-dl:has-text("零件包")', 1200);
  await capOff();

  // ================= 5. 鈑金 =================
  await card({ kicker: "05 · SHEET METAL", title: "鈑金:摺疊 ↔ 攤平", sub: "build 時併行產出雙 GLB,一鍵切換零重算", lines: ["攤平態疊折彎中心線:藍=上折、紅=下折", "攤平 GLB 自帶拓撲:面標記 / 物件樹 / 量測照常可用", "⤓ DXF 展開圖:CUT / BEND 分層,雷切直接下料"] }, 4800);
  await clickSel('.hdr-btn:has-text("新對話")', 500);
  if (await page.locator(".confirm-dialog").count()) await clickSel(".confirm-dialog .save-btn", 600);
  await typeInto(".composer-input", "做一個 1.5mm 厚的鈑金四邊立邊盒:外形 120×80、高 40,底面中央一個 Ø20 孔");
  await clickSel(".composer-btn.send", 200);
  await waitChat();
  await ev("stage", { index: 0 });
  await streamAi("鈑金件:底板 120×80(外形)、四邊各上折 90° 高 40、t=1.5,折彎半徑取 2、K 值 0.44。鈑金建模(角隅自動避讓),同時產出摺疊態、展開態與 DXF 展開圖。", 30);
  await ev("spec", { chips: [{ k: "件型", v: "鈑金四邊立邊盒" }, { k: "板厚", v: "1.5 mm" }, { k: "外形", v: "120 × 80" }, { k: "立邊高", v: "40 mm" }, { k: "折彎半徑", v: "2 mm", assumed: true }, { k: "K 值", v: "0.44", assumed: true }, { k: "底孔", v: "Ø20 置中" }] });
  await ev("stage", { index: 2 });
  await tool("s1", { name: "cad.build(sheet_box.py)", label: "撰寫幾何 → 執行 → 產出", status: "running", code: SHEET_CODE });
  await ev("busy", { text: "撰寫產生器原始碼 · 已寫 1.4k 字元…" });
  await sleep(2800);
  await tool("s1", { status: "done", ms: 6900, outputs: [{ path: "sheet_box.step", kind: "step" }, { path: ".sheet_box.step.glb", kind: "glb" }, { path: ".sheet_box.flat.step.glb", kind: "glb" }] });
  await ev("stage", { index: 3 });
  await ev("validate", { ok: true, attempt: 1, ms: 430, partCount: 1, checks: QUICK_CHECKS_FOR(1, false) });
  await ev("motion", { name: "sheet_box", schemaVersion: 1, dofs: [] });
  await ev("stage", { index: 4 });
  const SG = glb("models/sheet_box_flat_test/.box.step.glb", 1);
  const SF = glb("models/.cadchat/demo_video/box/.box.flat.step.glb", 1);
  const SL = glb("models/.cadchat/demo_video/box/.box.flat.lines.json", 1);
  await ev("artifact", { ver: "v1", name: "sheet_box", code: "sheet_box", ghost: "SHEE", formats: ["STEP", "GLB", "DXF"], type: "part", partCount: 1 });
  await ev("version", { id: "v1", name: "sheet_box", file: "models/.cadchat/demo_video/versions/v1/.sheet_box.step.glb", glbUrl: SG, formats: ["STEP", "GLB", "DXF"], type: "part", partCount: 1, source: "generated", snapshot: true, hasDxf: true, flatGlbUrl: SF, flatLinesUrl: SL, verified: false });
  await ev("present", { ver: "v1", name: "sheet_box", code: "sheet_box", glbUrl: SG, type: "part", flatGlbUrl: SF, flatLinesUrl: SL });
  await ev("params", { defs: [{ key: "box_w", label: "外形寬 box_w", min: 40, max: 300, step: 1, value: 120, unit: "mm" }, { key: "box_d", label: "外形深 box_d", min: 40, max: 300, step: 1, value: 80, unit: "mm" }, { key: "box_h", label: "立邊高 box_h", min: 10, max: 120, step: 1, value: 40, unit: "mm" }, { key: "thick", label: "板厚 thick", min: 0.5, max: 4, step: 0.1, value: 1.5, unit: "mm" }, { key: "bend_r", label: "折彎半徑 bend_r", min: 0.8, max: 6, step: 0.1, value: 2, unit: "mm" }, { key: "hole_d", label: "底孔徑 hole_d", min: 5, max: 60, step: 1, value: 20, unit: "mm" }] });
  await streamAi("完成 v1:鈑金四邊立邊盒。左上可切「摺疊 / 攤平」,展開態保留面資訊可量測;時間軸有「⤓ DXF 展開圖」可直接雷切下料。", 30);
  await finishChat(SID("sm"));
  await waitCanvasReady();
  await cap("鈑金件左上出現「<b>摺疊 / 攤平</b>」切換。build 時已併行產好雙 GLB,點一下瞬間換視角、零重算。", 1800);
  await dragOrbit(-120, 60, 900);
  await clickSel('.fold-seg:has-text("攤平")', 300);
  await waitCanvasReady();
  await cap("攤平展開圖疊上<b>折彎中心線</b>(藍=上折、紅=下折),對齊 DXF 的 BEND_UP / BEND_DOWN 圖層。", 3200);
  await cap("攤平 GLB 自帶 STEP 拓撲:<b>面標記、物件樹、量測在攤平態照常可用</b>,展開後東西不會消失。", 300);
  await clickSel(".marker-toggle", 600);
  await clickSel('.marker-panel-acts a:has-text("全部")', 2200);
  await clickSel(".marker-toggle", 400);
  await clickSel(".props-toggle", 1400);
  await hoverSel(".tree", 1500);
  if (await page.locator(".props-close").count()) await clickSel(".props-close", 500);
  await cap("要下料就按「<b>⤓ DXF 展開圖</b>」:外輪廓 / 孔 / 折彎線分層,雷切直接用。底部參數列可改板厚、立邊高、折彎半徑再重生。", 300);
  await hoverSel('.version-dl:has-text("DXF")', 1800);
  await hoverSel(".paramsbar-track", 1500);
  await clickSel('.fold-seg:has-text("摺疊")', 300);
  await waitCanvasReady();
  await capOff();
  await sleep(500);

  // ================= 6. 壓軸:史都華平台 =================
  await card({ kicker: "06 · FINALE", title: "史都華平台", sub: "六軸並聯機構:一句話,到 14 件真實組合件", lines: ["底座 + 動平台 + 六支液壓缸,兩端球鉸", "同一條流程:解析規格 → 產生器 → STEP / GLB → 運動示意"] }, 5000);
  await clickSel('.hdr-btn:has-text("新對話")', 500);
  if (await page.locator(".confirm-dialog").count()) await clickSel(".confirm-dialog .save-btn", 600);
  await typeInto(".composer-input", "六軸並聯史都華平台(Stewart platform):底座 Ø340、動平台 Ø240、平台高 230mm,六支液壓缸兩端球鉸,平台要能升降與俯仰");
  await clickSel(".composer-btn.send", 200);
  await waitChat();
  await ev("stage", { index: 0 });
  await streamAi("6-UPS 並聯機構:底座與動平台各六個球鉸,分三對、互相錯位 60°,六支缸交錯相連成三組「八」字。缸筒 + 活塞桿各自一體(含球鉸),桿在筒內孔滑動;剛體示意用平台升降與俯仰兩個自由度。", 40);
  await ev("spec", { chips: [{ k: "構型", v: "6-UPS 史都華平台" }, { k: "底座", v: "Ø340 × 12,球鉸分佈 R150" }, { k: "動平台", v: "Ø240 × 10,球鉸分佈 R100" }, { k: "平台高", v: "230 mm" }, { k: "缸", v: "筒 Ø36 / 桿 Ø14 × 6", assumed: true }, { k: "球鉸", v: "Ø28,沉入板面 6 mm", assumed: true }, { k: "運動", v: "升降 20 mm · 俯仰 ±6°" }] });
  await sleep(900);
  await ev("stage", { index: 1 });
  await ev("plan", { steps: ["底座板(中央減重孔 + 6 安裝孔)", "六個底座球鉸座標:R150,三對各夾 30°", "動平台(中央工具孔 + 4 安裝孔),球鉸 R100 錯位 60°", "每腿:球 + 缸筒一體、桿 + 球一體,桿在內孔滑動(餘隙 1 mm)", "宣告貼合:球鉸沉入板面 12 組", "運動宣告:平台升降(直線)/ 俯仰(迴轉)→ 建模 → 幾何驗證 → 呈現"].map((t, i) => ({ n: i + 1, t })) });
  await sleep(1400);
  await ev("stage", { index: 2 });
  await tool("w1", { name: "cad.build(stewart_platform.py)", label: "撰寫幾何 → 執行 → 產出", status: "running", code: STEWART_CODE });
  for (let k = 2; k <= 9; k++) { await ev("busy", { text: `撰寫產生器原始碼 · 已寫 ${(k * 0.7).toFixed(1)}k 字元…` }); await sleep(380); }
  await cap("六腿座標全由參數閉式導出:改分佈半徑或平台高,十二個球鉸與缸長一起重算。", 200);
  await ev("busy", { text: "執行產生器 · 建模 14 件…" });
  await sleep(3400);
  await tool("w1", { status: "done", ms: 6100, outputs: [{ path: "stewart_platform.step", kind: "step" }, { path: ".stewart_platform.step.glb", kind: "glb" }] });
  await ev("stage", { index: 3 });
  await ev("busy", { text: "幾何驗證中…" });
  await sleep(900);
  await ev("validate", { ok: true, attempt: 1, ms: 710, partCount: 14, checks: QUICK_CHECKS_FOR(14, true) });
  await ev("motion", { name: "stewart_platform", schemaVersion: 1, dofs: STEWART_DOFS });
  await ev("stage", { index: 4 });
  const SW = glb("models/stewart_platform/.stewart_platform.step.glb", 1);
  await ev("artifact", { ver: "v1", name: "stewart_platform", code: "stewart_platform", ghost: "STEW", formats: ["STEP", "GLB"], type: "assembly", partCount: 14 });
  await ev("version", { id: "v1", name: "stewart_platform", file: "models/.cadchat/demo_video/versions/v1/.stewart_platform.step.glb", glbUrl: SW, formats: ["STEP", "GLB"], type: "assembly", partCount: 14, source: "generated", snapshot: true, verified: false });
  await ev("present", { ver: "v1", name: "stewart_platform", code: "stewart_platform", glbUrl: SW, type: "assembly" });
  await ev("params", { defs: [{ key: "base_joint_r", label: "底座球鉸半徑", min: 100, max: 220, step: 1, value: 150, unit: "mm" }, { key: "plat_joint_r", label: "平台球鉸半徑", min: 60, max: 160, step: 1, value: 100, unit: "mm" }, { key: "height", label: "平台高 height", min: 160, max: 320, step: 1, value: 230, unit: "mm" }, { key: "pair_half_deg", label: "球鉸半夾角", min: 5, max: 25, step: 0.5, value: 15, unit: "°" }, { key: "cyl_r", label: "缸筒半徑 cyl_r", min: 12, max: 26, step: 0.5, value: 18, unit: "mm" }, { key: "heave", label: "升降行程 heave", min: 0, max: 60, step: 1, value: 20, unit: "mm" }, { key: "tilt_deg", label: "俯仰角 tilt_deg", min: 0, max: 15, step: 0.5, value: 6, unit: "°" }] });
  await streamAi("完成 v1:史都華平台,14 件組合件。六支缸交錯成三組「八」字,球鉸沉入板面已宣告貼合;運動宣告平台升降 20 mm 與俯仰 ±6°,按「▶ 運動示意」可看平台連動六桿。", 30);
  await finishChat(SID("sw"));
  await waitCanvasReady();
  await cap("14 件真實 STEP 組合件載入畫布:底座、動平台、六組缸筒與活塞桿。", 600);
  await dragOrbit(-300, 70, 1500);
  await clickSel('.canvas-tools .tool-chip:has-text("環繞")', 3200);
  await clickSel('.canvas-tools .tool-chip:has-text("環繞")', 300);
  await cap("「<b>▶ 運動示意</b>」:平台升降 + 俯仰,六支活塞桿跟著平台連動。", 300);
  await clickSel(".motion-toggle", 7500);
  await clickSel(".motion-toggle", 400);
  await cap("底部參數:球鉸分佈半徑、平台高、缸徑、行程、俯仰角——改一個數字,整台重生。", 300);
  await hoverSel(".paramsbar-track", 2200);
  await capOff();
  await sleep(600);

  // ================= 結尾 =================
  await card({ kicker: "SUIYAO · CONVERSATIONAL CAD", title: "對話式 CAD", sub: "從一句話,到可製造的模型", lines: [
    "草模:幾秒驗證機構動不動,⇪ 一鍵升級為正式設計",
    "設計:真 STEP / GLB,先問再做,三種迭代方式",
    "鈑金摺疊 ↔ 攤平、版本回退、精算驗證、匯出閘",
    "從夾爪到史都華平台,同一條流程",
  ] }, 7000);

  await page.close();
  const videoPath = await page.video().path();
  await ctx.close();
  await browser.close();
  console.log("VIDEO", videoPath);
  if (errs.length) console.log("PAGE ERRORS:\n" + errs.slice(0, 10).join("\n"));
})().catch((e) => { console.error(e); process.exit(1); });
