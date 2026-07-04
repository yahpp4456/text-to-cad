import React from "react";

import TypeBadge from "../TypeBadge.jsx";

export default function VersionTimeline({ versions, activeVer, onSelect }) {
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
        </div>
      )}
    </div>
  );
}
