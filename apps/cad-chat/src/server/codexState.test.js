import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CODEX_STATE_MAX_AGE_MS, codexUsable, evaluateCodexState } from "./codexState.mjs";

const now = Date.parse("2026-11-20T00:00:00Z");
const ok = {
  status: "ok",
  checkedAt: new Date(now).toISOString(),
  activeUntil: "2026-11-21T00:00:00Z",
};

test("evaluateCodexState checks status, expiry and freshness", () => {
  const cases = [
    [null, "state_missing"],
    ["ok", "state_missing"],
    [{ status: "expired" }, "expired"],
    [{ status: "login_invalid" }, "login_invalid"],
    [{ ...ok, activeUntil: "invalid" }, "state_invalid"],
    [{ ...ok, checkedAt: "invalid" }, "state_invalid"],
    [{ ...ok, activeUntil: ok.checkedAt }, "expired"],
    [{ ...ok, activeUntil: new Date(now - 1).toISOString() }, "expired"],
    [{ ...ok, checkedAt: new Date(now - CODEX_STATE_MAX_AGE_MS - 1).toISOString() }, "state_stale"],
  ];
  for (const [state, reason] of cases)
    assert.deepEqual(evaluateCodexState(state, now), { usable: false, reason });
  const boundary = { ...ok, checkedAt: new Date(now - CODEX_STATE_MAX_AGE_MS).toISOString() };
  for (const state of [ok, boundary])
    assert.deepEqual(evaluateCodexState(state, now), { usable: true, reason: "ok" });
});

test("codexUsable handles unmanaged, missing and updated state files", () => {
  assert.deepEqual(codexUsable({}, now), { usable: true, reason: "unmanaged" });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-state-"));
  const file = path.join(dir, "state.json");
  const env = { CADCHAT_CODEX_STATE_FILE: file };
  try {
    const missing = { usable: false, reason: "state_missing" };
    assert.deepEqual(codexUsable(env, now), missing);
    fs.writeFileSync(file, "invalid JSON");
    fs.utimesSync(file, new Date(now), new Date(now));
    assert.deepEqual(codexUsable(env, now), missing);
    fs.writeFileSync(file, JSON.stringify(ok));
    const updated = new Date(now + 5000);
    fs.utimesSync(file, updated, updated);
    assert.deepEqual(codexUsable(env, now), { usable: true, reason: "ok" });
    fs.writeFileSync(file, JSON.stringify({ status: "expired" }));
    const expired = new Date(now + 10000);
    fs.utimesSync(file, expired, expired);
    assert.deepEqual(codexUsable(env, now), { usable: false, reason: "expired" });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
