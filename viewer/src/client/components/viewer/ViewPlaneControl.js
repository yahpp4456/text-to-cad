import { useState } from "react";
// Cube-face/region geometry is shared with cad-chat's ViewCube through cadjs;
// only scale, palette and layout choices stay in this component.
import {
  CUBE_FACES,
  CUBE_REGION_BREAKS,
  CUBE_REGION_DIRECTIONS,
  directionForCubeRegion,
  insetInterval,
  normalizeOrientationAxes,
  pointForCubeFace,
  polygonPoints,
  projectDirection,
  projectedPoint as projectedCubePoint
} from "cadjs/lib/viewer/viewCubeMath.js";
import { directionSignsKey as directionKey } from "cadjs/lib/viewer/viewOrientations.js";

const DEFAULT_VIEW_PLANE_PALETTE = Object.freeze({
  axis: {
    x: {
      front: [250, 88, 79],
      back: [122, 32, 28]
    },
    y: {
      front: [92, 233, 123],
      back: [30, 99, 46]
    },
    z: {
      front: [84, 131, 255],
      back: [30, 53, 126]
    }
  },
  center: {
    fill: [252, 215, 74],
    stroke: [255, 235, 153]
  }
});

const DEFAULT_VIEW_PLANE_SIZE = "6rem";
const CUBE_SCALE = 24;

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeCssLength(value, fallback = "") {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return `${value}px`;
  }
  const text = String(value || "").trim();
  return text || fallback;
}

function toRgb(value) {
  const [r = 0, g = 0, b = 0] = Array.isArray(value) ? value : [0, 0, 0];
  return [Math.round(clamp(r, 0, 255)), Math.round(clamp(g, 0, 255)), Math.round(clamp(b, 0, 255))];
}

function mixRgb(from, to, amount) {
  const ratio = clamp(amount, 0, 1);
  const left = toRgb(from);
  const right = toRgb(to);
  return [
    left[0] + (right[0] - left[0]) * ratio,
    left[1] + (right[1] - left[1]) * ratio,
    left[2] + (right[2] - left[2]) * ratio
  ];
}

function rgbToCss(value, alpha = 1) {
  const [r, g, b] = toRgb(value);
  return `rgba(${r}, ${g}, ${b}, ${clamp(alpha, 0, 1)})`;
}

function normalizeRgbTriplet(value, fallback) {
  if (!Array.isArray(value) || value.length < 3) {
    return [...fallback];
  }
  const r = Number(value[0]);
  const g = Number(value[1]);
  const b = Number(value[2]);
  if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) {
    return [...fallback];
  }
  return [clamp(r, 0, 255), clamp(g, 0, 255), clamp(b, 0, 255)];
}

function resolveViewPlanePalette(viewerTheme) {
  const themePalette = viewerTheme?.viewPlanePalette || {};
  const themeAxisPalette = themePalette?.axis || {};
  const axis = {};
  for (const axisId of ["x", "y", "z"]) {
    const fallback = DEFAULT_VIEW_PLANE_PALETTE.axis[axisId];
    const custom = themeAxisPalette?.[axisId] || {};
    axis[axisId] = {
      front: normalizeRgbTriplet(custom.front, fallback.front),
      back: normalizeRgbTriplet(custom.back, fallback.back)
    };
  }
  return {
    axis,
    center: {
      fill: normalizeRgbTriplet(themePalette?.center?.fill, DEFAULT_VIEW_PLANE_PALETTE.center.fill),
      stroke: normalizeRgbTriplet(themePalette?.center?.stroke, DEFAULT_VIEW_PLANE_PALETTE.center.stroke)
    }
  };
}

function projectedPoint(orientation, point) {
  return projectedCubePoint(orientation, point, { scale: CUBE_SCALE });
}

function makeKeyboardHandler(action) {
  return (event) => {
    if (event.key !== "Enter" && event.key !== " ") {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    action?.();
  };
}

export default function ViewPlaneControl({
  showViewPlane,
  previewMode,
  isLoading,
  meshData,
  viewPlaneOffsetRight,
  viewPlaneOffsetBottom = 16,
  activeViewPlaneFace,
  viewPlaneFaces,
  viewPlaneOrientation,
  viewerTheme,
  compact = false,
  variant = "3d",
  viewPlaneSize,
  viewPlaneHeader = null,
  activateViewPlaneFace,
  activateDefaultViewPlane
}) {
  const [hoveredNodeId, setHoveredNodeId] = useState("");

  if (!showViewPlane || previewMode || isLoading || !meshData) {
    return null;
  }

  const orientation = normalizeOrientationAxes(viewPlaneOrientation);
  const palette = resolveViewPlanePalette(viewerTheme);
  const faces = Array.isArray(viewPlaneFaces) ? viewPlaneFaces : [];
  const presetByDirection = new Map(faces.map((face) => [directionKey(face.direction), face]));
  const is2d = variant === "2d";
  const customViewPlaneSize = !compact && !is2d
    ? normalizeCssLength(viewPlaneSize, DEFAULT_VIEW_PLANE_SIZE)
    : "";
  const viewPlaneSizeClasses = compact || is2d ? "h-20 w-20" : "";
  const viewPlaneSizeStyle = customViewPlaneSize
    ? { width: customViewPlaneSize, height: customViewPlaneSize }
    : undefined;
  const normalizedBottomOffset = typeof viewPlaneOffsetBottom === "number"
    ? `${viewPlaneOffsetBottom}px`
    : viewPlaneOffsetBottom;
  const activatePreset = (id) => {
    setHoveredNodeId("");
    activateViewPlaneFace?.(id);
  };

  const render2dSelector = () => {
    const projectedNodes = faces.map((face) => {
      const [x, y] = projectDirection(orientation, face.direction);
      return {
        ...face,
        x: 50 + x * 28,
        y: 50 - y * 28
      };
    });
    return (
      <svg className="absolute inset-0 h-full w-full" viewBox="0 0 100 100" aria-label="2D view selector">
        <rect x="15" y="15" width="70" height="70" rx="8" fill="var(--sidebar)" stroke="var(--sidebar-border)" strokeWidth="0.75" />
        <line x1="22" y1="50" x2="78" y2="50" stroke="color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)" strokeWidth="1" />
        <line x1="50" y1="22" x2="50" y2="78" stroke="color-mix(in oklch, var(--sidebar-foreground) 18%, transparent)" strokeWidth="1" />
        {projectedNodes.map((node) => {
          const hovered = hoveredNodeId === node.id;
          return (
            <g
              key={node.id}
              role="button"
              tabIndex={0}
              aria-label={node.title}
              className="cursor-pointer focus:outline-none"
              onPointerDown={(event) => event.stopPropagation()}
              onPointerEnter={() => setHoveredNodeId(node.id)}
              onPointerLeave={() => setHoveredNodeId("")}
              onFocus={() => setHoveredNodeId(node.id)}
              onBlur={() => setHoveredNodeId("")}
              onClick={(event) => {
                event.stopPropagation();
                activatePreset(node.id);
              }}
              onKeyDown={makeKeyboardHandler(() => activatePreset(node.id))}
            >
              <circle cx={node.x} cy={node.y} r={hovered ? 8 : 6} fill={rgbToCss(palette.center.fill, hovered ? 1 : 0.88)} stroke={rgbToCss(palette.center.stroke)} strokeWidth="1" />
            </g>
          );
        })}
        <g
          role="button"
          tabIndex={0}
          aria-label="Fit 2D view"
          className="cursor-pointer focus:outline-none"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            activateDefaultViewPlane?.();
          }}
          onKeyDown={makeKeyboardHandler(activateDefaultViewPlane)}
        >
          <circle cx="50" cy="50" r="10" fill={rgbToCss(palette.center.fill, 0.95)} stroke={rgbToCss(palette.center.stroke)} strokeWidth="1.1" />
        </g>
      </svg>
    );
  };

  const cubeFaces = CUBE_FACES.map((face) => {
    const normal = [0, 0, 0];
    normal[face.axis === "x" ? 0 : face.axis === "y" ? 1 : 2] = face.sign;
    const normalDepth = projectDirection(orientation, normal)[2];
    const corners = [
      pointForCubeFace(face, -1, -1),
      pointForCubeFace(face, 1, -1),
      pointForCubeFace(face, 1, 1),
      pointForCubeFace(face, -1, 1)
    ].map((point) => projectedPoint(orientation, point));
    return {
      ...face,
      normalDepth,
      corners,
      depth: corners.reduce((sum, point) => sum + point.depth, 0) / corners.length
    };
  }).sort((left, right) => left.depth - right.depth);

  const renderCubeFace = (face) => {
    const axisPalette = palette.axis[face.axis] || palette.axis.z;
    const faceDepth = clamp((face.normalDepth + 1) / 2, 0, 1);
    const faceFill = mixRgb(axisPalette.back, axisPalette.front, faceDepth * 0.58 + 0.18);
    const visible = face.normalDepth > 0.015;
    const facePreset = presetByDirection.get(directionKey(directionForCubeRegion(face, 0, 0)));
    const faceLabel = String(facePreset?.label || "").toUpperCase();

    return (
      <g key={face.id} data-view-cube-face={face.id}>
        <polygon
          points={polygonPoints(face.corners)}
          fill={rgbToCss(faceFill, visible ? 0.35 : 0.1)}
          stroke={visible ? "color-mix(in oklch, var(--sidebar-foreground) 52%, transparent)" : "color-mix(in oklch, var(--sidebar-foreground) 15%, transparent)"}
          strokeWidth={visible ? 0.85 : 0.5}
          strokeLinejoin="round"
          pointerEvents="none"
        />
        {visible ? CUBE_REGION_DIRECTIONS.flatMap((vDirection, vIndex) => (
          CUBE_REGION_DIRECTIONS.map((uDirection, uIndex) => {
            const preset = presetByDirection.get(directionKey(
              directionForCubeRegion(face, uDirection, vDirection)
            ));
            if (!preset) {
              return null;
            }
            const [uStart, uEnd] = insetInterval(
              CUBE_REGION_BREAKS[uIndex],
              CUBE_REGION_BREAKS[uIndex + 1]
            );
            const [vStart, vEnd] = insetInterval(
              CUBE_REGION_BREAKS[vIndex],
              CUBE_REGION_BREAKS[vIndex + 1]
            );
            const points = [
              pointForCubeFace(face, uStart, vStart),
              pointForCubeFace(face, uEnd, vStart),
              pointForCubeFace(face, uEnd, vEnd),
              pointForCubeFace(face, uStart, vEnd)
            ].map((point) => projectedPoint(orientation, point));
            const regionId = `${face.id}:${uIndex}:${vIndex}`;
            const hovered = hoveredNodeId === regionId;
            const active = activeViewPlaneFace === preset.id;
            const fill = active
              ? "color-mix(in oklch, var(--sidebar-foreground) 28%, transparent)"
              : hovered
                ? rgbToCss(faceFill, 0.82)
                : rgbToCss(faceFill, 0.48);
            return (
              <g
                key={regionId}
                role="button"
                tabIndex={0}
                aria-label={preset.title}
                aria-pressed={active}
                className="cursor-pointer focus:outline-none"
                onPointerDown={(event) => event.stopPropagation()}
                onPointerEnter={() => setHoveredNodeId(regionId)}
                onPointerMove={() => setHoveredNodeId(regionId)}
                onPointerLeave={() => setHoveredNodeId("")}
                onFocus={() => setHoveredNodeId(regionId)}
                onBlur={() => setHoveredNodeId("")}
                onClick={(event) => {
                  event.stopPropagation();
                  activatePreset(preset.id);
                }}
                onKeyDown={makeKeyboardHandler(() => activatePreset(preset.id))}
              >
                <polygon
                  points={polygonPoints(points)}
                  fill={fill}
                  stroke={active
                    ? "var(--sidebar-foreground)"
                    : hovered
                      ? rgbToCss(axisPalette.front, 0.95)
                      : "color-mix(in oklch, var(--sidebar-foreground) 20%, transparent)"}
                  strokeWidth={active ? 1.35 : hovered ? 1.05 : 0.52}
                  strokeLinejoin="round"
                  className="transition-[fill,stroke,stroke-width] duration-150"
                />
              </g>
            );
          })
        )) : null}
        {visible && faceLabel ? (() => {
          const center = projectedPoint(orientation, pointForCubeFace(face, 0, 0));
          return (
            <text
              x={center.x}
              y={center.y + 2.35}
              textAnchor="middle"
              fill="var(--sidebar-foreground)"
              fillOpacity="0.82"
              fontSize="6.3"
              fontWeight="700"
              letterSpacing="-0.15"
              pointerEvents="none"
            >
              {faceLabel}
            </text>
          );
        })() : null}
      </g>
    );
  };

  return (
    <div
      className="pointer-events-none absolute z-30 flex flex-col items-end gap-1"
      style={{ right: `${viewPlaneOffsetRight}px`, bottom: normalizedBottomOffset }}
    >
      {viewPlaneHeader ? (
        <div
          className="pointer-events-auto"
          onPointerDown={(event) => event.stopPropagation()}
        >
          {viewPlaneHeader}
        </div>
      ) : null}
      {!is2d ? (
        <button
          type="button"
          aria-label="Reset to default isometric view"
          title="Reset to default isometric view"
          className="cad-glass-surface pointer-events-auto absolute -left-6 top-0 grid size-5 place-items-center rounded-sm border border-sidebar-border text-sidebar-foreground/65 shadow-sm transition hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/45"
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation();
            activateDefaultViewPlane?.();
          }}
        >
          <svg viewBox="0 0 16 16" className="size-3" aria-hidden="true">
            <path d="M8 2.25 13.25 5.3v5.4L8 13.75 2.75 10.7V5.3L8 2.25Z" fill="none" stroke="currentColor" strokeWidth="1.15" strokeLinejoin="round" />
            <path d="m2.95 5.45 5.05 3 5.05-3M8 8.45v5.05" fill="none" stroke="currentColor" strokeWidth="1.05" strokeLinejoin="round" />
          </svg>
        </button>
      ) : null}
      <div
        className={`${is2d
          ? "cad-glass-surface"
          : "cad-glass-surface bg-sidebar/72 backdrop-blur-md"} ${viewPlaneSizeClasses} pointer-events-auto relative overflow-hidden rounded-md border border-sidebar-border text-sidebar-foreground shadow-[0_10px_28px_rgba(0,0,0,0.18)] transition duration-150`}
        style={viewPlaneSizeStyle}
        onPointerDown={(event) => event.stopPropagation()}
      >
        {is2d ? render2dSelector() : (
          <>
            <div
              aria-hidden="true"
              className="pointer-events-none absolute inset-0 opacity-70"
              style={{
                background: "radial-gradient(circle at 32% 22%, color-mix(in oklch, var(--sidebar-foreground) 8%, transparent), transparent 58%)"
              }}
            />
            <svg
              className="absolute inset-0 h-full w-full"
              viewBox="0 0 100 100"
              role="group"
              aria-label="ViewCube orientation selector"
            >
              {cubeFaces.map(renderCubeFace)}
            </svg>
          </>
        )}
      </div>
    </div>
  );
}
