import React from "react";

import TypeBadge from "../TypeBadge.jsx";

// version.file → 可下載的 STEP 相對路徑:
// generated 版 file 是快照隱藏 GLB(…/versions/vN/.name.step.glb)→ 去掉前導點與 .glb;
// opened 版 file 若本身就是 .step/.stp 直接用;推不出來回 null(藏鈕)。
function stepRelFor(v) {
  const f = String(v?.file || "");
  if (/\.(step|stp)$/i.test(f)) return f;
  const m = f.match(/^(.*)\/\.([^/]+\.step)\.glb$/i);
  return m ? `${m[1]}/${m[2]}` : null;
}

export default function VersionTimeline({
  versions,
  activeVer,
  onSelect,
  onRevert,
  onExport,
  onExportParts,
  exporting,
  running,
}) {
  // 「回到此版繼續」只對 server 產生的 v* 版有意義(有快照可回退),
  // 且看的必須是舊版——最新 v* 版本來就是改的基準,無回退可言。
  const latestGen = [...versions].reverse().find((v) => v.source !== "opened");
  const active = versions.find((v) => v.id === activeVer);
  const canRevert =
    !!onRevert &&
    !running &&
    active &&
    active.source !== "opened" &&
    latestGen &&
    active.id !== latestGen.id;
  return (
    <div className="versions">
      <div className="versions-tag">
        <span className="bar bar-ink" />
        <span className="versions-eyebrow">VERSIONS</span>
      </div>
      {versions.length === 0 ? (
        <span className="versions-empty">尚無版本 · 產出後可在此切換 / 對比 / 回退</span>
      ) : (
        <div className="versions-track">
          {versions.map((v) => (
            <a
              key={v.id}
              className="version-chip"
              data-active={v.id === activeVer}
              onClick={() => onSelect(v.id)}
            >
              <span className="version-thumb">{v.id.replace(/^[vo]/, "V")}</span>
              <div className="version-info">
                <span className="version-id">
                  {v.id}
                  {v.source === "opened" ? " · 檢視" : ""}
                </span>
                <span className="version-name">{v.name}</span>
                <TypeBadge type={v.type} partCount={v.partCount} />
              </div>
            </a>
          ))}
          {canRevert && (
            <a
              className="version-revert"
              title={`把 ${active.id} 的檔案還原成目前工作基準,後續對話從這版繼續`}
              onClick={() => onRevert(active.id)}
            >
              ⟲ 回到 {active.id} 繼續
            </a>
          )}
          {active && stepRelFor(active) && (
            <a
              className="version-dl"
              title={`下載 ${active.id} 的 STEP`}
              href={`/api/asset?file=${encodeURIComponent(stepRelFor(active))}&download=${encodeURIComponent(`${active.name}_${active.id}.step`)}`}
            >
              ⤓ STEP
            </a>
          )}
          {active &&
            active.source !== "opened" &&
            /^v\d+$/.test(active.id) &&
            onExport &&
            ["stl", "3mf"].map((f) => {
              const busy = exporting === `${active.id}:${f}`;
              return (
                <a
                  key={f}
                  className="version-dl"
                  data-busy={busy || undefined}
                  title={`把 ${active.id} 轉成 ${f.toUpperCase()} 下載(免 AI,約數秒~數十秒)`}
                  onClick={() => !running && !exporting && onExport(active.id, f)}
                >
                  {busy ? "⤓ 轉換中…" : `⤓ ${f.toUpperCase()}`}
                </a>
              );
            })}
          {active &&
            active.source !== "opened" &&
            /^v\d+$/.test(active.id) &&
            onExportParts && (
              <a
                className="version-dl"
                data-busy={exporting === "parts:step" || undefined}
                title="把每個零件各自拆成 STEP 打包 zip 下載(子組合件=一檔)"
                onClick={() => !running && !exporting && onExportParts()}
              >
                {exporting === "parts:step" ? "⤓ 拆件中…" : "⤓ 零件包"}
              </a>
            )}
        </div>
      )}
    </div>
  );
}
