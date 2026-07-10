import React from "react";

import { isAssumedChip, stripAssumedTag } from "../../lib/clarifyText.js";
import TypeBadge from "../TypeBadge.jsx";

function UserMsg({ it }) {
  return (
    <div className="msg-user">
      <div className="msg-user-col">
        {it.ref && <span className="user-ref">⊹ {it.ref}</span>}
        {it.images?.length > 0 && (
          <div className="user-imgs">
            {it.images.map((im, i) => (
              <img
                key={i}
                className="user-img"
                src={im.url}
                alt={im.name || "附圖"}
                title={im.name}
                // workdir 被 GC 後縮圖 404 → dashed 降級框,不炸版面
                onError={(e) => e.currentTarget.classList.add("broken")}
              />
            ))}
          </div>
        )}
        {(it.text || !it.images?.length) && (
          <div className="user-bubble">
            {it.text}
          </div>
        )}
      </div>
    </div>
  );
}

function AiMsg({ it }) {
  return (
    <div className="msg-ai">
      <span className="ai-avatar" />
      <div className={`ai-text${it.isError ? " ai-error" : ""}${it.streaming ? " streaming" : ""}`}>
        {it.text}
      </div>
    </div>
  );
}

function SpecCard({ it, onChipEdit }) {
  return (
    <div className="card spec-card">
      <div className="card-head">
        <span className="bar bar-design" />
        <span className="card-eyebrow">解析規格 · 可點擊修正</span>
      </div>
      <div className="spec-chips">
        {it.chips.map((c, i) => {
          // 「(假設)」剝字樣改 badge(assumed 旗標為主、文字慣例 fallback,視覺統一)
          const assumed = isAssumedChip(c);
          return (
            <a
              className="spec-chip"
              key={i}
              data-assumed={assumed || undefined}
              onClick={() => onChipEdit?.(c)}
            >
              <span className="chip-k">{c.k}</span>
              <span className="chip-v">{stripAssumedTag(c.v)}</span>
              {assumed && <span className="chip-assumed">假設</span>}
              <span className="chip-edit">✎</span>
            </a>
          );
        })}
      </div>
    </div>
  );
}

function PlanCard({ it, onToggle }) {
  return (
    <div className="card plan-card">
      <a className="card-head clickable" onClick={() => onToggle(it.id)}>
        <span className="bar bar-ink" />
        <span className="card-eyebrow grow">執行計畫 · {it.count} 步</span>
        <span className="card-toggle">{it.open ? "收合 ▾" : "展開 ▸"}</span>
      </a>
      {it.open && (
        <div className="plan-steps">
          {it.steps.map((s) => (
            <div className="plan-step" key={s.n}>
              <span className="plan-n">{s.n}</span>
              <span className="plan-t">{s.t}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ToolCard({ it, onToggle }) {
  const running = it.status === "running";
  const error = it.status === "error";
  const statusText = running ? "執行中" : error ? "失敗" : "完成";
  const accent = error ? "var(--danger)" : "var(--design)";
  return (
    <div className="card tool-card" style={{ "--ac": accent }}>
      <div className="card-head">
        <span className="tool-glyph">
          <span className="tool-glyph-dot" />
        </span>
        <div className="tool-titles">
          <span className="tool-name">{it.name}</span>
          <span className="tool-label">{it.label}</span>
        </div>
        {!running && it.ms != null && (
          <span className="tool-dur">{(it.ms / 1000).toFixed(1)} s</span>
        )}
        <span className="tool-status">{statusText}</span>
      </div>
      {running && <div className="tool-progress" />}
      {!running && it.code && (
        <>
          <a className="tool-logtoggle" onClick={() => onToggle(it.id)}>
            <span className="grow">{it.open ? "收合" : "展開"} 原始碼 / LOG</span>
            <span>{it.open ? "▾" : "▸"}</span>
          </a>
          {it.open && <pre className="tool-code">{it.code}</pre>}
        </>
      )}
      {it.note && error && <div className="tool-note">{it.note}</div>}
      {it.outputs && it.outputs.length > 0 && (
        <div className="tool-outputs">
          {it.outputs.map((f, i) => (
            <span className="out-pill" key={i}>
              ✓ {typeof f === "string" ? f : f.path}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function ValidateCard({ it }) {
  const accent = it.ok ? "var(--part)" : "var(--danger)";
  return (
    <div className="card validate-card" style={{ "--ac": accent }}>
      <div className="card-head validate-head">
        <span className="bar" style={{ background: accent }} />
        <span className="card-eyebrow grow">
          幾何驗證{it.attempt > 1 ? ` · 第 ${it.attempt} 次` : ""}
          {it.partCount > 1 ? ` · ${it.partCount} 件` : ""}
        </span>
        {it.ms != null && <span className="tool-dur">{(it.ms / 1000).toFixed(1)} s</span>}
        <span className="validate-verdict" style={{ color: accent }}>
          {it.ok ? "全部通過" : "偵測到問題"}
        </span>
      </div>
      <div className="validate-list">
        {it.checks.map((ck, i) => (
          <div className="validate-row" key={i}>
            <span className="check-icon" style={{ background: ck.color }}>
              {ck.icon}
            </span>
            <span className="check-label">{ck.label}</span>
            <span className="check-note" style={{ color: ck.color }}>
              {ck.note}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function RetryCard({ it }) {
  return (
    <div className="retry-card">
      <span className="retry-glyph">↻</span>
      <div className="retry-body">
        <span className="retry-eyebrow">自我修正 · 重生第 {it.attempt} 次</span>
        <span className="retry-reason">{it.reason}</span>
        {it.adjustment && <span className="retry-adjust">{it.adjustment}</span>}
      </div>
    </div>
  );
}

function ArtifactCard({ it, onSelectVersion }) {
  return (
    <div className="card artifact-card" style={{ "--ac": "var(--emit)" }}>
      <div className="artifact-poster">
        <span className="artifact-badge">{it.ver} · 完成</span>
        <span className="artifact-ghost">{it.ghost}</span>
      </div>
      <div className="artifact-body">
        <div className="artifact-titles">
          <span className="artifact-name">{it.name}</span>
          <span className="artifact-code">{it.code}</span>
        </div>
        <div className="artifact-foot">
          <TypeBadge type={it.fileType} partCount={it.partCount} />
          {it.formats.map((f) => (
            <span className="fmt-badge" key={f}>
              {f}
            </span>
          ))}
          <span className="grow" />
          <a className="artifact-open" onClick={() => onSelectVersion(it.ver)}>
            在 3D 開啟 ▸
          </a>
        </div>
      </div>
    </div>
  );
}

// 左欄澄清卡 = 被動紀錄(唯一作答面在視圖區的兩步精靈;答完 transcript 自然留下
// 「問題+選項紀錄 → 使用者氣泡(所選答案)」)。pending:是最後一張未答的 clarify。
function ClarifyCard({ it, pending }) {
  return (
    <div className="card clarify-card">
      <div className="card-head clarify-head">
        <span className="bar bar-emit" />
        <span className="card-eyebrow">需要澄清</span>
        {pending && <span className="clarify-live">作答中 · 請在右側畫布回答 ▸</span>}
      </div>
      <div className="clarify-body">
        <span className="clarify-q">{it.q}</span>
        <div className="clarify-opts">
          {it.opts.map((op, i) => (
            <span className="clarify-opt static" key={i}>
              {op.label}
            </span>
          ))}
          {it.suggested && (
            <span className="clarify-opt suggested static">採用建議:{it.suggested}</span>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Message({ it, handlers, pending }) {
  switch (it.type) {
    case "user":
      return <UserMsg it={it} />;
    case "ai":
      return <AiMsg it={it} />;
    case "spec":
      return <SpecCard it={it} onChipEdit={handlers.onChipEdit} />;
    case "plan":
      return <PlanCard it={it} onToggle={handlers.onToggle} />;
    case "tool":
      return <ToolCard it={it} onToggle={handlers.onToggle} />;
    case "validate":
      return <ValidateCard it={it} />;
    case "retry":
      return <RetryCard it={it} />;
    case "artifact":
      return <ArtifactCard it={it} onSelectVersion={handlers.onSelectVersion} />;
    case "clarify":
      return <ClarifyCard it={it} pending={pending} />;
    default:
      return null;
  }
}
