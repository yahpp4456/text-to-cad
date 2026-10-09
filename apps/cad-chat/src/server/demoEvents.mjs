// DEMO(展示身分)SSE 事件過濾:tool 事件的 code 欄位是 agent 寫的 build123d 產生器
// 原始碼(或 edits/params 摘要)。對 demo 不送——多看幾次就能歸納出產生器契約
// (PARAMS/INTENDED_CONTACT/MOTION/check_geometry 寫法),那是教訓庫養出來的 knowhow。
// 在 server 端剝掉,前端 ToolCard 的「展開 原始碼」只是 UX 配套,不是邊界。
// artifact/present 事件的 code 是檔名 stem(cube.step 的 "cube"),不是原始碼,照送。
export function demoEventFilter(demo) {
  if (!demo) return (event, data) => data;
  return (event, data) => {
    if (event === "tool" && data && typeof data === "object" && "code" in data) {
      const { code: _omit, ...rest } = data;
      return rest;
    }
    return data;
  };
}
