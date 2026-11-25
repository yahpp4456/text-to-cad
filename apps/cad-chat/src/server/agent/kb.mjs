// 機構設計知識庫(apps/cad-chat/kb)的索引載入:把 INDEX.md 的清單組成系統提示的一段。
// 主題檔本身不進提示——代理遇到清單上的情境才用讀檔工具讀(readScope 只放行這個目錄)。
// 新增主題 = 加一個 .md + INDEX.md 補一行,不必改程式(格式由 prompt.kb.test.js 守)。
import fs from "node:fs";
import path from "node:path";

import { RUNTIME_ROOT } from "../config.mjs";
import { KB_DIR_REL } from "./readScope.mjs";

// 主題檔必要章節(README.md「寫作規則」同一份;_TEMPLATE.md 也要有)
export const KB_REQUIRED_SECTIONS = [
  "## 適用情境",
  "## 計算與選型",
  "## 在本系統怎麼做",
  "## 做不到與要講明的事",
  "## 來源與信心",
];
// 不是主題檔的檔名(不必列入索引)
export const KB_META_FILES = new Set(["INDEX.md", "README.md", "_TEMPLATE.md"]);

// INDEX.md 的清單行:`- 檔名|主題|何時讀`。回 [{file, topic, when}];格式不合的行略過。
export function parseKbIndex(text) {
  const out = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^-\s+([a-z0-9][a-z0-9-]*\.md)\s*\|\s*([^|]+?)\s*\|\s*(.+?)\s*$/);
    if (m) out.push({ file: m[1], topic: m[2], when: m[3] });
  }
  return out;
}

let cached = null; // 每個程序讀一次:改 INDEX.md 要重啟伺服器(系統提示前綴因此穩定可快取)

export function loadKbIndex({ root = RUNTIME_ROOT, fresh = false } = {}) {
  if (cached && !fresh && cached.root === root) return cached.entries;
  let entries = [];
  try {
    const dir = path.join(root, KB_DIR_REL);
    entries = parseKbIndex(fs.readFileSync(path.join(dir, "INDEX.md"), "utf8")).filter((e) =>
      fs.existsSync(path.join(dir, e.file)),
    );
  } catch {
    entries = []; // 知識庫缺席(部署時沒帶到等)→ 不出這一段,其餘照常
  }
  cached = { root, entries };
  return entries;
}

// 系統提示的知識庫段(無主題 → 空字串,提示不出這段)。
export function buildKbSection(entries = loadKbIndex()) {
  if (!entries.length) return "";
  const lines = entries.map((e) => `- \`${KB_DIR_REL}/${e.file}\`——${e.topic}:${e.when}`);
  return (
    "\n**機構設計知識庫(選型計算、設計慣例、構型取捨)**:需要你**決定**尺寸、選型或構型時——使用者沒給而要你估推力/扭矩/" +
    "缸徑/導程/齒數/孔徑,或只講功能沒指定機構——先 Read 下列對應的檔(整檔讀一次),照裡面的算法定規格,算式用到而使用者沒給的" +
    "條件(質量、速度、氣壓、安全係數)放進 emit_spec 標 assumed。使用者已給齊規格的零件、或只是修改既有模型的尺寸,不必讀。" +
    "知識庫是給你查的:對使用者只講結論與假設,不提檔名。\n" +
    lines.join("\n")
  );
}
