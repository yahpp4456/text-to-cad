// 前端 facts 量測:把後端 cadpy.analysis + inspect measure_targets 的數學搬到前端,用
// runtime 已載的 pickData facts 即時算兩面距離(免 /api/measure round-trip、免「量測中」)。
//
// 為什麼精度和後端一樣:後端 measure_targets 本來就是「讀 manifest facts 算」(沿軸座標差+
// 歐氏+向量關係),不是 OCP 重算;那些 facts(center/normal/params)前端 pickData 全有,且座標
// 系一致(前端 pickData 與後端 manifest row 同世界座標,已用 golden 驗證)。後端的 11s 花在
// inspect 載入整個 selector bundle,而前端渲染時早已載入 → 前端算距離是微秒級。
//
// 唯一後端能做而這裡不做的:OCP 曲面對曲面真實最短距離(BRepExtrema)——但後端 measure_targets
// 現在也沒做,所以搬前端零精度損失。防漂移:measureFacts.test.js 對真 pickData 斷結果 == 後端
// CLI golden;這是第二計算源,動 cadpy.analysis 的 positioning 數學時兩邊要一起改。
//
// 對應後端:packages/cadpy/src/cadpy/analysis.py(positioning_facts_for_row 的 face 分支 +
// positioning_coordinate/positioning_point/infer_positioning_axis/vector_relationship)+
// skills/cad/scripts/inspect/inspect_refs/inspect.py(measure_targets)。此檔只覆蓋「面對面」
// (檢視器量測模式的範圍);edge/vertex/occurrence 不在此。

const AXIS_NAMES = ["x", "y", "z"];
const AXIS_INDEX = { x: 0, y: 1, z: 2 };
const AXIS_ALIGNMENT_THRESHOLD = 0.985; // 與 analysis.py 逐字一致

function floatTriplet(v) {
  if (!Array.isArray(v) || v.length !== 3) return null;
  const t = [Number(v[0]), Number(v[1]), Number(v[2])];
  return t.every(Number.isFinite) ? t : null;
}

function normalize(v) {
  if (!v) return null;
  const len = Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
  if (len <= 1e-12) return null;
  return [v[0] / len, v[1] / len, v[2] / len];
}

function dot(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function bboxCenter(bbox) {
  if (!bbox || typeof bbox !== "object") return null;
  const mn = floatTriplet(bbox.min);
  const mx = floatTriplet(bbox.max);
  if (!mn || !mx) return null;
  return [(mn[0] + mx[0]) * 0.5, (mn[1] + mx[1]) * 0.5, (mn[2] + mx[2]) * 0.5];
}

// analysis.dominant_axis:正規化後分量最大的全域軸 + 是否對齊(magnitude ≥ threshold)。
function dominantAxis(vec, threshold = AXIS_ALIGNMENT_THRESHOLD) {
  const n = normalize(floatTriplet(vec));
  if (!n) return null;
  const mags = [Math.abs(n[0]), Math.abs(n[1]), Math.abs(n[2])];
  let ai = 0;
  for (let i = 1; i < 3; i += 1) if (mags[i] > mags[ai]) ai = i;
  return {
    axis: AXIS_NAMES[ai],
    index: ai,
    sign: n[ai] >= 0 ? 1 : -1,
    magnitude: mags[ai],
    aligned: mags[ai] >= threshold,
  };
}

// analysis.positioning_facts_for_row 的 face 分支(plane/cylinder/cone/sphere/torus)。
// 輸入 = pickData(reference.pickData:center/normal/surfaceType/params/bbox,世界座標)。
export function facePositioningFacts(pickData) {
  if (!pickData) return null;
  const params = pickData.params && typeof pickData.params === "object" ? pickData.params : {};
  const center = floatTriplet(pickData.center) || bboxCenter(pickData.bbox);
  const facts = { selectorType: "face" };
  if (pickData.bbox) facts.bbox = pickData.bbox;
  if (center) facts.center = center;
  const surfaceType = String(pickData.surfaceType || "").toLowerCase();
  facts.kind = surfaceType || "face";
  // 圓柱/圓錐無 row.normal → 退回 params.axis(圓柱軸)當方向,與後端一致。
  const normal = normalize(
    floatTriplet(pickData.normal) || floatTriplet(params.normal) || floatTriplet(params.axis),
  );
  const point = floatTriplet(params.origin) || center;
  if (point) facts.origin = point;
  if (normal) {
    facts.normal = normal;
    const alignment = dominantAxis(normal);
    if (alignment) {
      facts.axisAlignment = alignment;
      if (alignment.aligned && point) {
        facts.axis = alignment.axis;
        facts.coordinate = point[AXIS_INDEX[alignment.axis]];
      }
    }
    if (point) facts.planeOffset = dot(normal, point);
  }
  const radius = params.radius;
  if (radius != null && radius !== "") facts.radius = Number(radius);
  if (surfaceType === "cylinder" || surfaceType === "cone" || surfaceType === "torus") {
    const axisVector = normalize(floatTriplet(params.axis));
    if (axisVector) {
      facts.axisVector = axisVector;
      facts.axisAlignment = dominantAxis(axisVector); // 與後端一致:cylinder 覆蓋為軸向對齊
    }
  }
  if (surfaceType === "sphere") {
    const sphereCenter = floatTriplet(params.center) || center;
    if (sphereCenter) facts.center = sphereCenter;
  }
  return facts;
}

// analysis.positioning_point:point/origin/center/translation 第一個有效者,或 bbox 中心。
function positioningPoint(facts) {
  for (const key of ["point", "origin", "center", "translation"]) {
    const p = floatTriplet(facts[key]);
    if (p) return p;
  }
  return bboxCenter(facts.bbox);
}

// analysis.positioning_coordinate:facts.axis==axis 且有 coordinate → 用它;否則 point[axis]。
function positioningCoordinate(facts, axis) {
  const a = String(axis || "").toLowerCase();
  if (!(a in AXIS_INDEX)) return null;
  if (String(facts.axis || "") === a && facts.coordinate != null && facts.coordinate !== "") {
    return [Number(facts.coordinate), "coordinate"];
  }
  const p = positioningPoint(facts);
  if (p) return [p[AXIS_INDEX[a]], "point"];
  return null;
}

// analysis.infer_positioning_axis:各 facts 的對齊軸都相同 → 那軸;否則第一個有 facts.axis 者。
function inferAxis(...factsList) {
  const axes = [];
  for (const f of factsList) {
    const al = f.axisAlignment;
    if (al && al.aligned && al.axis in AXIS_INDEX) axes.push(al.axis);
  }
  if (axes.length && axes.every((x) => x === axes[0])) return axes[0];
  for (const f of factsList) {
    const a = String(f.axis || "");
    if (a in AXIS_INDEX) return a;
  }
  return null;
}

// analysis.vector_relationship:兩方向的 dot → opposed/parallel/perpendicular/angled。
function vectorRelationship(left, right, threshold = AXIS_ALIGNMENT_THRESHOLD) {
  const l = normalize(floatTriplet(left));
  const r = normalize(floatTriplet(right));
  if (!l || !r) return null;
  const d = dot(l, r);
  const ad = Math.abs(d);
  let relation;
  if (d <= -threshold) relation = "opposed";
  else if (d >= threshold) relation = "parallel";
  else if (ad <= 1 - threshold) relation = "perpendicular";
  else relation = "angled";
  return { relation, dot: d, aligned: ad >= threshold };
}

// inspect._primary_vector:normal/direction/axisVector 第一個。
function primaryVector(facts) {
  for (const key of ["normal", "direction", "axisVector"]) {
    const v = facts[key];
    if (v != null && v !== "") return v;
  }
  return null;
}

// 主入口:兩面 pickData → 量測結果(同步、微秒級)。axisOverride 給軸 fallback(使用者點 x/y/z chip)。
// 回 {ok:true, axis, signedDistance, absoluteDistance, euclideanDistance, vectorRelationship}
// 或 {ok:false, needAxis?, error}(無共同軸 → needAxis:true,前端露出 x/y/z chip)。
// 對應後端 inspect.measure_targets;數學逐函式對齊,防漂移靠 measureFacts.test.js 的後端 golden。
export function measureBetween(fromPick, toPick, axisOverride) {
  const from = facePositioningFacts(fromPick);
  const to = facePositioningFacts(toPick);
  if (!from || !to) return { ok: false, error: "無法取得面幾何" };
  let axis;
  if (axisOverride && String(axisOverride).toLowerCase() in AXIS_INDEX) {
    axis = String(axisOverride).toLowerCase();
  } else {
    axis = inferAxis(from, to);
  }
  if (!axis) return { ok: false, needAxis: true, error: "兩面不平行,無法沿單一軸量測" };
  const fromCoord = positioningCoordinate(from, axis);
  const toCoord = positioningCoordinate(to, axis);
  if (!fromCoord || !toCoord) {
    return { ok: false, needAxis: true, error: `無法取得 ${axis} 軸座標` };
  }
  const fromPoint = positioningPoint(from);
  const toPoint = positioningPoint(to);
  let euclidean = null;
  if (fromPoint && toPoint) {
    euclidean = Math.sqrt(
      (toPoint[0] - fromPoint[0]) ** 2 +
        (toPoint[1] - fromPoint[1]) ** 2 +
        (toPoint[2] - fromPoint[2]) ** 2,
    );
  }
  const rel = vectorRelationship(primaryVector(from), primaryVector(to));
  const signed = toCoord[0] - fromCoord[0];
  return {
    ok: true,
    axis,
    signedDistance: signed,
    absoluteDistance: Math.abs(signed),
    euclideanDistance: euclidean,
    vectorRelationship: rel,
  };
}
