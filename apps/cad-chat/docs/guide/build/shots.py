# -*- coding: utf-8 -*-
"""手冊截圖規格清單。每筆 = 一張(或一組 storyboard)截圖:如何佈置畫面 + 要框哪些元件。

佈置手法全部零 LLM(除了標 live 的 storyboard):
  - ?glb= 直接載入既有 GLB fixture(glb_page_url)
  - window.__cadDispatch 注入 UI 狀態(payload 形狀沿用 tests/smoke 既有煙測)
  - 真的點 UI 開 overlay(開啟檔案 / 教訓)

callout 三型:{"sel":css}(單一元件)/{"sels":[css,...]}(取聯集外框)/{"rect":[x,y,w,h]}(手填)。
tone:primary(主藍)/accent(青)/good(綠)/warn(琥珀)。
"""
import os
import time

from guidelib import REPO, asset_url, glb_page_url, seed_file

# ── 既有 fixtures(相對 models/)──
STAGE = "motorized_linear_stage/.motorized_linear_stage.step.glb"
GANTRY = "xyz_pickplace_gantry/.xyz_pickplace_gantry.step.glb"
STEERING = "steering_box_rack_pinion/.steering_box_rack_pinion.step.glb"
GRIPPER = "flip_gripper/.flip_gripper.step.glb"
SHEET = "sheet_u_bracket/.sheet_u_bracket.step.glb"
SHEET_FLAT = "sheet_u_bracket/.sheet_u_bracket.flat.step.glb"
SHEET_LINES = "sheet_u_bracket/.sheet_u_bracket.flat.lines.json"

SKETCH_FIX = os.path.join(REPO, "apps", "cad-chat", "src", "lib", "sketch", "fixtures")

# steering_box 齒條齒輪耦合運動(自 smoke_part_visibility.py)
STEER_MOTION = {"schemaVersion": 1, "dofs": [
    {"id": "stroke", "type": "linear", "axis": [0, 1, 0], "travel": -7.6969, "period_s": 4, "moving": ["rack"]},
    {"id": "swing", "type": "revolute", "axis": [0, 0, 1], "pivot": [0, 0, 67.5], "angle_deg": 90,
     "period_s": 4, "couple": "stroke", "moving": ["pinion"]}]}

LIVE_PROMPT = (
    "做一個單軸電動直線滑台:行程 100mm、額定負載 50N,"
    "用 NEMA23 步進馬達透過 SFU1605 滾珠螺桿直接驅動,搭 HGR15 線性導軌。"
    "尺寸請採標準值,直接建模不用再問我。請全程用繁體中文簡短說明。"
)


# ── 共用小工具 ──
def _seed_sketch():
    """把 cylinder_tilt 草模場景 seed 到 models/.cadchat/ 讓 /api/asset 撈得到。回傳 sceneUrl。"""
    return seed_file(os.path.join(SKETCH_FIX, "cylinder_tilt.json"),
                     ".cadchat/guide_sketch/cyl.sketch.json")


def _present_sketch(cad):
    su = _seed_sketch()
    cad.goto()
    cad.wait_empty()
    cad.evaluate(
        """(su) => {
          window.__cadDispatch({ type: 'SET_MODE', mode: 'sketch' });
          window.__cadDispatch({ type: 'ADD_VERSION', version: {
            id: 'v1', name: 'cyl_tilt', sceneUrl: su, type: 'sketch', source: 'generated',
            title: '汽缸驅動平台前傾',
            dofs: [{ id: 'theta', label: '前傾角 θ', unit: '°', min: 0, max: 30 }] } });
          window.__cadDispatch({ type: 'PRESENT', sceneUrl: su, name: 'cyl_tilt', ver: 'v1', fileType: 'sketch' });
        }""",
        su,
    )
    cad.page.wait_for_function("() => window.__cadSketch && window.__cadSketch.scene()", timeout=20000)
    cad.sleep(900)


def _restore_two_versions(cad, glb):
    """擺出「v1 已驗證(綠)+ v2 未驗證(琥珀)」雙版時間軸 + 畫布模型。"""
    g = asset_url(glb)
    cad.goto()
    cad.wait_empty()
    cad.evaluate(
        """(g) => {
          window.__cadDispatch({ type: 'RESTORE', snapshot: {
            sessionId: 's_guide_ver', activeVer: 'v2',
            versions: [
              { id: 'v1', name: 'linear_stage', source: 'generated', verified: true,
                glbUrl: g, formats: ['STEP','GLB','STL','3MF'] },
              { id: 'v2', name: 'linear_stage', source: 'generated', verified: false,
                glbUrl: g, file: 'models/.cadchat/s_guide_ver/versions/v2/.x.step.glb',
                formats: ['STEP','GLB','STL','3MF'] } ] } });
          window.__cadDispatch({ type: 'PRESENT', glbUrl: g, name: 'linear_stage', ver: 'v2', source: 'generated' });
        }""",
        g,
    )
    cad.wait_canvas()


def _select_a_part(page):
    """對 canvas 掃描點擊直到圈選出零件名牌(自 smoke_click_select.py 掃描偏移)。"""
    box = page.locator("canvas.cad-canvas").bounding_box()
    if not box:
        return False
    cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
    for dx, dy in [(0, 0), (0.12, 0), (-0.12, 0.08), (0.08, -0.12), (0.18, 0.1), (-0.2, -0.05), (0.0, 0.2), (0.22, -0.18)]:
        page.mouse.click(cx + dx * box["width"], cy + dy * box["height"])
        page.wait_for_timeout(450)
        if page.locator(".sel-nameplate").count():
            return True
    return False


# ── clarify 兩步精靈注入(自 smoke_clarify_wizard.py)──
INJECT_CLARIFY = """() => window.__cadDispatch({ type: 'SET_CLARIFY', clarify: {
  q: '尺寸級別未給,請選整機配置',
  opts: [{label: '中載標準', value: '採用中載標準:HGR15 雙軌 + SFU1605 + NEMA23'},
         {label: '輕載桌上型', value: '採用輕載桌上型'},
         {label: '重載', value: '採用重載:HGR20 + SFU2005 + NEMA34'}],
  suggested: 'HGR15 雙軌 + SFU1605 + NEMA23',
  specs: [{k: '導軌', v: 'HGR15', assumed: true}, {k: '行程', v: '100 mm'},
          {k: '負載', v: '50 N'}, {k: '驅動', v: '步進馬達', assumed: true}] } })"""

INJECT_SPEC = """() => window.__cadDispatch({ type: 'ADD_ITEM', item: { type: 'spec', chips: [
  {k: '型式', v: '單軸電動滑台'}, {k: '行程', v: '100 mm'},
  {k: '負載', v: '50 N'}, {k: '導軌', v: 'HGR15', assumed: true},
  {k: '螺桿', v: 'SFU1605', assumed: true} ] } })"""


# ══════════════════════════ SHOTS ══════════════════════════
SHOTS = []


def shot(**kw):
    SHOTS.append(kw)


# ── 第 0 章:介面總覽(擺拍保證版;live storyboard 另產 overview_live)──
def _overview(cad):
    _restore_two_versions(cad, STAGE)
    cad.evaluate(
        """() => window.__cadDispatch({ type: 'SET_PARAMS', defs: [
          { key: 'stroke', value: 100, label: '行程', min: 50, max: 200, step: 5, unit: 'mm' },
          { key: 'load', value: 50, label: '負載', min: 10, max: 200, step: 10, unit: 'N' },
          { key: 'rail', value: 15, label: '導軌寬', min: 12, max: 25, step: 1, unit: 'mm' } ] })"""
    )
    cad.sleep(500)


shot(id="overview", chapter=0, title="六大介面區", storyboard=False, setup=_overview, callouts=[
    {"n": 1, "sel": ".hdr", "label": "頂部列:品牌、模式切換、功能鈕、狀態", "tone": "primary"},
    {"n": 2, "sel": ".stepper", "label": "階段列:看代理正在理解/規劃/生成/驗證/呈現", "tone": "accent"},
    {"n": 3, "sel": ".conv-col", "label": "對話欄:用工程語言描述與追加需求", "tone": "primary"},
    {"n": 4, "sel": ".canvas", "label": "3D 視圖:即時長出真實可製造模型", "tone": "accent"},
    {"n": 5, "sel": ".paramsbar", "label": "參數列:拉滑桿改尺寸即時重生", "tone": "good"},
    {"n": 6, "sel": ".versions", "label": "版本時間軸:回退與匯出", "tone": "good"},
])

# ── 第 1 章:啟動與空白畫面 ──
shot(id="startup_empty", chapter=1, title="剛啟動的空白畫面", setup=lambda cad: (cad.goto(), cad.wait_empty()), callouts=[
    {"n": 1, "sel": ".composer-input", "label": "在這裡用一句話描述你要的零件或機構", "tone": "primary"},
    {"n": 2, "sels": [".example"], "label": "或點範例卡快速開始", "tone": "accent"},
    {"n": 3, "sel": ".mode-switch", "label": "上方切換「草模 / 設計」兩種模式", "tone": "good"},
])

# ── 第 2 章:兩種模式 ──
shot(id="mode_switch", chapter=2, title="模式切換器", setup=lambda cad: (cad.goto(), cad.wait_empty()), callouts=[
    {"n": 1, "sel": ".mode-seg:has-text('草模')", "label": "草模:幾秒搭出會動的機構示意(零 Python)", "tone": "accent"},
    {"n": 2, "sel": ".mode-seg:has-text('設計')", "label": "設計:產出精確、可匯出的真實 CAD", "tone": "primary"},
])

shot(id="mode_design_view", chapter=2, title="設計模式視圖",
     setup=lambda cad: cad.goto_glb(GANTRY, "gantry"), callouts=[
         {"n": 1, "sel": ".canvas", "label": "設計模式:真實 STEP/GLB 幾何,可下載送製造", "tone": "primary"},
     ])

shot(id="mode_sketch_view", chapter=2, title="草模模式視圖", setup=_present_sketch, callouts=[
    {"n": 1, "sel": ".canvas", "label": "草模模式:剛體運動示意,驗證機構動得動", "tone": "accent"},
    {"n": 2, "sel": ".sketch-play", "label": "播放/速度/回原位控制", "tone": "primary"},
    {"n": 3, "sel": ".paramsbar[data-sketch]", "label": "拖驅動滑桿即時擺姿態", "tone": "good"},
])

# ── 第 3 章:你的第一個模型(clarify + 進度;first_prompt/generating 為 live fallback)──
def _first_prompt_s(cad):
    cad.goto()
    cad.wait_empty()
    cad.page.fill(".composer-input", LIVE_PROMPT)
    cad.sleep(300)


shot(id="first_prompt_s", chapter=3, title="描述你的需求", setup=_first_prompt_s, callouts=[
    {"n": 1, "sel": ".composer-input", "label": "把工程語言講清楚:行程、負載、驅動、傳動", "tone": "primary"},
    {"n": 2, "sel": ".composer-btn.send", "label": "按 ↑ 或 Enter 送出", "tone": "accent"},
])

shot(id="clarify_step1", chapter=3, title="釐清精靈 · 步驟 1 確認規格",
     setup=lambda cad: (cad.goto(), cad.wait_empty(), cad.evaluate(INJECT_CLARIFY), cad.sleep(300)), callouts=[
         {"n": 1, "sel": ".canvas-clarify", "label": "代理先問再做:視圖中央聚光燈精靈", "tone": "primary"},
         {"n": 2, "sel": ".cw-chip[data-assumed]", "label": "「假設」值(琥珀)可點開改", "tone": "warn"},
         {"n": 3, "sel": ".cw-steps", "label": "兩步閘門:先確認規格,再選配置", "tone": "accent"},
         {"n": 4, "sel": ".conv-col[data-frozen='true']", "label": "左欄反灰:作答重心讓給視圖", "tone": "primary"},
     ])


def _clarify_step2(cad):
    cad.goto()
    cad.wait_empty()
    cad.evaluate(INJECT_CLARIFY)
    cad.sleep(250)
    cad.page.locator(".cw-confirm").click()
    cad.sleep(300)


shot(id="clarify_step2", chapter=3, title="釐清精靈 · 步驟 2 選配置", setup=_clarify_step2, callouts=[
    {"n": 1, "sel": ".canvas-clarify-q", "label": "驅動/傳動屬拓撲級決定,猜錯整台重做故先問", "tone": "primary"},
    {"n": 2, "sels": [".canvas-clarify-opt"], "label": "選一個整機配置組合", "tone": "accent"},
    {"n": 3, "sel": ".canvas-clarify-suggest", "label": "或直接採用建議組合", "tone": "good"},
])


def _generating_s(cad):
    cad.goto()
    cad.wait_empty()
    cad.evaluate("() => window.__cadDispatch({ type: 'START_RUN' })")
    cad.evaluate("() => window.__cadDispatch({ type: 'SET_STAGE', index: 2 })")
    cad.evaluate("() => window.__cadDispatch({ type: 'SET_LIVE', live: { text: '撰寫產生器原始碼…已寫 2.3k 字元' } })")
    cad.evaluate("""() => window.__cadDispatch({ type: 'UPSERT_TOOL', id: 't1',
        patch: { name: 'cad_build', label: '建構模型', status: 'running' } })""")
    cad.sleep(400)


shot(id="generating_s", chapter=3, title="產圖中的進度面板", setup=_generating_s, callouts=[
    {"n": 1, "sels": [".prog-stage"], "label": "五階段直列:理解→規劃→生成→驗證→呈現", "tone": "primary"},
    {"n": 2, "sel": ".prog-live", "label": "即時活動:看代理正在做什麼", "tone": "accent"},
    {"n": 3, "sel": ".prog-tool", "label": "當前工具卡(可展開原始碼)", "tone": "good"},
])


def _first_model(cad):
    g = asset_url(STAGE)
    cad.goto()
    cad.wait_empty()
    cad.evaluate(
        """(g) => {
          window.__cadDispatch({ type: 'ADD_USER', text:
            '做一個單軸電動直線滑台:行程 100mm、負載 50N,NEMA23 步進馬達 + SFU1605 滾珠螺桿 + HGR15 導軌。' });
          window.__cadDispatch({ type: 'ADD_VERSION', version: { id: 'v1', name: 'linear_stage',
            source: 'generated', verified: false, glbUrl: g, formats: ['STEP','GLB','STL','3MF'] } });
          window.__cadDispatch({ type: 'PRESENT', glbUrl: g, name: 'linear_stage', ver: 'v1', source: 'generated' });
          window.__cadDispatch({ type: 'SET_PARAMS', defs: [
            { key: 'stroke', value: 100, label: '行程', min: 50, max: 200, step: 5, unit: 'mm' },
            { key: 'load', value: 50, label: '負載', min: 10, max: 200, step: 10, unit: 'N' } ] });
        }""",
        g,
    )
    cad.wait_canvas()


shot(id="first_model", chapter=3, title="第一個模型出爐", setup=_first_model, callouts=[
    {"n": 1, "sel": ".user-bubble", "label": "你打的需求(左欄對話串)", "tone": "primary"},
    {"n": 2, "sel": ".canvas", "label": "產出的真實 3D 模型:可拖曳旋轉、圈選、匯出", "tone": "accent"},
    {"n": 3, "sel": ".paramsbar", "label": "可調參數自動出現在底部", "tone": "good"},
    {"n": 4, "sel": ".versions", "label": "成果存成版本 v1,之後每次修改都新增一版", "tone": "good"},
])

# ── 第 4 章:檢視與挑選幾何 ──
shot(id="view_chrome", chapter=4, title="視圖工具列",
     setup=lambda cad: cad.goto_glb(STAGE, "stage"), callouts=[
         {"n": 1, "sel": ".canvas-tools", "label": "視圖工具:網格 / 座標軸 / 環繞 / 面標記 / 運動示意", "tone": "primary"},
         {"n": 2, "sel": ".orbit-hint", "label": "拖曳旋轉、滾輪縮放、雙擊推近", "tone": "accent"},
         {"n": 3, "sel": ".model-info", "label": "模型名稱 / 版號 / 類型", "tone": "good"},
     ])


def _pick_select(cad):
    cad.goto_glb(GANTRY, "gantry")
    _select_a_part(cad.page)
    cad.sleep(300)
    # 選件會自動展開物件屬性抽屜;關掉它讓焦點回到畫布上的圈選與面菱形
    try:
        if cad.page.locator(".tree-node").count():
            cad.page.locator(".props-toggle").click()
            cad.sleep(300)
    except Exception:
        pass


shot(id="pick_select", chapter=4, title="圈選零件與面菱形", setup=_pick_select, callouts=[
    {"n": 1, "sel": ".sel-nameplate", "label": "單擊圈選零件 → 出現名牌(可帶入對話,多選上限 4)", "tone": "primary"},
    {"n": 2, "sels": [".pick-marker"], "label": "面菱形◇:點它把面/邊帶入對話,供代理做量測、對齊", "tone": "good"},
])


def _props_tree(cad):
    cad.goto_glb(GANTRY, "gantry")
    cad.page.locator(".props-toggle").click()
    cad.page.wait_for_selector(".tree-node", timeout=8000)
    cad.sleep(400)


shot(id="props_tree", chapter=4, title="物件屬性與拓撲樹", setup=_props_tree, callouts=[
    {"n": 1, "sel": ".props-toggle", "label": "開啟物件屬性抽屜", "tone": "primary"},
    {"n": 2, "sels": [".tree-node"], "label": "拓撲樹:GROUP / PART / FACE 逐層展開", "tone": "accent"},
    {"n": 3, "sel": ".tree-eye", "label": "眼睛三態:實體 → 半透 → 隱藏(把外殼轉半透看內部)", "tone": "good"},
])

# ── 第 5 章:三種迭代 ──
def _spec_panel(cad):
    cad.goto()
    cad.wait_empty()
    cad.evaluate(INJECT_SPEC)
    cad.page.wait_for_selector(".canvas-spec", timeout=6000)
    panel = cad.page.locator(".canvas-spec")
    panel.locator(".cw-chip", has_text="導軌").click()
    cad.sleep(150)
    inp = panel.locator(".cw-chip-input")
    inp.fill("HGR20")
    inp.press("Enter")
    cad.sleep(300)


shot(id="spec_panel", chapter=5, title="規格修正面板", setup=_spec_panel, callouts=[
    {"n": 1, "sel": ".canvas-spec", "label": "視圖右上「解析規格」面板 = 事後改規格的作答面", "tone": "primary"},
    {"n": 2, "sel": ".cw-chip[data-edited]", "label": "任何 chip 都可點開改值(這裡把導軌改成 HGR20)", "tone": "accent"},
    {"n": 3, "sel": ".cw-confirm", "label": "「套用修正」送出;走「規格修正:」契約,精準只改這項", "tone": "good"},
])


def _params_bar(cad):
    cad.goto_glb(STAGE, "stage")
    cad.evaluate(
        """() => window.__cadDispatch({ type: 'SET_PARAMS', defs: [
          { key: 'stroke', value: 100, label: '行程', min: 50, max: 200, step: 5, unit: 'mm' },
          { key: 'load', value: 50, label: '負載', min: 10, max: 200, step: 10, unit: 'N' },
          { key: 'rail', value: 15, label: '導軌寬', min: 12, max: 25, step: 1, unit: 'mm' } ] })"""
    )
    cad.sleep(200)
    cad.evaluate("() => window.__cadDispatch({ type: 'SET_PARAM_VALUE', key: 'stroke', value: 130 })")
    cad.sleep(300)


shot(id="params_bar", chapter=5, title="參數滑桿", setup=_params_bar, callouts=[
    {"n": 1, "sel": ".paramsbar", "label": "底部參數列:對應產生器的可調尺寸", "tone": "primary"},
    {"n": 2, "sels": [".param"], "label": "拖滑桿走決定性路徑即時重生(免 LLM),每次一個新版本", "tone": "accent"},
    {"n": 3, "sel": ".paramsbar-apply", "label": "有改動 → 出現「套用 · 重生」;非法組合會顯示繁中錯誤並自動回滾", "tone": "good"},
])

# ── 第 6 章:運動與機構 ──
def _motion_design(cad):
    cad.goto_glb(STEERING, "steering_box", motion=STEER_MOTION)
    cad.evaluate("() => window.__cadMotion && window.__cadMotion.applyAt && window.__cadMotion.applyAt(0.5)")
    cad.sleep(500)


shot(id="motion_design", chapter=6, title="設計模式運動示意", setup=_motion_design, callouts=[
    {"n": 1, "sel": ".tool-chip:has-text('運動')", "label": "「▶ 運動示意」讓模型自己往復動(齒條齒輪耦合傳動)", "tone": "primary"},
    {"n": 2, "sel": ".canvas", "label": "同一份 MOTION 宣告:精算真跑掃掠、前端播放、滑桿改行程同步", "tone": "accent"},
])


def _sketch_dof(cad):
    _present_sketch(cad)
    cad.evaluate("() => window.__cadSketch && window.__cadSketch.setDrive('theta', 18)")
    cad.sleep(700)


shot(id="sketch_dof", chapter=6, title="草模驅動與讀數", setup=_sketch_dof, callouts=[
    {"n": 1, "sel": ".paramsbar[data-sketch]", "label": "拖驅動(DOF)滑桿 scrub,即時看姿態", "tone": "primary"},
    {"n": 2, "sels": [".sk-read"], "label": "傳動角讀數:綠(順)/黃(臨界)/紅(干涉或超程)", "tone": "good"},
    {"n": 3, "sel": ".sketch-legend", "label": "圖例:各構件對應色", "tone": "accent"},
])

# ── 第 7 章:標準件與鈑金 ──
def _sheet(cad, flat):
    g = asset_url(SHEET)
    gf = asset_url(SHEET_FLAT)
    gl = asset_url(SHEET_LINES)
    cad.goto()
    cad.wait_empty()
    cad.evaluate(
        """(a) => {
          const [g, gf, gl] = a;
          window.__cadDispatch({ type: 'RESTORE', snapshot: {
            sessionId: 's_guide_sheet', activeVer: 'v1',
            versions: [{ id: 'v1', name: 'sheet_u_bracket', source: 'generated', verified: true,
              glbUrl: g, flatGlbUrl: gf, flatLinesUrl: gl, hasDxf: true,
              formats: ['STEP','GLB','DXF'] }] } });
          window.__cadDispatch({ type: 'PRESENT', glbUrl: g, name: 'sheet_u_bracket', ver: 'v1',
            source: 'generated', flatGlbUrl: gf, flatLinesUrl: gl });
        }""",
        [g, gf, gl],
    )
    cad.wait_canvas()
    if flat:
        cad.page.locator(".fold-seg", has_text="攤平").click()
        try:
            cad.page.wait_for_function("() => !document.querySelector('.canvas-loading')", timeout=30000)
        except Exception:
            pass
        cad.sleep(900)


shot(id="sheet_folded", chapter=7, title="鈑金 · 摺疊態", setup=lambda cad: _sheet(cad, False), callouts=[
    {"n": 1, "sel": ".fold-switch", "label": "鈑金件左上出現「摺疊 / 攤平」切換", "tone": "primary"},
    {"n": 2, "sel": ".fold-seg:has-text('攤平')", "label": "點一下瞬間換視角、零重算(build 時已併行產雙 GLB)", "tone": "accent"},
])

shot(id="sheet_flat", chapter=7, title="鈑金 · 攤平態 + 折彎虛線", setup=lambda cad: _sheet(cad, True), callouts=[
    {"n": 1, "sel": ".canvas", "label": "攤平展開圖:板面疊折彎中心線 藍=上折 / 紅=下折", "tone": "primary"},
    {"n": 2, "sel": ".version-dl:has-text('DXF')", "label": "「⤓ DXF 展開圖」雷切下料用,CUT/BEND 分層", "tone": "good"},
])

shot(id="gripper_part", chapter=7, title="標準件選型範例",
     setup=lambda cad: cad.goto_glb(GRIPPER, "gripper"), callouts=[
         {"n": 1, "sel": ".canvas", "label": "講規格,代理自動選型並建進模型(此為平行氣爪族)", "tone": "primary"},
     ])

# ── 第 8 章:版本、回退、匯出 ──
shot(id="versions", chapter=8, title="版本時間軸與匯出閘",
     setup=lambda cad: _restore_two_versions(cad, STAGE), callouts=[
         {"n": 1, "sel": ".ver-verify[data-state='verified']", "label": "綠:已精算(完整幾何驗證通過)", "tone": "good"},
         {"n": 2, "sel": ".ver-verify[data-state='unverified']", "label": "琥珀:尚未精算(平常迭代很快,不等驗證)", "tone": "warn"},
         {"n": 3, "sel": ".version-dl:has-text('精算')", "label": "「✓ 精算此版」對此版跑完整驗證", "tone": "primary"},
         {"n": 4, "sel": ".version-dl:has-text('STEP')", "label": "匯出 STEP/STL/3MF;未驗證版按下會自動補跑驗證(匯出閘)", "tone": "accent"},
     ])

# ── 第 9 章:檔案管理 ──
def _file_browser(cad):
    cad.goto()
    cad.page.wait_for_selector(".hdr-btn", timeout=10000)
    cad.page.locator(".hdr-btn", has_text="開啟檔案").click()
    cad.page.wait_for_selector(".file-browser", timeout=8000)
    cad.sleep(500)


shot(id="file_browser", chapter=9, title="開啟檔案", setup=_file_browser, callouts=[
    {"n": 1, "sel": ".file-browser", "label": "從 models/ 開啟既有檔案", "tone": "primary"},
    {"n": 2, "sel": ".fb-projrow", "label": "可編輯專案:整列點開 = 複製成 session、帶滑桿可續改", "tone": "good"},
    {"n": 3, "sels": [".fb-row"], "label": "裸 STEP:僅檢視(不出驗證卡)", "tone": "accent"},
])

# ── 第 10 章:教訓系統 ──
shot(id="lesson_offer", chapter=10, title="人工記教訓卡",
     setup=lambda cad: (cad.goto(), cad.wait_empty(),
                        cad.evaluate("""() => window.__cadDispatch({ type: 'ADD_ITEM', item: {
                            type: 'lesson_offer', tag: 'guide-demo',
                            symptom: '鏡射定位靜默破壞左右對稱(肋錯位),幾何驗證仍全過',
                            fix: 'both=True 對稱擠出 + 鏡射' } })"""),
                        cad.page.wait_for_selector(".canvas-offer", timeout=6000), cad.sleep(300)), callouts=[
         {"n": 1, "sel": ".canvas-offer", "label": "「假綠」缺陷(驗證全過、只有看渲染才發現)修好後,代理問要不要記成教訓", "tone": "primary"},
         {"n": 2, "sel": ".fb-action.primary", "label": "按「是」直寫一筆待蒸餾教訓,未來生成避開同錯", "tone": "good"},
         {"n": 3, "sel": ".fb-action:has-text('否')", "label": "按「否」關掉不記", "tone": "accent"},
     ])


def _lessons_panel(cad):
    cad.goto()
    cad.page.wait_for_selector(".hdr-btn", timeout=10000)
    cad.page.locator(".hdr-btn", has_text="教訓").click()
    cad.page.wait_for_selector(".lessons-panel", timeout=8000)
    cad.sleep(500)


shot(id="lessons_panel", chapter=10, title="教訓管理面板", setup=_lessons_panel, callouts=[
    {"n": 1, "sel": ".lessons-panel", "label": "Header「📚 教訓」開管理面板:看/停用/重新蒸餾/刪除累積教訓", "tone": "primary"},
])


# ── 真回合 storyboard(選用;需認證,一次真實對話多點擷取)──
# 預設批次不跑(optional=True);要跑:capture.py --only live_first_story
def _live_first(cad):
    cad.goto()
    # BASE 會還原上次 session → 清 localStorage 後重載,拿到全新空白對話
    cad.page.evaluate("() => localStorage.clear()")
    cad.page.reload()
    cad.wait_empty()
    cad.page.fill(".composer-input", LIVE_PROMPT)
    cad.snap("first_prompt", chapter=3, title="描述你的需求(真實)", callouts=[
        {"n": 1, "sel": ".composer-input", "label": "把工程語言講清楚:行程、負載、驅動、傳動", "tone": "primary"},
        {"n": 2, "sel": ".composer-btn.send", "label": "按 ↑ 或 Enter 送出", "tone": "accent"},
    ])
    cad.page.click(".composer-btn.send")
    cad.page.wait_for_selector(".composer-btn.interrupt", timeout=45000)
    # 進度面板(可能轉瞬,盡力擷取)
    try:
        cad.page.wait_for_selector(".canvas-progress", timeout=120000)
        cad.sleep(600)
        cad.snap("generating_live", chapter=3, title="產圖中(真實)", callouts=[
            {"n": 1, "sels": [".prog-stage"], "label": "五階段直列", "tone": "primary"},
            {"n": 2, "sel": ".prog-live", "label": "即時活動", "tone": "accent"},
            {"n": 3, "sel": ".prog-tool", "label": "當前工具卡", "tone": "good"},
        ])
    except Exception:
        pass
    # 等模型真的建好呈現(版本 chip 出現);中途冒 clarify 就採用建議繼續。最多 ~10 分鐘。
    deadline = time.time() + 600
    while time.time() < deadline:
        if cad.page.locator(".version-chip").count():
            break
        if cad.page.locator(".canvas-clarify-opt").count():
            (cad.page.locator(".canvas-clarify-suggest").first
             if cad.page.locator(".canvas-clarify-suggest").count()
             else cad.page.locator(".canvas-clarify-opt").first).click()
            cad.sleep(1800)
            continue
        cad.sleep(3000)
    cad.sleep(2000)
    try:
        cad.page.wait_for_selector("canvas.cad-canvas", timeout=30000)
    except Exception:
        pass
    cad.sleep(1500)
    cad.snap("first_model", chapter=3, title="第一個模型出爐(真實)", callouts=[
        {"n": 1, "sel": ".user-bubble", "label": "你的需求", "tone": "primary"},
        {"n": 2, "sel": ".spec-card", "label": "代理解析出的規格", "tone": "accent"},
        {"n": 3, "sel": ".canvas", "label": "產出的真實 3D 模型", "tone": "good"},
    ])
    cad.snap("overview_live", chapter=0, title="介面總覽(真實產物)", callouts=[
        {"n": 1, "sel": ".hdr", "label": "頂部列", "tone": "primary"},
        {"n": 2, "sel": ".stepper", "label": "階段列", "tone": "accent"},
        {"n": 3, "sel": ".conv-col", "label": "對話欄", "tone": "primary"},
        {"n": 4, "sel": ".canvas", "label": "3D 視圖", "tone": "accent"},
        {"n": 5, "sel": ".paramsbar", "label": "參數列", "tone": "good"},
        {"n": 6, "sel": ".versions", "label": "版本時間軸", "tone": "good"},
    ])


shot(id="live_first_story", chapter=3, title="真實 happy-path", live=True, storyboard=True,
     optional=True, setup=_live_first, callouts=[])
