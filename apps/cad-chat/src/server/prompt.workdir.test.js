// buildSystemPrompt × 工作區路徑(node --test):提示面必須用絕對路徑 workdirAbs。
// 背景:agent 的 cwd 是 RUNTIME_ROOT(runner.mjs),而產物在 DATA_ROOT 下;雙根部署
// (CADCHAT_DATA_ROOT≠RUNTIME_ROOT,如 VM 的 /opt/cadchat/data vs /opt/cadchat/repo)
// 時 DATA_ROOT 相對的 workdirRel 會被解析到錯的根,agent 的 Read 全數 File does not
// exist。開發機兩根相同,這個缺陷只有本測試擋得住——別把 wd 改回 workdirRel。
import test from "node:test";
import assert from "node:assert/strict";
import { buildSystemPrompt } from "./agent/prompt.mjs";

const session = {
  workdirAbs: "/data-root/users/test/models/.cadchat/s_test",
  workdirRel: "users/test/models/.cadchat/s_test",
  imports: ["imported/x.step"],
  rehydratedFrom: "stewart",
  lastName: "stewart",
};

test("提示面用 workdirAbs,不落 DATA_ROOT 相對路徑", () => {
  const out = buildSystemPrompt(session);
  assert.ok(out.includes(`${session.workdirAbs}/`), "工作區段應含絕對路徑");
  assert.ok(
    out.includes(`Read ${session.workdirAbs}/stewart.py`),
    "rehydrate 段的 Read 目標應為絕對路徑",
  );
  assert.ok(
    !out.includes(`\`${session.workdirRel}/\``) &&
      !out.includes(`Read ${session.workdirRel}/`),
    "不得再出現裸 workdirRel 路徑(agent cwd 下解析不到)",
  );
});

test("舊測試假 session(無 workdirAbs)仍以 workdirRel 退場,不炸 undefined", () => {
  const out = buildSystemPrompt({ workdirRel: "models/.cadchat/s_x", imports: [] });
  assert.ok(out.includes("models/.cadchat/s_x/"));
  assert.ok(!out.includes("undefined/"));
});
