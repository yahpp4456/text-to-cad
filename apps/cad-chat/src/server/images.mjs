// 圖片 magic bytes 嗅探:上傳端點(落地副檔名)與 chat 組 image blocks(media_type)
// 共用,是 media_type 的唯一真相來源——不信 client content-type 與副檔名。
// 上限 3.5MB/張:base64 膨脹 ~33% 後 ~4.67MB,低於 API 單張 image 5MB 上限留餘裕。
export const MAX_IMAGE_BYTES = 3_500_000;

// 支援 API Base64ImageSource 的四種 media_type:png / jpeg / gif / webp。
export function sniffImageType(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return { ext: "png", mediaType: "image/png" };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { ext: "jpg", mediaType: "image/jpeg" };
  }
  if (buf.toString("ascii", 0, 4) === "GIF8") {
    return { ext: "gif", mediaType: "image/gif" };
  }
  if (buf.toString("ascii", 0, 4) === "RIFF" && buf.toString("ascii", 8, 12) === "WEBP") {
    return { ext: "webp", mediaType: "image/webp" };
  }
  return null;
}
