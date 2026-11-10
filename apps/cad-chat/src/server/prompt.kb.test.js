// 機構設計知識庫的格式守護(驗規範不驗內容):索引↔檔案雙向一致、必要章節齊全、
// 系統提示帶得到索引、讀取範圍放行知識庫且只放行知識庫、主題檔引用的參考模型真的存在。
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

import { RUNTIME_ROOT } from "./config.mjs";
import {
  KB_META_FILES,
  KB_REQUIRED_SECTIONS,
  buildKbSection,
  loadKbIndex,
  parseKbIndex,
} from "./agent/kb.mjs";
import { buildSystemPrompt } from "./agent/prompt.mjs";
import { KB_DIR_REL, isReadAllowed, readScopeFor } from "./agent/readScope.mjs";

const KB = path.join(RUNTIME_ROOT, KB_DIR_REL);
const read = (f) => fs.readFileSync(path.join(KB, f), "utf8");
const entries = loadKbIndex({ fresh: true });

test("parseKbIndex:只收「- 檔名|主題|何時讀」;壞行略過", () => {
  const got = parseKbIndex("# t\n- a-b.md|主題 A|何時 A\n- 壞行\n- c.md | 主題 C | 何時|含直線 \n-x.md|a|b\n- UP.md|a|b");
  assert.deepEqual(got, [
    { file: "a-b.md", topic: "主題 A", when: "何時 A" },
    { file: "c.md", topic: "主題 C", when: "何時|含直線" },
  ]);
});

test("索引↔檔案雙向一致:INDEX 列的檔都在;kb/ 下的主題檔都被列到", () => {
  assert.ok(entries.length >= 1, "INDEX.md 沒有任何主題");
  const listed = new Set(parseKbIndex(read("INDEX.md")).map((e) => e.file));
  for (const f of listed) assert.ok(fs.existsSync(path.join(KB, f)), `INDEX 列了不存在的檔:${f}`);
  const onDisk = fs.readdirSync(KB).filter((f) => f.endsWith(".md") && !KB_META_FILES.has(f));
  for (const f of onDisk) assert.ok(listed.has(f), `${f} 沒被 INDEX.md 列到(代理永遠不會讀它)`);
  assert.equal(new Set(entries.map((e) => e.file)).size, entries.length, "INDEX 有重複檔名");
});

test("每個主題檔與範本都含全部必要章節,且「做不到」與「來源」不是空的", () => {
  for (const f of [...entries.map((e) => e.file), "_TEMPLATE.md"]) {
    const text = read(f);
    assert.match(text, /^# \S/m, `${f} 缺一級標題`);
    for (const h of KB_REQUIRED_SECTIONS) assert.ok(text.includes(`\n${h}\n`), `${f} 缺章節「${h}」`);
  }
  for (const e of entries) {
    const text = read(e.file);
    for (const h of ["## 做不到與要講明的事", "## 來源與信心"]) {
      const body = text.split(`\n${h}\n`)[1].split(/\n## /)[0].trim();
      assert.ok(body.length > 40, `${e.file}「${h}」內容太少`);
    }
  }
});

test("系統提示帶知識庫索引(每個主題一行、路徑寫全);主題檔內容不進提示", () => {
  const prompt = buildSystemPrompt({ workdirRel: "models/.cadchat/s_x" });
  assert.ok(prompt.includes("機構設計知識庫"));
  for (const e of entries) assert.ok(prompt.includes(`\`${KB_DIR_REL}/${e.file}\``), e.file);
  assert.ok(!prompt.includes("## 做不到與要講明的事"));
  assert.equal(buildKbSection([]), ""); // 知識庫缺席時不出這段
  // 索引段的長度與主題數成正比(每主題一行),不隨主題檔內容成長
  assert.ok(buildKbSection(entries).length < 400 + 160 * entries.length);
});

test("讀取範圍:知識庫可讀;apps/ 其他地方(原始碼、教訓快照、.env)照拒", () => {
  const scope = readScopeFor({ workdirAbs: path.join(RUNTIME_ROOT, "models/.cadchat/s_x") });
  for (const e of entries) assert.equal(isReadAllowed(`${KB_DIR_REL}/${e.file}`, scope), true, e.file);
  assert.equal(isReadAllowed(KB_DIR_REL, scope), true); // Glob 知識庫目錄
  for (const p of [
    "apps/cad-chat/src/server/agent/prompt.mjs",
    "apps/cad-chat/data/lessons.sam.json",
    "apps/cad-chat/.env.local",
    "apps/cad-chat/kb/../src/server/config.mjs",
    "apps/cad-chat",
  ]) {
    assert.equal(isReadAllowed(p, scope), false, p);
  }
});

test("主題檔引用的 models/ 參考模型與 kb 內互相引用的檔都真的存在(防漂移)", () => {
  for (const e of entries) {
    const text = read(e.file);
    for (const m of text.matchAll(/`models\/([A-Za-z0-9_-]+)(\/[A-Za-z0-9_./-]+)?`/g)) {
      const rel = `models/${m[1]}${m[2] || ""}`;
      assert.ok(fs.existsSync(path.join(RUNTIME_ROOT, rel)), `${e.file} 引用不存在的 ${rel}`);
    }
    for (const m of text.matchAll(/`([a-z0-9-]+\.md)`/g)) {
      assert.ok(fs.existsSync(path.join(KB, m[1])), `${e.file} 引用不存在的 ${m[1]}`);
    }
  }
});
