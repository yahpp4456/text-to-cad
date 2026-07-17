import React, { useEffect, useMemo, useState } from "react";
// 立方投影幾何與 viewer 的 ViewPlaneControl 共用(cadjs 單一真相源);
// 這裡只留 cad-chat 的縮放/置中/配色等版面選擇。
import {
  CUBE_FACES,
  CUBE_REGION_BREAKS as REGION_BREAKS,
  CUBE_REGION_DIRECTIONS as REGION_DIRECTIONS,
  directionForCubeRegion as directionForRegion,
  insetInterval,
  normalizeOrientationAxes,
  pointForCubeFace as pointForFace,
  polygonPoints,
  projectDirection,
  projectedPoint as projectedCubePoint,
} from "cadjs/lib/viewer/viewCubeMath.js";
import { directionSignsKey as directionKey } from "../../lib/viewOrientations.js";

const AXIS_COLORS = Object.freeze({
  x: { front: [230, 79, 72], back: [118, 32, 31] },
  y: { front: [52, 178, 92], back: [27, 96, 51] },
  z: { front: [57, 111, 222], back: [28, 56, 128] },
});

const CUBE_SCALE = 23.5;
const FACE_IDS = Object.freeze(["x", "xNeg", "y", "yNeg", "z", "zNeg"]);
const COLLAPSED_STORAGE_KEY = "cad-chat:view-cube-collapsed";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function projectedPoint(orientation, point) {
  return projectedCubePoint(orientation, point, { scale: CUBE_SCALE, cy: 46 });
}

function mixRgb(from, to, amount) {
  const ratio = clamp(amount, 0, 1);
  return from.map((value, index) => Math.round(value + (to[index] - value) * ratio));
}

function rgba(rgb, alpha = 1) {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${clamp(alpha, 0, 1)})`;
}

function keyboardAction(action) {
  return (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    event.stopPropagation();
    action();
  };
}

function initialCollapsedState() {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(COLLAPSED_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

function MiniCubeGlyph() {
  return (
    <svg viewBox="0 0 32 32" aria-hidden="true">
      <path d="M16 3.5 27 9.8 16 16.2 5 9.8 16 3.5Z" />
      <path d="m5 9.8 11 6.4v12.3L5 22.1V9.8Z" />
      <path d="m27 9.8-11 6.4v12.3l11-6.4V9.8Z" />
    </svg>
  );
}

export default function ViewCube({
  orientation,
  activeId = "",
  presets = [],
  onSelect,
  onHome,
  drawerOpen = false,
}) {
  const [hoveredRegion, setHoveredRegion] = useState("");
  const [collapsed, setCollapsed] = useState(initialCollapsedState);
  const normalizedOrientation = normalizeOrientationAxes(orientation);
  const presetByDirection = useMemo(
    () => new Map((presets || []).map((preset) => [directionKey(preset.direction), preset])),
    [presets],
  );
  const presetById = useMemo(
    () => new Map((presets || []).map((preset) => [preset.id, preset])),
    [presets],
  );

  const faces = CUBE_FACES.map((face) => {
    const normal = [0, 0, 0];
    normal[face.axis === "x" ? 0 : face.axis === "y" ? 1 : 2] = face.sign;
    const normalDepth = projectDirection(normalizedOrientation, normal)[2];
    const corners = [
      pointForFace(face, -1, -1),
      pointForFace(face, 1, -1),
      pointForFace(face, 1, 1),
      pointForFace(face, -1, 1),
    ].map((point) => projectedPoint(normalizedOrientation, point));
    return {
      ...face,
      normalDepth,
      corners,
      depth: corners.reduce((sum, point) => sum + point.depth, 0) / corners.length,
    };
  }).sort((left, right) => left.depth - right.depth);

  const activate = (preset) => {
    if (!preset) return;
    setHoveredRegion("");
    onSelect?.(preset);
  };

  useEffect(() => {
    try {
      window.localStorage.setItem(COLLAPSED_STORAGE_KEY, collapsed ? "1" : "0");
    } catch {
      // localStorage 可能被瀏覽器隱私設定停用；收合仍維持當次頁面狀態。
    }
  }, [collapsed]);

  return (
    <div
      className="view-cube"
      data-drawer={drawerOpen || undefined}
      data-collapsed={collapsed || undefined}
      aria-label="模型視角控制"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {collapsed ? (
        <button
          type="button"
          className="view-cube-expand"
          onClick={() => setCollapsed(false)}
          title="展開 ViewCube"
          aria-label="展開 ViewCube 視角控制"
          aria-expanded="false"
        >
          <MiniCubeGlyph />
          <span>VIEW</span>
          <svg className="view-cube-chevron" viewBox="0 0 12 7" aria-hidden="true">
            <path d="m1 6 5-5 5 5" />
          </svg>
        </button>
      ) : (
        <>
          <div className="view-cube-head">
            <span>
              <i />
              VIEW
            </span>
            <div className="view-cube-head-actions">
              <button
                type="button"
                className="view-cube-iso"
                onClick={onHome}
                title="回到等角視圖"
                aria-label="回到等角視圖"
              >
                ISO
              </button>
              <button
                type="button"
                className="view-cube-collapse"
                onClick={() => setCollapsed(true)}
                title="收合 ViewCube"
                aria-label="收合 ViewCube 視角控制"
                aria-expanded="true"
              >
                <svg className="view-cube-chevron" viewBox="0 0 12 7" aria-hidden="true">
                  <path d="m1 1 5 5 5-5" />
                </svg>
              </button>
            </div>
          </div>
          <svg
            className="view-cube-stage"
            viewBox="0 0 100 92"
            role="group"
            aria-label="ViewCube 視角選擇器"
          >
            {faces.map((face) => {
              const colors = AXIS_COLORS[face.axis] || AXIS_COLORS.z;
              const faceDepth = clamp((face.normalDepth + 1) / 2, 0, 1);
              const faceColor = mixRgb(colors.back, colors.front, faceDepth * 0.58 + 0.18);
              const visible = face.normalDepth > 0.015;
              const facePreset = presetByDirection.get(directionKey(directionForRegion(face, 0, 0)));
              return (
                <g key={face.id} data-cube-face={face.id}>
                  <polygon
                    points={polygonPoints(face.corners)}
                    fill={rgba(faceColor, visible ? 0.26 : 0.06)}
                    stroke={visible ? "rgba(38, 52, 75, .5)" : "rgba(38, 52, 75, .12)"}
                    strokeWidth={visible ? 0.8 : 0.45}
                    strokeLinejoin="round"
                    pointerEvents="none"
                  />
                  {visible
                    ? REGION_DIRECTIONS.flatMap((vDirection, vIndex) => (
                        REGION_DIRECTIONS.map((uDirection, uIndex) => {
                          const preset = presetByDirection.get(directionKey(
                            directionForRegion(face, uDirection, vDirection),
                          ));
                          if (!preset) return null;
                          const [uStart, uEnd] = insetInterval(
                            REGION_BREAKS[uIndex],
                            REGION_BREAKS[uIndex + 1],
                          );
                          const [vStart, vEnd] = insetInterval(
                            REGION_BREAKS[vIndex],
                            REGION_BREAKS[vIndex + 1],
                          );
                          const points = [
                            pointForFace(face, uStart, vStart),
                            pointForFace(face, uEnd, vStart),
                            pointForFace(face, uEnd, vEnd),
                            pointForFace(face, uStart, vEnd),
                          ].map((point) => projectedPoint(normalizedOrientation, point));
                          const regionId = `${face.id}:${uIndex}:${vIndex}`;
                          const hovered = hoveredRegion === regionId;
                          const active = activeId === preset.id;
                          return (
                            <g
                              key={regionId}
                              role="button"
                              tabIndex={0}
                              data-preset={preset.id}
                              aria-label={preset.title}
                              aria-pressed={active}
                              className="view-cube-region"
                              onPointerEnter={() => setHoveredRegion(regionId)}
                              onPointerMove={() => setHoveredRegion(regionId)}
                              onPointerLeave={() => setHoveredRegion("")}
                              onFocus={() => setHoveredRegion(regionId)}
                              onBlur={() => setHoveredRegion("")}
                              onClick={(event) => {
                                event.stopPropagation();
                                activate(preset);
                              }}
                              onKeyDown={keyboardAction(() => activate(preset))}
                            >
                              <polygon
                                points={polygonPoints(points)}
                                fill={active
                                  ? "rgba(19, 36, 63, .86)"
                                  : hovered
                                    ? rgba(faceColor, 0.94)
                                    : rgba(faceColor, 0.55)}
                                stroke={active
                                  ? "#ffffff"
                                  : hovered
                                    ? rgba(colors.front, 1)
                                    : "rgba(255, 255, 255, .32)"}
                                strokeWidth={active ? 1.3 : hovered ? 1.05 : 0.5}
                                strokeLinejoin="round"
                              />
                            </g>
                          );
                        })
                      ))
                    : null}
                  {visible && facePreset ? (() => {
                    const center = projectedPoint(normalizedOrientation, pointForFace(face, 0, 0));
                    return (
                      <text
                        x={center.x}
                        y={center.y + 2.2}
                        textAnchor="middle"
                        className="view-cube-face-label"
                        pointerEvents="none"
                      >
                        {facePreset.label}
                      </text>
                    );
                  })() : null}
                </g>
              );
            })}
          </svg>
          <div className="view-cube-axis-strip" aria-label="六面視角捷徑">
            {FACE_IDS.map((id) => {
              const preset = presetById.get(id);
              return preset ? (
                <button
                  type="button"
                  key={id}
                  data-axis={id[0]}
                  data-on={activeId === id || undefined}
                  title={preset.title}
                  aria-label={preset.title}
                  onClick={() => activate(preset)}
                >
                  {preset.label}
                </button>
              ) : null;
            })}
          </div>
        </>
      )}
    </div>
  );
}
