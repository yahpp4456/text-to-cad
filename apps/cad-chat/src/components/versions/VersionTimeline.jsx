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
  onDownloadStep,
  onValidate,
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
    !exporting && // 精算/匯出閘持鎖期間回退必 409,先鎖鈕別發樂觀 notify
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
                {/* 驗證狀態 badge:三態——undefined(舊資料/opened)不渲染,對齊
                    TypeBadge「未知不出 badge」的誠實慣例 */}
                {v.source !== "opened" && v.verified === false && (
                  <span
                    className="ver-verify"
                    data-state="unverified"
                    title="此版尚未通過完整幾何驗證(快路徑產出);匯出/下載時會先自動精算把關,或選最新版用「✓ 精算此版」先補驗"
                  >
                    未驗證
                  </span>
                )}
                {v.source !== "opened" && v.verified === true && (
                  <span className="ver-verify" data-state="verified" title="已通過完整幾何驗證">
                    ✓ 已驗證
                  </span>
                )}
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
          {active &&
            active.source !== "opened" &&
            latestGen &&
            active.id === latestGen.id &&
            onValidate && (
              <a
                className="version-dl"
                data-busy={exporting === "validate" || undefined}
                data-attn={latestGen.verified === false || undefined}
                title="對此版跑完整幾何驗證(有效實體 / 干涉 / 運動掃掠);通過後匯出/下載免等閘"
                onClick={() => !running && !exporting && onValidate()}
              >
                {exporting === "validate" ? "✓ 精算中…" : "✓ 精算此版"}
              </a>
            )}
          {active &&
            stepRelFor(active) &&
            (active.source === "opened" || active.verified === true || !onDownloadStep ? (
              // 開檔檢視版(本來就是使用者自己的檔)與已驗證版:直接下載
              <a
                className="version-dl"
                title={`下載 ${active.id} 的 STEP`}
                href={`/api/asset?file=${encodeURIComponent(stepRelFor(active))}&download=${encodeURIComponent(`${active.name}_${active.id}.step`)}`}
              >
                ⤓ STEP
              </a>
            ) : (
              // 未驗證(或驗證狀態未知)的自產版:走匯出閘,通過才觸發下載
              <a
                className="version-dl"
                data-busy={exporting === "stepdl" || undefined}
                title={`下載 ${active.id} 的 STEP(未驗證:會先自動精算,通過才下載)`}
                onClick={() => !running && !exporting && onDownloadStep(active, stepRelFor(active))}
              >
                {exporting === "stepdl" ? "⤓ 驗證中…" : "⤓ STEP"}
              </a>
            ))}
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
