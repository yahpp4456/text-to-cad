import React, { useEffect, useRef, useState } from "react";

// 輸入框高度:未手動調整時隨內容自動長高(上限 AUTO_MAX);使用者抓上緣拖曳後
// 記住固定高度(localStorage 跨重整),雙擊把手還原自動模式。
const H_KEY = "cadchat.composer.h";
const H_MIN = 64;
const AUTO_MAX = 240;
const hMax = () => Math.min(Math.round(window.innerHeight * 0.6), 480);
const clampH = (h) => Math.max(H_MIN, Math.min(hMax(), h));

export default function Composer({
  running,
  mode, // "design" | "sketch" | "library":placeholder 換文案 + 附件收檔範圍(library 才收 STEP)
  locked = false, // 零件庫硬閘:新對話未附 STP 前鎖定打字/送出(附件鈕/拖放仍開=解鎖的路)
  lockedHint, // 鎖定時的 placeholder 覆寫(DEMO:硬閘不是「先上傳就能開始」而是不開放)
  attachDisabled = false, // DEMO:附件鈕照常渲染但禁用(拖放/貼上一併 no-op)
  attachDisabledTip,
  pickRefs = [],
  pendingFiles = [], // [{id,kind:"image"|"step",name,url,status:"uploading"|"ready"|"error",error?}] 附件 chips
  onAttachFiles,
  onRemoveFile,
  prefill,
  onPrefillConsumed,
  onRemovePick,
  onClearPicks,
  onSubmit,
  onInterrupt,
}) {
  const [draft, setDraft] = useState("");
  // null = 自動長高;數字 = 使用者拖出的固定高度
  const [boxH, setBoxH] = useState(() => {
    const v = Number.parseInt(localStorage.getItem(H_KEY) || "", 10);
    return Number.isFinite(v) ? clampH(v) : null;
  });
  const inputRef = useRef(null);
  const fileRef = useRef(null);
  const uploading = pendingFiles.some((p) => p.status === "uploading");
  const hasFile = pendingFiles.some((p) => p.status === "ready");
  // 上傳中不可送(refs 還沒拿到 rel);純附件無文字可送;硬閘鎖定時不可送
  const canSend = !running && !uploading && !locked && (draft.trim().length > 0 || hasFile);
  // library 模式才收 STEP(檔名判,拖放/貼上的 File.type 對 .step 常是空字串)
  const acceptsStep = mode === "library";
  const wantFile = (f) =>
    f && (f.type.startsWith("image/") || (acceptsStep && /\.ste?p$/i.test(f.name || "")));

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

  // 高度套用:固定模式直接設;自動模式量 scrollHeight(先歸零再量,縮短也會跟著縮)
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    if (boxH != null) {
      el.style.height = `${boxH}px`;
    } else {
      el.style.height = "auto";
      el.style.height = `${Math.max(H_MIN, Math.min(el.scrollHeight, AUTO_MAX))}px`;
    }
  }, [draft, boxH]);

  // 抓上緣拖曳調高(pointer capture:拖出把手範圍也不掉);放開才落盤
  const onResizeDown = (e) => {
    e.preventDefault();
    const el = inputRef.current;
    if (!el) return;
    const startY = e.clientY;
    const startH = el.getBoundingClientRect().height;
    const handle = e.currentTarget;
    handle.setPointerCapture?.(e.pointerId);
    const move = (ev) => setBoxH(clampH(startH + (startY - ev.clientY)));
    const up = (ev) => {
      handle.removeEventListener("pointermove", move);
      handle.removeEventListener("pointerup", up);
      const h = clampH(startH + (startY - ev.clientY));
      setBoxH(h);
      localStorage.setItem(H_KEY, String(h));
    };
    handle.addEventListener("pointermove", move);
    handle.addEventListener("pointerup", up);
  };
  const resetResize = () => {
    setBoxH(null);
    localStorage.removeItem(H_KEY);
  };

  const submit = () => {
    const text = draft.trim();
    if ((!text && !hasFile) || running || uploading || locked) return;
    onSubmit(text);
    setDraft("");
  };

  // 貼上附件(Ctrl+V 截圖/複製的檔案)→ 走同一條附件上傳路徑
  // 附件三路(點鈕/拖放/貼上)共用同一開關:禁用時全部 no-op,鈕仍在畫面上。
  const canAttach = !!onAttachFiles && !attachDisabled;

  const onPaste = (e) => {
    if (!canAttach) return;
    const files = Array.from(e.clipboardData?.items || [])
      .filter((it) => it.kind === "file")
      .map((it) => it.getAsFile())
      .filter(wantFile);
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
      onDragOver={canAttach ? (e) => e.preventDefault() : undefined}
      onDrop={
        canAttach
          ? (e) => {
              e.preventDefault();
              const files = Array.from(e.dataTransfer?.files || []).filter(wantFile);
              if (files.length) onAttachFiles(files);
            }
          : undefined
      }
    >
      <div
        className="composer-resize"
        title="拖曳調整輸入框高度(雙擊還原自動)"
        onPointerDown={onResizeDown}
        onDoubleClick={resetResize}
      >
        <span className="composer-resize-grip" />
      </div>
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
      {pendingFiles.length > 0 && (
        <div className="img-chips">
          {pendingFiles.map((im) => (
            <span className="img-chip" key={im.id} data-status={im.status} data-kind={im.kind || "image"}>
              {im.kind === "step" ? (
                <span className="img-ph" aria-hidden="true">▤</span>
              ) : im.url ? (
                <img src={im.url} alt="" />
              ) : (
                <span className="img-ph" />
              )}
              <span className="img-name" title={im.error || im.name}>
                {im.status === "error" ? `⚠ ${im.name}` : im.name}
              </span>
              <a className="pick-clear" onClick={() => onRemoveFile?.(im.id)}>
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
              accept={
                acceptsStep
                  ? "image/png,image/jpeg,image/webp,image/gif,.step,.stp"
                  : "image/png,image/jpeg,image/webp,image/gif"
              }
              multiple
              style={{ display: "none" }}
              onChange={(e) => {
                if (e.target.files?.length) onAttachFiles(e.target.files);
                e.target.value = ""; // 清掉才能重選同一檔
              }}
            />
            <a
              className="composer-btn attach"
              data-disabled={attachDisabled || undefined}
              title={
                attachDisabled
                  ? attachDisabledTip
                  : acceptsStep
                    ? "附加 STP / 圖片(也可直接貼上 / 拖放)"
                    : "附加圖片(也可直接貼上 / 拖放)"
              }
              onClick={attachDisabled ? undefined : () => fileRef.current?.click()}
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
          disabled={locked}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={onKey}
          onPaste={onPaste}
          placeholder={
            locked
              ? lockedHint || "先上傳 STP 才能開始:拖放到這裡,或點 ⌲ 選檔…"
              : mode === "sketch"
                ? "描述機構構想,幾秒搭出可玩草模（Enter 送出）…"
                : mode === "library"
                  ? "送出開始收庫訪談;可先補充型號/備註（Enter 送出）…"
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
