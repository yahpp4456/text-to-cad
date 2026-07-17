// STEP 上傳的大小上限與檔頭嗅探，鏡射 images.mjs 的圖片上傳角色。
export const MAX_STEP_BYTES = 25_000_000;

const STEP_MAGIC = Buffer.from("ISO-10303-21", "ascii");

function isAsciiWhitespace(byte) {
  return byte === 0x20 || byte === 0x09 || byte === 0x0d || byte === 0x0a;
}

export function sniffStepFile(buf) {
  if (!(Buffer.isBuffer(buf) || buf instanceof Uint8Array) || buf.byteLength === 0) {
    return null;
  }

  const head = buf.subarray(0, Math.min(buf.byteLength, 64));
  let offset = 0;
  if (head[0] === 0xef && head[1] === 0xbb && head[2] === 0xbf) offset = 3;
  while (offset < head.length && isAsciiWhitespace(head[offset])) offset += 1;
  if (offset + STEP_MAGIC.length > head.length) return null;

  for (let i = 0; i < STEP_MAGIC.length; i += 1) {
    if (head[offset + i] !== STEP_MAGIC[i]) return null;
  }
  return { ext: "step" };
}
