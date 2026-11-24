// 建置憑證:「這次 build 用了哪些輸入」的紀錄,用來判斷下次能不能直接沿用產物。
//
// build 成功後,把輸入檔的內容雜湊、kernel 版本、程式碼摘要寫成 `.{name}.build.json`,
// 放在產物旁。之後要重建前先核對:
//   - 每個輸入檔重新雜湊,內容相同
//   - kernel 版本與第一方 Python 程式的摘要相同
//   - 外部 CAD 檔(imported/ 等)的集合沒有增減
// 全部成立才算命中。任何一項對不上、或憑證不存在、或讀不到,都回「未命中」——
// 寧可多重建一次,也不沿用可能過期的產物。
//
// 輸入檔從哪裡來:
//   - worker 回報的 reads(腳本在 Python 層讀過的檔案:產生器、同目錄模組、資料檔);
//   - 「外部 CAD 檔」:OCCT 在 C++ 裡開的檔案(import_step 等)Python 層的讀檔紀錄看不到,
//     所以凡是產生器可能這樣讀到的都算——imported/ 全部檔案,加上產生器目錄頂層與 uploads/
//     裡的 CAD 交換檔(自己的產物除外)。例:組合件 import_step 同目錄另一個零件的 STEP。
//
// 本檔不 import 專案內其他模組;路徑與環境都由呼叫端傳入,方便單元測試。
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const STAMP_SCHEMA = 1;
// 超過這些上限就不寫憑證(不值得為了核對去雜湊這麼多東西;沒憑證 = 每次重建,行為同以前)。
export const MAX_INPUT_FILES = 400;
export const MAX_INPUT_BYTES = 256 * 1024 * 1024;

const toPosix = (p) => p.split(path.sep).join("/");

export function hashFile(abs) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(abs)).digest("hex").slice(0, 32);
  } catch {
    return null;
  }
}

// 目錄樹內指定副檔名檔案的內容摘要(相對路徑 + 內容)。目錄不存在視為空。
export function hashTree(dirs, { exts = [".py"] } = {}) {
  const digest = crypto.createHash("sha256");
  const walk = (root, dir) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (entry.name === "__pycache__" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(root, full);
      } else if (exts.includes(path.extname(entry.name))) {
        digest.update(toPosix(path.relative(root, full)));
        digest.update("\0");
        try {
          digest.update(fs.readFileSync(full));
        } catch {
          digest.update("<unreadable>");
        }
        digest.update("\0");
      }
    }
  };
  for (const dir of dirs) {
    digest.update(`[${path.basename(dir)}]`);
    walk(dir, dir);
  }
  return digest.digest("hex").slice(0, 16);
}

// rel(相對產生器目錄、正斜線)是不是 build / 伺服器自己寫出來的東西(不是輸入)。
export function isBuildOutput(rel, name) {
  const parts = rel.split("/");
  const top = parts[0];
  if (top === "versions" || top === ".exports" || top === "__pycache__") return true;
  const base = parts[parts.length - 1];
  if (base.startsWith(".")) return true; // 隱藏 sidecar(.x.step.glb / .x.step.meta.json / 憑證…)
  if (parts.length === 1) {
    if (base === "session.json" || base === "metrics.jsonl") return true;
    if (base === `${name}.asm.json`) return true;
    const ext = path.extname(base).toLowerCase();
    const stem = base.slice(0, base.length - ext.length);
    if (stem === name && [".step", ".stp", ".dxf", ".stl", ".3mf", ".glb", ".pdf"].includes(ext)) return true;
  }
  return false;
}

function listFiles(dir) {
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "__pycache__") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(full);
    }
  };
  walk(dir);
  return out;
}

// 產生器可能不經 Python 就讀到的檔(見檔頭)。回相對產生器目錄的路徑,已排序。
const CAD_EXTS = new Set([".step", ".stp", ".iges", ".igs", ".brep", ".stl", ".3mf", ".dxf"]);
const isCadFile = (file) => CAD_EXTS.has(path.extname(file).toLowerCase());
export function externalFiles(genDir, name) {
  const rels = [];
  for (const abs of listFiles(path.join(genDir, "imported"))) rels.push(toPosix(path.relative(genDir, abs)));
  for (const abs of listFiles(path.join(genDir, "uploads"))) {
    if (isCadFile(abs)) rels.push(toPosix(path.relative(genDir, abs)));
  }
  let top = [];
  try {
    top = fs.readdirSync(genDir, { withFileTypes: true });
  } catch {
    /* 目錄不存在:沒有外部檔 */
  }
  for (const entry of top) {
    if (entry.isFile() && isCadFile(entry.name)) rels.push(entry.name);
  }
  return [...new Set(rels)].filter((rel) => !isBuildOutput(rel, name)).sort();
}

// 把 worker 回報的 reads(相對 dataRoot)整理成輸入清單。
// 產生器目錄內的記成 {base:"gen"}(憑證隨專案複製到別處仍有效),之外的記成 {base:"root"}。
// 回 null = 不寫憑證(讀不到輸入、或超過上限)。
export function collectInputs({ reads, genDir, dataRoot, name }) {
  if (!Array.isArray(reads)) return null;
  const seen = new Map(); // "base:path" -> entry
  const add = (base, rel) => seen.set(`${base}:${rel}`, { base, path: rel });
  for (const read of reads) {
    const abs = path.resolve(dataRoot, read);
    const relGen = toPosix(path.relative(genDir, abs));
    if (!relGen.startsWith("../") && relGen !== ".." && !path.isAbsolute(relGen)) {
      if (!isBuildOutput(relGen, name)) add("gen", relGen);
    } else {
      const relRoot = toPosix(path.relative(dataRoot, abs));
      if (relRoot.startsWith("../") || path.isAbsolute(relRoot)) continue; // dataRoot 之外:不追蹤
      add("root", relRoot);
    }
  }
  for (const rel of externalFiles(genDir, name)) add("gen", rel);

  const entries = [...seen.values()].sort((a, b) => (a.base + a.path < b.base + b.path ? -1 : 1));
  if (entries.length === 0 || entries.length > MAX_INPUT_FILES) return null;
  let bytes = 0;
  const inputs = [];
  for (const entry of entries) {
    const abs = path.resolve(entry.base === "gen" ? genDir : dataRoot, entry.path);
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch {
      continue; // 讀過但現在不在了(暫存檔):不是穩定的輸入
    }
    if (!stat.isFile()) continue;
    bytes += stat.size;
    if (bytes > MAX_INPUT_BYTES) return null;
    const sha = hashFile(abs);
    if (!sha) return null;
    inputs.push({ ...entry, sha });
  }
  return inputs.length ? inputs : null;
}

export function stampKey({ name, env, inputs }) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify([STAMP_SCHEMA, name, env, inputs]))
    .digest("hex")
    .slice(0, 32);
}

// 產生憑證物件;env 不完整、輸入收集不到、或任何一個產物不存在時回 null。
// outputs:這次 build 寫出的產物(相對產生器目錄)。記下它們的雜湊,核對時產物必須原封不動——
// 否則「輸入對得上、但旁邊的產物是別次建置留下的」也會被當成命中。
export function makeStamp({ name, env, reads, genDir, dataRoot, outputs = [] }) {
  if (!envComplete(env)) return null;
  const inputs = collectInputs({ reads, genDir, dataRoot, name });
  if (!inputs) return null;
  // 產生器本身一定要在輸入裡;不在代表讀檔紀錄不完整,這張憑證不可信。
  if (!inputs.some((i) => i.base === "gen" && i.path === `${name}.py`)) return null;
  const hashed = [];
  for (const rel of [...new Set(outputs)].sort()) {
    const sha = hashFile(path.join(genDir, rel));
    if (!sha) return null;
    hashed.push({ path: rel, sha });
  }
  const stamp = { schema: STAMP_SCHEMA, name, env, inputs, external: externalFiles(genDir, name) };
  return { ...stamp, outputs: hashed, key: stampKey(stamp) };
}

const ENV_KEYS = ["python", "build123d", "ocp", "cadpy", "scripts"];
export function envComplete(env) {
  return !!env && ENV_KEYS.every((key) => typeof env[key] === "string" && env[key].length > 0);
}

export function readStamp(file) {
  try {
    const stamp = JSON.parse(fs.readFileSync(file, "utf8"));
    return stamp && typeof stamp === "object" ? stamp : null;
  } catch {
    return null;
  }
}

export function writeStamp(file, stamp) {
  fs.writeFileSync(file, JSON.stringify(stamp), "utf8");
}

// 憑證對目前的檔案與環境是否仍然成立。回 { hit, reason };hit=false 時 reason 說明第一個對不上的地方。
export function checkStamp(stamp, { name, env, genDir, dataRoot }) {
  const miss = (reason) => ({ hit: false, reason });
  if (!stamp) return miss("沒有憑證");
  if (stamp.schema !== STAMP_SCHEMA) return miss("憑證格式版本不同");
  if (stamp.name !== name) return miss("憑證屬於別的名稱");
  if (!envComplete(env)) return miss("目前環境未知(worker 尚未就緒或已停用)");
  for (const key of ENV_KEYS) {
    if (stamp.env?.[key] !== env[key]) return miss(`環境不同:${key}`);
  }
  if (!Array.isArray(stamp.inputs) || stamp.inputs.length === 0) return miss("憑證沒有輸入清單");
  if (stamp.key !== stampKey(stamp)) return miss("憑證內容與其 key 不符");
  // 外部 CAD 檔的集合要一樣:多出來的檔不在 inputs 裡,只比 inputs 會看不到它。
  const external = externalFiles(genDir, name);
  const recorded = Array.isArray(stamp.external) ? stamp.external : null;
  if (!recorded || external.length !== recorded.length || external.some((rel, i) => rel !== recorded[i])) {
    return miss("外部 CAD 檔有增減");
  }
  for (const input of stamp.inputs) {
    if (input.base !== "gen" && input.base !== "root") return miss("憑證輸入格式不明");
    const base = input.base === "gen" ? genDir : dataRoot;
    const abs = path.resolve(base, String(input.path));
    // 憑證是使用者資料目錄裡的檔案,不可信:路徑不得跑出它宣稱的根(否則可拿來探測任意檔案)。
    const rel = path.relative(base, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return miss("憑證輸入路徑越界");
    const sha = hashFile(abs);
    if (sha == null) return miss(`輸入不見了:${input.path}`);
    if (sha !== input.sha) return miss(`輸入變了:${input.path}`);
  }
  for (const output of Array.isArray(stamp.outputs) ? stamp.outputs : []) {
    const abs = path.resolve(genDir, String(output.path));
    const rel = path.relative(genDir, abs);
    if (rel.startsWith("..") || path.isAbsolute(rel)) return miss("憑證產物路徑越界");
    const sha = hashFile(abs);
    if (sha == null) return miss(`產物不見了:${output.path}`);
    if (sha !== output.sha) return miss(`產物不是這次建置留下的:${output.path}`);
  }
  return { hit: true, reason: "" };
}
