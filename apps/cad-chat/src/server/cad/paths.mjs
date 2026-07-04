// 路徑沙箱 helper:確保所有檔案存取/寫入都限制在指定根目錄內。
import path from "node:path";

// child 是否在 parent 內(含 parent 本身)。跨平台、防 .. 逃逸。
export function pathIsInside(child, parent) {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

// 把外部來的相對路徑(如 "models/.cadchat/<id>/part.step")安全解析到 root 內。
// 越界則丟錯。
export function resolveInside(root, relOrAbs) {
  const resolved = path.isAbsolute(relOrAbs)
    ? path.resolve(relOrAbs)
    : path.resolve(root, relOrAbs);
  if (!pathIsInside(resolved, root)) {
    throw new Error(`path escapes sandbox: ${relOrAbs}`);
  }
  return resolved;
}
