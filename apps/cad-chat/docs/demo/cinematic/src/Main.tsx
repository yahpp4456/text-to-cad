import React from "react";
import { AbsoluteFill, Audio, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import { noise2D } from "@remotion/noise";
import tl from "./timeline.json";
import { ACCENT, ACCENT_DIM, Background, DrawBar, DrawNumber, Enter, FONT, MONO, Particles, StaggerText, clamp, easeIn, easeInOut, parseCaption } from "./primitives";
import { Cam, FocusBox, LensDirt, Set, Shot, Slate, Stage, StageTraces, Viewfinder, Vignette, cameraAt } from "./stage";

type Card = { start: number; end: number; kicker: string; title: string; sub: string; lines: string[] };
type Cap = { start: number; end: number; html: string };
type Hl = { start: number; end: number; label: string; rect: { x: number; y: number; w: number; h: number } | null };
type Chapter = { no: string; title: string; start: number; end: number };

// 開場加長:場記板 + 直接對觀眾的一句話需要時間;整條時間軸(除開場起點)後移,錄影延後 OPEN_EXTRA 幀起播
const OPEN_EXTRA = 100;
const shiftAll = <T extends { start: number; end: number }>(arr: T[]): T[] => arr.map((o) => ({ ...o, start: o.start + OPEN_EXTRA, end: o.end + OPEN_EXTRA }));
const cards = shiftAll(tl.cards as Card[]).map((c, i) => (i === 0 ? { ...c, start: 0 } : c));
const captions = shiftAll(tl.captions as Cap[]);
const highlights = (tl.highlights as Hl[]).map((h) => ({ ...h })); // 主景內以錄影幀為準,不平移(Sequence 掛在錄影之下)
const chapters = shiftAll(tl.chapters as Chapter[]);
const TOTAL = (tl.total as number) + OPEN_EXTRA;
const FPS = tl.fps as number;
const opening = cards[0];
const closing = cards[cards.length - 1];
const sections = cards.slice(1, -1);

// ---------- 攝影棚配置(世界座標;每個佈景 1920×1080) ----------
const APP_SCALE = 0.9;
const SETS = {
  app: { x: 0, y: 0 },
  opening: { x: 0, y: -2100 },
  closing: { x: 0, y: 2150 },
  cards: [
    { x: 2750, y: -1000 }, // 01 右上
    { x: 2750, y: 1150 }, // 02 右下
    { x: -2750, y: 1150 }, // 03 左下
    { x: -2750, y: -1000 }, // 04 左上
    { x: -3900, y: 70 }, // 05 左遠
    { x: 3900, y: 70 }, // 06 右遠(壓軸)
  ],
};
const center = (s: { x: number; y: number }) => ({ x: s.x + 960, y: s.y + 540 });

// ---------- 鏡位表(由時間軸推導) ----------
const WHIP = 13; // 甩鏡幀數
const GLIDE = 24; // 滑回主景
const CRANE = 30; // 吊臂
const APP_ARRIVE = opening.end + 12; // 吊臂落到主景
const SLATE_LEAD = 36; // 場記板在甩鏡前多少幀落下
type ShotEx = Shot & { name: string };
const shots: ShotEx[] = [];
shots.push({ ...center(SETS.opening), scale: 1, rot: 0, start: 0, moveFrames: CRANE, kind: "crane", name: "opening" });
shots.push({ ...center(SETS.app), scale: APP_SCALE, rot: 0, start: APP_ARRIVE, moveFrames: WHIP, kind: "whip", name: "app" });
sections.forEach((c, i) => {
  const p = center(SETS.cards[i]);
  const finale = i === sections.length - 1;
  shots.push({ x: p.x, y: p.y, scale: finale ? 1.04 : 1, rot: 0, start: c.start, moveFrames: GLIDE, kind: "glide", name: `card${i}` });
  shots.push({ ...center(SETS.app), scale: APP_SCALE, rot: 0, start: c.end + GLIDE, moveFrames: WHIP, kind: "whip", name: "app" });
});
// 最後一個 app shot 以吊臂離開到結尾景
shots[shots.length - 1].moveFrames = CRANE;
shots[shots.length - 1].kind = "crane";
shots.push({ ...center(SETS.closing), scale: 1, rot: 0, start: closing.start + 18, moveFrames: 0, kind: "hold", name: "closing" });

// 落地幀清單(對焦搜尋 / 曝光修正 / 震動 / thud)
const landings = shots.slice(1).map((s) => ({ frame: s.start, name: s.name, dir: 1 }));
const moves = shots.slice(0, -1).map((s, i) => ({ start: shots[i + 1].start - s.moveFrames, end: shots[i + 1].start, kind: s.kind, to: shots[i + 1].name }));
// 場記板:開場(吊臂前)與壓軸(甩鏡前)
const finaleCard = sections[sections.length - 1];
const slates = [
  { at: 0, scene: "01", take: "1", title: "對話式 CAD", subtitle: "SCENE 01 · 總覽 → 草模 → 設計 · 全程真實操作畫面" },
  { at: finaleCard.start - WHIP - SLATE_LEAD, scene: "06", take: "1", title: "史都華平台", subtitle: "SCENE 06 · 壓軸 · 六軸並聯機構,一句話到 14 件" },
];

// 主景長時間停留時的攝影師微調:每 ~6 s 推/拉一點、慢慢重新取景
function holdAdjust(frame: number) {
  const k = Math.floor(frame / 150);
  const p = (frame % 150) / 150;
  const amp = 0.035;
  const s = k % 2 === 0 ? amp * easeInOut(p) : amp * (1 - easeInOut(p));
  const px = noise2D("rx", frame / 260, 0) * 28;
  const py = noise2D("ry", frame / 300, 0) * 18;
  return { s, px, py };
}

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cam0 = cameraAt(shots, frame, fps);
  const camPrev = cameraAt(shots, frame - 1, fps);
  // 停留在主景:疊上微調
  const onApp = !cam0.moving && Math.abs(cam0.x - 960) < 400 && Math.abs(cam0.y - 540) < 400 && frame > APP_ARRIVE;
  const adj = holdAdjust(frame);
  // 章節佈景停留:慢推鏡(鏡頭永遠在動)
  let curIdx = shots.findIndex((_, k) => frame < (shots[k + 1]?.start ?? Infinity));
  if (curIdx < 0) curIdx = shots.length - 1;
  const cur = shots[curIdx];
  const nxt = shots[curIdx + 1];
  const holdLen = nxt ? Math.max(1, nxt.start - cur.moveFrames - cur.start) : 200;
  const holdP = clamp((frame - cur.start) / holdLen, 0, 1);
  const cardPush = !cam0.moving && !onApp && cur.name !== "app" ? 0.05 * easeInOut(holdP) : 0;
  const cam: Cam = onApp
    ? { ...cam0, scale: cam0.scale + adj.s, x: cam0.x + adj.px, y: cam0.y + adj.py }
    : { ...cam0, scale: cam0.scale + cardPush };
  const vx = cam0.x - camPrev.x;

  // C. 落地瑕疵:對焦搜尋(每次落地)、曝光修正(回到主景時,隔次)
  let focusBlur = 0, bright = 1, jolt = 0;
  landings.forEach((l, i) => {
    const t = frame - l.frame;
    if (t < 0 || t > 20) return;
    focusBlur = Math.max(focusBlur, interpolate(t, [0, 6, 14], [0, 4.5, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }));
    if (l.name === "app" && i % 2 === 1) bright = interpolate(t, [0, 6, 16], [1, 1.14, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const d = Math.sign(shots.find((s) => s.start === l.frame)!.x - (shots[shots.findIndex((s) => s.start === l.frame) - 1]?.x ?? 0)) || 1;
    jolt = interpolate(t, [0, 2, 10], [0, 6, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * d;
  });
  const skew = clamp(vx / 60, -1.6, 1.6); // 捲簾快門

  // 主景視窗:內容知道鏡頭在哪(朝移動方向微傾)
  const lean = clamp(-vx / 35, -7, 7);
  const sceneNow = chapters.find((c) => frame >= c.start - WHIP && frame < c.end - WHIP) || null;
  const footageOpacity = interpolate(frame, [APP_ARRIVE - CRANE - 6, APP_ARRIVE - CRANE + 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: "#fff", background: "#07090f" }}>
      <Background intensity={0.8} />
      <Stage cam={cam} extraBlur={focusBlur} brightness={bright} skew={skew} jolt={jolt}>
        <StageTraces />
        {/* 主景:真實 app 錄影 */}
        <Set x={SETS.app.x} y={SETS.app.y} style={{ perspective: 2400 }}>
          <div
            style={{
              width: 1920, height: 1080, borderRadius: 18, overflow: "hidden", transform: `rotateY(${lean}deg)`, transformOrigin: "50% 50%",
              boxShadow: "0 40px 120px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.08)", opacity: footageOpacity, background: "#0b1220",
            }}
          >
            <Sequence from={OPEN_EXTRA} layout="none">
              <OffthreadVideo src={staticFile("footage.mp4")} startFrom={(tl as any).trim || 0} muted style={{ width: 1920, height: 1080 }} />
              {highlights.map((h, i) => (
                <Sequence key={`hl${i}`} from={h.start} durationInFrames={Math.max(1, h.end - h.start + 10)} layout="none">
                  <Highlight h={h} />
                </Sequence>
              ))}
            </Sequence>
          </div>
          {/* 佈景標籤(地板) */}
          <div style={{ position: "absolute", left: 0, top: 1110, fontFamily: MONO, fontSize: 30, letterSpacing: "0.3em", color: "rgba(255,255,255,0.25)" }}>MAIN SET · LIVE APP · 1920×1080</div>
        </Set>
        <Set x={SETS.opening.x} y={SETS.opening.y}><OpeningSet card={opening} /></Set>
        {sections.map((c, i) => (
          <Set key={`s${i}`} x={SETS.cards[i].x} y={SETS.cards[i].y}>
            <Sequence from={c.start - 4} durationInFrames={c.end - c.start + GLIDE + 20} layout="none">
              <SectionSet card={c} finale={i === sections.length - 1} />
            </Sequence>
          </Set>
        ))}
        <Set x={SETS.closing.x} y={SETS.closing.y}>
          <Sequence from={closing.start + 10} durationInFrames={TOTAL - closing.start} layout="none">
            <ClosingSet card={closing} />
          </Sequence>
        </Set>
      </Stage>
      <Vignette />
      <LensDirt />

      {/* 字幕(觀景窗層) */}
      {captions.map((c, i) => (
        <Sequence key={`cap${i}`} from={c.start} durationInFrames={Math.max(1, c.end - c.start + 12)} layout="none">
          <Caption cap={c} />
        </Sequence>
      ))}
      {/* 落地對焦框:章節卡吸標題、主景吸 3D 畫布 */}
      {landings.map((l, i) => (
        <FocusBox key={`fb${i}`} at={l.frame + 2} rect={l.name === "app" ? { x: 520, y: 160, w: 1180, h: 700 } : l.name === "closing" ? { x: 560, y: 380, w: 800, h: 180 } : { x: 600, y: 300, w: 1000, h: 300 }} />
      ))}
      <Viewfinder scene={sceneNow ? { no: sceneNow.no, title: sceneNow.title } : null} />
      {slates.map((s, i) => (
        <Slate key={`sl${i}`} at={s.at} scene={s.scene} take={s.take} title={s.title} subtitle={s.subtitle} />
      ))}
      {/* 結尾黑場 */}
      <AbsoluteFill style={{ background: "#000", opacity: interpolate(frame, [closing.end + 8, closing.end + 36], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) }} />

      {/* SFX:開錄 beep、甩鏡 whoosh(出發前 2 幀)、落地 thud、場記板 clap */}
      <Sequence from={0} durationInFrames={10}><Audio src={staticFile("sfx/beep.wav")} volume={0.5} /></Sequence>
      {moves.map((m, i) => (
        <Sequence key={`wh${i}`} from={Math.max(0, m.start - 2)} durationInFrames={20}>
          <Audio src={staticFile("sfx/whoosh.wav")} volume={m.kind === "whip" ? 0.9 : 0.45} />
        </Sequence>
      ))}
      {landings.map((l, i) => (
        <Sequence key={`th${i}`} from={l.frame} durationInFrames={12}>
          <Audio src={staticFile("sfx/thud.wav")} volume={0.8} />
        </Sequence>
      ))}
      {slates.map((s, i) => (
        <Sequence key={`cl${i}`} from={s.at + 16} durationInFrames={6}>
          <Audio src={staticFile("sfx/clap.wav")} volume={1} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

// ---------- 開場佈景(鏡頭從這裡開始;F 直接對觀眾說話) ----------
const OpeningSet: React.FC<{ card: Card }> = ({ card }) => {
  const frame = useCurrentFrame();
  const out = easeIn((frame - (APP_ARRIVE - CRANE - 4)) / 12);
  return (
    <AbsoluteFill style={{ opacity: 1 - out }}>
      <Particles count={30} opacity={0.9} />
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: 1500, display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
          <Enter delay={34} from={18}>
            <div style={{ fontSize: 22, letterSpacing: "0.42em", color: "#8ab4f8", fontFamily: MONO }}>{card.kicker}</div>
          </Enter>
          <div style={{ fontSize: 118, fontWeight: 800, letterSpacing: "0.04em", textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
            <StaggerText text={card.title} delay={40} step={4} from={60} />
          </div>
          <DrawBar delay={54} width={220} height={6} />
          <div style={{ fontSize: 40, color: "#dbe4f3" }}>
            <StaggerText text={card.sub} delay={62} step={2} from={28} />
          </div>
          <Enter delay={84} from={24}>
            <div style={{ fontSize: 30, color: "#dbe4f3" }}><span style={{ color: ACCENT, marginRight: 14 }}>◆</span>{card.lines[0]}</div>
          </Enter>
          {/* F. 直接對觀眾 */}
          <Enter delay={100} from={26}>
            <div style={{ marginTop: 26, padding: "14px 28px", borderRadius: 12, background: "rgba(255,182,74,0.1)", border: `1px solid ${ACCENT_DIM}`, fontSize: 30, color: ACCENT }}>
              你接下來看到的每一幀,都是這個 app 真正被操作的畫面——鏡頭後面有人。
            </div>
          </Enter>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------- 章節佈景:鏡頭抵達時才開始進場 ----------
const SectionSet: React.FC<{ card: Card; finale: boolean }> = ({ card, finale }) => {
  const frame = useCurrentFrame(); // 0 = card.start - 4
  const t = frame - 4;
  const m = /^0?(\d)\s*·\s*(.*)$/.exec(card.kicker);
  const no = (m?.[1] || "").padStart(2, "0");
  const en = m?.[2] || card.kicker;
  const dur = card.end - card.start;
  const out = easeIn((t - dur) / 14);
  return (
    <AbsoluteFill style={{ opacity: 1 - out * 0.7 }}>
      {/* 佈景本身:一面深色板 + 琥珀邊 */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(135deg, rgba(20,32,56,0.92), rgba(9,14,26,0.96))", borderRadius: 22, boxShadow: "0 40px 120px rgba(0,0,0,0.55), inset 0 0 0 1px rgba(255,255,255,0.07)" }} />
      {finale && <Particles count={40} opacity={0.95} />}
      <div style={{ position: "absolute", left: 150, top: 150 }}>
        <DrawNumber text={no} delay={4} size={finale ? 460 : 400} />
      </div>
      <div style={{ position: "absolute", left: 640, top: 300, width: 1150, display: "flex", flexDirection: "column", gap: 20 }}>
        <Enter delay={4 + 4} from={18}><div style={{ fontSize: 22, letterSpacing: "0.4em", color: "#8ab4f8", fontFamily: MONO }}>{en}</div></Enter>
        <div style={{ fontSize: finale ? 112 : 96, fontWeight: 800, lineHeight: 1.1, textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
          <StaggerText text={card.title} delay={4 + 8} step={4} from={54} />
        </div>
        <DrawBar delay={4 + 16} width={160} height={6} />
        <div style={{ fontSize: 38, color: "#dbe4f3" }}><StaggerText text={card.sub} delay={4 + 22} step={2} from={26} /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
          {card.lines.map((l, i) => (
            <Enter key={i} delay={4 + 36 + i * 6} from={26}>
              <div style={{ fontSize: 30, color: "#dbe4f3", lineHeight: 1.5 }}><span style={{ color: ACCENT, marginRight: 14, fontSize: 20 }}>◆</span>{l}</div>
            </Enter>
          ))}
        </div>
      </div>
      {finale && <FinaleGlyph />}
      <div style={{ position: "absolute", left: 0, top: 1110, fontFamily: MONO, fontSize: 30, letterSpacing: "0.3em", color: "rgba(255,255,255,0.25)" }}>SET {no} · {en}</div>
    </AbsoluteFill>
  );
};

const FinaleGlyph: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const base = [[-260, 80], [-130, 80], [130, 80], [260, 80], [60, 180], [-60, 180]];
  const top = [[-120, -140], [-40, -140], [40, -140], [120, -140], [100, -90], [-100, -90]];
  const pairs = [[0, 5], [1, 0], [2, 3], [3, 4], [4, 2], [5, 1]];
  const cfg = { mass: 1, damping: 20, stiffness: 100 };
  return (
    <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
      <g transform="translate(1560 760)" fill="none" stroke={ACCENT} strokeWidth={3} strokeLinecap="round">
        <ellipse cx={0} cy={110} rx={300} ry={80} strokeDasharray={1300} strokeDashoffset={1300 * (1 - spring({ frame: frame - 14, fps, config: cfg, durationInFrames: 40 }))} opacity={0.8} />
        <ellipse cx={0} cy={-150} rx={190} ry={50} strokeDasharray={900} strokeDashoffset={900 * (1 - spring({ frame: frame - 28, fps, config: cfg, durationInFrames: 40 }))} />
        {pairs.map(([b, t], i) => {
          const p = spring({ frame: frame - 34 - i * 4, fps, config: cfg, durationInFrames: 36 });
          const [x1, y1] = base[b], [x2, y2] = top[t];
          return <line key={i} x1={x1} y1={y1 + 30} x2={x1 + (x2 - x1) * p} y2={y1 + 30 + (y2 - 10 - y1 - 30) * p} strokeWidth={5} />;
        })}
      </g>
    </svg>
  );
};

// ---------- 結尾佈景(F 直接對觀眾) ----------
const ClosingSet: React.FC<{ card: Card }> = ({ card }) => (
  <AbsoluteFill>
    <Particles count={30} opacity={0.8} />
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center" }}>
      <div style={{ width: 1500, display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
        <Enter delay={10} from={18}><div style={{ fontSize: 22, letterSpacing: "0.42em", color: "#8ab4f8", fontFamily: MONO }}>{card.kicker}</div></Enter>
        <div style={{ fontSize: 104, fontWeight: 800, letterSpacing: "0.04em" }}><StaggerText text={card.title} delay={14} step={4} from={54} /></div>
        <DrawBar delay={26} width={220} />
        <div style={{ fontSize: 38, color: "#dbe4f3" }}><StaggerText text={card.sub} delay={32} step={2} from={26} /></div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14, alignItems: "flex-start" }}>
          {card.lines.map((l, i) => (
            <Enter key={i} delay={50 + i * 7} from={28}>
              <div style={{ fontSize: 30, color: "#dbe4f3", lineHeight: 1.6 }}><span style={{ color: ACCENT, marginRight: 14, fontSize: 20 }}>◆</span>{l.replace("⇪", "→")}</div>
            </Enter>
          ))}
        </div>
        <Enter delay={88} from={26}>
          <div style={{ marginTop: 26, padding: "14px 28px", borderRadius: 12, background: "rgba(255,182,74,0.1)", border: `1px solid ${ACCENT_DIM}`, fontSize: 30, color: ACCENT }}>
            鏡頭後面是一個人在操作——就像你坐下來用它一樣。這支片到這裡,換你了。
          </div>
        </Enter>
      </div>
    </AbsoluteFill>
  </AbsoluteFill>
);

// ---------- 字幕(觀景窗層):底部彈入、逐段 stagger、關鍵詞琥珀 ----------
const Caption: React.FC<{ cap: Cap }> = ({ cap }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const len = cap.end - cap.start;
  const parts = parseCaption(cap.html);
  const s = spring({ frame: frame - 2, fps, config: { mass: 0.6, damping: 14, stiffness: 200 } });
  const out = easeIn((frame - len) / 9);
  const y = 44 * (1 - s) + out * 26;
  const op = interpolate(frame, [0, 8], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * (1 - out);
  let k = 0;
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", pointerEvents: "none" }}>
      <div
        style={{
          marginBottom: 150, maxWidth: 1240, padding: "14px 30px 14px 24px", borderRadius: 14,
          background: "rgba(11,18,32,0.86)", boxShadow: "0 12px 40px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08)",
          borderLeft: `6px solid ${ACCENT}`, fontSize: 30, lineHeight: 1.4, letterSpacing: "0.02em", textAlign: "left",
          transform: `translateY(${y}px)`, opacity: op,
        }}
      >
        {parts.map((p, i) =>
          chunkTextForCaption(p.text).map((c, j) => {
            const d = 2 + k++ * 1.2;
            return (
              <Enter key={`${i}-${j}`} delay={d} from={14} style={{ display: "inline-block", whiteSpace: "pre" }}>
                <span style={p.bold ? { color: ACCENT, fontWeight: 700 } : undefined}>{c}</span>
              </Enter>
            );
          }),
        )}
      </div>
    </AbsoluteFill>
  );
};

function chunkTextForCaption(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9°×Ø±./+\-→↔⟲✓▶⇪①②③]+|[一-鿿]{1,3}|\s+|./gu;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (out.length && (/^[,,.。、;;::)」』)]/.test(s) || /^\s+$/.test(s))) out[out.length - 1] += s;
    else out.push(s);
  }
  return out;
}

// ---------- 框選標示(主景內,世界座標) ----------
const Highlight: React.FC<{ h: Hl }> = ({ h }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!h.rect) return null;
  const len = h.end - h.start;
  const s = spring({ frame, fps, config: { mass: 0.6, damping: 14, stiffness: 200 } });
  const out = easeIn((frame - len) / 8);
  const sc = 0.94 + 0.06 * s;
  const op = interpolate(frame, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * (1 - out);
  const r = h.rect;
  const pulse = 0.5 + 0.5 * Math.sin(frame / 6);
  return (
    <div style={{ position: "absolute", left: r.x - 6, top: r.y - 6, width: r.w + 12, height: r.h + 12, border: `4px solid ${ACCENT}`, borderRadius: 12, opacity: op, transform: `scale(${sc})`, boxShadow: `0 0 0 ${4 + pulse * 6}px ${ACCENT_DIM}, 0 0 40px rgba(255,182,74,0.35)` }}>
      <Enter delay={3} from={-16} axis="x" style={{ position: "absolute", left: -4, top: -48 }}>
        <div style={{ background: ACCENT, color: "#1a1a1a", fontSize: 24, fontWeight: 700, padding: "5px 14px", borderRadius: 8, whiteSpace: "nowrap" }}>{h.label}</div>
      </Enter>
    </div>
  );
};
