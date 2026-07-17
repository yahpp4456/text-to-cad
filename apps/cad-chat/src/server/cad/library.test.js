// 零件庫純邏輯單元測(node --test,tmp modelsRoot 注入,零 spawn):
// librarySlug 淨化、addLibraryPart 寫檔/meta 內容、exists/overwrite、越界拒絕。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import { LIBRARY_DIR, addLibraryPart, deleteLibraryPart, librarySlug, listLibraryParts } from "./library.mjs";
import { resolveLibrarySource } from "./library.mjs";

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

test("resolveLibrarySource:上傳/models 來源放行,絕對路徑/越界/副檔名/缺檔拒絕", () => {
  const workdir = tmpRoot("source-work");
  const modelsRoot = tmpRoot("source-models");
  const session = { workdir, modelsRoot };
  try {
    const uploadsDir = path.join(workdir, "uploads");
    fs.mkdirSync(uploadsDir, { recursive: true });
    const uploadAbs = seedStep(uploadsDir, "x.step");
    const upload = resolveLibrarySource(session, "uploads/x.step");
    assert.equal(upload.ok, true);
    assert.equal(upload.fromUploads, true);
    assert.equal(upload.srcAbs, uploadAbs);

    assert.equal(resolveLibrarySource(session, "C:\\evil\\x.step").ok, false);
    assert.equal(resolveLibrarySource(session, "../escape.step").ok, false);
    assert.equal(resolveLibrarySource(session, "foo.glb").ok, false);

    const modelDir = path.join(modelsRoot, "sub");
    fs.mkdirSync(modelDir, { recursive: true });
    const modelAbs = seedStep(modelDir, "part.step");
    const model = resolveLibrarySource(session, "sub/part.step");
    assert.equal(model.ok, true);
    assert.equal(model.fromUploads, false);
    assert.equal(model.srcAbs, modelAbs);

    assert.deepEqual(resolveLibrarySource(session, "uploads/missing.step"), {
      ok: false,
      error: "檔案不存在",
    });
  } finally {
    fs.rmSync(workdir, { recursive: true, force: true });
    fs.rmSync(modelsRoot, { recursive: true, force: true });
  }
});

test("listLibraryParts:列 meta+GLB 存在性,壞 meta 跳過,addedAt 降冪", () => {
  const root = tmpRoot("list");
  try {
    const src = seedStep(root);
    addLibraryPart({ srcAbs: src, modelsRoot: root, label: "old part", family: "other" });
    // 手改 addedAt 排序可測(old 較舊)
    const oldMeta = path.join(root, LIBRARY_DIR, "old_part", "meta.json");
    const m = JSON.parse(fs.readFileSync(oldMeta, "utf8"));
    fs.writeFileSync(oldMeta, JSON.stringify({ ...m, addedAt: "2020-01-01T00:00:00Z" }));
    addLibraryPart({ srcAbs: src, modelsRoot: root, label: "new part", family: "cylinder" });
    // new_part 補一個 GLB sidecar;再放一個壞目錄(無 meta)
    fs.writeFileSync(path.join(root, LIBRARY_DIR, "new_part", ".new_part.step.glb"), "glb");
    fs.mkdirSync(path.join(root, LIBRARY_DIR, "broken"), { recursive: true });

    const parts = listLibraryParts(root);
    assert.equal(parts.length, 2); // broken 跳過
    assert.equal(parts[0].slug, "new_part"); // addedAt 降冪
    assert.equal(parts[0].family, "cylinder");
    assert.ok(parts[0].glbRel && parts[0].glbMtime > 0);
    assert.equal(parts[1].slug, "old_part");
    assert.equal(parts[1].glbRel, null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("listLibraryParts:無庫目錄回空陣列", () => {
  const root = tmpRoot("empty");
  try {
    assert.deepEqual(listLibraryParts(root), []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("deleteLibraryPart:整目錄移除;不存在回 ok:false;slug 淨化不越界", () => {
  const root = tmpRoot("del");
  try {
    const src = seedStep(root);
    addLibraryPart({ srcAbs: src, modelsRoot: root, label: "victim", family: "other" });
    const r = deleteLibraryPart(root, "victim");
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(root, LIBRARY_DIR, "victim")));

    assert.equal(deleteLibraryPart(root, "victim").ok, false); // 已刪
    // "../evil" 淨化吸收為 evil(無 meta)→ ok:false,絕不動庫外
    assert.equal(deleteLibraryPart(root, "../../evil").ok, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
