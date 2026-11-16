// 草模 ⇪ 轉為正式設計的 prefill 文字(純函數;App.jsx promoteSketch 消費)。
//
// 交接內容 = 從場景算出來的**機構定義本身**(關節軸與樞軸、定長連桿桿長、滑銷導線、
// 致動器行程、主要外形),全部是 home 姿態的世界座標,直接寫進文字。
//
// 為什麼不帶「原始場景檔路徑、叫 design agent 去 Read」(審查 F6 的第一版修法):
// 轉正式設計會開**新對話**,而讀取範圍硬閘(agent/readScope.mjs)拒絕讀其他對話的
// 資料夾——那個 Read 必被擋,agent 只剩 label+驅動範圍,連桿桿長/鉸點全丟,
// 等於退回 F6。把數字直接放進文字則與讀取範圍無關,使用者送出前也看得到、改得了。
import { anchorWorld, compileSketch, evalPose } from "./sketch/sketchEval.js";

const num = (x) => {
  const r = Math.round(Number(x) * 100) / 100;
  return Object.is(r, -0) ? "0" : String(r);
};
const vec = (v) => `(${v.map(num).join(", ")})`;

const PART_DESC = {
  box: (p) => `方塊 ${p.size.map(num).join("×")}`,
  plate: (p) => `板 ${p.size.map(num).join("×")} 厚 ${num(p.t)}`,
  cylinder: (p) => `圓柱 ø${num(p.r * 2)}×${num(p.len)}`,
  gear: (p) => `齒輪 模數 ${num(p.module)}、${p.teeth} 齒、寬 ${num(p.width)}`,
  rack: (p) => `齒條 模數 ${num(p.module)}、${p.count} 齒、寬 ${num(p.width)}`,
  pulley: (p) => `皮帶輪 ø${num(p.r * 2)}×${num(p.width)}`,
  belt: (p) => `皮帶 輪徑 ø${num(p.rA * 2)}/ø${num(p.rB * 2)}、寬 ${num(p.width)}`,
  motor: () => "馬達",
};

// 機構定義條列(compile 失敗回 null → 呼叫端退回只帶名稱的降級句)
function mechanismLines(doc) {
  let c;
  try {
    c = compileSketch(doc);
  } catch {
    return null;
  }
  const d = c.doc;
  const home = evalPose(c, c.homeDrives, c.attachInitials);
  const bodyLabel = (id) => c.bodiesById[id]?.label || id;
  const driveLabel = (id) => c.drivesById[id]?.label || id;
  const entLabel = (e) => e.look?.label || e.id;
  const anchorDesc = (a) => {
    if (a.point !== undefined) return `滑銷 ${a.point}`;
    if (a.body === "world") return `固定點 ${vec(a.at)}`;
    return `「${bodyLabel(a.body)}」上的點 ${vec(anchorWorld(home, a))}`;
  };
  // 行程取樣:每個 drive 掃 [min,max]、其餘停 home(致動器長度範圍用)
  const frames = [home];
  for (const dr of d.drives) {
    for (let i = 0; i <= 40; i += 1) {
      const v = dr.min + ((dr.max - dr.min) * i) / 40;
      frames.push(evalPose(c, { ...c.homeDrives, [dr.id]: v }, c.attachInitials));
    }
  }

  const lines = [];
  if (d.drives.length) {
    lines.push(
      "驅動:" + d.drives.map((dr) => `${dr.label || dr.id} ${num(dr.min)}~${num(dr.max)}${dr.unit || ""}`).join("、"),
    );
  }
  for (const b of d.bodies) {
    const j = b.joint;
    if (!j || j.type === "fixed") continue;
    const m = home.bodyWorld[b.id];
    const at = [m[12], m[13], m[14]];
    const ratio =
      (j.scale !== 1 ? `×${num(j.scale)}` : "") + (j.offset ? `${j.offset > 0 ? "+" : ""}${num(j.offset)}` : "");
    lines.push(
      j.type === "revolute"
        ? `關節:${bodyLabel(b.id)} 繞軸 ${vec(j.axis)} 旋轉,樞軸 ${vec(at)},跟隨 ${driveLabel(j.drive)}${ratio}`
        : `關節:${bodyLabel(b.id)} 沿 ${vec(j.axis)} 平移,基準點 ${vec(at)},跟隨 ${driveLabel(j.drive)}${ratio}`,
    );
  }
  for (const e of d.derived) {
    if (e.type === "pin_on_line") {
      lines.push(
        `滑銷 ${e.id}:沿直線(過 ${vec(e.line.origin)}、方向 ${vec(e.line.dir)})滑動,` +
          `與${anchorDesc(e.link.to)}保持定長 ${num(e.link.len)} mm;基準位置 ${vec(home.points[e.id])}`,
      );
    } else if (e.type === "coupler") {
      lines.push(
        `剛性連桿 ${entLabel(e)}:長 ${num(home.derivedPose[e.id].len)} mm,` +
          `連接${anchorDesc(e.from)}與${anchorDesc(e.to)}`,
      );
    } else if (e.type === "actuator") {
      const lens = frames.map((f) => f.derivedPose[e.id].len);
      const lo = Math.min(...lens);
      const hi = Math.max(...lens);
      lines.push(
        `伸縮致動器 ${entLabel(e)}:${anchorDesc(e.from)} → ${anchorDesc(e.to)},` +
          `安裝長度 ${num(lo)}~${num(hi)} mm(行程 ${num(hi - lo)} mm)`,
      );
    } else if (e.type === "attach") {
      lines.push(`工件 ${entLabel(e)}:狀態 ${Object.keys(e.states).join(" → ")}(起始 ${e.initial})`);
    }
  }
  const shapes = [];
  for (const b of d.bodies) {
    const descs = (b.parts || [])
      .filter((p) => PART_DESC[p.type])
      .slice(0, 3)
      .map((p) => PART_DESC[p.type](p));
    if (descs.length) shapes.push(`${bodyLabel(b.id)}=${descs.join("+")}`);
  }
  if (shapes.length) lines.push("主要外形(示意尺寸):" + shapes.join(";"));
  return lines;
}

export function buildPromoteText({ doc, fallbackName }) {
  const title = doc?.title || fallbackName || "sketch";
  const tail = "沿用上述關節配置、桿長與行程;截面、材料與軸承配置由你建議,先列規格再動工。";
  const lines = doc ? mechanismLines(doc) : null;
  if (!lines || !lines.length) {
    return (
      `照機構草模「${title}」做正式設計。草模的機構定義沒能自動帶入,` +
      "請先向我確認關節配置、鉸點位置、桿長與行程再動工,不要憑名稱推測。"
    );
  }
  return (
    `照機構草模「${title}」做正式設計。以下是草模已定案的機構定義(基準姿態的世界座標,mm、Z 朝上、角度為度),` +
    "照此沿用,不要重推:\n" +
    lines.map((l) => `- ${l}`).join("\n") +
    `\n${tail}`
  );
}
