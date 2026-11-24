// frame 協定(一行 JSON + 可選位元組)的編解碼。
import assert from "node:assert/strict";
import { test } from "node:test";

import { createFrameDecoder, encodeFrame } from "./frames.mjs";

function decodeAll(chunks) {
  const frames = [];
  const errors = [];
  const decoder = createFrameDecoder(
    (message, payload) => frames.push({ message, payload: payload.toString("utf8") }),
    (err, text) => errors.push(text),
  );
  for (const chunk of chunks) decoder.push(chunk);
  return { frames, errors, decoder };
}

test("encodeFrame:無 payload 是單行 JSON,不帶 bytes", () => {
  const buf = encodeFrame({ id: 1, op: "ping" });
  assert.equal(buf.toString("utf8"), '{"id":1,"op":"ping"}\n');
});

test("encodeFrame:有 payload 時補上 bytes(位元組數,不是字元數)並緊接其後", () => {
  const payload = Buffer.from("繁中✓", "utf8");
  const buf = encodeFrame({ id: 2, done: true }, payload);
  const newline = buf.indexOf(0x0a);
  assert.deepEqual(JSON.parse(buf.subarray(0, newline).toString("utf8")), {
    id: 2,
    done: true,
    bytes: payload.length,
  });
  assert.equal(buf.subarray(newline + 1).toString("utf8"), "繁中✓");
});

test("encodeFrame:空 payload 視同沒有", () => {
  assert.equal(encodeFrame({ a: 1 }, Buffer.alloc(0)).toString("utf8"), '{"a":1}\n');
});

test("解碼:一次餵多個 frame", () => {
  const wire = Buffer.concat([
    encodeFrame({ id: 1 }),
    encodeFrame({ id: 2 }, Buffer.from("hello")),
    encodeFrame({ id: 3 }),
  ]);
  const { frames } = decodeAll([wire]);
  assert.deepEqual(frames, [
    { message: { id: 1 }, payload: "" },
    { message: { id: 2, bytes: 5 }, payload: "hello" },
    { message: { id: 3 }, payload: "" },
  ]);
});

test("解碼:逐位元組餵入(任意切法)結果相同,多位元組字元不會被切壞", () => {
  const wire = Buffer.concat([
    encodeFrame({ id: 1, note: "繁中" }, Buffer.from("第一段\n含換行✓")),
    encodeFrame({ id: 2 }),
  ]);
  const { frames, decoder } = decodeAll([...wire].map((byte) => Buffer.from([byte])));
  assert.equal(frames.length, 2);
  assert.equal(frames[0].message.note, "繁中");
  assert.equal(frames[0].payload, "第一段\n含換行✓");
  assert.equal(frames[1].message.id, 2);
  assert.equal(decoder.buffered, 0);
});

test("解碼:payload 內的換行與大括號不會被當成 frame", () => {
  const { frames } = decodeAll([encodeFrame({ id: 1 }, Buffer.from('{"id":99}\n{"id":98}\n')), encodeFrame({ id: 2 })]);
  assert.deepEqual(
    frames.map((f) => f.message.id),
    [1, 2],
  );
});

test("解碼:frame 之前不以 { 開頭的行(banner、空行、CRLF)略過", () => {
  const wire = Buffer.concat([Buffer.from("banner line\r\n\n  \n"), encodeFrame({ id: 1 }), Buffer.from("noise\n")]);
  const { frames, errors } = decodeAll([wire]);
  assert.deepEqual(frames, [{ message: { id: 1 }, payload: "" }]);
  assert.deepEqual(errors, []);
});

test("解碼:以 { 開頭卻不是 JSON 的行交給 onError,後續 frame 照常", () => {
  const { frames, errors } = decodeAll([Buffer.from("{not json\n"), encodeFrame({ id: 5 })]);
  assert.deepEqual(errors, ["{not json"]);
  assert.deepEqual(frames, [{ message: { id: 5 }, payload: "" }]);
});

test("解碼:斷在 frame 中途時 buffered > 0", () => {
  const wire = encodeFrame({ id: 1 }, Buffer.from("0123456789"));
  const { frames, decoder } = decodeAll([wire.subarray(0, wire.length - 3)]);
  assert.equal(frames.length, 0);
  assert.ok(decoder.buffered > 0);
});
