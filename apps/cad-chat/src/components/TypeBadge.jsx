import React from "react";

// 檔案類型 badge:元件(part)/ 組合件(assembly)。type 未知時不 render(誠實)。
export default function TypeBadge({ type, partCount }) {
  if (type !== "part" && type !== "assembly") return null;
  const label = type === "assembly" ? "組合件" : "元件";
  const count = type === "assembly" && partCount > 1 ? ` · ${partCount} 件` : "";
  return (
    <span className="type-badge" data-type={type}>
      {label}
      {count}
    </span>
  );
}
