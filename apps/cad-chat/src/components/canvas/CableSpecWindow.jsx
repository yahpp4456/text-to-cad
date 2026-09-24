import React, { useEffect, useRef, useState } from "react";

import NumberField from "../NumberField.jsx";
import { apiUrl } from "@/lib/apiBase";
import {
  canSkipAi,
  derivedNote,
  defsWithLayers,
  describeBands,
  layerEditable,
  paramsWithLayers,
  screwFromTop,
  screwLabel,
  specWithBand,
  specWithLayers,
  specWithScrew,
} from "@/lib/cableSpec";

// 無塵電纜規格表單(蓋在 3D 上的浮動雙欄視窗;觸發=工作台點範本/案件卡)。
// 左欄=可改的驅動尺寸(NumberField,範圍來自產生器 PARAM_RANGES,與底部滑桿
// 同一份 defs);右欄=範本固定住的結構(層數/帶表/加高模組,唯讀)+ 量法宣告
// + 「我不確定量法」+「給 AI 的修改說明」。
// 兩顆鈕:
//   ▶ 直接生成  零 LLM:open-project 帶 params,一次 build 就是要的配置。
//              canSkipAi 不成立時禁用並在 title 說原因。
//   ✎ 給 AI 確認 把規格組成「電纜規格:」契約文字預填 composer(先過目再送)。
// clarify 待答時整個讓位(由 Canvas3D 的 !clarify 守衛),草稿在 store 不會丟。
export default function CableSpecWindow({
  form,
  busy,
  onValue,
  onPatch,
  onClose,
  onGenerate,
  onAskAi,
}) {
  // 即時閉式檢核:改值 → 300ms 防抖 → POST /api/cable/check(spawn OCP-free
  // cadpy.parts.cable_spec ~0.3s)。**與 build 時的 _check_params 同一份實作**,
  // 所以不會「表單綠、build 紅」;沒有它,跨參數耦合(層長差、直段容納板深)
  // 要等 1–2 分鐘 build 失敗才知道。
  const [live, setLive] = useState(null); // {issues, derived} | null
  const [checking, setChecking] = useState(false);
  const valuesKey = JSON.stringify(form?.values || {});
  const specKey = form?.specDirty && form?.spec ? JSON.stringify(form.spec) : "";
  const dir = form?.dir || "";
  const aliveRef = useRef(true);
  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);
  useEffect(() => {
    if (!dir) return undefined;
    let cancelled = false;
    setChecking(true);
    const t = setTimeout(async () => {
      try {
        const r = await fetch(apiUrl("/api/cable/check"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            dir,
            params: JSON.parse(valuesKey),
            ...(specKey ? { spec: JSON.parse(specKey) } : {}),
          }),
        });
        const j = await r.json();
        if (!cancelled && aliveRef.current) setLive(j.ok ? j : null);
      } catch {
        if (!cancelled && aliveRef.current) setLive(null); // 端點掛了不擋人:退回單欄範圍檢查
      } finally {
        if (!cancelled && aliveRef.current) setChecking(false);
      }
    }, 300);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [dir, valuesKey, specKey]);

  if (!form) return null;
  const liveIssues = live?.issues || [];
  const issueFor = (key) => liveIssues.find((i) => i.key === key) || null;
  const skip = canSkipAi(form, liveIssues);
  const spec = form.spec || null;
  const layers = Number(spec?.layers ?? form.layers);
  const bands = describeBands(spec?.bands || form.bands);
  const riser = Number(spec?.riser_module ?? form.riserModule);
  // 結構改動(層數/帶型)= 一組新的 CABLE_SPEC + 跟著調整的 PARAMS;兩者一起 patch
  const editSpec = (nextSpec, nextValues) =>
    onPatch?.({
      spec: nextSpec,
      specDirty: true,
      ...(nextValues ? { values: nextValues } : {}),
      error: null,
    });
  const setLayers = (n) => {
    if (!spec || !Number.isInteger(n) || n < 1 || n > 8 || n === layers) return;
    const nextValues = paramsWithLayers(form.values, layers, n);
    // defs 也要跟著長/縮——表單渲染的是 defs,只改 values 新的 L 鍵不會出現欄位
    onPatch?.({
      spec: specWithLayers(spec, n),
      specDirty: true,
      values: nextValues,
      defs: defsWithLayers(form.defs, layers, n, nextValues),
      error: null,
    });
  };
  // 派生數字:端點回來的用閉式(彎徑/包絡),沒回來就先用表單自己算得出的那兩項
  const r2 = (n) => Math.round(Number(n) * 100) / 100; // 顯示用:閉式回 4 位太吵
  const derived = live?.derived
    ? [
        `總高 ${r2(live.derived.height)}`,
        `包絡長 ${r2(live.derived.envelopeLength)}`,
        `彎徑 ${live.derived.layers.map((l) => r2(l.bendR)).join(" / ")}`,
      ]
    : derivedNote(form);
  const disabled = !!busy;

  return (
    <div className="sweep-window cable-window" data-form={form.dir}>
      <div className="sweepwin-head">
        <span className="sweepwin-title">
          ⌒ 規格表單 · {form.label}
          {form.source === "case" ? "(複製成新案)" : ""}
        </span>
        <a className="sweepwin-close" onClick={onClose} title="關閉(草稿保留到重選範本)">
          ✕
        </a>
      </div>
      <div className="cablewin-body">
        <div className="cablewin-col">
          <span className="sweepwin-eyebrow">
            可改 · 驅動尺寸{checking ? " · 檢核中…" : liveIssues.length ? ` · ${liveIssues.length} 項不符` : ""}
          </span>
          {(form.defs || []).map((d) => {
            const bad = issueFor(d.key);
            const fix = bad && (Number.isFinite(bad.min) ? bad.min : Number.isFinite(bad.max) ? bad.max : null);
            return (
              <div className="cable-field" key={d.key} data-key={d.key} data-bad={bad ? "1" : undefined}>
                <div className="cable-field-head">
                  <span className="cable-field-label">{form.labels?.[d.key] || d.key}</span>
                  <span className="cable-field-key">{d.key}</span>
                </div>
                <NumberField
                  def={d}
                  value={form.values?.[d.key]}
                  disabled={disabled}
                  onCommit={(key, value) => onValue?.(key, value)}
                />
                {bad ? (
                  <span className="cable-field-bad">
                    {bad.message}
                    {fix !== null && (
                      <a
                        className="cable-fix"
                        onClick={disabled ? undefined : () => onValue?.(d.key, fix)}
                        title={`把 ${d.key} 套成 ${fix}`}
                      >
                        套用 {fix}
                      </a>
                    )}
                  </span>
                ) : (
                  form.notes?.[d.key] && <span className="cable-field-note">{form.notes[d.key]}</span>
                )}
              </div>
            );
          })}
        </div>
        <div className="cablewin-col">
          <span className="sweepwin-eyebrow">結構 · 層數與帶型{form.specDirty ? " · 已改" : ""}</span>
          <div className="cable-fixed">
            {Number.isFinite(layers) && (
              <div className="cable-fixed-row">
                <span className="cable-fixed-k">層數</span>
                <span className="cable-fixed-v cable-layers">
                  {spec ? (
                    <>
                      <a
                        className="cable-step"
                        data-disabled={disabled || layers <= 1 || undefined}
                        title="砍掉最外層(該層的 L 鍵一起消失)"
                        onClick={disabled ? undefined : () => setLayers(layers - 1)}
                      >
                        −
                      </a>
                      <b>{layers}</b> 層
                      <a
                        className="cable-step"
                        data-disabled={disabled || layers >= 8 || undefined}
                        title={`在最外側加一層(既有各層的 L 編號不變,新層是 L${layers + 1})`}
                        onClick={disabled ? undefined : () => setLayers(layers + 1)}
                      >
                        ＋
                      </a>
                      <span className="cable-fixed-hint">加/減都在最外側,既有 L 編號不變</span>
                    </>
                  ) : (
                    `${layers} 層(此範本沒有 CABLE_SPEC,層數要用對話改)`
                  )}
                </span>
              </div>
            )}
            {bands.map((b) => {
              const canEdit = spec && layerEditable(spec, b.level);
              const row = (spec?.bands || []).find((x) => Number(x.level) === b.level) || {};
              return (
                <div className="cable-fixed-row" key={b.level} data-level={b.level}>
                  <span className="cable-fixed-k">{b.label} 護套</span>
                  <span className="cable-fixed-v">
                    {canEdit ? (
                      <span className="cable-band-edit">
                        <input
                          className="cable-band-n"
                          type="number"
                          min={1}
                          max={16}
                          step={1}
                          disabled={disabled}
                          value={row.n ?? ""}
                          onChange={(e) =>
                            editSpec(specWithBand(spec, b.level, { n: Number(e.target.value) }))
                          }
                        />
                        袋 ×
                        <input
                          className="cable-band-bore"
                          type="number"
                          min={4}
                          max={60}
                          step={0.1}
                          disabled={disabled}
                          value={row.bore ?? ""}
                          onChange={(e) =>
                            editSpec(specWithBand(spec, b.level, { bore: Number(e.target.value) }))
                          }
                        />
                        mm
                      </span>
                    ) : (
                      <>
                        {b.text}
                        {b.count > 1 ? "(並排窄條:寬度/位置要用對話改)" : ""}
                      </>
                    )}
                  </span>
                </div>
              );
            })}
            {Number.isFinite(riser) && (
              <div className="cable-fixed-row">
                <span className="cable-fixed-k">加高模組</span>
                <span className="cable-fixed-v">固定架由下數第 {riser + 1} 格</span>
              </div>
            )}
            {/* 固定座安裝面:客戶抓過 X 的 OEM STEP 螺絲建反 → 升格成可確認/可
                翻轉的欄位,不再默默信檔案姿態 */}
            {spec && (
              <div className="cable-fixed-row" data-screw={screwFromTop(spec)}>
                <span className="cable-fixed-k">固定座螺向</span>
                <span className="cable-fixed-v">
                  {screwLabel(screwFromTop(spec))}
                  <a
                    className="cable-fix cable-screw-flip"
                    data-disabled={disabled || undefined}
                    title="翻轉螺絲方向(實裝標準=六角螺帽袋朝下、埋頭圓孔朝上)"
                    onClick={
                      disabled
                        ? undefined
                        : () => editSpec(specWithScrew(spec, 1 - screwFromTop(spec)))
                    }
                  >
                    翻轉
                  </a>
                </span>
              </div>
            )}
          </div>
          {form.specDirty && (
            <div className="cable-specdirty">
              結構已改(層數/帶型)——生成時會一併改寫產生器的 CABLE_SPEC。
            </div>
          )}
          {derived.length > 0 && (
            <div className="cable-derived">
              {derived.map((t) => (
                <span className="cable-derived-chip" key={t}>
                  {t}
                </span>
              ))}
            </div>
          )}
          <label className="cable-unsure">
            <input
              type="checkbox"
              checked={!!form.unsure}
              disabled={disabled}
              onChange={(e) => onPatch?.({ unsure: e.target.checked })}
            />
            <span>
              我不確定量法(L 含不含兩端夾持段 32.4、mount_h 是否量到下固定頭底面)
            </span>
          </label>
          <textarea
            className="cable-note"
            rows={2}
            disabled={disabled}
            placeholder="給 AI 的修改說明(選填):表單改不到的事,例如換帶型、改固定架樣式…"
            value={form.note || ""}
            onChange={(e) => onPatch?.({ note: e.target.value })}
          />
        </div>
      </div>
      {form.error && <div className="cable-error">{form.error}</div>}
      <div className="cablewin-foot">
        <a
          className="cable-btn cable-btn-primary"
          data-disabled={!skip.ok || disabled || undefined}
          title={skip.ok ? "不經 AI,直接算幾何(約 1–2 分鐘)" : skip.reason}
          onClick={skip.ok && !disabled ? () => onGenerate?.() : undefined}
        >
          {busy ? "生成中…" : "▶ 直接生成"}
        </a>
        <a
          className="cable-btn"
          data-disabled={disabled || undefined}
          title="把規格組成文字預填到輸入框,你過目後再送給 AI"
          onClick={disabled ? undefined : () => onAskAi?.()}
        >
          ✎ 給 AI 確認
        </a>
        {!skip.ok && !disabled && <span className="cable-foot-hint">{skip.reason}</span>}
      </div>
    </div>
  );
}
