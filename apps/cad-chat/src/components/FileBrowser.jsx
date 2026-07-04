import React, { useEffect, useState } from "react";

import TypeBadge from "./TypeBadge.jsx";

// models/ 檔案瀏覽器 overlay:開檔看圖(免 LLM)。
// onOpenFile(res):/api/open 成功回應 → App dispatch ADD_VERSION+PRESENT。
// onImportFile / onOpenProject:階段 C 掛入(未提供就不顯示對應按鈕)。
export default function FileBrowser({ open, onClose, onOpenFile, onImportFile, onOpenProject }) {
  const [dir, setDir] = useState("");
  const [entries, setEntries] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(""); // 進行中動作的 rel(顯示 spinner 字樣)
  const [kindPick, setKindPick] = useState(null); // 待選 kind 的 step rel

  useEffect(() => {
    if (!open) return;
    setError("");
    setKindPick(null);
    fetch(`/api/files?dir=${encodeURIComponent(dir)}`)
      .then((r) => r.json())
      .then((j) => {
        if (j.ok) setEntries(j.entries || []);
        else setError(j.error || "列目錄失敗");
      })
      .catch(() => setError("無法連線到本機伺服器"));
  }, [open, dir]);

  if (!open) return null;

  const openFile = async (rel, kind) => {
    setBusy(rel);
    setError("");
    try {
      const r = await fetch("/api/open", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: rel, kind }),
      });
      const j = await r.json();
      if (j.ok) {
        setKindPick(null);
        onOpenFile(j);
        onClose();
      } else if (j.error === "kind_required") {
        setKindPick(rel);
      } else {
        setError(j.error || "開啟失敗");
      }
    } catch {
      setError("無法連線到本機伺服器");
    }
    setBusy("");
  };

  const crumbs = dir ? dir.split("/") : [];
  const fmtSize = (n) =>
    n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} KB`;

  return (
    <div className="fb-overlay" onClick={onClose}>
      <div className="file-browser" onClick={(e) => e.stopPropagation()}>
        <div className="fb-head">
          <span className="bar bar-ink" />
          <div className="fb-titles">
            <span className="fb-eyebrow">MODELS / FILE BROWSER</span>
            <span className="fb-title">開啟檔案</span>
          </div>
          <a className="fb-close" onClick={onClose}>
            ✕
          </a>
        </div>

        <div className="fb-breadcrumb">
          <a className="fb-crumb" onClick={() => setDir("")}>
            models
          </a>
          {crumbs.map((c, i) => (
            <React.Fragment key={i}>
              <span className="fb-crumb-sep">/</span>
              <a className="fb-crumb" onClick={() => setDir(crumbs.slice(0, i + 1).join("/"))}>
                {c}
              </a>
            </React.Fragment>
          ))}
        </div>

        {error && <div className="fb-error">⚠ {error}</div>}

        <div className="fb-list">
          {entries.map((e) => (
            <div className="fb-row" key={e.rel} data-kind={e.kind}>
              {e.kind === "dir" ? (
                <>
                  <a className="fb-name fb-dir" onClick={() => setDir(e.rel)}>
                    ▸ {e.name}/
                  </a>
                  <span className="grow" />
                  {e.project && onOpenProject && (
                    <a className="fb-action" onClick={() => onOpenProject(e.rel)}>
                      開啟專案
                    </a>
                  )}
                </>
              ) : (
                <>
                  <span className="fb-name">
                    {e.name}
                    <TypeBadge type={e.type} />
                  </span>
                  <span className="fb-meta">
                    {e.kind === "step" && !e.hasGlb ? "未轉檔 · " : ""}
                    {fmtSize(e.size)}
                  </span>
                  <span className="grow" />
                  {kindPick === e.rel ? (
                    <span className="fb-kind-pick">
                      類型?
                      <a className="fb-action" onClick={() => openFile(e.rel, "part")}>
                        元件
                      </a>
                      <a className="fb-action" onClick={() => openFile(e.rel, "assembly")}>
                        組合件
                      </a>
                    </span>
                  ) : (
                    <>
                      <a className="fb-action" onClick={() => !busy && openFile(e.rel)}>
                        {busy === e.rel ? "處理中…" : "開啟"}
                      </a>
                      {e.kind === "step" && onImportFile && (
                        <a className="fb-action" onClick={() => !busy && onImportFile(e.rel)}>
                          匯入場景
                        </a>
                      )}
                    </>
                  )}
                </>
              )}
            </div>
          ))}
          {entries.length === 0 && !error && <div className="fb-empty">此目錄沒有可開啟的檔案</div>}
        </div>

        <div className="fb-foot">
          僅列 models/ 下的 .step / .glb · 裸 STEP 首次開啟會轉檔(數秒~數十秒)
        </div>
      </div>
    </div>
  );
}
