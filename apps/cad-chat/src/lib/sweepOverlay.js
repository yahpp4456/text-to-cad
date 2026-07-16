// 掃出路徑預覽 overlay 的純資料轉換(零 three 依賴 → node --test 可直測)。
// 輸入:`.{name}.sweep.json` sidecar 的 paths([{label, points:[[x,y,z],…]}],
// 伺服端收割時已防禦正規化);輸出:每條路徑的「相鄰點成對展開」線段座標平陣列
// (直接餵 BufferGeometry position)與起終點(端點小球用)。
// 防禦與收割同語義:任一點壞 = 整條丟棄(不畫半條線),點數 < 2 丟棄。
export function buildSweepSegments(paths) {
  const out = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    const pts = Array.isArray(p?.points) ? p.points : [];
    if (pts.length < 2) continue;
    if (!pts.every((q) => Array.isArray(q) && q.length === 3 && q.every(Number.isFinite))) continue;
    const segments = new Array((pts.length - 1) * 6);
    for (let i = 0; i < pts.length - 1; i += 1) {
      segments[i * 6 + 0] = pts[i][0];
      segments[i * 6 + 1] = pts[i][1];
      segments[i * 6 + 2] = pts[i][2];
      segments[i * 6 + 3] = pts[i + 1][0];
      segments[i * 6 + 4] = pts[i + 1][1];
      segments[i * 6 + 5] = pts[i + 1][2];
    }
    out.push({
      label: String(p.label ?? `path_${out.length}`),
      segments,
      start: [...pts[0]],
      end: [...pts[pts.length - 1]],
      pointCount: pts.length,
    });
  }
  return out;
}
