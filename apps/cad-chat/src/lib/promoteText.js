// 草模 ⇪ 轉為正式設計的 prefill 文字(純函數;App.jsx promoteSketch 消費)。
// 審查 F6:只帶 bodies label + drives 範圍會把 derived 的連桿/氣缸、鉸點座標、
// 桿長全丟掉。修法是把原始場景檔路徑一起帶進去,叫 design agent 先 Read。
// 路徑取自 sceneUrl 的 file= 參數(相對 DATA_ROOT;dev 下 = repo 根 = agent cwd)。

export function scenePathFromUrl(sceneUrl) {
  if (typeof sceneUrl !== "string") return "";
  const m = sceneUrl.match(/[?&]file=([^&#]+)/);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return "";
  }
}

export function buildPromoteText({ doc, sceneUrl, fallbackName }) {
  const rel = scenePathFromUrl(sceneUrl);
  const title = doc?.title || fallbackName || "sketch";
  const pathClause = rel
    ? `原始場景檔=${rel}(先 Read 它取回鉸點座標、桿長、行程與尺寸,勿憑摘要猜);`
    : "";
  const tail = "沿用其關節配置與行程,截面、材料與軸承配置由你建議,先列規格再動工。";
  if (!doc) return `照草模「${title}」做正式設計:${pathClause}${tail}`;
  const drives = (doc.drives || [])
    .map((d) => `${d.label || d.id} ${d.min}~${d.max}${d.unit || ""}`)
    .join("、");
  const bodies = (doc.bodies || [])
    .filter((b) => b?.label)
    .map((b) => b.label)
    .join("、");
  return (
    `照機構草模「${title}」做正式設計:` +
    pathClause +
    (bodies ? `機構件=${bodies};` : "") +
    (drives ? `驅動=${drives};` : "") +
    tail
  );
}
