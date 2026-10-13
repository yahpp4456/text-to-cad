// DOM 層繁→簡轉換:MutationObserver 盯 #root,把文字節點與 title/placeholder/aria-label/alt
// 屬性即時轉成簡體。選這條路而不是 React 層 t():850 條 UI 字串散在 48 檔,加上 SSE 送來
// 的伺服端繁中 error/label/note,只有 DOM 層能全覆蓋且不抽字串。
// 不碰 React state,所以協定字串(CABLE_SPEC_PREFIX、clarify regex 比對的 chip 值)天然安全。
//
// 排除:使用者輸入(textarea/input/select 的值、.composer 整塊)、使用者原話氣泡
// (.user-bubble/.user-ref)、程式碼(code/pre/kbd)、script/style、[data-no-convert]。
// AI 回覆氣泡(.msg-ai)刻意**不排除**(CONVERT_AI_BUBBLE):Phase 1 AI 仍回繁中,排除會
// 「UI 簡、回覆繁」混排;Phase 2 AI 改簡中後轉換是冪等 no-op。
// 防自觸發:記下自己寫進去的值,characterData 事件值相同就跳過,批次後 takeRecords()。
import { convertText, converterReady, hasCjk } from "./zhConvert.js";

export const CONVERT_AI_BUBBLE = true;

const BASE_EXCLUDE = ["script", "style", "code", "pre", "kbd", ".user-bubble", ".user-ref", ".composer", "[data-no-convert]"];
if (!CONVERT_AI_BUBBLE) BASE_EXCLUDE.push(".msg-ai");
// 文字節點:表單元素的「值」不能動
export const EXCLUDE_SELECTOR = ["textarea", "input", "select", ...BASE_EXCLUDE].join(",");
// 屬性(title/placeholder…):表單元素的 placeholder 是 UI 文案,要轉
export const EXCLUDE_ATTR_SELECTOR = BASE_EXCLUDE.join(",");
export const ATTRS = ["title", "placeholder", "aria-label", "alt"];

export function installDomConverter(root = typeof document !== "undefined" ? document.getElementById("root") : null) {
  if (!root || typeof MutationObserver === "undefined" || !converterReady()) return () => {};

  const writtenText = new WeakMap(); // Text → 我們最後寫入的值
  const writtenAttr = new WeakMap(); // Element → {attr: value}
  const pendingText = new Set();
  const pendingEl = new Set();
  let scheduled = false;

  const excludedText = (node) => {
    const p = node.parentElement;
    return !p || !!p.closest(EXCLUDE_SELECTOR);
  };
  const excludedAttr = (el) => !!el.closest(EXCLUDE_ATTR_SELECTOR);

  function convertTextNode(node) {
    const cur = node.data;
    if (!cur || !hasCjk(cur) || excludedText(node)) return;
    if (writtenText.get(node) === cur) return; // 自己寫的
    const out = convertText(cur);
    if (out !== cur) {
      writtenText.set(node, out);
      node.data = out;
    }
  }

  function convertAttrs(el) {
    if (excludedAttr(el)) return;
    let rec = writtenAttr.get(el);
    for (const a of ATTRS) {
      if (!el.hasAttribute(a)) continue;
      const cur = el.getAttribute(a);
      if (!hasCjk(cur) || (rec && rec[a] === cur)) continue;
      const out = convertText(cur);
      if (out !== cur) {
        if (!rec) writtenAttr.set(el, (rec = {}));
        rec[a] = out;
        el.setAttribute(a, out);
      }
    }
  }

  function walk(el) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
    let n = tw.currentNode;
    while (n) {
      if (n.nodeType === Node.TEXT_NODE) convertTextNode(n);
      else if (n.nodeType === Node.ELEMENT_NODE) convertAttrs(n);
      n = tw.nextNode();
    }
  }

  function flush() {
    scheduled = false;
    for (const t of pendingText) if (t.isConnected) convertTextNode(t);
    for (const e of pendingEl) if (e.isConnected) walk(e);
    pendingText.clear();
    pendingEl.clear();
    observer.takeRecords(); // 丟掉自己寫入產生的紀錄
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    (typeof requestAnimationFrame === "function" ? requestAnimationFrame : (f) => setTimeout(f, 0))(flush);
  }

  const observer = new MutationObserver((records) => {
    for (const r of records) {
      if (r.type === "characterData") {
        if (r.target.nodeType === Node.TEXT_NODE) pendingText.add(r.target);
      } else if (r.type === "attributes") {
        if (r.target.nodeType === Node.ELEMENT_NODE) pendingEl.add(r.target);
      } else if (r.type === "childList") {
        for (const n of r.addedNodes) {
          if (n.nodeType === Node.TEXT_NODE) pendingText.add(n);
          else if (n.nodeType === Node.ELEMENT_NODE) pendingEl.add(n);
        }
      }
    }
    if (pendingText.size || pendingEl.size) schedule();
  });

  walk(root);
  observer.observe(root, {
    childList: true,
    subtree: true,
    characterData: true,
    attributes: true,
    attributeFilter: ATTRS,
  });
  return () => observer.disconnect();
}
