import React, { useEffect, useRef, useState } from "react";

export default function Composer({
  running,
  mode, // "design" | "sketch":placeholder 換文案(「我這句會產出什麼」的提示)
  pickRefs = [],
  pendingImages = [], // [{id,name,url,status:"uploading"|"ready"|"error",error?}] 附件縮圖 chips
  onAttachFiles,
  onRemoveImage,
  prefill,
  onPrefillConsumed,
  onRemovePick,
  onClearPicks,
  onSubmit,
  onInterrupt,
}) {
  const [draft, setDraft] = useState("");
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const uploading = pendingImages.some((p) => p.status === "uploading");
  const hasImg = pendingImages.some((p) => p.status === "ready");
  // 上傳中不可送(imageRefs 還沒拿到 rel);純圖無文字可送
  const canSend = !running && !uploading && (draft.trim().length > 0 || hasImg);

  // 點規格 chip → 預填草稿並聚焦,讓使用者接著打修正值。
  useEffect(() => {
    if (prefill == null) return;
    setDraft(prefill);
    onPrefillConsumed?.();
    const el = inputRef.current;
    if (el) {
      el.focus();
      requestAnimationFrame(() => el.setSelectionRange(el.value.length, el.value.length));
    }
  }, [prefill]);

  const submit = () => {
    const text = draft.trim();
    if ((!text && !hasImg) || running || uploading) return;
    onSubmit(text);
    setDraft("");
  };

  // 貼上圖片(Ctrl+V 截圖/複製的圖檔)→ 走同一條附件上傳路徑
  const onPaste = (e) => {
    if (!onAttachFiles) return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter((f) => f && f.type.startsWith("image/"));
    if (files.length) {
      e.preventDefault();
      onAttachFiles(files);
    }
  };

  const onKey = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="composer"
      onDragOver={onAttachFiles ? (e) => e.preventDefault() : undefined}
      onDrop={
        onAttachFiles
          ? (e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer?.files || []).filter((f) =>
                f.type.startsWith("image/"),
              );
              if (files.length) onAttachFiles(files);
            }
          : undefined
      }
    >
      {pickRefs.length > 0 && (
        <div className="pick-chips">
          {pickRefs.map((r) => (
            <span className="pick-chip" key={r.token}>
              ⊹ {r.label || r.token}
              <a className="pick-clear" onClick={() => onRemovePick?.(r.token)}>
                ✕
              </a>
            </span>
          ))}
          {pickRefs.length > 1 && (
            <a className="pick-clear-all" onClick={onClearPicks}>
              全部清除
            </a>
          )}
        </div>
      )}
      {pendingImages.length > 0 && (
        <div className="img-chips">
          {pendingImages.map((im) => (
            <span className="img-chip" key={im.id} data-status={im.status}>
              {im.url ? <img src={im.url} alt="" /> : <span className="img-ph" />}
              <span className="img-name" title={im.error || im.name}>
                {im.status === "error" ? `⚠ ${im.name}` : im.name}
              </span>
              <a className="pick-clear" onClick={() => onRemoveImage?.(im.id)}>
                ✕
              </a>
            </span>
          ))}
        </div>
      )}
      <div className="composer-row">
        {onAttachFiles && (
          <>
            <input
              ref={fileRef}
              type="file"
              className="composer-file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) onAttachFiles(e.target.files);
                e.target.value = ""; // 清掉才能重選同一檔
              }}
            />
            <a
              className="composer-btn attach"
              title="附加圖片(也可直接貼上 / 拖放)"
              onClick={() => fileRef.current?.click()}
            >
              ⌲
            </a>
          </>
        )}
        <textarea
          rows={1}
          ref={inputRef}
          className="composer-input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={
            mode === "sketch"
              ? "描述機構構想,幾秒搭出可玩草模（Enter 送出）…"
              : "描述零件,或追加修改（Enter 送出）…"
          }
        />
        {running ? (
          <a className="composer-btn interrupt" title="中斷" onClick={onInterrupt}>
            <span className="stop-square" />
          </a>
        ) : (
          <a
            className="composer-btn send"
            data-active={canSend}
            title={uploading ? "圖片上傳中…" : undefined}
            onClick={canSend ? submit : undefined}
          >
            ↑
          </a>
        )}
      </div>
    </div>
  );
}
