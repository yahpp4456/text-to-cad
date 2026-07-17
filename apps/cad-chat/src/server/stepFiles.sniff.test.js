import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_STEP_BYTES, sniffStepFile } from "./stepFiles.mjs";

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

test("sniffStepFile:接受標準 STEP 檔頭", () => {
  assert.deepEqual(sniffStepFile(Buffer.from("ISO-10303-21;\nHEADER;")), { ext: "step" });
});

test("sniffStepFile:接受 UTF-8 BOM 前綴", () => {
  const buf = Buffer.concat([BOM, Buffer.from("ISO-10303-21;")]);
  assert.deepEqual(sniffStepFile(buf), { ext: "step" });
});

test("sniffStepFile:接受前導 ASCII 空白", () => {
  assert.deepEqual(sniffStepFile(Buffer.from("\r\n  ISO-10303-21;")), { ext: "step" });
});

test("sniffStepFile:接受 BOM 與空白混合前綴", () => {
  const buf = Buffer.concat([BOM, Buffer.from("\n ISO-10303-21;")]);
  assert.deepEqual(sniffStepFile(buf), { ext: "step" });
});

test("sniffStepFile:接受 Uint8Array", () => {
  const buf = new Uint8Array(Buffer.from("ISO-10303-21;"));
  assert.deepEqual(sniffStepFile(buf), { ext: "step" });
});

test("sniffStepFile:拒絕 PNG magic bytes", () => {
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(sniffStepFile(pngMagic), null);
});

test("sniffStepFile:拒絕隨機文字", () => {
  assert.equal(sniffStepFile(Buffer.from("hello world")), null);
});

test("sniffStepFile:檔頭比對大小寫敏感", () => {
  assert.equal(sniffStepFile(Buffer.from("iso-10303-21;")), null);
});

test("sniffStepFile:空值與無效型別安全回傳 null", () => {
  assert.equal(sniffStepFile(Buffer.alloc(0)), null);
  assert.equal(sniffStepFile(null), null);
  assert.equal(sniffStepFile(undefined), null);
  assert.equal(sniffStepFile("ISO-10303-21;"), null);
});

test("MAX_STEP_BYTES:鎖定 STEP 上傳上限", () => {
  assert.equal(MAX_STEP_BYTES, 25_000_000);
});
