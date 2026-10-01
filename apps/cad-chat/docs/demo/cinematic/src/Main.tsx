import React from "react";
import { AbsoluteFill, OffthreadVideo, Sequence, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from "remotion";
import tl from "./timeline.json";
import {
  ACCENT, ACCENT_DIM, Background, DrawBar, DrawNumber, Enter, FONT, MONO, Particles, StaggerText, cameraScale, clamp, easeIn, easeInOut, easeOut, parseCaption, useExit,
} from "./primitives";

type Card = { start: number; end: number; kicker: string; title: string; sub: string; lines: string[] };
type Cap = { start: number; end: number; html: string };
type Hl = { start: number; end: number; label: string; rect: { x: number; y: number; w: number; h: number } | null };
type Chapter = { no: string; title: string; start: number; end: number };

const cards = tl.cards as Card[];
const captions = tl.captions as Cap[];
const highlights = tl.highlights as Hl[];
const chapters = tl.chapters as Chapter[];
const TOTAL = tl.total as number;
const opening = cards[0];
const closing = cards[cards.length - 1];
const sections = cards.slice(1, -1);
const CARD_IN = 12; // 卡進場:錄影退焦所需幀
const CARD_OUT = 14; // 卡退場:錄影回焦
const BASE = 0.955; // 錄影視窗基礎比例(留出深色背景層,三層有縱深)

// ---------- 鏡頭:每 ~6 s 交替推/拉;章節卡期間另有退焦放大 ----------
const SEG = 150;
function cameraAt(frame: number) {
  // 以開場結束為零點切段
  const f0 = opening.end + 16;
  if (frame < f0) return BASE;
  const k = Math.floor((frame - f0) / SEG);
  const p = ((frame - f0) % SEG) / SEG;
  const amp = 0.04;
  // 偶數段推(BASE→BASE+amp),奇數段拉(BASE+amp→BASE),段間連續
  return k % 2 === 0 ? BASE + amp * easeInOut(p) : BASE + amp * (1 - easeInOut(p));
}

// 章節卡/開場/結尾對錄影層的影響:blur、dim、scale
function focusAt(frame: number) {
  let blur = 0, dim = 0, extra = 0, hide = 0;
  for (const c of cards) {
    const isEdge = c === opening || c === closing;
    const inP = clamp((frame - c.start) / CARD_IN, 0, 1);
    const outP = clamp((frame - c.end) / CARD_OUT, 0, 1);
    const on = easeOut(inP) * (1 - easeInOut(outP));
    if (on <= 0) continue;
    blur = Math.max(blur, on * 16);
    dim = Math.max(dim, on * 0.62);
    extra = Math.max(extra, on * 0.06);
    if (isEdge) hide = Math.max(hide, on);
  }
  return { blur, dim, extra, hide };
}

export const Main: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const cam = cameraAt(frame);
  const focus = focusAt(frame);
  // 開場 wipe 揭露:開場卡結束 → 琥珀面板擴張再收縮到右下 chip 位置,錄影由 1.08 縮到 cam
  const revealP = clamp((frame - opening.end) / 18, 0, 1);
  const footageScale = (cam + focus.extra) * (frame < opening.end ? 1.08 : interpolate(easeOut(revealP), [0, 1], [1.08, 1]));
  const footageOpacity = frame < opening.end - 6 ? 0 : interpolate(frame, [opening.end - 6, opening.end + 10], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const endFade = interpolate(frame, [closing.start - 2, closing.start + CARD_IN], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  return (
    <AbsoluteFill style={{ fontFamily: FONT, color: "#fff", background: "#0b1220" }}>
      {/* 背景層(慢) */}
      <Background intensity={0.9} />

      {/* 中景:真實 app 錄影,圓角視窗 + 陰影,鏡頭推拉 + 退焦 */}
      <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", opacity: footageOpacity * (1 - (frame > closing.start ? 1 - endFade : 0)) }}>
        <div
          style={{
            width: 1920, height: 1080, borderRadius: 16, overflow: "hidden",
            transform: `scale(${footageScale})`, transformOrigin: "60% 48%",
            boxShadow: "0 30px 90px rgba(0,0,0,0.55), 0 0 0 1px rgba(255,255,255,0.06)",
            filter: focus.blur > 0.2 ? `blur(${focus.blur}px)` : undefined,
          }}
        >
          <OffthreadVideo src={staticFile("footage.mp4")} startFrom={(tl as any).trim || 0} muted style={{ width: 1920, height: 1080 }} />
          <AbsoluteFill style={{ background: "#0b1220", opacity: focus.dim }} />
        </div>
      </AbsoluteFill>

      {/* 前景:框選、字幕、章節 chip、進度條、卡片 */}
      {highlights.map((h, i) => (
        <Sequence key={`hl${i}`} from={h.start} durationInFrames={Math.max(1, h.end - h.start + 10)} layout="none">
          <Highlight h={h} />
        </Sequence>
      ))}
      {captions.map((c, i) => (
        <Sequence key={`cap${i}`} from={c.start} durationInFrames={Math.max(1, c.end - c.start + 12)} layout="none">
          <Caption cap={c} />
        </Sequence>
      ))}
      {chapters.map((ch, i) => (
        <Sequence key={`ch${i}`} from={ch.start} durationInFrames={Math.max(1, ch.end - ch.start)} layout="none">
          <ChapterChip ch={ch} />
        </Sequence>
      ))}
      <ProgressBar />

      {sections.map((c, i) => (
        <Sequence key={`card${i}`} from={c.start} durationInFrames={c.end - c.start + CARD_OUT + 2} layout="none">
          <SectionCard card={c} finale={i === sections.length - 1} />
        </Sequence>
      ))}
      <Sequence from={0} durationInFrames={opening.end + 24} layout="none">
        <Opening card={opening} />
      </Sequence>
      <Sequence from={closing.start} durationInFrames={TOTAL - closing.start} layout="none">
        <Closing card={closing} />
      </Sequence>
    </AbsoluteFill>
  );
};

// ---------- 開場:三層 + 逐字 spring + 琥珀線 draw-on → 面板 wipe 揭開 UI ----------
const Opening: React.FC<{ card: Card }> = ({ card }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const dur = card.end - card.start;
  const push = cameraScale(frame, 0, dur, 1, 1.06);
  const out = easeIn((frame - (dur - 10)) / 10); // 文字先退
  // wipe 面板:dur-8 起從琥珀線位置長成全幕,dur+6 起收到右下 chip
  const grow = easeInOut((frame - (dur - 8)) / 14);
  const shrink = easeInOut((frame - (dur + 6)) / 16);
  const planeW = interpolate(grow, [0, 1], [180, 2400]);
  const planeH = interpolate(grow, [0, 1], [6, 2400]);
  const planeX = interpolate(shrink, [0, 1], [0, 1920 - 230]);
  const planeY = interpolate(shrink, [0, 1], [0, 1080 - 56]);
  const planeS = 1 - shrink * 0.985;
  return (
    <AbsoluteFill>
      <AbsoluteFill style={{ opacity: 1 - shrink }}>
        <Particles count={34} opacity={0.9} />
      </AbsoluteFill>
      <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: "50% 50%", justifyContent: "center", alignItems: "center", opacity: 1 - out }}>
        <div style={{ width: 1400, display: "flex", flexDirection: "column", alignItems: "center", gap: 22 }}>
          <Enter delay={0} from={18}>
            <div style={{ fontSize: 22, letterSpacing: "0.42em", color: "#8ab4f8", fontFamily: MONO }}>{card.kicker}</div>
          </Enter>
          <div style={{ fontSize: 118, fontWeight: 800, letterSpacing: "0.04em", textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
            <StaggerText text={card.title} delay={6} step={4} from={60} />
          </div>
          <div style={{ marginTop: 6 }}>
            <DrawBar delay={18} width={220} height={6} />
          </div>
          <div style={{ fontSize: 40, color: "#dbe4f3" }}>
            <StaggerText text={card.sub} delay={26} step={2} from={28} />
          </div>
          {card.lines.map((l, i) => (
            <Enter key={i} delay={44 + i * 5} from={24}>
              <div style={{ fontSize: 30, color: "#dbe4f3" }}>
                <span style={{ color: ACCENT, marginRight: 14 }}>◆</span>{l}
              </div>
            </Enter>
          ))}
        </div>
      </AbsoluteFill>
      {/* wipe 面板(延續元素:線 → 面 → 右下章節 chip) */}
      {frame >= dur - 8 && shrink < 1 && (
        <div
          style={{
            position: "absolute", left: 960, top: 478, width: planeW, height: planeH, background: ACCENT, borderRadius: 10,
            transform: `translate(-50%, -50%) translate(${planeX}px, ${planeY}px) scale(${planeS})`, transformOrigin: "50% 50%",
            boxShadow: "0 0 80px rgba(255,182,74,0.45)",
          }}
        />
      )}
    </AbsoluteFill>
  );
};

// ---------- 章節卡:大號描邊數字 + 標題 spring + 行 stagger;錄影退焦在後 ----------
const SectionCard: React.FC<{ card: Card; finale: boolean }> = ({ card, finale }) => {
  const frame = useCurrentFrame();
  const dur = card.end - card.start;
  const m = /^0?(\d)\s*·\s*(.*)$/.exec(card.kicker);
  const no = (m?.[1] || "").padStart(2, "0");
  const en = m?.[2] || card.kicker;
  const out = easeIn((frame - dur) / CARD_OUT);
  const push = cameraScale(frame, 0, dur, 1, 1.05);
  return (
    <AbsoluteFill style={{ opacity: 1 - out, transform: `translateY(${-out * 60}px)` }}>
      {finale && <Particles count={40} opacity={0.95} />}
      <AbsoluteFill style={{ transform: `scale(${push})`, transformOrigin: "40% 50%" }}>
        <div style={{ position: "absolute", left: 150, top: 150 }}>
          <DrawNumber text={no} delay={0} size={finale ? 460 : 400} />
        </div>
        <div style={{ position: "absolute", left: 640, top: 300, width: 1150, display: "flex", flexDirection: "column", gap: 20 }}>
          <Enter delay={4} from={18}>
            <div style={{ fontSize: 22, letterSpacing: "0.4em", color: "#8ab4f8", fontFamily: MONO }}>{en}</div>
          </Enter>
          <div style={{ fontSize: finale ? 112 : 96, fontWeight: 800, lineHeight: 1.1, textShadow: "0 10px 40px rgba(0,0,0,0.5)" }}>
            <StaggerText text={card.title} delay={8} step={4} from={54} />
          </div>
          <DrawBar delay={16} width={160} height={6} />
          <div style={{ fontSize: 38, color: "#dbe4f3" }}>
            <StaggerText text={card.sub} delay={22} step={2} from={26} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 8 }}>
            {card.lines.map((l, i) => (
              <Enter key={i} delay={36 + i * 6} from={26}>
                <div style={{ fontSize: 30, color: "#dbe4f3", lineHeight: 1.5 }}>
                  <span style={{ color: ACCENT, marginRight: 14, fontSize: 20 }}>◆</span>{l}
                </div>
              </Enter>
            ))}
          </div>
        </div>
        {finale && <FinaleGlyph />}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** 壓軸卡右側:六條線描邊成平台圖形(draw-on) */
const FinaleGlyph: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const base = [[-260, 80], [-130, 80], [130, 80], [260, 80], [60, 180], [-60, 180]];
  const top = [[-120, -140], [-40, -140], [40, -140], [120, -140], [100, -90], [-100, -90]];
  const pairs = [[0, 5], [1, 0], [2, 3], [3, 4], [4, 2], [5, 1]];
  return (
    <svg width="1920" height="1080" style={{ position: "absolute", inset: 0 }}>
      <g transform="translate(1560 760)" fill="none" stroke={ACCENT} strokeWidth={3} strokeLinecap="round">
        <ellipse cx={0} cy={110} rx={300} ry={80} strokeDasharray={1300} strokeDashoffset={1300 * (1 - spring({ frame: frame - 10, fps, config: { mass: 1, damping: 20, stiffness: 100 }, durationInFrames: 40 }))} opacity={0.8} />
        <ellipse cx={0} cy={-150} rx={190} ry={50} strokeDasharray={900} strokeDashoffset={900 * (1 - spring({ frame: frame - 24, fps, config: { mass: 1, damping: 20, stiffness: 100 }, durationInFrames: 40 }))} />
        {pairs.map(([b, t], i) => {
          const p = spring({ frame: frame - 30 - i * 4, fps, config: { mass: 1, damping: 20, stiffness: 100 }, durationInFrames: 36 });
          const [x1, y1] = base[b], [x2, y2] = top[t];
          return <line key={i} x1={x1} y1={y1 + 30} x2={x1 + (x2 - x1) * p} y2={y1 + 30 + (y2 - 10 - y1 - 30) * p} strokeWidth={5} />;
        })}
      </g>
    </svg>
  );
};

// ---------- 結尾 ----------
const Closing: React.FC<{ card: Card }> = ({ card }) => {
  const frame = useCurrentFrame();
  const dur = card.end - card.start;
  const push = cameraScale(frame, 0, dur + 40, 1, 1.07);
  const fade = interpolate(frame, [dur + 10, dur + 36], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ opacity: fade }}>
      <Particles count={30} opacity={0.8} />
      <AbsoluteFill style={{ transform: `scale(${push})`, justifyContent: "center", alignItems: "center" }}>
        <div style={{ width: 1500, display: "flex", flexDirection: "column", alignItems: "center", gap: 20 }}>
          <Enter delay={CARD_IN} from={18}>
            <div style={{ fontSize: 22, letterSpacing: "0.42em", color: "#8ab4f8", fontFamily: MONO }}>{card.kicker}</div>
          </Enter>
          <div style={{ fontSize: 104, fontWeight: 800, letterSpacing: "0.04em" }}>
            <StaggerText text={card.title} delay={CARD_IN + 4} step={4} from={54} />
          </div>
          <DrawBar delay={CARD_IN + 16} width={220} />
          <div style={{ fontSize: 38, color: "#dbe4f3" }}>
            <StaggerText text={card.sub} delay={CARD_IN + 22} step={2} from={26} />
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, marginTop: 14, alignItems: "flex-start" }}>
            {card.lines.map((l, i) => (
              <Enter key={i} delay={CARD_IN + 40 + i * 7} from={28}>
                <div style={{ fontSize: 30, color: "#dbe4f3", lineHeight: 1.6 }}>
                  <span style={{ color: ACCENT, marginRight: 14, fontSize: 20 }}>◆</span>{l}
                </div>
              </Enter>
            ))}
          </div>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

// ---------- 字幕(lower-third):底部彈入、逐段 stagger、關鍵詞琥珀;退場 ease-in 較快 ----------
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
          marginBottom: 176, maxWidth: 1240, padding: "14px 30px 14px 24px", borderRadius: 14,
          background: "rgba(11,18,32,0.86)", boxShadow: "0 12px 40px rgba(0,0,0,0.35), inset 0 0 0 1px rgba(255,255,255,0.08)",
          borderLeft: `6px solid ${ACCENT}`, fontSize: 30, lineHeight: 1.4, letterSpacing: "0.02em", textAlign: "left",
          transform: `translateY(${y}px)`, opacity: op, backdropFilter: "blur(6px)",
        }}
      >
        {parts.map((p, i) => {
          const chunks = chunkTextForCaption(p.text);
          return chunks.map((c, j) => {
            const d = 2 + k++ * 1.2;
            return (
              <Enter key={`${i}-${j}`} delay={d} from={14} style={{ display: "inline-block", whiteSpace: "pre" }}>
                <span style={p.bold ? { color: ACCENT, fontWeight: 700 } : undefined}>{c}</span>
              </Enter>
            );
          });
        })}
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

// ---------- 框選標示 ----------
const Highlight: React.FC<{ h: Hl }> = ({ h }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  if (!h.rect) return null;
  const len = h.end - h.start;
  const s = spring({ frame, fps, config: { mass: 0.6, damping: 14, stiffness: 200 } });
  const out = easeIn((frame - len) / 8);
  const sc = 0.94 + 0.06 * s;
  const op = interpolate(frame, [0, 6], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * (1 - out);
  // 錄影視窗以 (60%,48%) 為原點縮放;框選座標要跟著同一個變換
  const cam = cameraAt(h.start + frame) + focusAt(h.start + frame).extra;
  const ox = 1920 * 0.6, oy = 1080 * 0.48;
  const tx = (v: number) => ox + (v - ox) * cam;
  const ty = (v: number) => oy + (v - oy) * cam;
  const r = h.rect;
  const pulse = 0.5 + 0.5 * Math.sin(frame / 6);
  return (
    <div
      style={{
        position: "absolute", left: tx(r.x) - 6, top: ty(r.y) - 6, width: r.w * cam + 12, height: r.h * cam + 12,
        border: `4px solid ${ACCENT}`, borderRadius: 12, opacity: op, transform: `scale(${sc})`,
        boxShadow: `0 0 0 ${4 + pulse * 6}px ${ACCENT_DIM}, 0 0 40px rgba(255,182,74,0.35)`,
      }}
    >
      <Enter delay={3} from={-16} axis="x" style={{ position: "absolute", left: -4, top: -48 }}>
        <div style={{ background: ACCENT, color: "#1a1a1a", fontSize: 24, fontWeight: 700, padding: "5px 14px", borderRadius: 8, whiteSpace: "nowrap" }}>{h.label}</div>
      </Enter>
    </div>
  );
};

// ---------- 章節 chip(右下,跨幕延續)+ 脈動點 ----------
const ChapterChip: React.FC<{ ch: Chapter }> = ({ ch }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const len = ch.end - ch.start;
  const s = spring({ frame: frame - (CARD_IN), fps, config: { mass: 0.6, damping: 14, stiffness: 200 } });
  const out = easeIn((frame - (len - 6)) / 6);
  const pulse = 0.55 + 0.45 * Math.sin(frame / 9);
  return (
    <div
      style={{
        position: "absolute", right: 26, bottom: 18, display: "flex", alignItems: "center", gap: 12, padding: "8px 16px 8px 12px",
        background: "rgba(11,18,32,0.88)", borderRadius: 999, boxShadow: "inset 0 0 0 1px rgba(255,255,255,0.1), 0 8px 24px rgba(0,0,0,0.35)",
        transform: `translateX(${(1 - s) * 80 + out * 60}px)`, opacity: Math.min(1, s * 1.3) * (1 - out),
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 5, background: ACCENT, boxShadow: `0 0 ${6 + pulse * 10}px ${ACCENT}`, opacity: 0.7 + pulse * 0.3 }} />
      <span style={{ fontFamily: MONO, color: ACCENT, fontSize: 20, fontWeight: 700 }}>{ch.no}</span>
      <span style={{ fontSize: 20, color: "#eef2f8" }}>{ch.title}</span>
    </div>
  );
};

// ---------- 進度條(全片次要動態) ----------
const ProgressBar: React.FC = () => {
  const frame = useCurrentFrame();
  const p = frame / TOTAL;
  return (
    <>
      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, height: 5, background: "rgba(255,255,255,0.08)" }} />
      <div style={{ position: "absolute", left: 0, bottom: 0, height: 5, width: `${p * 100}%`, background: ACCENT, boxShadow: `0 0 12px ${ACCENT}` }} />
    </>
  );
};
