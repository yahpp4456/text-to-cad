import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { introVideoStatus, parseRange } from "./introVideo.mjs";

test("introVideoStatus:LFS pointer(百餘 bytes)視為不可用;真檔可用;不存在不可用", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "intro-"));
  const pointer = path.join(dir, "p.mp4");
  fs.writeFileSync(pointer, "version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 11760930\n");
  assert.equal(introVideoStatus(pointer).available, false);
  const real = path.join(dir, "r.mp4");
  fs.writeFileSync(real, Buffer.alloc(8192, 1));
  assert.deepEqual(introVideoStatus(real), { available: true, size: 8192 });
  assert.equal(introVideoStatus(path.join(dir, "nope.mp4")).available, false);
  fs.rmSync(dir, { recursive: true, force: true });
});

test("parseRange:無標頭→整檔;開區間/閉區間/尾綴;越界→invalid", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.equal(parseRange("", 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 }); // end 夾到檔尾
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "invalid");
  assert.equal(parseRange("bytes=20-10", 100), "invalid");
  assert.equal(parseRange("bytes=-", 100), "invalid");
  assert.equal(parseRange("items=0-1", 100), null); // 非 bytes 單位 → 當整檔
});
