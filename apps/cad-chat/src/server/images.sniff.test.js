// 圖片 magic bytes 嗅探單元測(node --test):media_type 唯一真相來源
// (上傳端點落地副檔名與 chat.mjs 組 image blocks 共用)。
import assert from "node:assert/strict";
import { test } from "node:test";

import { MAX_IMAGE_BYTES, sniffImageType } from "./images.mjs";

const pad = (bytes) => Buffer.concat([Buffer.from(bytes), Buffer.alloc(16)]);

test("sniffImageType:四種格式 magic bytes 判對", () => {
  assert.deepEqual(sniffImageType(pad([0x89, 0x50, 0x4e, 0x47])), {
    ext: "png",
    mediaType: "image/png",
  });
  assert.deepEqual(sniffImageType(pad([0xff, 0xd8, 0xff, 0xe0])), {
    ext: "jpg",
    mediaType: "image/jpeg",
  });
  assert.deepEqual(sniffImageType(pad(Buffer.from("GIF89a"))), {
    ext: "gif",
    mediaType: "image/gif",
  });
  const webp = Buffer.alloc(16);
  webp.write("RIFF", 0, "ascii");
  webp.write("WEBP", 8, "ascii");
  assert.deepEqual(sniffImageType(webp), { ext: "webp", mediaType: "image/webp" });
});

test("sniffImageType:亂 bytes / 截斷 / 偽 RIFF / 空 → null", () => {
  assert.equal(sniffImageType(Buffer.from("not an image at all")), null);
  assert.equal(sniffImageType(Buffer.from([0x89, 0x50])), null); // 不足 12 bytes
  const riffOnly = Buffer.alloc(16);
  riffOnly.write("RIFF", 0, "ascii"); // RIFF 但不是 WEBP(如 wav)
  assert.equal(sniffImageType(riffOnly), null);
  assert.equal(sniffImageType(null), null);
  assert.equal(sniffImageType(Buffer.alloc(0)), null);
});

test("MAX_IMAGE_BYTES:base64 膨脹後仍低於 API 單張 5MB", () => {
  assert.ok(MAX_IMAGE_BYTES > 0);
  assert.ok((MAX_IMAGE_BYTES * 4) / 3 < 5_000_000);
});
