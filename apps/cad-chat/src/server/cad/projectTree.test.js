// 專案樹複製 / 原子換名寫入(node --test):tmp 根,不碰真 models/。
// 核心不變式:完整替代品在旁邊之前,目的地絕不消失——注入 copy/prepare/rename 製造
// 中途失敗,斷言目的地逐位不變或終態完整。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  copyProjectTree,
  generatorStems,
  ownedByGenerator,
  shouldSkipProjectEntry,
  sweepStaleSiblings,
  validateProjectDir,
  writeProjectTreeAtomic,
} from "./projectTree.mjs";

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-ptree-${tag}-`));
}

// 寫一棵樹:{ "a.py": "text", "sub/": { "x.txt": "…" } }(鍵尾 / = 目錄)
function writeTree(root, spec) {
  fs.mkdirSync(root, { recursive: true });
  for (const [k, v] of Object.entries(spec)) {
    if (k.endsWith("/")) writeTree(path.join(root, k.slice(0, -1)), v);
    else fs.writeFileSync(path.join(root, k), v, "utf8");
  }
}

function readTree(root, rel = "") {
  const out = {};
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const r = rel ? `${rel}/${ent.name}` : ent.name;
    if (ent.isDirectory()) Object.assign(out, readTree(path.join(root, ent.name), r));
    else out[r] = fs.readFileSync(path.join(root, ent.name), "utf8");
  }
  return out;
}

const SESSION_TREE = {
  "part.py": "PARAMS = {'w': 2}\n",
  "part.step": "STEP-v2",
  ".part.step.glb": "GLB-v2",
  ".part.step.meta.json": "{}",
  ".part.sweep.json": "[]",
  "part.asm.json": "{}",
  "imported/": { "a.step": "IMP" },
  "uploads/": { "ref.png": "PNG" },
  "versions/": { "v1/": { "part.py": "old" } },
  ".exports/": { "part.stl": "STL" },
  "session.json": "{}",
  "__pycache__/": { "part.cpython-313.pyc": "x" },
  "part.dxf": "DXF-stale",
  "notes.md": "session notes",
};

test("shouldSkipProjectEntry / copyProjectTree:跳過 session 私有項(含新加的 uploads)", () => {
  for (const n of ["__pycache__", "versions", ".exports", "session.json", "uploads", "a.pyc", "a.dxf"]) {
    assert.equal(shouldSkipProjectEntry(n), true, n);
  }
  for (const n of ["part.py", "part.step", ".part.step.glb", "imported", "notes.md", "case.json"]) {
    assert.equal(shouldSkipProjectEntry(n), false, n);
  }
  const root = tmpRoot("copy");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "dst");
    writeTree(src, SESSION_TREE);
    copyProjectTree(src, dst);
    assert.deepEqual(readTree(dst), {
      ".part.step.glb": "GLB-v2",
      ".part.step.meta.json": "{}",
      ".part.sweep.json": "[]",
      "imported/a.step": "IMP",
      "notes.md": "session notes",
      "part.asm.json": "{}",
      "part.py": "PARAMS = {'w': 2}\n",
      "part.step": "STEP-v2",
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("validateProjectDir:1–3 段、每段英數底線連字號;拒 . / .. / 空段 / 其他字元", () => {
  assert.equal(validateProjectDir("flip_gripper"), true);
  assert.equal(validateProjectDir("cases/20260825_XY"), true);
  assert.equal(validateProjectDir("a/b/c"), true);
  assert.equal(validateProjectDir("a/b/c/d"), false);
  assert.equal(validateProjectDir(""), false);
  assert.equal(validateProjectDir("a/"), false);
  assert.equal(validateProjectDir("/a"), false);
  assert.equal(validateProjectDir("../a"), false);
  assert.equal(validateProjectDir("a/./b"), false);
  assert.equal(validateProjectDir("a b"), false);
  assert.equal(validateProjectDir("客戶"), false);
  assert.equal(validateProjectDir(null), false);
});

test("ownedByGenerator / generatorStems:產生器家族(含隱藏衍生)與 imported 為 owned,其餘不是", () => {
  const stems = ["part", "old"];
  for (const n of [
    "part.py",
    "part.step",
    "part.asm.json",
    ".part.step.glb",
    ".part.step.meta.json",
    ".part.step.js",
    ".part.flat.step.glb",
    ".part.flat.lines.json",
    ".part.sweep.json",
    "old.py",
    ".old.step.glb",
    "imported",
    "__pycache__",
    "x.pyc",
  ]) {
    assert.equal(ownedByGenerator(n, stems), true, n);
  }
  for (const n of ["part.dxf", "drawing.pdf", "case.json", "20260825_fix", "other.step", "notes.md"]) {
    assert.equal(ownedByGenerator(n, stems), false, n);
  }
  const root = tmpRoot("stems");
  try {
    writeTree(root, { "a.py": "", "b.py": "", "c.txt": "", "sub/": { "d.py": "" } });
    assert.deepEqual(generatorStems(root).sort(), ["a", "b"]); // 只看頂層
    assert.deepEqual(generatorStems(path.join(root, "nope")), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeProjectTreeAtomic:全新目的地 → 純 rename;結果同 copyProjectTree,無暫存殘留", async () => {
  const root = tmpRoot("fresh");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "models", "proj");
    writeTree(src, SESSION_TREE);
    const r = await writeProjectTreeAtomic(src, dst);
    assert.deepEqual(r, { swapped: true, fallback: null });
    assert.equal(readTree(dst)["part.step"], "STEP-v2");
    assert.equal("uploads/ref.png" in readTree(dst), false);
    const siblings = fs.readdirSync(path.join(root, "models")).filter((n) => n.startsWith("."));
    assert.deepEqual(siblings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeProjectTreeAtomic 另存覆蓋(merge=false):整目錄取代,舊家族殘檔不留", async () => {
  const root = tmpRoot("replace");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "models", "proj");
    writeTree(src, SESSION_TREE);
    writeTree(dst, { "old.py": "OLD", "old.step": "OLD", "drawing.pdf": "PDF", "part.dxf": "DXF-tracked" });
    const r = await writeProjectTreeAtomic(src, dst, { merge: false });
    assert.equal(r.swapped, true);
    const t = readTree(dst);
    assert.equal("old.py" in t, false);
    assert.equal("drawing.pdf" in t, false);
    assert.equal("part.dxf" in t, false);
    assert.equal(t["part.py"], "PARAMS = {'w': 2}\n");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeProjectTreeAtomic 就地(merge=true):家族檔全換新、非家族檔保留、prepare 寫進暫存", async () => {
  const root = tmpRoot("merge");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "models", "cases", "x");
    writeTree(src, SESSION_TREE);
    writeTree(dst, {
      "part.py": "PARAMS = {'w': 1}\n",
      "part.step": "STEP-v1",
      ".part.step.glb": "GLB-v1",
      ".part.flat.step.glb": "FLAT-v1", // session 沒有這個衍生 → 也要消失(家族整組換)
      "old.py": "OLD", // 改名前的舊產生器家族 → 消失
      "old.step": "OLD",
      "part.dxf": "DXF-tracked", // 非家族:保留(tracked)
      "drawing.pdf": "PDF",
      "case.json": '{"customer":"甲"}',
      "20260825_fix/": { "a.pdf": "A" },
      "imported/": { "stale.step": "STALE" }, // owned 目錄 → 換成 session 的
    });
    const r = await writeProjectTreeAtomic(src, dst, {
      merge: true,
      prepare: (tmp) => fs.writeFileSync(path.join(tmp, "case.json"), '{"customer":"甲","updated":"x"}'),
    });
    assert.equal(r.swapped, true);
    assert.deepEqual(readTree(dst), {
      ".part.step.glb": "GLB-v2",
      ".part.step.meta.json": "{}",
      ".part.sweep.json": "[]",
      "20260825_fix/a.pdf": "A",
      "case.json": '{"customer":"甲","updated":"x"}',
      "drawing.pdf": "PDF",
      "imported/a.step": "IMP",
      "notes.md": "session notes",
      "part.asm.json": "{}",
      "part.dxf": "DXF-tracked",
      "part.py": "PARAMS = {'w': 2}\n",
      "part.step": "STEP-v2",
    });
    const siblings = fs.readdirSync(path.join(root, "models", "cases")).filter((n) => n.startsWith("."));
    assert.deepEqual(siblings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeProjectTreeAtomic:copy/prepare 中途 throw → 目的地逐位不變、無 .saving 殘留", async () => {
  const root = tmpRoot("fail");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "models", "proj");
    writeTree(src, SESSION_TREE);
    writeTree(dst, { "part.py": "KEEP", "part.step": "KEEP", "drawing.pdf": "PDF" });
    const before = readTree(dst);
    await assert.rejects(
      writeProjectTreeAtomic(src, dst, {
        copy: (s, d) => {
          copyProjectTree(s, d);
          throw new Error("ENOSPC boom");
        },
      }),
      /ENOSPC/,
    );
    assert.deepEqual(readTree(dst), before);
    await assert.rejects(
      writeProjectTreeAtomic(src, dst, {
        merge: true,
        prepare: () => {
          throw new Error("prepare boom");
        },
      }),
      /prepare boom/,
    );
    assert.deepEqual(readTree(dst), before);
    const siblings = fs.readdirSync(path.join(root, "models")).filter((n) => n.startsWith("."));
    assert.deepEqual(siblings, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("writeProjectTreeAtomic:rename 一路 EPERM → 退 rm+copy-over,終態仍完整", async () => {
  const root = tmpRoot("eperm");
  try {
    const src = path.join(root, "src");
    const dst = path.join(root, "models", "proj");
    writeTree(src, SESSION_TREE);
    writeTree(dst, { "part.py": "OLD", "part.step": "OLD" });
    let calls = 0;
    const rename = () => {
      calls += 1;
      const err = new Error("EPERM: operation not permitted");
      err.code = "EPERM";
      throw err;
    };
    const r = await writeProjectTreeAtomic(src, dst, { rename });
    assert.equal(r.swapped, false);
    assert.equal(r.fallback, "rm-then-copy");
    assert.ok(calls >= 2, `rename 應該被重試(calls=${calls})`);
    const t = readTree(dst);
    assert.equal(t["part.py"], "PARAMS = {'w': 2}\n");
    assert.equal(t["part.step"], "STEP-v2");
    const siblings = fs.readdirSync(path.join(root, "models")).filter((n) => n.startsWith("."));
    assert.deepEqual(siblings, []); // 暫存已清
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("sweepStaleSiblings:清掉同名的 .saving-* / .old-*,不碰別的點目錄", () => {
  const root = tmpRoot("sweep");
  try {
    writeTree(root, {
      ".proj.saving-abc/": { "x": "" },
      ".proj.old-abc/": { "x": "" },
      ".other.saving-abc/": { "x": "" },
      ".cadchat/": { "x": "" },
      "proj/": { "x": "" },
    });
    const removed = sweepStaleSiblings(root, "proj").sort();
    assert.deepEqual(removed, [".proj.old-abc", ".proj.saving-abc"]);
    assert.deepEqual(fs.readdirSync(root).sort(), [".cadchat", ".other.saving-abc", "proj"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
