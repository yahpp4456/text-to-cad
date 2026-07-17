// 零件庫 family 分類的單一真相源，供 FileBrowser 下拉、agent 工具 z.enum
// 與 prompt 分類表共用。
// 本清單刻意與 cadpy.parts 產生器家族同名對齊（linear_guide 對 linear_guide），
// agent 靠同詞彙對映「庫有現成庫件 vs 用產生器生一個」；新增分類時優先沿用
// 產生器家族名，勿另造近義詞。
export const LIBRARY_FAMILIES = [
  "cylinder",
  "bearing",
  "stepper",
  "linear_guide",
  "ball_screw",
  "gripper",
  "gear",
  "motor",
  "other",
];
