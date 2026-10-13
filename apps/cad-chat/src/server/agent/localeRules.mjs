// 系統提示的「文字系統」規則(繁體/簡體)。
// 原本的語言段只說「依使用者的語言回覆…預設繁體中文」,沒說簡繁是不同書寫系統,
// 模型多半把簡中使用者當「中文」照回繁中。這裡補一句明確規則;前端傳 locale=zh-Hans
// (runner 掛在 session._locale)時再補一句「本使用者介面是簡體,預設簡體」。
// 三份 prompt(design/cable 共用、sketch、library)都接在「預設繁體中文。」那句後面、
// 同段內插入;不碰 buildWordingSection(prompt.wording.test 釘住它的字面與結尾)。
export const SCRIPT_RULE =
  "**文字系統(簡體/繁體)也要跟使用者一致**——使用者打簡體中文就以簡體中文輸出(回覆、進度短句、" +
  "chips、question/options 全部),打繁體就用繁體;簡體與繁體是不同的書寫系統,不要用繁體回簡體的使用者。" +
  "系統自動加在訊息前後的括註與表單前綴不算使用者的語言線索。";

export const HANS_DEFAULT =
  "本使用者的介面語言設定為簡體中文:沒有明確語言線索時**預設簡體中文**(取代上面的繁體預設)。";

export function buildLanguageRules(session) {
  return SCRIPT_RULE + (session?._locale === "zh-Hans" ? `\n${HANS_DEFAULT}` : "");
}
