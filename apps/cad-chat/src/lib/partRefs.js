// 用零件名稱寫的幾何參照(藍圖 C3)。
//
//   @arm            名叫 arm 的零件
//   @gantry/arm     gantry 底下的 arm(路徑由外而內,不必從根寫起)
//   @bolt.2         同名的第 2 個(依模型樹順序,從 1 起算)
//   @arm#f3         arm 的第 3 個面(#e 邊、#v 頂點同理)
//   @arm#~3fa9c2d1e0 arm 上穩定名稱為 3fa9c2d1e0 的面或邊(藍圖 C1):名稱說的是「它是怎麼
//                   做出來的」,不是第幾個——重建後序號變了,名稱還指同一個面
//
// 解析成量測/對齊工具吃的位置 token(#o1.5 / #o1.5.f3)。原則借自上游的 ref 文法:
// **對不上或不只一個時列出候選,絕不代選**——代選錯了是一次安靜的錯量測。
// 純函式:occurrence 表由呼叫端給(server 從 GLB 內嵌拓撲讀,見 cad/occurrences.mjs)。

const ELEMENT_RE = /^(?:[fev]\d+|~[0-9a-f]{6,16})$/;
const MAX_CANDIDATES = 8;

export function isPartRef(text) {
  return typeof text === "string" && text.trim().startsWith("@");
}

// "@gantry/arm.2#f3" → { path: ["gantry", "arm.2"], element: "f3" };文法錯回 { error }。
export function parsePartRef(text) {
  const raw = String(text || "").trim();
  if (!raw.startsWith("@")) return { error: `零件參照要以 @ 開頭,收到「${raw}」` };
  const hash = raw.indexOf("#");
  const body = hash < 0 ? raw.slice(1) : raw.slice(1, hash);
  const element = hash < 0 ? null : raw.slice(hash + 1);
  if (element !== null && !ELEMENT_RE.test(element)) {
    return { error: `「${raw}」的元素要寫成 #f3 / #e12 / #v5(面/邊/頂點 + 編號)或 #~穩定名稱` };
  }
  const path = body.split("/").map((s) => s.trim());
  if (!body || path.some((s) => !s)) return { error: `「${raw}」缺零件名稱` };
  return { path, element };
}

// occurrences: [{ id, name, parentId }](模型樹順序)。
function matchesPath(occ, byId, names) {
  let cur = occ;
  for (let i = names.length - 1; i >= 0; i -= 1) {
    if (!cur || cur.name !== names[i]) return false;
    cur = cur.parentId ? byId.get(cur.parentId) : null;
  }
  return true;
}

function describe(occ, byId) {
  const parent = occ.parentId ? byId.get(occ.parentId) : null;
  return parent?.parentId ? `${parent.name}/${occ.name}` : occ.name;
}

// 找不到時的候選:名稱含有(或被含於)要找的字的排前面,其餘依樹順序補滿。
function nearby(occurrences, wanted) {
  const w = wanted.toLowerCase();
  const names = [...new Set(occurrences.map((o) => o.name))];
  const close = names.filter((n) => n.toLowerCase().includes(w) || w.includes(n.toLowerCase()));
  return [...close, ...names.filter((n) => !close.includes(n))].slice(0, MAX_CANDIDATES).map((n) => `@${n}`);
}

// 穩定名稱 → 目前這次建置裡的元素(f3 / e12)。names 是 build sidecar 的 names 欄位。
// 找不到就是找不到:那個面在目前的版本不存在了(被切掉、合併,或做法變了)——不找替代品。
function elementByName(names, part, stable) {
  const table = names?.parts && Object.hasOwn(names.parts, part) ? names.parts[part] : null;
  if (!table) return { error: `零件 ${part} 沒有穩定名稱可查(匯入件、同名零件或這次建置沒有產生),請改用 #f 編號` };
  for (const code of ["f", "e"]) {
    const at = Array.isArray(table[code]) ? table[code].indexOf(stable) : -1;
    if (at >= 0) return { element: `${code}${at + 1}` };
  }
  return { error: `零件 ${part} 在目前的版本沒有名稱為 ~${stable} 的面或邊(它已經被改掉或移除);請重新點選或改用 #f 編號` };
}

// → { ok: true, token, name } 或 { ok: false, error, candidates: [...] }
export function resolvePartRef(text, occurrences, names = null) {
  const parsed = parsePartRef(text);
  if (parsed.error) return { ok: false, error: parsed.error, candidates: [] };
  const list = Array.isArray(occurrences) ? occurrences : [];
  if (!list.length) {
    return { ok: false, error: "這個模型沒有可用的零件表,請改用位置 token(#o1.2 這種)", candidates: [] };
  }
  const byId = new Map(list.map((o) => [o.id, o]));
  const { path, element } = parsed;
  const done = (occ) => {
    if (element?.startsWith("~")) {
      const found = elementByName(names, occ.name, element.slice(1));
      if (found.error) return { ok: false, error: found.error, candidates: [] };
      return { ok: true, token: `#${occ.id}.${found.element}`, name: occ.name };
    }
    return { ok: true, token: `#${occ.id}${element ? `.${element}` : ""}`, name: occ.name };
  };

  // 名稱原樣比對(名稱本身可以含 .2)
  let hits = list.filter((o) => matchesPath(o, byId, path));
  let index = null;
  if (!hits.length) {
    // 尾端 .N = 同名的第 N 個
    const m = /^(.+)\.(\d+)$/.exec(path[path.length - 1]);
    if (m) {
      index = Number(m[2]);
      hits = list.filter((o) => matchesPath(o, byId, [...path.slice(0, -1), m[1]]));
    }
  }
  const shown = String(text).trim();
  if (!hits.length) {
    return {
      ok: false,
      error: `找不到零件「${shown}」`,
      candidates: nearby(list, path[path.length - 1].replace(/\.\d+$/, "")),
    };
  }
  if (index !== null) {
    if (index >= 1 && index <= hits.length) return done(hits[index - 1]);
    return {
      ok: false,
      error: `「${shown}」超出範圍:同名的只有 ${hits.length} 個`,
      candidates: hits.slice(0, MAX_CANDIDATES).map((o, i) => `@${describe(o, byId)}.${i + 1} (#${o.id})`),
    };
  }
  if (hits.length === 1) return done(hits[0]);
  const base = path.join("/");
  return {
    ok: false,
    error: `「${shown}」有 ${hits.length} 個同名零件,請指明是哪一個`,
    candidates: hits.slice(0, MAX_CANDIDATES).map((o, i) => `@${base}.${i + 1} (#${o.id},在 ${describe(o, byId)})`),
  };
}

// 工具參數用:@ 開頭才解析,其餘(#o1.2 這種位置 token)原樣通過。
export function resolveSelector(text, occurrences, names = null) {
  if (!isPartRef(text)) return { ok: true, token: String(text ?? "") };
  return resolvePartRef(text, occurrences, names);
}

// 位置 token(#o1.2.f3 / #f3)裡的元素 → { code: "f", index: 3 };不是面/邊回 null。
export function elementOfToken(token) {
  const m = /(?:^#?|\.)([fe])(\d+)$/.exec(String(token || ""));
  return m ? { code: m[1], index: Number(m[2]) } : null;
}

// 點選的元素在這次建置的穩定名稱與建立位置:{ stable, file, line }(各自可能缺)。
export function elementProvenance(names, part, token) {
  const el = elementOfToken(token);
  if (!el || !names || !part) return null;
  const pick = (table) => (table && Object.hasOwn(table, part) ? table[part]?.[el.code]?.[el.index - 1] : null);
  const stable = pick(names.parts);
  const made = pick(names.lines);
  const out = {};
  if (typeof stable === "string" && /^[0-9a-f]{6,16}$/.test(stable)) out.stable = stable;
  if (Array.isArray(made) && Number.isInteger(made[1]) && made[1] > 0) {
    const file = String(names.files?.[made[0]] || "").replace(/[^\w.\-]/g, "").slice(0, 80);
    if (file) Object.assign(out, { file, line: made[1] });
  }
  return Object.keys(out).length ? { ...out, kind: el.code } : null;
}
