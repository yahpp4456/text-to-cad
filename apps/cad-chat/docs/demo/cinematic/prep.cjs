// 前處理:cues.json + 素材時長 → src/timeline.json(全部換成 frame),並把素材轉成 mp4 放 public/。
// 用法:node prep.cjs <rawDir>   (rawDir 內有 *.webm 與 cues.json)
const fs = require("node:fs");
const path = require("node:path");
const { execSync } = require("node:child_process");

const rawDir = process.argv[2];
const webm = fs.readdirSync(rawDir).find((f) => f.endsWith(".webm"));
const cuesDoc = JSON.parse(fs.readFileSync(path.join(rawDir, "cues.json"), "utf8"));
const fps = 25;
fs.mkdirSync("public", { recursive: true });
const mp4 = path.join("public", "footage.mp4");
if (!fs.existsSync(mp4) || process.env.FORCE) {
  execSync(`ffmpeg -v error -y -i "${path.join(rawDir, webm)}" -c:v libx264 -preset fast -crf 18 -pix_fmt yuv420p -r ${fps} -an "${mp4}"`, { stdio: "inherit" });
}
const dur = Number(execSync(`ffprobe -v error -show_entries format=duration -of csv=p=0 "${mp4}"`).toString().trim());
const cues = cuesDoc.cues;
const endT = cues.find((c) => c.kind === "end")?.t ?? dur;
// 錄影零點比 t0 早一點(context 建立 → page 建立);影片尾 = page.close ≈ end cue
// 影片零點 ≈ 第一幀擷取(晚於 t0)、影片尾 ≈ page.close ≈ end cue → 以尾端對齊推回偏移(可為負)
const lead = dur - endT;
const F = (t) => Math.round((t + lead) * fps);
const total = Math.ceil(dur * fps);

const captions = [];
const cards = [];
const highlights = [];
let openCap = null;
let openHl = null;
for (const c of cues) {
  const f = F(c.t);
  if (c.kind === "cap") {
    if (openCap) openCap.end = f;
    openCap = { start: f, end: total, html: c.html };
    captions.push(openCap);
  } else if (c.kind === "capOff") {
    if (openCap) { openCap.end = f; openCap = null; }
  } else if (c.kind === "card") {
    cards.push({ start: f, end: f + Math.round((c.ms / 1000) * fps), kicker: c.kicker || "", title: c.title || "", sub: c.sub || "", lines: c.lines || [] });
  } else if (c.kind === "hl") {
    if (openHl) openHl.end = f;
    openHl = { start: f, end: total, label: c.label, rect: c.rect };
    highlights.push(openHl);
  } else if (c.kind === "hlClear") {
    if (openHl) { openHl.end = f; openHl = null; }
  }
}
// 章節:每張卡 = 一章(開場卡與結尾卡除外),章節 chip 從卡結束起到下一章開始
const chapters = [];
cards.forEach((cd, i) => {
  const m = /^0?(\d)\s*·/.exec(cd.kicker);
  if (!m) return;
  const next = cards[i + 1];
  chapters.push({ no: m[1].padStart(2, "0"), title: cd.title, start: cd.start, end: next ? next.start : total });
});
// 裁掉開場卡之前的頁面載入段:全部時間點平移,錄影 startFrom=trim
const trim = cards[0].start;
const shift = (o) => { o.start -= trim; o.end -= trim; };
captions.forEach(shift); cards.forEach(shift); highlights.forEach(shift); chapters.forEach(shift);
const totalTrim = Math.min(total - trim, cards[cards.length - 1].end + 40);
const timeline = { fps, width: cuesDoc.width, height: cuesDoc.height, total: totalTrim, trim, lead, captions, cards, highlights, chapters };
fs.mkdirSync("src", { recursive: true });
fs.writeFileSync("src/timeline.json", JSON.stringify(timeline, null, 1));
console.log(JSON.stringify({ dur, total: totalTrim, trim, lead, captions: captions.length, cards: cards.length, highlights: highlights.length, chapters: chapters.map((c) => c.no + c.title) }));
