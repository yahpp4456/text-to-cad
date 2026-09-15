// 無塵電纜規格表單的純函數層(零依賴,node --test 直測)。
// 表單值的「真相」永遠是 session 內產生器的 PARAMS——這裡只做三件事:
//   canSkipAi        能不能零 LLM 直接生成(決定主鈕),不成立時給人話理由
//   composeCableSpecText  走 AI 那條時的「電纜規格:」契約文字
//   describeBands / derivedNote  唯讀顯示用的摘要(不參與幾何計算)
// **刻意不做量法換算**:換算後 PDF 參數表/滑桿/agent 看到的都是換算值,客戶拿
// 自己的手繪對照會對不上——量法不確定一律勾「我不確定量法」降級給 AI 問。

export const CABLE_SPEC_PREFIX = "電纜規格:";

// 值在欄位宣告範圍內嗎(defs 來自 PARAM_RANGES / 啟發式,與滑桿同一份)
export function outOfRange(defs, values) {
  const bad = [];
  for (const d of defs || []) {
    const v = Number(values?.[d.key]);
    if (!Number.isFinite(v)) {
      bad.push({ key: d.key, reason: "不是數值" });
      continue;
    }
    if (Number.isFinite(d.min) && v < d.min) bad.push({ key: d.key, reason: `低於下限 ${d.min}` });
    else if (Number.isFinite(d.max) && v > d.max) bad.push({ key: d.key, reason: `高於上限 ${d.max}` });
  }
  return bad;
}

// 「直接生成」能不能走(= 這件事不需要模型判斷)。回 {ok, reason}。
// 不成立時主鈕降級成「給 AI 確認」,reason 直接當 title 顯示——使用者要看得懂
// 為什麼這次得經過 AI。
// liveIssues:/api/cable/check 回來的閉式違規(跨參數耦合,單欄範圍看不出來)。
// 少了它,表單會在「幾何上根本建不起來」的組合上還亮著主鈕,按下去等 1–2 分鐘
// 才被 _check_params 踢回來。
export function canSkipAi(form, liveIssues = []) {
  if (!form || !form.dir) return { ok: false, reason: "還沒選範本" };
  const bad = outOfRange(form.defs, form.values);
  if (bad.length) {
    return { ok: false, reason: `${bad[0].key} ${bad[0].reason}` };
  }
  if (Array.isArray(liveIssues) && liveIssues.length) {
    return { ok: false, reason: liveIssues[0].message || "規格檢核未通過" };
  }
  if (form.unsure) return { ok: false, reason: "你勾了「不確定量法」——交給 AI 確認量法再生成" };
  if (String(form.note || "").trim()) {
    return { ok: false, reason: "有「給 AI 的修改說明」——那是表單改不到的事,交給 AI" };
  }
  return { ok: true, reason: "" };
}

// 帶表摘要(唯讀顯示:每層有幾條帶、各幾袋 × 內腔寬)。bands 缺 → 空陣列。
export function describeBands(bands) {
  const byLevel = new Map();
  for (const b of bands || []) {
    const lvl = Number(b?.level);
    if (!Number.isFinite(lvl)) continue;
    if (!byLevel.has(lvl)) byLevel.set(lvl, []);
    byLevel.get(lvl).push(b);
  }
  const n = byLevel.size;
  return [...byLevel.entries()]
    .sort((a, b) => b[0] - a[0]) // level 大 = 內層 = 客戶 L1,由內往外列
    .map(([lvl, bs]) => ({
      level: lvl,
      // 客戶編號:L1 = 最內層 = level N-1
      label: `L${n - lvl}`,
      text: bs.map((b) => `${b.n}×${b.bore}`).join(" + "),
      count: bs.length,
    }));
}

// 表單能當場算出來、且**不需要幾何核心**的派生數字(唯讀顯示)。
// 逐層定長型:總高 = 固定頭安裝高度 + 固定頭高;固定頭高應 = 11.5×層數 + 加高。
// (彎徑/包絡/餘隙這些要閉式,Phase 3 由 /api/cable/check 給。)
export function derivedNote(form) {
  const v = form?.values || {};
  const out = [];
  if (Number.isFinite(v.mount_h) && Number.isFinite(v.head_h)) {
    out.push(`總高 ${round2(v.mount_h + v.head_h)}`);
  }
  if (Number.isFinite(v.head_h) && Number.isFinite(form?.layers) && form.layers > 0) {
    const riser = round2(v.head_h - 11.5 * form.layers);
    out.push(`固定頭 = 11.5 × ${form.layers}${riser ? ` + 加高 ${riser}` : ""}`);
  }
  return out;
}

function round2(n) {
  return Math.round(n * 100) / 100;
}

function fmt(n) {
  const s = Number(n);
  if (!Number.isFinite(s)) return String(n);
  return String(Math.round(s * 1000) / 1000);
}

// 「電纜規格:」契約文字(送進 composer 讓使用者過目再送)。
// prompt.cable 認這個前綴 = 完整規格:已給的欄位不得再 emit_clarify,先 Read
// 產生器核對再 emit_spec;只有「不確定/備註」列的事才問。
export function composeCableSpecText(form) {
  if (!form || !form.dir) return "";
  const lines = [CABLE_SPEC_PREFIX];
  const layers = Number.isFinite(form.layers) ? `${form.layers} 層` : "";
  lines.push(
    `範本:models/${form.dir}/${form.name}.py(${[form.label, layers].filter(Boolean).join(" · ")})`,
  );
  lines.push("");
  lines.push("PARAMS(表單值,單位 mm):");
  for (const d of form.defs || []) {
    const label = form.labels?.[d.key];
    const note = form.notes?.[d.key];
    lines.push(
      `- ${d.key} = ${fmt(form.values?.[d.key])}` +
        (label ? `  # ${label}${note ? `,${note}` : ""}` : ""),
    );
  }
  const bands = describeBands(form.spec?.bands || form.bands);
  if (bands.length) {
    lines.push("");
    lines.push(
      form.specDirty
        ? "結構(**表單已改**,以這份為準——改寫產生器的 CABLE_SPEC):"
        : "固定結構(表單沒動,照範本):",
    );
    for (const b of bands) {
      lines.push(`- ${b.label}(level ${b.level}):${b.text}${b.count > 1 ? "(並排窄條)" : ""}`);
    }
    const riser = Number(form.spec?.riser_module ?? form.riserModule);
    if (Number.isFinite(riser)) {
      lines.push(`- 加高模組:固定架由下數第 ${riser + 1} 格`);
    }
    if (form.spec) {
      // 螺向已在表單確認過(預設=實裝標準)——明講「不要再問」,免得 agent 又拿
      // 檔案姿態當根據(X 的 OEM STEP 就是建反的)
      lines.push(`- 固定座螺向:${screwLabel(screwFromTop(form.spec))}(表單已確認,不要再問)`);
    }
    const lay = Number(form.spec?.layers ?? form.layers);
    if (form.specDirty && Number.isFinite(lay)) lines.push(`- 層數:${lay}`);
  }
  if (form.unsure) {
    lines.push("");
    lines.push(
      "不確定:量法未確認——L 是否含兩端夾持段 32.4、mount_h 是否量到下固定頭底面。" +
        "請先就這兩點問我(其餘欄位已確定,不要再問)。",
    );
  }
  const note = String(form.note || "").trim();
  if (note) {
    lines.push("");
    lines.push(`要改的地方:${note}`);
  }
  return lines.join("\n");
}

// ── 固定座螺向(measured.screw_from_top;1 = 六角袋朝下 = 客戶確認實裝標準)──
// 2026-08-25 客戶抓出 X 的 OEM STEP 把螺絲建反(照檔量測就複製了錯),所以這件
// 事升格成表單欄位:開範本預設吃範本宣告、使用者可翻轉;沒有 CABLE_SPEC 的
// 範本改不了(用對話改)。生成時隨 CABLE_SPEC 整塊改寫進產生器(rewriteSpec)。
export function screwFromTop(spec) {
  const v = spec?.measured?.screw_from_top;
  return v === 0 ? 0 : 1; // 只有明寫 0 才是反向;缺席=實裝標準
}

export function screwLabel(v) {
  return v ? "六角袋朝下、埋頭朝上(實裝標準)" : "六角袋朝上、埋頭朝下(反向)";
}

export function specWithScrew(spec, v) {
  if (!spec) return spec;
  return { ...spec, measured: { ...(spec.measured || {}), screw_from_top: v ? 1 : 0 } };
}

// ── 結構編輯(Phase 4:層數/帶型可改;送 open-project 的 spec 由這裡產生)──
// **加層一律加在最外側**(level 0):客戶編號 L1=最內層,所以既有層的 L 鍵完全
// 不動,只多出一個 L(N+1)。(若加在最內側,每一層的客戶編號都會 +1,使用者
// 剛填好的值全部錯位。)減層同理砍最外層。
export function specWithLayers(spec, n) {
  const cur = Number(spec?.layers) || 0;
  if (!spec || !Number.isInteger(n) || n < 1 || n > 12 || n === cur) return spec;
  let bands = (spec.bands || []).map((b) => ({ ...b }));
  let layers = cur;
  while (layers < n) {
    const next = layers + 1;
    const outer = bands
      .filter((b) => Number(b.level) === 0)
      .map((b, i) => ({ ...b, level: 0, key: `sleeve_l${next}${i ? `_${i + 1}` : ""}` }));
    bands = bands.map((b) => ({ ...b, level: Number(b.level) + 1 })).concat(outer);
    layers = next;
  }
  while (layers > n && layers > 1) {
    bands = bands
      .filter((b) => Number(b.level) !== 0)
      .map((b) => ({ ...b, level: Number(b.level) - 1 }));
    layers -= 1;
  }
  const riser = Math.min(Math.max(Number(spec.riser_module) || 0, 0), n - 1);
  return { ...spec, layers: n, riser_module: riser, bands };
}

// 層數變動時的 PARAMS:新的最外層拿「目前最長 + lenStep」,砍掉的層鍵直接消失
// (rewriteSpec 整塊替換,留著就是幽靈滑桿);head_h 保住原本的加高量。
export function paramsWithLayers(values, curLayers, n, { moduleH = 11.5, lenStep = 35 } = {}) {
  const out = { ...(values || {}) };
  if (n > curLayers) {
    let last = Number(out[`L${curLayers}`]) || 800;
    for (let i = curLayers + 1; i <= n; i++) {
      last += lenStep;
      out[`L${i}`] = last;
    }
  } else {
    for (let i = n + 1; i <= curLayers; i++) delete out[`L${i}`];
  }
  if (Number.isFinite(Number(out.head_h))) {
    const riser = Math.max(0, Number(out.head_h) - curLayers * moduleH);
    out.head_h = Math.round((n * moduleH + riser) * 10) / 10;
  }
  return out;
}

// 改某一層的帶型(口袋數 / 內腔寬)。多條並排的層只改第一條——並排窄條的配置
// (各自寬度與 x 位置)不是表單能安全編的,要動請用對話。
export function specWithBand(spec, level, patch) {
  if (!spec) return spec;
  let done = false;
  const bands = (spec.bands || []).map((b) => {
    if (done || Number(b.level) !== Number(level)) return b;
    done = true;
    const next = { ...b };
    if (Number.isFinite(Number(patch?.n))) next.n = Math.max(1, Math.round(Number(patch.n)));
    if (Number.isFinite(Number(patch?.bore))) next.bore = Number(patch.bore);
    return next;
  });
  return { ...spec, bands };
}

// 這一層可不可以在表單裡編帶型(單條才行;並排窄條列交給對話)
export function layerEditable(spec, level) {
  return (spec?.bands || []).filter((b) => Number(b.level) === Number(level)).length === 1;
}

// 層數變動時的**欄位定義**(表單渲染的是 defs,不是 values——只改 values 的話
// 新的 L 鍵不會長出欄位、砍掉的還留著)。新 L 沿用既有 L 的範圍模板;
// head_h 的下限跟著層數走(上限不夠就一起放寬,否則一加層就永遠越界)。
export function defsWithLayers(defs, curLayers, n, values, { moduleH = 11.5 } = {}) {
  const list = Array.isArray(defs) ? defs : [];
  const lTpl = list.find((d) => /^L\d+$/.test(d.key)) || { min: 200, max: 3000, step: 5, unit: "mm" };
  const out = [];
  for (let i = 1; i <= n; i++) {
    const key = `L${i}`;
    const cur = list.find((d) => d.key === key);
    const value = Number(values?.[key]);
    out.push(
      cur
        ? { ...cur, value: Number.isFinite(value) ? value : cur.value }
        : { ...lTpl, key, label: key, value: Number.isFinite(value) ? value : lTpl.min },
    );
  }
  for (const d of list) {
    if (/^L\d+$/.test(d.key)) continue;
    const value = Number(values?.[d.key]);
    const next = { ...d, value: Number.isFinite(value) ? value : d.value };
    if (d.key === "head_h") {
      next.min = Math.round(n * moduleH * 10) / 10;
      next.max = Math.max(Number(d.max) || 0, next.min + 30);
    }
    out.push(next);
  }
  return out;
}
