import test from "node:test";
import assert from "node:assert/strict";
import { prepareHandoff, importHistory, remember } from "./handoff.mjs";
import fs from "node:fs";
import os from "node:os";
import { acquireCodexSlot, CODEX_EFFORT, demoProvider, providerFor, resolveCodexMaxTurns, teamProvider } from "./provider.mjs";
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

test("provider selection: desktop, team, demo", () => {
  function withProviderEnv(values, check) {
    const keys = ["CADCHAT_PROVIDER", "CADCHAT_DEMO_PROVIDER", "CADCHAT_TEAM_PROVIDER", "CADCHAT_CODEX_STATE_FILE"];
    const previous = Object.fromEntries(keys.map(key => [key, process.env[key]]));
    try {
      for (const key of keys) {
        if (values[key] === undefined) delete process.env[key];
        else process.env[key] = values[key];
      }
      check();
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }
  withProviderEnv({ CADCHAT_PROVIDER: "codex" }, () => {
    assert.equal(providerFor(), "codex");
    assert.equal(CODEX_EFFORT, "high");
    assert.equal(providerFor({ user: true }), "claude");
    assert.equal(providerFor({ user: true, demo: true }), "claude");
  });
  withProviderEnv({ CADCHAT_DEMO_PROVIDER: "codex" }, () => {
    assert.equal(providerFor({ user: true, demo: true }), "codex");
    assert.equal(providerFor({ user: true }), "claude");
    assert.equal(providerFor(), "claude");
  });
  // 團隊帳號:CADCHAT_TEAM_PROVIDER 獨立於 DEMO 與桌面版旗標
  withProviderEnv({ CADCHAT_TEAM_PROVIDER: "codex" }, () => {
    assert.equal(providerFor({ user: true }), "codex");
    assert.equal(providerFor({ user: true, demo: true }), "claude");
    assert.equal(providerFor(), "claude");
  });
  withProviderEnv({ CADCHAT_TEAM_PROVIDER: "codex", CADCHAT_DEMO_PROVIDER: "codex" }, () => {
    assert.equal(providerFor({ user: true }), "codex");
    assert.equal(providerFor({ user: true, demo: true }), "codex");
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-provider-"));
  try {
    const file = path.join(dir, "state.json");
    fs.writeFileSync(file, JSON.stringify({ status: "expired" }));
    withProviderEnv({ CADCHAT_DEMO_PROVIDER: "codex", CADCHAT_CODEX_STATE_FILE: file }, () => {
      assert.equal(providerFor({ user: true, demo: true }), "claude");
    });
    withProviderEnv({ CADCHAT_TEAM_PROVIDER: "codex", CADCHAT_CODEX_STATE_FILE: file }, () => {
      assert.equal(providerFor({ user: true }), "claude");
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("codex turn slots cap concurrent remote turns", () => {
  const env = { CADCHAT_CODEX_MAX_TURNS: "2" };
  const releases = [];
  function acquire() {
    const release = acquireCodexSlot(env);
    if (typeof release === "function") releases.push(release);
    return release;
  }
  try {
    const first = acquire();
    assert.equal(typeof first, "function");
    assert.equal(typeof acquire(), "function");
    assert.equal(acquire(), null);
    first();
    assert.equal(typeof acquire(), "function");
    first();
    assert.equal(acquire(), null);
  } finally {
    for (const release of releases) release();
  }
});

test("demoProvider / resolveCodexMaxTurns parsing", () => {
  assert.equal(demoProvider({ CADCHAT_DEMO_PROVIDER: " Codex " }), "codex");
  assert.equal(demoProvider({}), "claude");
  for (const value of ["claude", "other"])
    assert.equal(demoProvider({ CADCHAT_DEMO_PROVIDER: value }), "claude");
  assert.equal(teamProvider({ CADCHAT_TEAM_PROVIDER: " Codex " }), "codex");
  assert.equal(teamProvider({}), "claude");
  assert.equal(teamProvider({ CADCHAT_DEMO_PROVIDER: "codex" }), "claude");
  assert.equal(resolveCodexMaxTurns({}), 2);
  assert.equal(resolveCodexMaxTurns({ CADCHAT_CODEX_MAX_TURNS: "5" }), 5);
  for (const value of ["0", "-1", "abc", "1.5"])
    assert.equal(resolveCodexMaxTurns({ CADCHAT_CODEX_MAX_TURNS: value }), 2);
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
