// buildTopologyModel 巢狀樹單元測(node --test 直跑,不需瀏覽器)。
// 涵蓋:occurrence 巢狀、root 併合、降級(無 occurrences/單件)、ownerOf 三層 fallback、cap。
import assert from "node:assert/strict";
import { test } from "node:test";

import { buildTopologyModel, derivedRows } from "./cadTopology.js";

const shape = (name, occ, extra = {}) => ({ name, occurrenceId: occ, ...extra });
const face = (surfaceType, occ, extra = {}) => ({ surfaceType, occurrenceId: occ, ...extra });

test("巢狀組合件:中繼母節點 + root 併合 + DFS 順序", () => {
  const runtime = {
    occurrences: [
      { id: "o1", parentId: null, name: "stage_asm" },
      { id: "o1.1", parentId: "o1", name: "base" },
      { id: "o1.2", parentId: "o1", name: "motor" },
      { id: "o1.2.1", parentId: "o1.2", name: "motor_body" },
      { id: "o1.2.2", parentId: "o1.2", name: "motor_shaft" },
      { id: "o1.3", parentId: "o1", name: "bracket" },
    ],
    shapes: [
      shape("base", "o1.1"),
      shape("motor_body", "o1.2.1"),
      shape("motor_shaft", "o1.2.2"),
      shape("bracket", "o1.3"),
    ],
    faces: [
      face("plane", "o1.1", { center: [0, 0, 0] }),
      face("cylinder", "o1.2.1", { center: [1, 1, 1] }),
      // occurrence 表查無此 id → 前綴 fallback 掛 bracket
      face("plane", "o1.3.7"),
    ],
    edges: [],
    references: [
      { selectorType: "occurrence", pickData: { rowIndex: 2 }, copyText: "#o1.2-ref" },
    ],
  };
  const t = buildTopologyModel(runtime);
  assert.equal(t.nodes[0].label, "stage_asm"); // root 併合用 root occurrence 名字
  assert.equal(t.nodes[0].kindEn, "ASSEMBLY");
  assert.deepEqual(
    t.nodes.map((n) => n.id),
    ["__root", "s0", "f0", "o1.2", "s1", "f1", "s2", "s3", "f2"],
  );
  const motor = t.nodes.find((n) => n.id === "o1.2");
  assert.equal(motor.kind, "occurrence");
  assert.equal(motor.kindEn, "GROUP");
  assert.equal(motor.label, "motor");
  assert.equal(motor.depth, 1);
  assert.equal(motor.childCount, 2);
  assert.equal(motor.token, "#o1.2-ref"); // occurrence reference copyText 優先
  const body = t.nodes.find((n) => n.id === "s1");
  assert.equal(body.parentId, "o1.2");
  assert.equal(body.depth, 2);
  assert.equal(body.token, "#o1.2.1");
  const bodyFace = t.nodes.find((n) => n.id === "f1");
  assert.equal(bodyFace.parentId, "s1");
  assert.equal(bodyFace.depth, 3); // 面深度跟著零件深度走
  assert.equal(bodyFace.ownerOcc, "o1.2.1");
  const strayFace = t.nodes.find((n) => n.id === "f2");
  assert.equal(strayFace.parentId, "s3"); // 前綴 fallback
});

test("ownerOf occurrence 表 parentId 上溯(face 指到無 shape 的子 occurrence)", () => {
  const runtime = {
    occurrences: [
      { id: "o1", parentId: null, name: "asm" },
      { id: "o1.1", parentId: "o1", name: "wheel" },
      { id: "o1.1.1", parentId: "o1.1", name: "wheel_sub" }, // 無 shape row
      { id: "o1.2", parentId: "o1", name: "axle" },
    ],
    shapes: [shape("wheel", "o1.1"), shape("axle", "o1.2")],
    faces: [face("cone", "o1.1.1")], // 上溯 o1.1.1 → o1.1 命中 wheel
    edges: [],
    references: [],
  };
  const t = buildTopologyModel(runtime);
  // wheel occ 有子 occurrence → 成 GROUP,shape 掛其下
  const group = t.nodes.find((n) => n.id === "o1.1");
  assert.equal(group.kind, "occurrence");
  const wheelShape = t.nodes.find((n) => n.kind === "shape" && n.row.name === "wheel");
  assert.equal(wheelShape.parentId, "o1.1");
  const f = t.nodes.find((n) => n.kind === "face");
  assert.equal(f.parentId, wheelShape.id);
  // 空葉 occurrence(無 shape 無子)成 childCount 0 節點
  const sub = t.nodes.find((n) => n.id === "o1.1.1");
  assert.equal(sub.kind, "occurrence");
  assert.equal(sub.childCount, 0);
});

test("降級:無 occurrences → 扁平單層(現行為不變)", () => {
  const runtime = {
    shapes: [shape("a", "o1.1"), shape("b", "o1.2")],
    faces: [face("plane", "o1.1")],
    edges: [],
    references: [],
  };
  const t = buildTopologyModel(runtime);
  assert.equal(t.nodes[0].label, "assembly");
  const shapesOut = t.nodes.filter((n) => n.kind === "shape");
  assert.equal(shapesOut.length, 2);
  for (const s of shapesOut) {
    assert.equal(s.depth, 1);
    assert.equal(s.parentId, "__root");
  }
  assert.equal(t.nodes.filter((n) => n.kind === "occurrence").length, 0);
  assert.equal(t.nodes.find((n) => n.kind === "face").depth, 2);
});

test("降級:單件模型(occurrences 存在也不建層)", () => {
  const runtime = {
    occurrences: [{ id: "o1", parentId: null, name: "flange" }],
    shapes: [shape("flange", "o1", { kind: "solid" })],
    faces: [face("plane", "o1"), face("cylinder", "o1")],
    edges: [],
    references: [],
  };
  const t = buildTopologyModel(runtime);
  assert.equal(t.nodes[0].label, "flange");
  assert.equal(t.nodes[0].kindEn, "SOLID");
  assert.equal(t.nodes.filter((n) => n.kind === "shape").length, 0);
  for (const f of t.nodes.filter((n) => n.kind === "face")) {
    assert.equal(f.depth, 1);
    assert.equal(f.parentId, "__root");
  }
});

test("多 root occurrence:各自成 __root 子節點", () => {
  const runtime = {
    occurrences: [
      { id: "o1", parentId: null, name: "left" },
      { id: "o2", parentId: null, name: "right" },
      { id: "o1.1", parentId: "o1", name: "l_part" },
      { id: "o2.1", parentId: "o2", name: "r_part" },
    ],
    shapes: [shape("l_part", "o1.1"), shape("r_part", "o2.1")],
    faces: [],
    edges: [],
    references: [],
  };
  const t = buildTopologyModel(runtime);
  assert.equal(t.nodes[0].label, "assembly"); // 多 root 保留合成名
  const left = t.nodes.find((n) => n.id === "o1");
  const right = t.nodes.find((n) => n.id === "o2");
  assert.equal(left.parentId, "__root");
  assert.equal(right.parentId, "__root");
  assert.equal(t.nodes.find((n) => n.row?.name === "l_part").parentId, "o1");
});

test("面/邊 cap:每件 12 面上限 + more 節點", () => {
  const manyFaces = Array.from({ length: 15 }, (_, i) => face("plane", "o1.1", { idx: i }));
  const runtime = {
    occurrences: [
      { id: "o1", parentId: null, name: "asm" },
      { id: "o1.1", parentId: "o1", name: "big" },
      { id: "o1.2", parentId: "o1", name: "small" },
    ],
    shapes: [shape("big", "o1.1"), shape("small", "o1.2")],
    faces: manyFaces,
    edges: [],
    references: [],
  };
  const t = buildTopologyModel(runtime);
  const bigId = t.nodes.find((n) => n.row?.name === "big").id;
  const bigFaces = t.nodes.filter((n) => n.kind === "face" && n.parentId === bigId);
  assert.equal(bigFaces.length, 12);
  const more = t.nodes.find((n) => n.kind === "more");
  assert.equal(more.parentId, bigId);
  assert.match(more.label, /還有 3 個面/);
});

test("derivedRows occurrence 分支:聚合欄位 + ORIGIN", () => {
  const node = {
    kind: "occurrence",
    childCount: 2,
    row: {
      bbox: { min: [0, 0, 0], max: [10, 20, 30] },
      transform: [1, 0, 0, 5, 0, 1, 0, 6, 0, 0, 1, 7, 0, 0, 0, 1],
      shapeCount: 2,
      faceCount: 9,
      edgeCount: 12,
    },
  };
  const rows = derivedRows(node, {});
  const byK = Object.fromEntries(rows.map((r) => [r.k, r.v]));
  assert.equal(byK["外形 BBOX"], "10 × 20 × 30 mm");
  assert.equal(byK["位置 ORIGIN"], "(5, 6, 7)");
  assert.equal(byK["直接子件"], "2");
  assert.equal(byK["後代 SHAPE / FACE"], "2 / 9");
  assert.equal(byK["EDGE"], "12");
});
