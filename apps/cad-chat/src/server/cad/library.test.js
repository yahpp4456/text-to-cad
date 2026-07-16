// 零件庫純邏輯單元測(node --test,tmp modelsRoot 注入,零 spawn):
// librarySlug 淨化、addLibraryPart 寫檔/meta 內容、exists/overwrite、越界拒絕。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LIBRARY_DIR, addLibraryPart, librarySlug } from "./library.mjs";

function tmpRoot(tag) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-lib-${tag}-`));
}

function seedStep(root, name = "src.step") {
  const p = path.join(root, name);
  fs.writeFileSync(p, "ISO-10303-21; fake step for tests", "utf8");
  return p;
}

test("librarySlug:ASCII 淨化、去副檔名、CJK 全滅退 part、長度截斷", () => {
  assert.equal(librarySlug("SMC CQ2B32.step"), "smc_cq2b32");
  assert.equal(librarySlug("MY-Part_01.STP"), "my-part_01");
  assert.equal(librarySlug("汽缸"), "part");
  assert.equal(librarySlug("  "), "part");
  assert.ok(librarySlug("x".repeat(99)).length <= 48);
});

test("addLibraryPart:寫 <slug>.step + meta.json(內容/欄位),回 rel/dir", () => {
  const root = tmpRoot("add");
  try {
    const src = seedStep(root);
    const r = addLibraryPart({
      srcAbs: src,
      modelsRoot: root,
      label: "SMC CQ2B32",
      family: "cylinder",
      notes: "薄型方身",
      bbox: { size: [32, 32, 50.5], faceCount: 42 },
    });
    assert.equal(r.ok, true);
    assert.equal(r.slug, "smc_cq2b32");
    assert.equal(r.rel, `${LIBRARY_DIR}/smc_cq2b32/smc_cq2b32.step`);
    const stepAbs = path.join(root, LIBRARY_DIR, "smc_cq2b32", "smc_cq2b32.step");
    assert.ok(fs.existsSync(stepAbs) && fs.statSync(stepAbs).size > 0);
    const meta = JSON.parse(
      fs.readFileSync(path.join(root, LIBRARY_DIR, "smc_cq2b32", "meta.json"), "utf8"),
    );
    assert.equal(meta.schemaVersion, 1);
    assert.equal(meta.label, "SMC CQ2B32");
    assert.equal(meta.family, "cylinder");
    assert.deepEqual(meta.bboxMm, [32, 32, 50.5]);
    assert.equal(meta.faceCount, 42);
    assert.ok(meta.addedAt);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("addLibraryPart:同 slug 未 overwrite → exists;overwrite:true 放行覆蓋", () => {
  const root = tmpRoot("exists");
  try {
    const src = seedStep(root);
    assert.equal(addLibraryPart({ srcAbs: src, modelsRoot: root, label: "a" }).ok, true);
    const dup = addLibraryPart({ srcAbs: src, modelsRoot: root, label: "a" });
    assert.equal(dup.ok, false);
    assert.equal(dup.error, "exists");
    assert.equal(dup.slug, "a");
    const over = addLibraryPart({ srcAbs: src, modelsRoot: root, label: "a", overwrite: true });
    assert.equal(over.ok, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("addLibraryPart:slug 越界(../)被 slug 淨化吸收,寫入恆在 parts-library/ 內", () => {
  const root = tmpRoot("escape");
  try {
    const src = seedStep(root);
    const r = addLibraryPart({ srcAbs: src, modelsRoot: root, slug: "../../evil" });
    assert.equal(r.ok, true);
    // "../../evil" 淨化成 "evil"(斜線/點滅);絕不寫出 parts-library 外
    assert.ok(r.rel.startsWith(`${LIBRARY_DIR}/`));
    assert.ok(fs.existsSync(path.join(root, LIBRARY_DIR, r.slug, `${r.slug}.step`)));
    assert.ok(!fs.existsSync(path.join(root, "..", "evil")));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
