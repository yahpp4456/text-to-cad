import assert from "node:assert/strict";
import { test } from "node:test";

import { demoEventFilter } from "./demoEvents.mjs";

test("demoEventFilter:demo 剝掉 tool.code,其餘欄位與事件原樣;非 demo 不動", () => {
  const f = demoEventFilter(true);
  const tool = { id: "t1", name: "cad.build(x.py)", status: "running", code: "from build123d import *" };
  assert.deepEqual(f("tool", tool), { id: "t1", name: "cad.build(x.py)", status: "running" });
  assert.ok("code" in tool, "不可改動原物件");
  const toolNoCode = { id: "t1", status: "done", ms: 12 };
  assert.deepEqual(f("tool", toolNoCode), toolNoCode);
  const present = { name: "cube", code: "cube", glbUrl: "/x.glb" };
  assert.deepEqual(f("present", present), present, "present.code 是檔名,不剝");
  assert.deepEqual(f("artifact", { ver: "v1", code: "cube" }), { ver: "v1", code: "cube" });
  assert.equal(f("tool", null), null);
  const g = demoEventFilter(false);
  assert.deepEqual(g("tool", tool), tool);
});
