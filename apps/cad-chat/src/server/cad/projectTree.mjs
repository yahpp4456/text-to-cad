// 專案樹(models/<dir> ↔ session workdir)的複製與**原子換名寫入**。
//
// 兩個寫入者共用:open-project(models/<dir> → session workdir)與 save-project
// (session workdir → models/<dir>,含「儲存」就地覆寫)。純檔案系統邏輯,不碰 session/
// user,所以 L1 可用 tmp 目錄直接測(projectTree.test.js)。
//
// 不變式(writeProjectTreeAtomic):**完整替代品在旁邊之前,目的地絕不消失**。
// 舊做法 rmSync(dst) 再 copyProjectTree——複製中途炸掉(磁碟滿、Windows EPERM:viewer 正
// 串流該目錄的 GLB、/api/open 的 Python 子程序開著 STEP)= 唯一存檔消失。
import fs from "node:fs";
import path from "node:path";

// versions/ 跳過:那是 session 內部的版本快照歷史——存出的專案是「成品」不是「歷史」,
// 開回來的新 session 版本計數從 0 起,帶舊快照只會 id 錯位。
// session.json / .exports/ 也跳過:前者是 session 私有中繼資料(sdkSessionId 等機器
// 本地識別;models/<name>/ 是 git 追蹤的,存出去就是把它發佈出去),後者是轉檔
// 工作區雜物;兩者對「存出的成品/開回來的新 session」都沒有意義。
// (轉檔區取名 .exports 帶點前綴,避免與手工專案裡使用者自己的 exports/ 目錄撞名被丟。)
// uploads/ 跳過:聊天附件(參考圖/客戶 STEP)屬於 session,產生器只引用 imported/;
// 帶出去會把附件塞進 git 追蹤的專案目錄。
const SKIP_NAMES = new Set(["__pycache__", "versions", ".exports", "session.json", "uploads"]);

export function shouldSkipProjectEntry(name) {
  if (SKIP_NAMES.has(name)) return true;
  if (name.endsWith(".pyc")) return true;
  // 展開圖 DXF 是「按需匯出」產物,不隨滑桿重生更新:帶出去會是與 STEP
  // 尺寸不符的過期圖(viewer 又會自動與同名 .py 配對)。要展開圖用匯出鈕現算。
  if (name.endsWith(".dxf")) return true;
  return false;
}

// 遞迴複製專案樹(跳過快取/隱藏目錄雜物;隱藏 topology GLB 要帶——重建失敗時至少能看圖)。
export function copyProjectTree(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    if (shouldSkipProjectEntry(ent.name)) continue;
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyProjectTree(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// 逐字複製(不過濾;給已經過濾好的暫存樹退路用)。
function copyVerbatim(srcDir, dstDir) {
  fs.mkdirSync(dstDir, { recursive: true });
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const s = path.join(srcDir, ent.name);
    const d = path.join(dstDir, ent.name);
    if (ent.isDirectory()) copyVerbatim(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// ── 產生器家族(就地儲存時由 session 樹整組取代;其餘檔案保留)──
// <stem>.py 及其衍生:<stem>.step / <stem>.asm.json / .<stem>.step.glb / .<stem>.step.meta.json /
// .<stem>.step.js / .<stem>.flat.step.glb / .<stem>.flat.lines.json / .<stem>.sweep.json;
// 加 imported/(產生器引用的零件)與 __pycache__。
// stems 取「目的地 + 來源」所有頂層 *.py 的 stem:產生器中途改名也不留舊家族殘檔,
// 之後 open-project 的 pickGenerator 不會被干擾。
const OWNED_DIRS = new Set(["imported", "__pycache__"]);
const OWNED_SUFFIXES = [".py", ".step", ".asm.json"];
const OWNED_HIDDEN_SUFFIXES = [
  ".step.glb",
  ".step.meta.json",
  ".step.js",
  ".flat.step.glb",
  ".flat.lines.json",
  ".sweep.json",
];

export function generatorStems(dir) {
  let ents;
  try {
    ents = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return ents
    .filter((e) => e.isFile() && e.name.endsWith(".py"))
    .map((e) => e.name.slice(0, -3));
}

export function ownedByGenerator(name, stems) {
  if (OWNED_DIRS.has(name)) return true;
  if (name.endsWith(".pyc")) return true;
  for (const stem of stems) {
    for (const suf of OWNED_SUFFIXES) if (name === `${stem}${suf}`) return true;
    for (const suf of OWNED_HIDDEN_SUFFIXES) if (name === `.${stem}${suf}`) return true;
  }
  return false;
}

// 合併用:把目的地「非產生器家族」的檔案先搬進暫存樹(tracked .dxf、PDF 圖面、
// 子資料夾、case.json 等都保留;case.json 之後由 prepare 覆寫成合併結果)。
function copyPreserved(dstDir, tmpDir, stems) {
  fs.mkdirSync(tmpDir, { recursive: true });
  for (const ent of fs.readdirSync(dstDir, { withFileTypes: true })) {
    if (ownedByGenerator(ent.name, stems)) continue;
    const s = path.join(dstDir, ent.name);
    const d = path.join(tmpDir, ent.name);
    if (ent.isDirectory()) copyVerbatim(s, d);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

// ── 專案目錄名(session 綁定用)──
// models 相對 posix 路徑,1–3 段,每段只准英數/底線/連字號(與 sanitizeName 同字元集),
// 不得有 . / ..;巢狀(cases/20260825_XY)也合法——就地儲存用它逐段驗過再 resolveInside,
// **不走 sanitizeName**(那支會把 / 拍掉,cases/x 變 casesx)。
const DIR_SEGMENT_RE = /^[a-z0-9_-]{1,64}$/i;
export function validateProjectDir(dir) {
  if (typeof dir !== "string" || !dir) return false;
  const segs = dir.split("/");
  if (segs.length < 1 || segs.length > 3) return false;
  return segs.every((s) => DIR_SEGMENT_RE.test(s));
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Windows 上目錄 rename 在子樹任一檔案有 handle 開著時 EPERM/EBUSY(Defender 掃剛寫的
// GLB、viewer 串流中);短暫重試多半就過。
async function renameRetry(rename, from, to, { tries = 5, delayMs = 200 } = {}) {
  let lastErr;
  for (let i = 0; i < tries; i += 1) {
    try {
      rename(from, to);
      return;
    } catch (err) {
      lastErr = err;
      if (i < tries - 1) await sleep(delayMs);
    }
  }
  throw lastErr;
}

function stagingPrefixes(base) {
  return [`.${base}.saving-`, `.${base}.old-`];
}

// 清掃上次中途死掉留下的同層暫存/舊版目錄(點開頭,對檔案列表/工作台都隱藏)。
export function sweepStaleSiblings(parent, base) {
  let ents;
  try {
    ents = fs.readdirSync(parent, { withFileTypes: true });
  } catch {
    return [];
  }
  const prefixes = stagingPrefixes(base);
  const removed = [];
  for (const ent of ents) {
    if (!ent.isDirectory()) continue;
    if (!prefixes.some((p) => ent.name.startsWith(p))) continue;
    try {
      fs.rmSync(path.join(parent, ent.name), { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      removed.push(ent.name);
    } catch {
      /* 還被咬著:下次再掃 */
    }
  }
  return removed;
}

// 把 srcDir(session workdir)寫成 dstAbs(models/<dir>),原子換名:
//   1. 暫存樹 tmp = <parent>/.<base>.saving-<tag>:merge 時先放目的地的非家族檔,再疊
//      copy(srcDir),再 prepare(tmp)(cable 在此寫 case.json)——任何一步 throw → 刪 tmp、
//      rethrow,**目的地未動**。
//   2. 目的地存在 → rename(dst → old);重試仍 EPERM → 退 rmSync(dst)(maxRetries)。
//   3. rename(tmp → dst);失敗 → 退 copy-over(tmp 是完整的,終態完整)。
//   4. 刪 old(best-effort;留下也隱藏,下次儲存清掃)。
// 回 { swapped, fallback }:swapped=true 表示走的是純 rename 路徑。
// copy/rename/now 可注入(L1 測退路與中途失敗)。
export async function writeProjectTreeAtomic(
  srcDir,
  dstAbs,
  { merge = false, prepare = null, copy = copyProjectTree, rename = fs.renameSync, now = Date.now } = {},
) {
  const parent = path.dirname(dstAbs);
  const base = path.basename(dstAbs);
  fs.mkdirSync(parent, { recursive: true });
  sweepStaleSiblings(parent, base);
  const tag = `${now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  const tmp = path.join(parent, `.${base}.saving-${tag}`);
  const old = path.join(parent, `.${base}.old-${tag}`);
  const dstExists = fs.existsSync(dstAbs);

  try {
    if (merge && dstExists) {
      const stems = [...new Set([...generatorStems(dstAbs), ...generatorStems(srcDir)])];
      copyPreserved(dstAbs, tmp, stems);
    }
    copy(srcDir, tmp);
    if (prepare) prepare(tmp);
  } catch (err) {
    fs.rmSync(tmp, { recursive: true, force: true });
    throw err;
  }

  let fallback = null;
  let movedOld = false;
  if (dstExists) {
    try {
      await renameRetry(rename, dstAbs, old);
      movedOld = true;
    } catch {
      fallback = "rm-then-rename";
      try {
        fs.rmSync(dstAbs, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch {
        /* 半刪:下面 rename 會失敗 → copy-over 補成完整 */
      }
    }
  }
  try {
    await renameRetry(rename, tmp, dstAbs);
  } catch {
    fallback = fallback ? "rm-then-copy" : "copy-over";
    copyVerbatim(tmp, dstAbs);
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  if (movedOld) {
    try {
      fs.rmSync(old, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    } catch {
      /* 留著也隱藏;下次儲存 sweepStaleSiblings 清 */
    }
  }
  return { swapped: fallback === null, fallback };
}
