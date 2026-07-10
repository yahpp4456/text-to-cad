import React, { useEffect, useMemo, useState } from "react";

import { derivedRows, engineeringRows } from "../../lib/cadTopology.js";

export default function PropertiesDrawer({
  topo,
  selNode,
  canvas,
  activeVer,
  dispatch,
  onBringToChat,
  citedTokens,
  partDisplay = {},
  onCycleDisplay,
  onPickPart,
}) {
  const nodes = topo?.nodes || [];
  const sel = nodes.find((n) => n.id === selNode) || nodes[0] || null;
  const derived = sel ? derivedRows(sel, topo?.overall || {}) : [];
  const engineering = sel ? engineeringRows(sel) : [];

  // 節點折疊狀態(組合件預設全收合,樹只見 assembly + 頂層零件/群組)。
  const [expanded, setExpanded] = useState(() => new Set());
  useEffect(() => setExpanded(new Set()), [topo]);
  const nodeById = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // 雙擊圈選(SELECT_NODE)→ 自動展開該節點與其全祖先鏈(深葉件也不會藏在收合層裡)。
  useEffect(() => {
    if (!selNode) return;
    const nd = nodeById.get(selNode);
    if (!nd) return;
    const add = [];
    if (nd.childCount > 0) add.push(nd.id);
    let pid = nd.parentId;
    let guard = 0;
    while (pid && pid !== "__root" && guard++ < 32) {
      add.push(pid);
      pid = nodeById.get(pid)?.parentId;
    }
    if (!add.length) return;
    setExpanded((prev) => {
      if (add.every((id) => prev.has(id))) return prev;
      const next = new Set(prev);
      add.forEach((id) => next.add(id));
      return next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selNode, topo]);

  const toggleExpand = (id) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  // 祖先鏈上任一收合節點都會藏住後代(任意深巢狀)。
  const isVisible = (n) => {
    let pid = n.parentId;
    let guard = 0;
    while (pid && pid !== "__root" && guard++ < 32) {
      if (!expanded.has(pid)) return false;
      pid = nodeById.get(pid)?.parentId;
    }
    return true;
  };

  const cited = citedTokens || new Set();
  const tokenOf = (n) => n?.token || n?.ref?.copyText || null;

  // 誠實原則:opened(開檔看圖)沒經過生成管線,不宣稱 generator / 驗證。
  const provenance =
    canvas.source === "opened"
      ? [
          { k: "來源 FILE", v: canvas.name || "—" },
          { k: "版本", v: activeVer || "—" },
          { k: "狀態 STATUS", v: "已載入 · 未經生成驗證" },
        ]
      : [
          { k: "GENERATOR", v: `cad.build · ${canvas.name || "part"}.py` },
          { k: "版本", v: activeVer || "—" },
          { k: "OUTPUTS", v: "step · glb" },
          { k: "狀態 STATUS", v: "finished" },
        ];

  const selRef = tokenOf(sel);

  return (
    <div className="props">
      <div className="props-head">
        <span className="bar bar-ink" />
        <div className="props-titles">
          <span className="props-eyebrow">PROPERTIES</span>
          <span className="props-title">物件屬性</span>
        </div>
        <a className="props-close" onClick={() => dispatch({ type: "TOGGLE_PROPS", open: false })}>
          ✕
        </a>
      </div>

      <div className="props-scroll">
        <div className="props-section">
          <span className="props-section-eyebrow">物件樹 · HIERARCHY</span>
          <div className="tree">
            {nodes.filter(isVisible).map((n) => {
              if (n.kind === "more") {
                return (
                  <span key={n.id} className="tree-more" style={{ paddingLeft: 8 + n.depth * 16 }}>
                    {n.label}
                  </span>
                );
              }
              const expandable = n.childCount > 0;
              const isCited = !!tokenOf(n) && cited.has(tokenOf(n));
              // 零件級節點(有 occurrenceId):點擊連動 3D 圈選(殼擋住 raycast 時
              // 從樹選內部件的逃生口)+ 眼睛三態(solid→半透明→隱藏,透視外殼用)
              const occId = n.kind === "shape" ? n.row?.occurrenceId : null;
              const eye = occId ? partDisplay[occId] || "solid" : null;
              return (
                <a
                  key={n.id}
                  className="tree-node"
                  data-active={n.id === sel?.id}
                  data-cited={isCited || undefined}
                  data-display={eye && eye !== "solid" ? eye : undefined}
                  style={{ paddingLeft: 8 + n.depth * 16 }}
                  onClick={() => {
                    dispatch({ type: "SELECT_NODE", id: n.id });
                    if (expandable) toggleExpand(n.id);
                    if (occId) onPickPart?.(occId, "toggle");
                  }}
                >
                  {expandable && (
                    <span className="tree-caret">{expanded.has(n.id) ? "▾" : "▸"}</span>
                  )}
                  <span className="tree-label">{n.label}</span>
                  {isCited && <span className="tree-cited" title="已帶入對話">⊹</span>}
                  <span className="tree-kind">{n.kindEn}</span>
                  {occId && (
                    <span
                      className="tree-eye"
                      data-state={eye}
                      title={
                        eye === "solid"
                          ? "顯示中 · 點擊轉半透明(透視)"
                          : eye === "ghost"
                            ? "半透明中(點擊穿透) · 點擊轉隱藏"
                            : "已隱藏 · 點擊恢復顯示"
                      }
                      onClick={(e) => {
                        e.stopPropagation(); // 別觸發整列的圈選/展開
                        onCycleDisplay?.(occId);
                      }}
                    >
                      {eye === "solid" ? "●" : eye === "ghost" ? "◍" : "○"}
                    </span>
                  )}
                </a>
              );
            })}
            {nodes.length === 0 && <span className="tree-empty">尚無拓撲資料</span>}
          </div>
        </div>

        {sel && (
          <>
            <div className="props-sel-head">
              <div className="props-sel-titles">
                <span className="props-sel-name">{sel.label}</span>
                <span className="props-sel-kind">{sel.kindEn}</span>
              </div>
              {selRef && (
                <a
                  className="props-bring"
                  data-cited={cited.has(selRef) || undefined}
                  onClick={() => onBringToChat(selRef, sel.label)}
                >
                  {cited.has(selRef) ? "✓ 已帶入" : "⊹ 帶入對話"}
                </a>
              )}
            </div>

            <PropGroup title="幾何衍生 · DERIVED" hint="一定有" barColor="var(--part)" rows={derived} />
            {engineering.length > 0 && (
              <PropGroup
                title="工程標註 · ENGINEERING"
                hint="可能缺"
                barColor="var(--amber)"
                rows={engineering}
                muted
              />
            )}
            <PropGroup title="來源 / 驗證 · PROVENANCE" barColor="var(--ink)" rows={provenance} />
          </>
        )}
      </div>
    </div>
  );
}

function PropGroup({ title, hint, barColor, rows, muted }) {
  return (
    <div className="prop-group">
      <div className="prop-group-head">
        <span className="bar" style={{ background: barColor, height: 12 }} />
        <span className="prop-group-title">{title}</span>
        {hint && <span className="prop-group-hint">{hint}</span>}
      </div>
      <div className="prop-rows">
        {rows.map((r, i) => (
          <div className="prop-row" key={i}>
            <span className="prop-k">{r.k}</span>
            <span className={`prop-v${muted ? " muted" : ""}`}>{r.v}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
