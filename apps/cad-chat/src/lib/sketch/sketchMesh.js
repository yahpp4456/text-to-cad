// 草模 mesh 建構:schema parts/macros → three 幾何,一次建好;每幀只套矩陣
// (applyFrame)。本檔是 sketch lib 裡唯一 import three 的檔——schema/math/eval
// 保持零依賴供 server 共用與 node --test。刻意零 cadjs 依賴(耦合面最小)。
import * as THREE from "three";

import { ROLE_COLORS } from "./sketchSchema.js";

const DEG = Math.PI / 180;

// role → 材質(每場景一份 cache;DoubleSide 是鏡像 body 負 scale 翻繞向的保險)
function makeMaterials() {
  const cache = new Map();
  return (role) => {
    const key = ROLE_COLORS[role] ? role : "frame";
    if (!cache.has(key)) {
      const spec = ROLE_COLORS[key];
      cache.set(
        key,
        new THREE.MeshStandardMaterial({
          color: new THREE.Color(spec.color),
          metalness: spec.metalness,
          roughness: spec.roughness,
          side: THREE.DoubleSide,
        }),
      );
    }
    return cache.get(key);
  };
}

// 圓角矩形 Shape(中心 0,0)
function roundedRectShape(w, h, r) {
  const rr = Math.max(0, Math.min(r || 0, w / 2 - 0.01, h / 2 - 0.01));
  const x = -w / 2;
  const y = -h / 2;
  const s = new THREE.Shape();
  s.moveTo(x + rr, y);
  s.lineTo(x + w - rr, y);
  s.absarc(x + w - rr, y + rr, rr, -Math.PI / 2, 0, false);
  s.lineTo(x + w, y + h - rr);
  s.absarc(x + w - rr, y + h - rr, rr, 0, Math.PI / 2, false);
  s.lineTo(x + rr, y + h);
  s.absarc(x + rr, y + h - rr, rr, Math.PI / 2, Math.PI, false);
  s.lineTo(x, y + rr);
  s.absarc(x + rr, y + rr, rr, Math.PI, Math.PI * 1.5, false);
  return s;
}

// 圓柱幾何預轉:CylinderGeometry 原生沿 Y;axis 指定軸向。
function cylGeo(r, len, axis, seg = 28) {
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  if (axis === "x") g.rotateZ(-Math.PI / 2);
  else if (axis === "z") g.rotateX(Math.PI / 2);
  return g;
}

const AXIS_V = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
function parseFace(face, fallback = [-1, 0, 0]) {
  const m = /^([+-]?)([xyz])$/.exec(String(face || ""));
  if (!m) return fallback;
  const v = [...AXIS_V[m[2]]];
  return m[1] === "-" ? v.map((n) => -n) : v;
}

// 單一 part(primitive / macro)→ Object3D。局部座標;rot=[rx,ry,rz] 度 XYZ 序。
function buildPart(p, inheritRole, mat) {
  const role = p.role || inheritRole;
  const place = (obj) => {
    obj.position.set(p.at[0], p.at[1], p.at[2]);
    if (p.rot) obj.rotation.set(p.rot[0] * DEG, p.rot[1] * DEG, p.rot[2] * DEG);
    return obj;
  };
  if (p.type === "box") {
    return place(new THREE.Mesh(new THREE.BoxGeometry(...p.size), mat(role)));
  }
  if (p.type === "cylinder") {
    return place(new THREE.Mesh(cylGeo(p.r, p.len, p.axis), mat(role)));
  }
  if (p.type === "hole") {
    // 視覺假孔:深色圓柱微凸 0.2mm 防 z-fighting(ref 手法,一行換巨大真實感)
    return place(new THREE.Mesh(cylGeo(p.r, p.depth + 0.4, p.axis, 20), mat("hole")));
  }
  if (p.type === "plate") {
    const geo = new THREE.ExtrudeGeometry(roundedRectShape(p.size[0], p.size[1], p.r), {
      depth: p.t,
      bevelEnabled: true,
      bevelThickness: 0.6,
      bevelSize: 0.7,
      bevelSegments: 2,
      steps: 1,
    });
    geo.translate(0, 0, -p.t / 2); // 厚度置中
    // shape 平面 → 指定厚度軸:axis"z"=不轉;"x"=[YZ]平面;"y"=[XZ]平面
    if (p.axis === "x") {
      geo.applyMatrix4(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, 0, 0),
        ),
      );
    } else if (p.axis === "y") {
      geo.applyMatrix4(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 1, 0),
        ),
      );
    }
    return place(new THREE.Mesh(geo, mat(role)));
  }
  if (p.type === "pin_clevis") {
    // 叉耳夾片×2(含孔口暗面)+ 銷桿 + 銷頭 + 扣環——鉸點視覺一件搞定(ref clevisTabs+makePin)
    const g = new THREE.Group();
    const r = p.r > 0 ? p.r : 7.5;
    const span = p.span > 0 ? p.span : 16;
    const half = span / 2;
    const t = 5.5;
    for (const off of [half, -half]) {
      const tab = new THREE.Mesh(cylGeo(r, t, p.axis, 26), mat(p.role || "clevis"));
      const csk = new THREE.Mesh(cylGeo(r * 0.45, t + 0.4, p.axis, 18), mat("hole"));
      const v = AXIS_V[p.axis];
      tab.position.set(v[0] * off, v[1] * off, v[2] * off);
      csk.position.copy(tab.position);
      g.add(tab, csk);
    }
    const pinLen = span + 12;
    const pin = new THREE.Mesh(cylGeo(r * 0.42, pinLen, p.axis, 20), mat("pin"));
    const head = new THREE.Mesh(cylGeo(r * 0.62, 2.6, p.axis, 22), mat("pin"));
    const clip = new THREE.Mesh(new THREE.TorusGeometry(r * 0.5, 0.8, 8, 20), mat("rod"));
    const v = AXIS_V[p.axis];
    head.position.set(v[0] * (pinLen / 2 - 1), v[1] * (pinLen / 2 - 1), v[2] * (pinLen / 2 - 1));
    clip.position.set(-v[0] * (pinLen / 2 - 2), -v[1] * (pinLen / 2 - 2), -v[2] * (pinLen / 2 - 2));
    // torus 原生在 XY 平面(法向 Z)→ 轉到銷軸向
    if (p.axis === "x") clip.rotation.y = Math.PI / 2;
    else if (p.axis === "y") clip.rotation.x = Math.PI / 2;
    g.add(pin, head, clip);
    return place(g);
  }
  if (p.type === "gear") {
    // 真梯形齒:root 圓柱芯 + N 個梯形齒 Extrude 繞轉(視覺示意,非漸開線)
    const m = p.module;
    const rPitch = (m * p.teeth) / 2;
    const rTip = rPitch + m;
    const rRoot = rPitch - 1.25 * m;
    const g = new THREE.Group();
    const core = new THREE.Mesh(cylGeo(rRoot, p.width, p.axis, 48), mat(role));
    g.add(core);
    // 齒形(在 XY 平面、沿 +X 徑向;寬度沿 Z)→ 再轉到指定軸
    const tooth = new THREE.Shape();
    const hwRoot = 0.85 * m;
    const hwTip = 0.38 * m;
    tooth.moveTo(rRoot - 0.5, -hwRoot);
    tooth.lineTo(rTip, -hwTip);
    tooth.lineTo(rTip, hwTip);
    tooth.lineTo(rRoot - 0.5, hwRoot);
    tooth.closePath();
    const toothGeo = new THREE.ExtrudeGeometry(tooth, { depth: p.width, bevelEnabled: false });
    toothGeo.translate(0, 0, -p.width / 2);
    for (let i = 0; i < p.teeth; i++) {
      const tm = new THREE.Mesh(toothGeo, mat(role));
      tm.rotation.z = (i * 2 * Math.PI) / p.teeth;
      g.add(tm);
    }
    // 齒盤原生法向 Z(齒在 XY 徑向)→ axis 指定齒輪軸向
    if (p.axis === "x") g.rotation.y = Math.PI / 2;
    else if (p.axis === "y") g.rotation.x = -Math.PI / 2;
    return place((() => {
      const wrap = new THREE.Group();
      wrap.add(g);
      return wrap;
    })());
  }
  if (p.type === "rack") {
    // 齒條齒排:N 個梯形齒沿 dir 等距(節距 πm),齒尖朝 face(預設 -x)
    const m = p.module;
    const pitch = Math.PI * m;
    const g = new THREE.Group();
    const f = parseFace(p.face); // 齒尖方向
    const d = AXIS_V[p.dir]; // 齒排方向
    const w = [
      f[1] * d[2] - f[2] * d[1],
      f[2] * d[0] - f[0] * d[2],
      f[0] * d[1] - f[1] * d[0],
    ]; // 齒寬方向 = f×d
    // 齒形:沿 face 突出 2.25m,根寬 0.85m、尖寬 0.38m(對齊 gear 的齒形參數)
    const tooth = new THREE.Shape();
    tooth.moveTo(0, -0.85 * m);
    tooth.lineTo(2.25 * m, -0.38 * m);
    tooth.lineTo(2.25 * m, 0.38 * m);
    tooth.lineTo(0, 0.85 * m);
    tooth.closePath();
    const toothGeo = new THREE.ExtrudeGeometry(tooth, { depth: p.width, bevelEnabled: false });
    toothGeo.translate(0, 0, -p.width / 2);
    // shape x→face、shape y→dir、extrude z→width
    toothGeo.applyMatrix4(
      new THREE.Matrix4().makeBasis(
        new THREE.Vector3(...f),
        new THREE.Vector3(...d),
        new THREE.Vector3(...w),
      ),
    );
    for (let i = 0; i < p.count; i++) {
      const off = (i - (p.count - 1) / 2) * pitch;
      const tm = new THREE.Mesh(toothGeo, mat(role));
      tm.position.set(d[0] * off, d[1] * off, d[2] * off);
      g.add(tm);
    }
    return place(g);
  }
  if (p.type === "link_eye") {
    const g = new THREE.Group();
    const r = p.r > 0 ? p.r : 6;
    g.add(new THREE.Mesh(cylGeo(r, p.w > 0 ? p.w : 9, p.axis, 26), mat(role)));
    g.add(new THREE.Mesh(cylGeo(r * 0.5, (p.w > 0 ? p.w : 9) + 0.4, p.axis, 18), mat("hole")));
    return place(g);
  }
  if (p.type === "motor") {
    // 馬達外形:機身圓柱 + 前法蘭盤 + 軸伸(沿 +axis 突出)+ 尾蓋
    const g = new THREE.Group();
    const r = p.r > 0 ? p.r : 16;
    const l = p.l > 0 ? p.l : 40;
    const shaftLen = p.shaftLen > 0 ? p.shaftLen : 18;
    const shaftR = p.shaftR > 0 ? p.shaftR : 3;
    const v = AXIS_V[p.axis];
    const along = (obj, off) => {
      obj.position.set(v[0] * off, v[1] * off, v[2] * off);
      return obj;
    };
    g.add(new THREE.Mesh(cylGeo(r, l, p.axis, 36), mat(p.role || "motor")));
    g.add(along(new THREE.Mesh(cylGeo(r * 1.18, 3, p.axis, 36), mat(p.role || "motor")), l / 2));
    g.add(along(new THREE.Mesh(cylGeo(shaftR, shaftLen, p.axis, 20), mat("rod")), l / 2 + shaftLen / 2));
    g.add(along(new THREE.Mesh(cylGeo(r * 0.55, 5, p.axis, 24), mat("pin")), -(l / 2 + 2)));
    return place(g);
  }
  if (p.type === "pulley") {
    // 皮帶輪:輪面圓柱 + 兩側凸緣盤 + 深色軸轂。role 繼承 body(同 gear:
    // 輪子掛在自己的旋轉 body 上,顏色要跟圖例的 body role 一致)。
    const g = new THREE.Group();
    const flangeT = Math.max(1.2, p.width * 0.12);
    const v = AXIS_V[p.axis];
    g.add(new THREE.Mesh(cylGeo(p.r, p.width, p.axis, 36), mat(role)));
    for (const s of [1, -1]) {
      const f = new THREE.Mesh(cylGeo(p.r * 1.15, flangeT, p.axis, 36), mat(role));
      const off = s * (p.width / 2 + flangeT / 2 - 0.4); // 微入 0.4 防縫
      f.position.set(v[0] * off, v[1] * off, v[2] * off);
      g.add(f);
    }
    g.add(new THREE.Mesh(cylGeo(Math.max(3, p.r * 0.22), p.width + 4, p.axis, 20), mat("pin")));
    return place(g);
  }
  if (p.type === "belt") {
    // 帶體:繞兩輪心 a/b 的封閉環(外公切線跑道形,Shape+hole 一次 Extrude)。
    // 靜態幾何掛共同安裝體——輪心距恆定,帶身不隨幀變形(示意帶不畫轉動)。
    const ai = { x: 0, y: 1, z: 2 }[p.axis];
    const [ui, vi] = [0, 1, 2].filter((i) => i !== ai);
    const au = p.a[ui], av = p.a[vi], bu = p.b[ui], bv = p.b[vi];
    const d = Math.hypot(bu - au, bv - av);
    const t = p.t > 0 ? p.t : 3;
    const gap = 0.3; // 內廓離輪面微退,防 z-fighting(hole 微凸同思路)
    const phi = Math.atan2(bv - av, bu - au);
    // 外公切線與中心線的夾角:offset 同量(+gap/+gap+t)不改角度,內外廓共用
    const beta = Math.acos(Math.max(-1, Math.min(1, (p.rA - p.rB) / d)));
    const ring = (rA, rB) => {
      const path = new THREE.Shape();
      path.absarc(bu, bv, rB, phi + beta, phi - beta, true); // 繞 B 遠端(絕對角度)
      path.absarc(au, av, rA, phi - beta, phi + beta, true); // 繞 A 遠端(過 phi+π)
      path.closePath();
      return path;
    };
    const shape = ring(p.rA + gap + t, p.rB + gap + t);
    shape.holes.push(ring(p.rA + gap, p.rB + gap));
    const geo = new THREE.ExtrudeGeometry(shape, { depth: p.width, bevelEnabled: false, curveSegments: 48 });
    geo.translate(0, 0, p.a[ai] - p.width / 2); // 帶面置中在輪心的 axis 座標
    if (p.axis === "x") {
      // shape 平面(u,v)=(Y,Z)、extrude → X(對映 plate 的基底慣例)
      geo.applyMatrix4(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(0, 1, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(1, 0, 0),
        ),
      );
    } else if (p.axis === "y") {
      geo.applyMatrix4(
        new THREE.Matrix4().makeBasis(
          new THREE.Vector3(1, 0, 0),
          new THREE.Vector3(0, 0, 1),
          new THREE.Vector3(0, 1, 0),
        ),
      );
    }
    return place(new THREE.Mesh(geo, mat(p.role || "belt")));
  }
  return null; // 未知 type(validator 已 warning)→ 忽略
}

// compiled(compileSketch 輸出)→ three 場景:{root, applyFrame, dispose, legend}
export function buildSketchScene(compiled) {
  const mat = makeMaterials();
  const root = new THREE.Group();
  const bodyNodes = new Map();
  const derivedNodes = new Map(); // id → {group, rod?, eyeB?, shank?, dims?}

  // ---- bodies(每個剛體一個 matrixAutoUpdate=false 的 Group)----
  for (const b of compiled.doc.bodies) {
    const g = new THREE.Group();
    g.matrixAutoUpdate = false;
    let host = g;
    if (b.partsFrom) {
      // 鏡像複用另一 body 的 parts:負 scale 子群組(材質 DoubleSide 保繞向)
      const src = compiled.bodiesById[b.partsFrom.body];
      const mirror = new THREE.Group();
      const s = [1, 1, 1];
      s[{ x: 0, y: 1, z: 2 }[b.partsFrom.mirror]] = -1;
      mirror.scale.set(...s);
      for (const p of src?.parts || []) {
        const obj = buildPart(p, b.role || src.role, mat);
        if (obj) mirror.add(obj);
      }
      g.add(mirror);
      host = null;
    }
    if (host) {
      for (const p of b.parts) {
        const obj = buildPart(p, b.role, mat);
        if (obj) host.add(obj);
      }
    }
    root.add(g);
    bodyNodes.set(b.id, g);
  }

  // ---- derived 視覺 ----
  for (const e of compiled.doc.derived) {
    if (e.type === "actuator") {
      const dims = compiled.actuatorDims[e.id];
      const role = e.look.role || "actuator";
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      const odR = dims.odR;
      const bl = dims.barrelLen;
      const barrel = new THREE.Mesh(cylGeo(odR, bl * 0.82, "y", 32), mat(role));
      barrel.position.y = bl * 0.45;
      const rearCap = new THREE.Mesh(cylGeo(odR * 0.62, bl * 0.1, "y", 32), mat("pin"));
      rearCap.position.y = bl * 0.02;
      const headCap = new THREE.Mesh(cylGeo(odR * 0.62, bl * 0.1, "y", 32), mat("pin"));
      headCap.position.y = bl * 0.9;
      const gland = new THREE.Mesh(cylGeo(dims.rodR * 1.5, bl * 0.08, "y", 20), mat("pin"));
      gland.position.y = bl * 0.97;
      // 桿:單位長圓柱,每幀 scale.y = rodLen(ref 手法)
      const rod = new THREE.Mesh(cylGeo(dims.rodR, 1, "y", 20), mat("rod"));
      g.add(barrel, rearCap, headCap, gland, rod);
      root.add(g);
      derivedNodes.set(e.id, { group: g, rod, dims });
    } else if (e.type === "coupler") {
      const role = e.look.role || "coupler";
      const w = e.look.w > 0 ? e.look.w : 7;
      const eyeR = e.look.eyeR > 0 ? e.look.eyeR : 6;
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      // 沿 +Y:eyeA 在 0、eyeB 在 len(每幀更新)、shank 置中拉伸
      const eyeA = new THREE.Mesh(cylGeo(eyeR, w + 2, "z", 24), mat(role));
      const eyeB = new THREE.Mesh(cylGeo(eyeR, w + 2, "z", 24), mat(role));
      const holeA = new THREE.Mesh(cylGeo(eyeR * 0.45, w + 2.4, "z", 16), mat("hole"));
      const holeB = new THREE.Mesh(cylGeo(eyeR * 0.45, w + 2.4, "z", 16), mat("hole"));
      const shank = new THREE.Mesh(new THREE.BoxGeometry(w, 1, w), mat(role));
      g.add(eyeA, holeA, eyeB, holeB, shank);
      root.add(g);
      derivedNodes.set(e.id, { group: g, eyeB, holeB, shank, eyeR });
    } else if (e.type === "attach") {
      const g = new THREE.Group();
      g.matrixAutoUpdate = false;
      for (const p of e.look.parts || []) {
        const obj = buildPart(p, e.look.role || "workpiece", mat);
        if (obj) g.add(obj);
      }
      root.add(g);
      derivedNodes.set(e.id, { group: g });
    }
    // pin_on_line 無自身視覺(銷/叉耳由掛在該點的 body parts 承載)
  }

  // ---- 軌跡註解(靜態虛線;compile 已預取樣)----
  const bbox = new THREE.Box3().setFromObject(root);
  const radius = Math.max(1, bbox.getSize(new THREE.Vector3()).length() / 2);
  for (const tr of compiled.traces) {
    const pos = new Float32Array(tr.points.length * 3);
    tr.points.forEach((pt, i) => pos.set(pt, i * 3));
    const geo = new THREE.BufferGeometry();
    geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
    const line = new THREE.Line(
      geo,
      new THREE.LineDashedMaterial({
        color: 0x8fa6b6,
        dashSize: Math.max(radius * 0.02, 1.4),
        gapSize: Math.max(radius * 0.015, 1.0),
        transparent: true,
        opacity: 0.9,
        toneMapped: false,
      }),
    );
    line.computeLineDistances();
    line.frustumCulled = false;
    root.add(line);
  }

  // ---- 每幀套用(evalPose 的 frame;矩陣 column-major 直灌)----
  const applyFrame = (frame) => {
    for (const [id, g] of bodyNodes) {
      const m = frame.bodyWorld[id];
      if (m) {
        g.matrix.fromArray(m);
        g.matrixWorldNeedsUpdate = true;
      }
    }
    for (const [id, node] of derivedNodes) {
      const pose = frame.derivedPose[id];
      if (!pose?.mat) continue;
      node.group.matrix.fromArray(pose.mat);
      node.group.matrixWorldNeedsUpdate = true;
      if (node.rod) {
        const rodLen = Math.max(0.5, pose.rodLen ?? 1);
        node.rod.scale.y = rodLen;
        node.rod.position.y = node.dims.barrelLen + rodLen / 2;
      }
      if (node.eyeB) {
        const len = Math.max(1, pose.len ?? 1);
        node.eyeB.position.y = len;
        node.holeB.position.y = len;
        node.shank.scale.y = Math.max(1, len - 2 * node.eyeR);
        node.shank.position.y = len / 2;
      }
    }
  };

  // 圖例:自動彙整有 label 的 bodies/derived(role → 色塊)
  const legend = [];
  for (const b of compiled.doc.bodies) {
    if (b.label) legend.push({ label: b.label, color: (ROLE_COLORS[b.role] || ROLE_COLORS.frame).color });
  }
  for (const e of compiled.doc.derived) {
    if (e.look?.label) {
      const role = e.look.role || (e.type === "actuator" ? "actuator" : e.type === "coupler" ? "coupler" : "workpiece");
      legend.push({ label: e.look.label, color: (ROLE_COLORS[role] || ROLE_COLORS.frame).color });
    }
  }

  const dispose = () => {
    root.traverse((o) => {
      o.geometry?.dispose?.();
    });
    // 材質是共享 cache,traverse 完統一釋放
    root.traverse((o) => {
      if (o.material?.dispose && !o.material._sketchDisposed) {
        o.material._sketchDisposed = true;
        o.material.dispose();
      }
    });
  };

  return { root, applyFrame, dispose, legend, radius, bbox };
}
