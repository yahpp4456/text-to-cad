// 繁→簡執行期轉換的術語例外表(單一真相源;前端 lib/zhConvert 與 server agent/hans 共用)。
// OpenCC twp→cn 會做字形+台灣詞彙替換(資料→数据、軟體→软件、專案→项目),大多是好事;
// 這裡只列「會轉錯」或「要指定譯法」的詞:
//   PROTECT:原樣保留(品牌名、不該被字形轉換動到的詞)
//   OVERRIDE:繁→指定簡(優先於 OpenCC 的結果)
// 機制:轉換前先把命中詞換成 PUA 佔位字元,轉完再還原(見 zhConvert.convertText)。
// 新增條目後補 zhConvert.test.js 案例。長詞要排前面的規則由 zhConvert 依長度排序處理。
export const PROTECT = [
  "穗鈅", // 品牌名;OpenCC 會變「穗钥」
  "SUIYAO",
];

export const OVERRIDE = {
  公釐: "毫米", // twp 給「公厘」,大陸慣用「毫米」
  步進馬達: "步进电机", // twp 給「步进马达」,大陸慣用「电机」
  // 候選(待 Sam 校,先不動):組合件→装配体、掃出→扫掠、擠出→拉伸、治具→工装/夹具
};

// 依長度降序(長詞先吃,避免「步進馬達」被「馬達」類短詞截斷),供 RegExp 交替用。
export function termList() {
  return [...new Set([...PROTECT, ...Object.keys(OVERRIDE)])].sort((a, b) => b.length - a.length);
}
