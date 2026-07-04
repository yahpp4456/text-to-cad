// 把 buildSelectorRuntime 的輸出轉成物件屬性抽屜需要的樹 + 分組欄位(§10 資料模型)。
const r2 = (n) => (typeof n === "number" ? Math.round(n * 100) / 100 : n);

function fmtVec(v) {
  if (!Array.isArray(v)) return "—";
  return `(${v.map((n) => r2(n)).join(", ")})`;
}

function bboxSize(bbox) {
  if (!bbox) return null;
  if (Array.isArray(bbox.size)) return bbox.size;
  if (Array.isArray(bbox.min) && Array.isArray(bbox.max)) {
    return bbox.max.map((m, i) => m - bbox.min[i]);
  }
  if (Array.isArray(bbox) && bbox.length >= 6) {
    return [bbox[3] - bbox[0], bbox[4] - bbox[1], bbox[5] - bbox[2]];
  }
  return null;
}

function fmtSize(bbox) {
  const s = bboxSize(bbox);
  return s ? s.map((n) => r2(n)).join(" × ") + " mm" : "—";
}

// 組合件展開時每個零件底下最多列幾個 face/edge(其餘以「…還有 N 個」示意,
// 61 件 gantry 全列會讓樹爆掉;單件模型維持全列不受限)。
const FACE_CAP = 12;
const EDGE_CAP = 8;

export function buildTopologyModel(runtime) {
  if (!runtime) return null;
  const shapes = runtime.shapes || [];
  const faces = runtime.faces || [];
  const edges = runtime.edges || [];
  const occs = runtime.occurrences || [];

  // reference 查表(用 selectorType + rowIndex 對應 #o / #f / #e token)
  const refByKey = {};
  for (const ref of runtime.references || []) {
    const k = `${ref.selectorType}:${ref.pickData?.rowIndex ?? ref.rowIndex}`;
    refByKey[k] = ref;
  }

  const isAssembly = shapes.length > 1;
  const rootShape = shapes[0] || {};
  const occOf = (row) => String(row?.occurrenceId || row?.partId || "").trim();

  // ── occurrence 巢狀樹索引(組合件;舊 bundle 無 occurrences 則整段空,走扁平降級) ──
  const occById = new Map(); // id → occurrence row
  const occIndex = new Map(); // id → rowIndex(occurrence reference token 查表)
  const occChildren = new Map(); // parentId → [occurrence rows](保留 manifest 順序)
  if (isAssembly) {
    occs.forEach((o, i) => {
      const id = String(o?.id || "").trim();
      if (!id) return;
      occById.set(id, o);
      occIndex.set(id, i);
    });
    for (const o of occs) {
      const id = String(o?.id || "").trim();
      const pid = String(o?.parentId || "").trim();
      if (!id || !pid || !occById.has(pid)) continue; // root/孤兒不進 children 表
      if (!occChildren.has(pid)) occChildren.set(pid, []);
      occChildren.get(pid).push(o);
    }
  }
  const rootOccs = [...occById.values()].filter((o) => {
    const pid = String(o?.parentId || "").trim();
    return !pid || !occById.has(pid);
  });
  // 單一 root occurrence 併入 __root(不重複顯示一層);多 root 各自成子節點。
  const singleRoot = rootOccs.length === 1 ? rootOccs[0] : null;

  const root = {
    id: "__root",
    label: isAssembly
      ? singleRoot?.name || singleRoot?.sourceName || "assembly"
      : rootShape.name || rootShape.sourceName || "part",
    kindEn: isAssembly ? "ASSEMBLY" : (rootShape.kind || "SOLID").toUpperCase(),
    depth: 0,
    kind: "root",
    parentId: null,
  };

  // shape rows 按 occurrenceId 分組(同 occ 多 row 各自成節點掛同父)
  const shapeRowsByOcc = new Map();
  shapes.forEach((s, i) => {
    const occ = occOf(s);
    if (!occ) return;
    if (!shapeRowsByOcc.has(occ)) shapeRowsByOcc.set(occ, []);
    shapeRowsByOcc.get(occ).push({ s, i });
  });

  // ── DFS 產出 occurrence/shape 節點(treeNodes 順序即顯示順序) ──
  const treeNodes = [];
  const shapeNodeByOcc = new Map();
  const usedShapeIdx = new Set();

  const makeShapeNode = ({ s, i }, parentNodeId, depth) => {
    const node = {
      id: `s${i}`,
      label: s.name || s.sourceName || `part ${i}`,
      kindEn: "PART",
      depth,
      kind: "shape",
      row: s,
      parentId: parentNodeId,
      // occurrence token(#o1.2):可直接餵 cad_measure/cad_align 的 selector
      token: s.occurrenceId ? `#${s.occurrenceId}` : null,
      childCount: 0,
    };
    treeNodes.push(node);
    usedShapeIdx.add(i);
    const occ = occOf(s);
    if (occ && !shapeNodeByOcc.has(occ)) shapeNodeByOcc.set(occ, node);
    return node;
  };

  const emitOcc = (o, parentNodeId, depth) => {
    const id = String(o?.id || "").trim();
    const kids = occChildren.get(id) || [];
    const ownShapes = (shapeRowsByOcc.get(id) || []).filter((x) => !usedShapeIdx.has(x.i));
    if (!kids.length) {
      // 葉 occurrence → 直接 shape 節點(保留 volume/token/圈選查找相容);
      // 無 shape row 的空葉才落成 occurrence 節點(childCount 0,不可展開)。
      if (ownShapes.length) {
        for (const sr of ownShapes) makeShapeNode(sr, parentNodeId, depth);
        return;
      }
    }
    // 中繼母節點(motor=body+shaft 這種):kind:"occurrence",token 可餵 measure/align
    const ri = occIndex.get(id);
    const node = {
      id,
      label: o.name || o.sourceName || id,
      kindEn: "GROUP",
      depth,
      kind: "occurrence",
      row: o,
      parentId: parentNodeId,
      token: refByKey[`occurrence:${ri}`]?.copyText || `#${id}`,
      childCount: 0,
    };
    treeNodes.push(node);
    for (const sr of ownShapes) {
      makeShapeNode(sr, node.id, depth + 1);
      node.childCount += 1;
    }
    for (const k of kids) {
      emitOcc(k, node.id, depth + 1);
      node.childCount += 1;
    }
  };

  if (isAssembly && occById.size) {
    if (singleRoot) {
      const rid = String(singleRoot.id || "").trim();
      for (const sr of shapeRowsByOcc.get(rid) || []) makeShapeNode(sr, "__root", 1);
      for (const k of occChildren.get(rid) || []) emitOcc(k, "__root", 1);
    } else {
      for (const r of rootOccs) emitOcc(r, "__root", 1);
    }
    // 漏網 shape rows(occurrence 表對不上)→ 掛 root 層,不丟失
    shapes.forEach((s, i) => {
      if (!usedShapeIdx.has(i)) makeShapeNode({ s, i }, "__root", 1);
    });
  } else if (isAssembly) {
    // 降級:舊 bundle 無 occurrences → 現行扁平單層,行為不變
    shapes.forEach((s, i) => makeShapeNode({ s, i }, "__root", 1));
  }

  // 面/邊 → 所屬零件:精確命中 → occurrence 表 parentId 上溯 → 前綴 fallback(舊 bundle)
  const ownerOf = (row) => {
    const occ = occOf(row);
    if (!occ) return null;
    const exact = shapeNodeByOcc.get(occ);
    if (exact) return exact;
    let cur = occById.get(occ);
    let guard = 0;
    while (cur && guard++ < 32) {
      const pid = String(cur.parentId || "").trim();
      if (!pid) break;
      const hit = shapeNodeByOcc.get(pid);
      if (hit) return hit;
      cur = occById.get(pid);
    }
    let best = null;
    for (const [k, nd] of shapeNodeByOcc) {
      if (occ.startsWith(`${k}.`) && (!best || k.length > best.k.length)) best = { k, nd };
    }
    return best?.nd || null;
  };

  const makeFeat = (kind, row, i, owner) => ({
    id: `${kind === "face" ? "f" : "e"}${i}`,
    label: `${((kind === "face" ? row.surfaceType : row.curveType) || kind.toUpperCase()).toUpperCase()} #${i}`,
    kindEn: kind.toUpperCase(),
    depth: owner ? owner.depth + 1 : 1,
    kind,
    row,
    ref: refByKey[`${kind}:${i}`],
    parentId: owner ? owner.id : "__root",
    ownerOcc: owner ? occOf(owner.row) : "",
  });

  const childrenByShape = new Map(); // shapeNode.id → { faces:[], edges:[] }
  const rootFeats = [];
  faces.forEach((f, i) => {
    const owner = isAssembly ? ownerOf(f) : null;
    const node = makeFeat("face", f, i, owner);
    if (owner) {
      if (!childrenByShape.has(owner.id)) childrenByShape.set(owner.id, { faces: [], edges: [] });
      childrenByShape.get(owner.id).faces.push(node);
      owner.childCount += 1;
    } else rootFeats.push(node);
  });
  edges.forEach((e, i) => {
    const owner = isAssembly ? ownerOf(e) : null;
    const node = makeFeat("edge", e, i, owner);
    if (owner) {
      if (!childrenByShape.has(owner.id)) childrenByShape.set(owner.id, { faces: [], edges: [] });
      childrenByShape.get(owner.id).edges.push(node);
      owner.childCount += 1;
    } else rootFeats.push(node);
  });

  // 攤平成有序清單:root → DFS(中繼 → 零件 → 其面/邊(有上限)) → 無主面/邊。
  // PropertiesDrawer 靠 parentId 做折疊,Canvas3D 靠 ownerOcc 過濾面標記。
  const nodes = [root];
  for (const tn of treeNodes) {
    nodes.push(tn);
    if (tn.kind !== "shape") continue;
    const kids = childrenByShape.get(tn.id);
    if (!kids) continue;
    const featDepth = tn.depth + 1;
    nodes.push(...kids.faces.slice(0, FACE_CAP));
    if (kids.faces.length > FACE_CAP) {
      nodes.push({
        id: `${tn.id}_more_f`,
        label: `…還有 ${kids.faces.length - FACE_CAP} 個面`,
        kindEn: "",
        depth: featDepth,
        kind: "more",
        parentId: tn.id,
      });
    }
    nodes.push(...kids.edges.slice(0, EDGE_CAP));
    if (kids.edges.length > EDGE_CAP) {
      nodes.push({
        id: `${tn.id}_more_e`,
        label: `…還有 ${kids.edges.length - EDGE_CAP} 條邊`,
        kindEn: "",
        depth: featDepth,
        kind: "more",
        parentId: tn.id,
      });
    }
  }
  nodes.push(...rootFeats);

  const overall = {
    bbox: runtime.bbox,
    shapeCount: shapes.length,
    faceCount: faces.length,
    edgeCount: edges.length,
    volume: rootShape.volume,
    area: rootShape.area,
    center: rootShape.center,
    kind: rootShape.kind,
  };

  return { nodes, overall, faces, edges };
}

// 選定節點 → 三組欄位之中的「幾何衍生」與「工程標註」。
export function derivedRows(node, overall) {
  if (!node || node.kind === "root") {
    return [
      { k: "外形 BBOX", v: fmtSize(overall.bbox) },
      { k: "體積 VOLUME", v: overall.volume != null ? `${r2(overall.volume)} mm³` : "—" },
      { k: "表面積 AREA", v: overall.area != null ? `${r2(overall.area)} mm²` : "—" },
      { k: "重心 CENTER", v: fmtVec(overall.center) },
      { k: "SHAPE / FACE", v: `${overall.shapeCount} / ${overall.faceCount}` },
      { k: "EDGE", v: String(overall.edgeCount) },
      { k: "實心 SOLID", v: overall.kind === "solid" ? "Watertight 有效" : overall.kind || "—" },
    ];
  }
  if (node.kind === "shape") {
    const s = node.row || {};
    return [
      { k: "外形 BBOX", v: fmtSize(s.bbox) },
      { k: "體積 VOLUME", v: s.volume != null ? `${r2(s.volume)} mm³` : "—" },
      { k: "表面積 AREA", v: s.area != null ? `${r2(s.area)} mm²` : "—" },
      { k: "重心 CENTER", v: fmtVec(s.center) },
      { k: "類型 KIND", v: (s.kind || "SOLID").toUpperCase() },
    ];
  }
  if (node.kind === "occurrence") {
    // 中繼母節點:只有聚合資料,不編造 volume(誠實原則)。
    const o = node.row || {};
    const t = Array.isArray(o.transform) && o.transform.length >= 12 ? o.transform : null;
    return [
      { k: "外形 BBOX", v: fmtSize(o.bbox) },
      { k: "位置 ORIGIN", v: t ? fmtVec([t[3], t[7], t[11]]) : "—" },
      { k: "直接子件", v: String(node.childCount ?? 0) },
      {
        k: "後代 SHAPE / FACE",
        v: `${o.shapeCount != null ? o.shapeCount : "—"} / ${o.faceCount != null ? o.faceCount : "—"}`,
      },
      { k: "EDGE", v: o.edgeCount != null ? String(o.edgeCount) : "—" },
    ];
  }
  if (node.kind === "face") {
    const f = node.row;
    const rows = [
      { k: "類型 SURFACE", v: (f.surfaceType || "—").toUpperCase() },
      { k: "面積 AREA", v: f.area != null ? `${r2(f.area)} mm²` : "—" },
      { k: "法向 NORMAL", v: fmtVec(f.normal) },
      { k: "中心 CENTER", v: fmtVec(f.center) },
    ];
    if (f.params?.radius != null) rows.push({ k: "半徑 RADIUS", v: `R${r2(f.params.radius)} mm` });
    return rows;
  }
  if (node.kind === "edge") {
    const e = node.row;
    const rows = [
      { k: "類型 CURVE", v: (e.curveType || "—").toUpperCase() },
      { k: "長度 LENGTH", v: e.length != null ? `${r2(e.length)} mm` : "—" },
    ];
    if (e.params?.radius != null) rows.push({ k: "半徑 RADIUS", v: `R${r2(e.params.radius)} mm` });
    if (e.dihedralDeg != null) rows.push({ k: "二面角 DIHEDRAL", v: `${r2(e.dihedralDeg)}°` });
    if (e.continuity) rows.push({ k: "連續性", v: String(e.continuity) });
    if (e.visibilityClass) rows.push({ k: "類別 CLASS", v: String(e.visibilityClass) });
    return rows;
  }
  return [];
}

// 工程標註:pipeline 目前缺,一律 N/A(§10.9 誠實原則)。
export function engineeringRows(node) {
  if (node && node.kind !== "root") return [];
  return [
    { k: "質量 MASS", v: "N/A · 需密度" },
    { k: "材質 MATERIAL", v: "N/A · 生成件無" },
    { k: "公差 / 配合", v: "N/A" },
    { k: "表面處理", v: "N/A" },
    { k: "數量 QTY", v: "N/A" },
  ];
}
