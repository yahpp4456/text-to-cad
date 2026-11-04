// golden:由 .venv python 現算(cadpy.surface.curves.make_curve → geom_adaptor().Value(first+(last−first)·t),
// t=0/.25/.5/.75/1)。注意 build123d 的 position_at(t, PARAMETER) 是「弧長正規化」不是曲線參數,
// 對 bezier/nurbs 會差一截——重算 golden 必走 adaptor.Value。
import assert from "node:assert/strict";
import { test } from "node:test";

import { clampedUniformKnots, editablePoints, evalCurve, sampleCurve, withEditablePoint } from "./nurbsEval.js";

const GOLDEN = {
  bezier: { spec: { id: "b", kind: "bezier", poles: [[0, 0, 0], [10, 20, 5], [30, 20, -5], [40, 0, 0]] }, pts: [[0, 0, 0], [9.0625, 11.25, 1.40625], [20, 15, 0], [30.9375, 11.25, -1.40625], [40, 0, 0]] },
  nurbs_quarter: { spec: { id: "q", kind: "nurbs", degree: 2, poles: [[10, 0, 0], [10, 10, 0], [0, 10, 0]], weights: [1, 0.7071067811865476, 1] }, pts: [[10, 0, 0], [9.297883, 3.680947, 0], [7.071068, 7.071068, 0], [3.680947, 9.297883, 0], [0, 10, 0]] },
  nurbs_cubic: { spec: { id: "n", kind: "nurbs", degree: 3, poles: [[0, 0, 0], [5, 8, 0], [12, 9, 3], [20, 2, 1], [30, 0, 0]] }, pts: [[0, 0, 0], [6.59375, 7.0625, 0.78125], [12.25, 7, 1.75], [18.78125, 3.6875, 1.34375], [30, 0, 0]] },
  arc3: { spec: { id: "a", kind: "arc3", points: [[-10, 0, 0], [0, 10, 0], [10, 0, 0]] }, pts: [[-10, 0, 0], [-7.071068, 7.071068, 0], [0, 10, 0], [7.071068, 7.071068, 0], [10, 0, 0]] },
  circle: { spec: { id: "c", kind: "circle", center: [1, 2, 3], normal: [0, 0, 1], r: 5 }, pts: [[6, 2, 3], [1, 7, 3], [-4, 2, 3], [1, -3, 3], [6, 2, 3]] },
  line: { spec: { id: "l", kind: "line", points: [[0, 0, 0], [10, 4, 2]] }, pts: [[0, 0, 0], [2.5, 1, 0.5], [5, 2, 1], [7.5, 3, 1.5], [10, 4, 2]] },
};

const close = (a, b, tol = 2e-4) => a.every((x, i) => Math.abs(x - b[i]) <= tol);

test("精確曲線:bezier/nurbs/arc3/circle/line 在參數 t 與 kernel 逐點重合", () => {
  for (const [name, g] of Object.entries(GOLDEN)) {
    [0, 0.25, 0.5, 0.75, 1].forEach((t, i) => {
      const r = evalCurve(g.spec, t);
      assert.ok(r && !r.approx, `${name}: 應為精確曲線`);
      assert.ok(close(r.p, g.pts[i]), `${name} t=${t}: ${r.p} vs ${g.pts[i]}`);
    });
  }
});

test("clamped uniform knots 與 Python _nurbs_edge 同構;spline 走 Catmull-Rom 近似並標 approx", () => {
  assert.deepEqual(clampedUniformKnots(5, 3), [0, 0, 0, 0, 0.5, 1, 1, 1, 1]);
  assert.deepEqual(clampedUniformKnots(3, 2), [0, 0, 0, 1, 1, 1]);
  const s = { kind: "spline", points: [[0, 0, 0], [10, 5, 0], [20, 0, 0]] };
  const r = sampleCurve(s, 9);
  assert.equal(r.approx, true);
  assert.equal(r.pts.length, 9);
  assert.deepEqual(r.pts[0], [0, 0, 0]);
  assert.deepEqual(r.pts[8], [20, 0, 0]);
  assert.ok(close(r.pts[4], [10, 5, 0], 1e-6), "過中間點");
  const closed = sampleCurve({ kind: "spline", points: [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0]], closed: true }, 5);
  assert.ok(close(closed.pts[0], closed.pts[4], 1e-6), "閉合首尾相接");
});

test("sampleCurve 防禦:壞 kind / 共線 arc3 退直線 / 最少 2 點;editablePoints 與 withEditablePoint", () => {
  assert.equal(sampleCurve({ kind: "helix" }, 4), null);
  const col = sampleCurve({ kind: "arc3", points: [[0, 0, 0], [1, 0, 0], [2, 0, 0]] }, 3);
  assert.deepEqual(col.pts[1], [1, 0, 0]);
  assert.equal(sampleCurve(GOLDEN.line.spec, 1).pts.length, 2);
  assert.equal(editablePoints(GOLDEN.circle.spec).length, 0);
  assert.equal(editablePoints(GOLDEN.bezier.spec).length, 4);
  assert.equal(editablePoints(GOLDEN.arc3.spec).length, 3);
  const moved = withEditablePoint(GOLDEN.bezier.spec, 1, [11, 21, 6]);
  assert.deepEqual(moved.poles[1], [11, 21, 6]);
  assert.deepEqual(GOLDEN.bezier.spec.poles[1], [10, 20, 5], "不改原件");
  const movedPts = withEditablePoint(GOLDEN.line.spec, 0, [1, 1, 1]);
  assert.deepEqual(movedPts.points[0], [1, 1, 1]);
});
