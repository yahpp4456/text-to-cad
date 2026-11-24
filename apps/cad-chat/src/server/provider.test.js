import test from "node:test";
import assert from "node:assert/strict";
import { prepareHandoff, importHistory, remember } from "./handoff.mjs";
import { CODEX_EFFORT, providerFor } from "./provider.mjs";
import { queryFiles } from "./agent/codexFiles.mjs";
import { REPO_ROOT } from "./config.mjs";
import path from "node:path";

test("legacy Claude resume, Codex → Claude → Codex uses latest work", () => {
  const s = {
    sdkSessionId: "old-claude",
    version: 1,
    lastName: "bracket",
    workdirAbs: "fixtures",
  };
  importHistory(s, [{ type: "user", text: "Left holes are mounting holes" }]);
  assert.equal(prepareHandoff(s, "claude"), "");
  assert.equal(s.sdkSessionId, "old-claude");
  assert.match(prepareHandoff(s, "codex"), /Left holes/);
  assert.equal(s.sdkSessionId, null);
  s.sdkSessionId = "codex-thread";
  assert.equal(prepareHandoff(s, "codex"), "");
  remember(s, "user", "8 mm mounting holes");
  s.version = 2;
  assert.match(prepareHandoff(s, "claude"), /v2.*bracket\.py[\s\S]*8 mm/);
  s.sdkSessionId = "new-claude";
  assert.match(prepareHandoff(s, "codex"), /8 mm/);
  assert.equal(s.sdkSessionId, null);
});

test("Codex effort is high for every local mode and demo uses Claude", () => {
  const previous = process.env.CADCHAT_PROVIDER;
  try {
    process.env.CADCHAT_PROVIDER = "codex";
    assert.equal(providerFor(), "codex");
    assert.equal(CODEX_EFFORT, "high");
    assert.equal(providerFor(true), "claude");
  } finally {
    if (previous === undefined) delete process.env.CADCHAT_PROVIDER;
    else process.env.CADCHAT_PROVIDER = previous;
  }
});

test("Codex text tools can read skills and reject other sessions or repo configuration", async () => {
  const s = {
    workdir: path.join(REPO_ROOT, "models/.cadchat/provider-unit"),
    modelsRoot: path.join(REPO_ROOT, "models"),
  };
  const signal = new AbortController().signal;
  const read = (file_path) =>
    queryFiles("Read", { file_path, limit: 2 }, s, signal);
  assert.match(await read("skills/cad/SKILL.md"), /---/);
  await assert.rejects(read("apps/cad-chat/.env.local"), /越界/);
  await assert.rejects(read("models/.cadchat/another/session.json"), /越界/);
  await assert.rejects(
    queryFiles("Glob", { path: ".", pattern: "**/*.py" }, s, signal),
    /越界/,
  );
});
