import React from "react";
import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { noise2D } from "@remotion/noise";
import { ACCENT, MONO, clamp, easeInOut } from "./primitives";

// ---------- 一個攝影棚、一台被操作的攝影機 ----------
export type Shot = { x: number; y: number; scale: number; rot: number; start: number; moveFrames: number; kind: "whip" | "glide" | "crane" | "hold" };
export type Cam = { x: number; y: number; scale: number; rot: number; velocity: number; moving: boolean; landing: number | null; dir: number };

const CAM_CFG = { mass: 1, damping: 14, stiffness: 160 }; // damping 12–16 = 攝影師過衝

/** 純函數:給 frame 回鏡頭狀態(可對 frame-1 再算一次取速度)。 */
export function cameraAt(shots: Shot[], frame: number, fps: number): Cam {
  let i = shots.findIndex((_, k) => frame < (shots[k + 1]?.start ?? Infinity));
  if (i < 0) i = shots.length - 1;
  const from = shots[i];
  const to = shots[i + 1] ?? shots[i];
  const same = to === from;
  const moveStart = to.start - from.moveFrames;
  const t = frame - moveStart;
  const sp = (f: number) => (same ? 0 : spring({ frame: f, fps, durationInFrames: from.moveFrames, config: CAM_CFG }));
  const p = sp(t);
  const pPrev = sp(t - 1);
  const dirX = Math.sign(to.x - from.x) || 1;
  const isWhip = from.kind === "whip" || from.moveFrames <= 16;
  // 預備動作:甩鏡前 3 幀先反向帶一下
  const antic = isWhip && t > -3 && t < 0 ? (t + 3) * -7 : 0;
  const lerp = (a: number, b: number) => a + (b - a) * p;
  const arc = from.kind === "glide" || from.kind === "crane" ? Math.sin(p * Math.PI) * 50 : 0;
  const x = lerp(from.x, to.x) + antic * dirX;
  const y = lerp(from.y, to.y) + arc;
  const scale = lerp(from.scale, to.scale);
  const rot = lerp(from.rot, to.rot) + (isWhip ? Math.sin(p * Math.PI) * 3 * dirX : 0);
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const velocity = same ? 0 : dist * Math.abs(p - pPrev);
  const moving = !same && t >= 0 && p < 0.985;
  // 落地幀:下一個 shot 的 start(鏡頭抵達)
  const landing = !same && frame >= to.start && frame < to.start + 20 ? to.start : null;
  return { x, y, scale, rot, velocity, moving, landing, dir: dirX };
}

/** 手持噪聲:永遠開著;停留小、移動大。 */
export function handheld(frame: number, amount: number) {
  return {
    jx: noise2D("hx", frame / 45, 0) * 6 * amount,
    jy: noise2D("hy", frame / 38, 0) * 4 * amount,
    jr: noise2D("hr", frame / 60, 0) * 0.35 * amount,
  };
}

export const Stage: React.FC<{ cam: Cam; extraBlur?: number; brightness?: number; skew?: number; jolt?: number; children: React.ReactNode }> = ({ cam, extraBlur = 0, brightness = 1, skew = 0, jolt = 0, children }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const hand = handheld(frame, cam.moving ? 1.5 : 0.55);
  const blur = Math.min(cam.velocity / 22, 16) + extraBlur;
  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transformOrigin: `${width / 2}px ${height / 2}px`,
          transform: `translate(${width / 2 - (cam.x + hand.jx) + jolt}px, ${height / 2 - (cam.y + hand.jy)}px) scale(${cam.scale}) rotate(${cam.rot + hand.jr}deg) skewX(${skew}deg)`,
          filter: `${blur > 0.4 ? `blur(${blur.toFixed(2)}px)` : ""} ${brightness !== 1 ? `brightness(${brightness.toFixed(3)})` : ""}`.trim() || undefined,
          willChange: "transform",
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Set: React.FC<{ x: number; y: number; children: React.ReactNode; style?: React.CSSProperties }> = ({ x, y, children, style }) => (
  <div style={{ position: "absolute", left: x, top: y, width: 1920, height: 1080, ...style }}>{children}</div>
);

// ---------- B. 棚邊痕跡(只在甩鏡時掃過) ----------
export const StageTraces: React.FC = () => (
  <svg width="1" height="1" style={{ position: "absolute", left: 0, top: 0, overflow: "visible" }}>
    <defs>
      <pattern id="floor" width="120" height="120" patternUnits="userSpaceOnUse">
        <path d="M0 120 L120 0" stroke="rgba(255,255,255,0.035)" strokeWidth="1" />
      </pattern>
    </defs>
    {/* 攝影棚地板紋 + cyclorama 邊線 */}
    <rect x={-5200} y={-3200} width={10400} height={7200} fill="url(#floor)" />
    <path d="M-5200 1120 H5200" stroke="rgba(255,255,255,0.08)" strokeWidth="2" strokeDasharray="18 14" />
    <path d="M-5200 -80 H5200" stroke="rgba(255,255,255,0.05)" strokeWidth="2" />
    {/* 膠帶 X 記號 */}
    {[[2300, 300], [2250, 1500], [-400, 1420], [-400, -420], [-2300, 640], [-1500, 640], [3300, 640], [-3100, -300], [600, -520], [1300, 1640], [400, 1600], [1300, -480]].map(([x, y], i) => (
      <g key={i} transform={`translate(${x} ${y}) rotate(${(i * 37) % 30 - 15})`} stroke={ACCENT} strokeWidth="14" strokeLinecap="round" opacity="0.85">
        <path d="M-34 -34 L34 34" /><path d="M34 -34 L-34 34" />
      </g>
    ))}
    {/* 燈架 / 柔光箱剪影 */}
    {[[2080, -700, 1], [-520, -760, -1], [2260, 1750, -1], [-520, 1760, 1], [-3450, -900, 1], [4850, 300, -1], [2300, 2400, 1]].map(([x, y, s], i) => (
      <g key={`l${i}`} transform={`translate(${x} ${y}) scale(${s} 1)`} fill="rgba(255,255,255,0.12)" stroke="rgba(255,255,255,0.22)" strokeWidth="3">
        <rect x={-6} y={0} width={12} height={520} />
        <path d="M-70 520 L0 440 L70 520 Z" fill="none" />
        <rect x={-10} y={-40} width={160} height={110} rx={10} transform="rotate(-18)" fill="rgba(255,255,255,0.18)" />
        <rect x={6} y={-24} width={128} height={78} rx={6} transform="rotate(-18)" fill="rgba(255,255,255,0.45)" />
      </g>
    ))}
    {/* 地板字 */}
    {[["CAM A · STAGE 1", 300, -860], ["KEEP CLEAR", 2000, 1700], ["KEEP CLEAR", -600, -280]].map(([t, x, y], i) => (
      <text key={`t${i}`} x={x as number} y={y as number} fill="rgba(255,255,255,0.22)" fontFamily={MONO} fontSize={44} letterSpacing={8}>{t}</text>
    ))}
    {/* 散落的線材 */}
    <path d="M-1900 1240 C -1200 1180, -600 1320, 100 1230 S 1500 1200, 2200 1300" stroke="rgba(0,0,0,0.55)" strokeWidth="7" fill="none" />
    <path d="M-1900 1240 C -1200 1180, -600 1320, 100 1230 S 1500 1200, 2200 1300" stroke="rgba(255,255,255,0.12)" strokeWidth="2" fill="none" />
  </svg>
);

// ---------- D. 錄影 UI(靜態疊在棚面之上) ----------
export const Viewfinder: React.FC<{ scene: { no: string; title: string } | null; recFrom?: number }> = ({ scene, recFrom = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = Math.max(0, frame - recFrom);
  const tc = `${String(Math.floor(f / fps / 3600)).padStart(2, "0")}:${String(Math.floor(f / fps / 60) % 60).padStart(2, "0")}:${String(Math.floor(f / fps) % 60).padStart(2, "0")}:${String(f % fps).padStart(2, "0")}`;
  const recOn = (f % fps) < fps / 2;
  const flick = 0.92 + noise2D("vf", frame / 7, 0) * 0.08;
  const bracket = (pos: React.CSSProperties, rx: boolean, ry: boolean) => (
    <div style={{ position: "absolute", width: 54, height: 54, ...pos, borderColor: "rgba(255,255,255,0.75)", borderStyle: "solid", borderWidth: 0, borderTopWidth: ry ? 0 : 3, borderBottomWidth: ry ? 3 : 0, borderLeftWidth: rx ? 0 : 3, borderRightWidth: rx ? 3 : 0 }} />
  );
  return (
    <AbsoluteFill style={{ pointerEvents: "none", opacity: flick, fontFamily: MONO }}>
      {bracket({ left: 26, top: 22 }, false, false)}
      {bracket({ right: 26, top: 22 }, true, false)}
      {bracket({ left: 26, bottom: 22 }, false, true)}
      {bracket({ right: 26, bottom: 22 }, true, true)}
      {/* 三分線 */}
      <svg width="1920" height="1080" style={{ position: "absolute", inset: 0, opacity: 0.1 }}>
        <path d="M640 0 V1080 M1280 0 V1080 M0 360 H1920 M0 720 H1920" stroke="#fff" strokeWidth="1" />
        <circle cx="960" cy="540" r="18" stroke="#fff" fill="none" strokeWidth="1" />
        <path d="M940 540 H980 M960 520 V560" stroke="#fff" strokeWidth="1" />
      </svg>
      {/* REC + timecode */}
      <div style={{ position: "absolute", left: 92, top: 26, display: "flex", alignItems: "center", gap: 14, fontSize: 22, color: "#fff", letterSpacing: "0.12em" }}>
        <span style={{ width: 16, height: 16, borderRadius: 8, background: "#ff3b3b", opacity: recOn ? 1 : 0.15, boxShadow: recOn ? "0 0 14px #ff3b3b" : undefined }} />
        <span style={{ fontWeight: 700 }}>REC</span>
        <span style={{ opacity: 0.85 }}>{tc}</span>
        <span style={{ opacity: 0.5, fontSize: 16 }}>CAM A · 25P · 1080</span>
      </div>
      {scene && (
        <div style={{ position: "absolute", right: 92, top: 28, fontSize: 20, color: "#fff", letterSpacing: "0.14em", opacity: 0.9 }}>
          SCENE <span style={{ color: ACCENT, fontWeight: 700 }}>{scene.no}</span> · {scene.title}
        </div>
      )}
      <div style={{ position: "absolute", right: 92, bottom: 30, fontSize: 16, color: "rgba(255,255,255,0.55)", letterSpacing: "0.14em" }}>
        AF · ISO 800 · 1/50 · WB 5600K
      </div>
    </AbsoluteFill>
  );
};

/** 落地時對焦框:吸到英雄元素(矩形為螢幕座標),10 幀出現後淡出 */
export const FocusBox: React.FC<{ rect: { x: number; y: number; w: number; h: number }; at: number }> = ({ rect, at }) => {
  const frame = useCurrentFrame();
  const t = frame - at;
  if (t < 0 || t > 40) return null;
  const s = interpolate(t, [0, 6], [1.25, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: easeInOut });
  const op = interpolate(t, [0, 4, 26, 40], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const col = t < 10 ? "#fff" : "#52ff8a";
  return (
    <div style={{ position: "absolute", left: rect.x, top: rect.y, width: rect.w, height: rect.h, transform: `scale(${s})`, opacity: op, border: `2px solid ${col}`, boxShadow: `0 0 0 1px rgba(0,0,0,0.4)` }}>
      <div style={{ position: "absolute", right: -2, top: -26, fontFamily: MONO, fontSize: 14, color: col, letterSpacing: "0.1em" }}>{t < 10 ? "AF…" : "AF ●"}</div>
    </div>
  );
};

// ---------- E. 場記板 ----------
export const Slate: React.FC<{ at: number; scene: string; take: string; title: string; subtitle: string }> = ({ at, scene, take, title, subtitle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame - at;
  if (t < -2 || t > 34) return null;
  const drop = spring({ frame: t, fps, durationInFrames: 7, config: { mass: 0.8, damping: 12, stiffness: 220 } });
  const lift = interpolate(t, [24, 30], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: (v) => v * v });
  const y = -1200 + 1200 * drop - 1300 * lift;
  const clapT = t - 16; // 第 16 幀合板
  const armRot = clapT < 0 ? interpolate(t, [4, 16], [-22, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) : 0;
  const flash = clapT === 0 || clapT === 1 ? 0.85 : 0;
  const shake = clapT >= 0 && clapT < 6 ? Math.sin(clapT * 2.2) * (6 - clapT) : 0;
  return (
    <AbsoluteFill style={{ justifyContent: "center", alignItems: "center", pointerEvents: "none" }}>
      <AbsoluteFill style={{ background: "#fff", opacity: flash }} />
      <div style={{ transform: `translateY(${y + shake}px) rotate(${-2 + shake * 0.2}deg)`, width: 980, filter: "drop-shadow(0 30px 60px rgba(0,0,0,0.6))", fontFamily: MONO }}>
        {/* 上板(拍板臂) */}
        <div style={{ transformOrigin: "0 100%", transform: `rotate(${armRot}deg)`, height: 64, background: "repeating-linear-gradient(135deg,#111 0 60px,#f5f5f5 60px 120px)", borderRadius: "8px 8px 0 0" }} />
        <div style={{ height: 64, background: "repeating-linear-gradient(135deg,#f5f5f5 0 60px,#111 60px 120px)", marginTop: -2 }} />
        {/* 本體 */}
        <div style={{ background: "#141414", color: "#f3f3f3", padding: "26px 36px 30px", borderRadius: "0 0 10px 10px", border: "3px solid #2a2a2a", display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "18px 24px" }}>
          <div style={{ gridColumn: "1 / -1", display: "flex", justifyContent: "space-between", borderBottom: "2px solid #333", paddingBottom: 12 }}>
            <span style={{ fontSize: 26, letterSpacing: "0.3em", color: "#aaa" }}>PROD.</span>
            <span style={{ fontSize: 40, fontWeight: 800, letterSpacing: "0.06em", fontFamily: '"WenQuanYi Zen Hei", sans-serif' }}>{title}</span>
          </div>
          <SlateCell k="SCENE" v={scene} big />
          <SlateCell k="TAKE" v={take} big />
          <SlateCell k="ROLL" v="A001" big />
          <SlateCell k="DIRECTOR" v="SAM" />
          <SlateCell k="CAMERA" v="CAM A · 25P" />
          <SlateCell k="DATE" v="2026.10.02" />
          <div style={{ gridColumn: "1 / -1", fontSize: 24, color: ACCENT, fontFamily: '"WenQuanYi Zen Hei", sans-serif', letterSpacing: "0.08em" }}>{subtitle}</div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
const SlateCell: React.FC<{ k: string; v: string; big?: boolean }> = ({ k, v, big }) => (
  <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
    <span style={{ fontSize: 16, letterSpacing: "0.3em", color: "#888" }}>{k}</span>
    <span style={{ fontSize: big ? 54 : 26, fontWeight: 800, color: "#fff", letterSpacing: "0.04em" }}>{v}</span>
  </div>
);

/** C. 鏡頭髒污(固定不動,極低透明度) */
export const LensDirt: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none", opacity: 0.06, background: "radial-gradient(260px 180px at 68% 30%, rgba(255,255,255,0.9), transparent 70%), radial-gradient(120px 90px at 22% 72%, rgba(255,255,255,0.8), transparent 70%), radial-gradient(60px 60px at 80% 80%, rgba(255,255,255,0.9), transparent 70%)" }} />
);

export const Vignette: React.FC = () => (
  <AbsoluteFill style={{ pointerEvents: "none", background: "radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.45) 100%)" }} />
);

export const clampNum = clamp;
