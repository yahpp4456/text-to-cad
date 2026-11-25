// 從 GLB 內嵌的 STEP_topology 讀模型樹(occurrence 表):id / name / parentId。
// 給「用零件名稱寫的參照」(lib/partRefs.js,藍圖 C3)解析用——不 spawn Python,
// 只讀 GLB 的 JSON chunk 與索引那一段 bufferView。讀不到一律回 [](呼叫端退回位置 token)。
import fs from "node:fs";

const GLB_MAGIC = 0x46546c67;
const CHUNK_JSON = 0x4e4f534a;
const MAX_INDEX_BYTES = 64 * 1024 * 1024;

export function readOccurrences(glbPath) {
  let fd = null;
  try {
    fd = fs.openSync(glbPath, "r");
    const head = Buffer.alloc(20);
    if (fs.readSync(fd, head, 0, 20, 0) !== 20) return [];
    if (head.readUInt32LE(0) !== GLB_MAGIC || head.readUInt32LE(16) !== CHUNK_JSON) return [];
    const jsonLen = head.readUInt32LE(12);
    const jsonBuf = Buffer.alloc(jsonLen);
    if (fs.readSync(fd, jsonBuf, 0, jsonLen, 20) !== jsonLen) return [];
    const gltf = JSON.parse(jsonBuf.toString("utf8"));
    const view = gltf.bufferViews?.[gltf.extensions?.STEP_topology?.indexView];
    const len = Number(view?.byteLength);
    if (!view || (view.buffer ?? 0) !== 0 || !(len > 0) || len > MAX_INDEX_BYTES) return [];
    const binStart = 20 + jsonLen + 8; // BIN chunk header 8 bytes
    const buf = Buffer.alloc(len);
    if (fs.readSync(fd, buf, 0, len, binStart + (Number(view.byteOffset) || 0)) !== len) return [];
    return occurrencesFromIndex(JSON.parse(buf.toString("utf8")));
  } catch {
    return [];
  } finally {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

// 索引 JSON → [{ id, name, parentId }](欄位位置依 tables.occurrenceColumns,不寫死)。獨立 export 供 L1 直測。
export function occurrencesFromIndex(index) {
  const cols = index?.tables?.occurrenceColumns;
  const rows = index?.occurrences;
  if (!Array.isArray(cols) || !Array.isArray(rows)) return [];
  const at = (k) => cols.indexOf(k);
  const [iId, iName, iSrc, iParent] = [at("id"), at("name"), at("sourceName"), at("parentId")];
  if (iId < 0) return [];
  const out = [];
  for (const row of rows) {
    if (!Array.isArray(row)) continue;
    const id = String(row[iId] || "");
    if (!/^o\d+(\.\d+)*$/.test(id)) continue;
    const name = String((iName >= 0 && row[iName]) || (iSrc >= 0 && row[iSrc]) || id);
    out.push({ id, name, parentId: iParent >= 0 && row[iParent] ? String(row[iParent]) : null });
  }
  return out;
}
