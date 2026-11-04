// 草稿儲存(node --test,tmp 工作目錄,零 spawn):保存/讀回/patch 合併/revision 衝突/捨棄/
// 由產生器嵌的 SURFACE_SPEC 重建。
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { compileSurfaceGenerator } from "./surfaceGen.mjs";
import { discardDraft, draftFileName, draftSummary, readDraft, resetDraftFromGenerator, saveDraft, writeDraft } from "./surfaceDraft.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const mouse = JSON.parse(fs.readFileSync(path.join(here, "../../lib/surface/examples/mouse_shell.json"), "utf8"));

function tmpSession(tag) {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `cadchat-draft-${tag}-`));
  return { sessionId: `s_${tag}`, workdir, workdirRel: `models/.cadchat/s_${tag}`, mode: "product", version: 0, lastName: null };
}

test("saveDraft(整份)→ 檔案落地、revision 從 1 起算、讀回正規化;draftSummary 可生成", () => {
  const s = tmpSession("save");
  try {
    const r = saveDraft(s, "Mouse Top", { draft: mouse, source: "ai" });
    assert.equal(r.ok, true);
    assert.equal(r.revision, 1);
    assert.ok(fs.existsSync(path.join(s.workdir, draftFileName("Mouse Top"))));
    const cur = readDraft(s, "MouseTop"); // sanitizeName 去空白、保留大小寫
    assert.equal(cur.revision, 1);
    assert.equal(cur.source, "ai");
    assert.equal(cur.draft.revision, 1);
    assert.equal(cur.draft.ops[0].op, "sew");
    const sum = draftSummary(cur.draft);
    assert.equal(sum.curves, 3);
    assert.equal(sum.surfaces, 1);
    assert.equal(sum.buildable, true);
    assert.equal(sum.symmetry, "YZ");
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("saveDraft(patch)局部合併:同 id 取代、新 id 追加、remove 刪除;半完成草稿可存但不可生成", () => {
  const s = tmpSession("patch");
  try {
    saveDraft(s, "m", { draft: mouse });
    const r = saveDraft(s, "m", { patch: { curves: [{ id: "sec_mid", kind: "line", points: [[0, 0, 0], [1, 0, 0]] }, { id: "extra", kind: "line", points: [[0, 0, 0], [2, 0, 0]] }] } });
    assert.equal(r.ok, true);
    assert.equal(r.revision, 2);
    assert.equal(r.draft.curves.length, 4);
    assert.equal(r.draft.curves[1].kind, "line");
    const r2 = saveDraft(s, "m", { patch: { remove: { surfaces: ["body"] } } });
    assert.equal(r2.ok, true);
    assert.equal(r2.draft.surfaces.length, 0);
    assert.equal(draftSummary(r2.draft).buildable, false, "沒有曲面 = 半完成");
    const bad = saveDraft(s, "m", { patch: { curves: [{ kind: "line" }] } });
    assert.equal(bad.ok, false);
    assert.ok(bad.errors[0].path.startsWith("patch.curves[0]"));
    const bad2 = saveDraft(s, "m", { draft: { schemaVersion: 2 } });
    assert.equal(bad2.ok, false);
    assert.ok(bad2.errors.some((e) => e.path === "schemaVersion"));
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("baseRevision 不符 → conflict(帶磁碟現值);相符 → 保存;捨棄後讀回 null", () => {
  const s = tmpSession("rev");
  try {
    saveDraft(s, "m", { draft: mouse });
    saveDraft(s, "m", { patch: { analysis: { minContinuity: "G2" } } });
    const stale = saveDraft(s, "m", { patch: { fuse: false }, baseRevision: 1 });
    assert.equal(stale.ok, false);
    assert.equal(stale.conflict, true);
    assert.equal(stale.revision, 2);
    assert.equal(stale.draft.analysis.minContinuity, "G2");
    const fresh = saveDraft(s, "m", { patch: { fuse: false }, baseRevision: 2, source: "user" });
    assert.equal(fresh.ok, true);
    assert.equal(fresh.revision, 3);
    assert.equal(readDraft(s, "m").source, "user");
    assert.equal(discardDraft(s, "m"), true);
    assert.equal(readDraft(s, "m"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("resetDraftFromGenerator:由 .py 嵌的 SURFACE_SPEC 重建草稿(無草稿 rev 0;有草稿 +1);無產生器 → null", () => {
  const s = tmpSession("reset");
  try {
    assert.equal(resetDraftFromGenerator(s, "m"), null);
    fs.writeFileSync(path.join(s.workdir, "m.py"), compileSurfaceGenerator(mouse, { name: "m" }), "utf8");
    const r = resetDraftFromGenerator(s, "m");
    assert.equal(r.revision, 0);
    assert.equal(r.draft.symmetry, "YZ");
    assert.equal(r.draft.curves.length, 3);
    writeDraft(s, "m", r.draft, { revision: 5 });
    assert.equal(resetDraftFromGenerator(s, "m").revision, 6);
    fs.writeFileSync(path.join(s.workdir, "plain.py"), "PARAMS = {}\ndef gen_step():\n    return None\n", "utf8");
    assert.equal(resetDraftFromGenerator(s, "plain"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});

test("readDraft:壞 JSON / schemaVersion 不符 / 結構不合法 → null", () => {
  const s = tmpSession("bad");
  try {
    fs.writeFileSync(path.join(s.workdir, draftFileName("m")), "{nope", "utf8");
    assert.equal(readDraft(s, "m"), null);
    fs.writeFileSync(path.join(s.workdir, draftFileName("m")), JSON.stringify({ schemaVersion: 9, draft: mouse }), "utf8");
    assert.equal(readDraft(s, "m"), null);
    fs.writeFileSync(path.join(s.workdir, draftFileName("m")), JSON.stringify({ schemaVersion: 1, revision: 1, draft: { schemaVersion: 1, curves: [{ id: "X" }] } }), "utf8");
    assert.equal(readDraft(s, "m"), null);
  } finally {
    fs.rmSync(s.workdir, { recursive: true, force: true });
  }
});
