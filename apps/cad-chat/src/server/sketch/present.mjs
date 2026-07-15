// 草模呈現:驗證 → 寫 <name>.sketch.json → bump 版本 → versions/vN 快照 → 三事件。
// emitPresent(cad/pipeline.mjs)的平行輕量實作,不塞進去:那條深度 CAD 專屬
// (manifest 推導/gen_dxf 偵測/verified memo),草模只有「一個 JSON 檔」要凍結,
// 平行 ~60 行把 flatGlbUrl 那串手帶陷阱面縮到最小。共用的只有版本計數器、
// versions/vN 目錄慣例、pruneSnapshots 與同名三事件。
import fs from "node:fs";
import path from "node:path";

import { BASE_PATH, resolveMaxSnapshots } from "../config.mjs";
import { persistSession } from "../sessions.mjs";
import { pruneSnapshots, sanitizeName, snapshotDir } from "../cad/pipeline.mjs";
import { scrubPaths } from "../cad/python.mjs";
import { compileSketch } from "../../lib/sketch/sketchEval.js";
import { validateSketch } from "../../lib/sketch/sketchSchema.js";

export function sketchFileName(name) {
  return `${sanitizeName(name)}.sketch.json`;
}

// 驗證+寫檔+呈現一體(純函式,LLM-free 可測;deterministicRegen 先例)。
// 失敗契約:不寫檔、不 bump 版本、不發版本事件——無半成品,errors 原樣回
// agent 自修(訊息繁中、帶 path)。
export function presentSketch(session, { name, scene }, emit) {
  const res = validateSketch(scene);
  if (!res.ok) return { ok: false, errors: res.errors, warnings: res.warnings };
  // 驗證過但求值器編不動(理論上不該發生)也走同一失敗契約,別寫下viewer
  // 打不開的場景。compile 是純 JS(毫秒級),同時預跑致動器配尺寸/軌跡取樣。
  try {
    compileSketch(res.doc);
  } catch (err) {
    const errors = Array.isArray(err?.errors)
      ? err.errors
      : [{ path: "", message: String(err?.message || err) }];
    return { ok: false, errors, warnings: res.warnings };
  }
  const part = sanitizeName(name || res.doc.name || "sketch");
  writeSketchScene(session, part, res.doc);
  const out = emitSketchPresent(session, part, emit);
  return { ok: true, warnings: res.warnings, ...out };
}

// 寫入正規化後的 doc(磁碟保持 canonical 形式;前端載入時仍防禦性重驗)。
export function writeSketchScene(session, part, doc) {
  fs.writeFileSync(
    path.join(session.workdir, sketchFileName(part)),
    JSON.stringify(doc, null, 1),
    "utf8",
  );
  session.lastName = part;
}

// 呈現(sketch_present 與 revert-version 共用):以磁碟 <part>.sketch.json 為
// 真相源讀摘要(revert 復用時 doc 不在手上)。
export function emitSketchPresent(session, part, emit) {
  session.version += 1;
  session.lastName = part;
  const ver = `v${session.version}`;
  const file = sketchFileName(part);
  let doc = null;
  try {
    doc = JSON.parse(fs.readFileSync(path.join(session.workdir, file), "utf8"));
  } catch {
    /* 摘要欄位降級為空;sceneUrl 仍指向檔案(前端載入時誠實報錯) */
  }
  const partCount = Array.isArray(doc?.bodies) ? doc.bodies.length : 0;
  session.lastPartCount = partCount;
  const dofs = Array.isArray(doc?.drives)
    ? doc.drives.map((d) => ({
        id: d.id,
        label: d.label || d.id,
        unit: d.unit || "",
        min: d.min,
        max: d.max,
      }))
    : [];
  const joints = { revolute: 0, prismatic: 0 };
  for (const b of doc?.bodies || []) {
    if (b?.joint?.type === "revolute") joints.revolute += 1;
    else if (b?.joint?.type === "prismatic") joints.prismatic += 1;
  }
  const title = (typeof doc?.title === "string" && doc.title) || part;

  // 快照:只凍 scene + meta.json 兩個檔;失敗鏡射 emitPresent 的誠實降級
  //(退頂層檔 + error 事件 + snapshot:false,此版無法回退)。
  let fileRel;
  let snapshotOk = true;
  try {
    const dir = snapshotDir(session, session.version);
    fs.mkdirSync(dir, { recursive: true });
    fs.copyFileSync(path.join(session.workdir, file), path.join(dir, file));
    fs.writeFileSync(
      path.join(dir, "meta.json"),
      JSON.stringify({ name: part, type: "sketch", partCount, ts: Date.now() }),
      "utf8",
    );
    fileRel = `${session.workdirRel}/versions/v${session.version}/${file}`;
  } catch (err) {
    snapshotOk = false;
    console.warn(`[cad-chat] 草模版本快照失敗(退回頂層檔):${err?.message || err}`);
    fileRel = `${session.workdirRel}/${file}`;
    emit("error", {
      message: `${ver} 的版本快照建立失敗(${scrubPaths(String(err?.message || err))}):此版無法回退,將跟隨最新草模。`,
    });
  }
  pruneSnapshots(session, resolveMaxSnapshots());

  const sceneUrl = `${BASE_PATH}/api/asset?file=${encodeURIComponent(fileRel)}&v=${session.version}`;
  const ghost = (part || "SKCH").replace(/[^a-z0-9]/gi, "").slice(0, 4).toUpperCase() || "SKCH";
  // 三事件契約:type:"sketch" + sceneUrl 承載;不帶 glbUrl、不帶 verified
  //(undefined 三態 → 前端驗證 badge 自動不渲染)、禁帶 mode 欄位(events.js
  // 有已拆除雙模式時代的 legacy mode 映射殘留,撞名必踩)。
  emit("artifact", {
    ver, name: part, code: part, ghost, formats: [],
    type: "sketch", partCount, source: "generated",
    sceneUrl, dofs, joints, title,
  });
  emit("version", {
    id: ver,
    name: part,
    file: fileRel,
    sceneUrl,
    formats: [],
    type: "sketch",
    partCount,
    source: "generated",
    snapshot: snapshotOk,
    dofs,
    title,
  });
  emit("present", { ver, name: part, code: part, file: fileRel, sceneUrl, type: "sketch" });
  persistSession(session);
  return { ver, sceneUrl, partCount, dofs };
}
