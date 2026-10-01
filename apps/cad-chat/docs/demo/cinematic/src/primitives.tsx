import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig, Easing } from "remotion";

// ---- 動態詞彙(全片共用同一組 easing 家族:Product launch = crisp/smooth 小過衝) ----
export const SPRINGS = {
  crisp: { mass: 0.6, damping: 14, stiffness: 200 },
  smooth: { mass: 1, damping: 20, stiffness: 100 },
  heavy: { mass: 2, damping: 25, stiffness: 80 },
};
export const ACCENT = "#FFB64A";
export const ACCENT_DIM = "rgba(255,182,74,0.22)";
export const INK = "#0b1220";
export const FONT = '"WenQuanYi Zen Hei", "Noto Sans TC", "PingFang TC", "Microsoft JhengHei", sans-serif';
export const MONO = '"DejaVu Sans Mono", "WenQuanYi Zen Hei Mono", monospace';

export const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
export const easeOut = (t: number) => 1 - Math.pow(1 - clamp(t, 0, 1), 2.2);
export const easeIn = (t: number) => Math.pow(clamp(t, 0, 1), 2);
export const easeInOut = (t: number) => Easing.inOut(Easing.cubic)(clamp(t, 0, 1));

/** 進場:3 幀預備動作(先微沉)→ spring 上浮帶過衝;可指定方向。 */
export const Enter: React.FC<{
  delay?: number;
  from?: number; // 位移起點(px)
  axis?: "x" | "y";
  config?: keyof typeof SPRINGS;
  style?: React.CSSProperties;
  children: React.ReactNode;
}> = ({ delay = 0, from = 40, axis = "y", config = "crisp", style, children }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - delay;
  const anticipation = interpolate(t, [0, 3], [0, from * 0.18], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const s = spring({ frame: t - 3, fps, config: SPRINGS[config] });
  const d = anticipation + from * (1 - s);
  const opacity = interpolate(t, [2, 11], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const transform = axis === "y" ? `translateY(${d}px)` : `translateX(${d}px)`;
  return <div style={{ transform, opacity, willChange: "transform", ...style }}>{children}</div>;
};

/** 退場係數:endFrame 起 dur 幀內 ease-in 退場(比進場快)。回 {p: 0→1} */
export const useExit = (endFrame: number, dur = 10) => {
  const frame = useCurrentFrame();
  return easeIn((frame - endFrame) / dur);
};

/** 文字逐段 stagger(中文以 2 字為一段,標點附著前段)。 */
export const StaggerText: React.FC<{ text: string; delay?: number; step?: number; from?: number; style?: React.CSSProperties; accent?: string[] }> = ({
  text, delay = 0, step = 2, from = 26, style, accent = [],
}) => {
  const chunks = chunkText(text);
  return (
    <span style={{ display: "inline-block", ...style }}>
      {chunks.map((c, i) => (
        <Enter key={i} delay={delay + i * step} from={from} style={{ display: "inline-block", whiteSpace: "pre" }}>
          <span style={accent.some((a) => a && c.includes(a)) ? { color: ACCENT } : undefined}>{c}</span>
        </Enter>
      ))}
    </span>
  );
};

export function chunkText(text: string): string[] {
  const out: string[] = [];
  const re = /[A-Za-z0-9°×Ø±./+\-]+|[一-鿿]{1,2}|\s+|./gu;
  for (const m of text.matchAll(re)) {
    const s = m[0];
    if (/^[,,.。、;;::)」』)]/.test(s) && out.length) out[out.length - 1] += s;
    else if (/^\s+$/.test(s) && out.length) out[out.length - 1] += s;
    else out.push(s);
  }
  return out;
}

/** 字幕 html(含 <b>)→ 片段:{text, bold} */
export function parseCaption(html: string): { text: string; bold: boolean }[] {
  const parts: { text: string; bold: boolean }[] = [];
  const re = /<b>(.*?)<\/b>|([^<]+)/g;
  for (const m of html.matchAll(re)) {
    if (m[1] != null) parts.push({ text: m[1], bold: true });
    else if (m[2]) parts.push({ text: m[2], bold: false });
  }
  return parts;
}

/** 大號數字描邊 draw-on:先描邊由左至右掃出,再填色淡入。 */
export const DrawNumber: React.FC<{ text: string; delay?: number; size?: number }> = ({ text, delay = 0, size = 440 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - delay;
  const reveal = spring({ frame: t, fps, config: SPRINGS.smooth, durationInFrames: 34 });
  const fill = interpolate(t, [18, 40], [0, 0.16], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <div style={{ position: "relative", fontFamily: MONO, fontWeight: 800, fontSize: size, lineHeight: 0.9, letterSpacing: "-0.04em" }}>
      <div style={{ WebkitTextStroke: `3px ${ACCENT}`, color: "transparent", clipPath: `inset(0 ${100 - reveal * 100}% 0 0)` }}>{text}</div>
      <div style={{ position: "absolute", inset: 0, color: ACCENT, opacity: fill }}>{text}</div>
    </div>
  );
};

/** 水平線 draw-on */
export const DrawBar: React.FC<{ delay?: number; width?: number; height?: number; color?: string }> = ({ delay = 0, width = 180, height = 6, color = ACCENT }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const p = spring({ frame: frame - delay, fps, config: SPRINGS.smooth, durationInFrames: 30 });
  return <div style={{ width: width * p, height, background: color, borderRadius: height }} />;
};

/** 背景:深色漸層慢漂移 + 顆粒 + 六角環慢轉(前景速度的 ~10%) */
export const Background: React.FC<{ intensity?: number }> = ({ intensity = 1 }) => {
  const frame = useCurrentFrame();
  const drift = frame * 0.12;
  const rot = frame * 0.06;
  return (
    <AbsoluteFill style={{ background: INK, overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          background: `radial-gradient(1100px 700px at ${28 + Math.sin(frame / 900) * 6}% ${22 + Math.cos(frame / 700) * 5}%, #233b5c 0%, #101b30 55%, ${INK} 100%)`,
          transform: `translateX(${-drift * 0.3}px)`,
        }}
      />
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0, opacity: 0.18 * intensity }}>
        <g transform={`translate(1500 540) rotate(${rot})`}>
          {[520, 400, 280].map((r, i) => (
            <polygon key={i} points={hexPoints(r)} fill="none" stroke={i === 1 ? ACCENT : "#8ab4f8"} strokeWidth={i === 1 ? 2 : 1.2} strokeDasharray={i === 2 ? "14 10" : undefined} />
          ))}
        </g>
        <g transform={`translate(${-80 + drift * 0.15} 900) rotate(${-rot * 0.7})`}>
          <polygon points={hexPoints(260)} fill="none" stroke="#8ab4f8" strokeWidth={1} />
        </g>
      </svg>
      <Grain opacity={0.07 * intensity} />
    </AbsoluteFill>
  );
};

export function hexPoints(r: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i + Math.PI / 6;
    return `${(r * Math.cos(a)).toFixed(1)},${(r * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
}

export const Grain: React.FC<{ opacity?: number }> = ({ opacity = 0.08 }) => {
  const frame = useCurrentFrame();
  const seed = frame % 37;
  return (
    <svg width="1920" height="1080" style={{ position: "absolute", inset: 0, opacity, mixBlendMode: "overlay" }}>
      <filter id={`grain${seed}`}>
        <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed={seed} stitchTiles="stitch" />
        <feColorMatrix type="saturate" values="0" />
      </filter>
      <rect width="1920" height="1080" filter={`url(#grain${seed})`} />
    </svg>
  );
};

/** 次要動態:漂浮粒子 */
export const Particles: React.FC<{ count?: number; opacity?: number }> = ({ count = 28, opacity = 1 }) => {
  const frame = useCurrentFrame();
  return (
    <svg width="1920" height="1080" style={{ position: "absolute", inset: 0, opacity }}>
      {Array.from({ length: count }).map((_, i) => {
        const seed = ((i * 9301 + 49297) % 233280) / 233280;
        const x = (seed * 1920 + frame * (0.15 + seed * 0.5)) % 1920;
        const y = (seed * 7 * 1080 + Math.sin((frame + i * 10) / 40) * 14) % 1080;
        return <circle key={i} cx={x} cy={y} r={1 + seed * 2.2} opacity={0.12 + seed * 0.3} fill={i % 5 === 0 ? ACCENT : "#dbe4f3"} />;
      })}
    </svg>
  );
};

/** 推鏡/拉鏡:在 [start,end] 幀內由 from → to(ease-out) */
export const cameraScale = (frame: number, start: number, end: number, from: number, to: number) =>
  interpolate(frame, [start, end], [from, to], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (t) => easeInOut(t) });
