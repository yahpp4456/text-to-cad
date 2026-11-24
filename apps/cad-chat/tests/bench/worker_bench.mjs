#!/usr/bin/env node
// CAD 腳本耗時量測:每次起新 Python(cold) vs 常駐 worker(warm)。
//
// 直接呼叫伺服器用的同一個 spawnPython(同一份腳本、同一個直譯器、同樣的 cwd / env),
// 對 fixture 的工作副本量 build / validate / inspect。不需要 dev server、不燒 LLM。
//
//   node apps/cad-chat/tests/bench/worker_bench.mjs [--out tmp/bench.json]
//        [--fixtures linear_stage,sheet_u_bracket] [--runs 3] [--mode cold|warm|both]
//
// 輸出每個操作的中位數(秒)。warm 另列「第一次」(含 worker 啟動)與穩定後的數字。
// 量的時候機器要閒:同時跑測試或建置會把數字拖慢好幾倍。
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";

import { REPO_ROOT } from "../../src/server/config.mjs";
import { disposePython, pythonWorkerStats, spawnPython } from "../../src/server/cad/python.mjs";

const STEP = "skills/cad/scripts/step";
const INSPECT = "skills/cad/scripts/inspect";
const VALIDATE = "apps/cad-chat/src/server/cad/validate.py";

function parseArgs(argv) {
  const opts = { out: null, fixtures: ["sheet_u_bracket", "linear_stage"], runs: 3, mode: "both" };
  for (let i = 0; i < argv.length; i += 1) {
    const [flag, value] = [argv[i], argv[i + 1]];
    if (flag === "--out") opts.out = value;
    else if (flag === "--fixtures") opts.fixtures = value.split(",").filter(Boolean);
    else if (flag === "--runs") opts.runs = Math.max(1, Number(value) || 3);
    else if (flag === "--mode") opts.mode = value;
    else continue;
    i += 1;
  }
  return opts;
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const round = (seconds) => Math.round(seconds * 100) / 100;

// 把 models/<name>/ 的產生器(與同目錄 .py、匯入件)複製成工作副本,不動 tracked 產物。
function prepare(name, tag) {
  const src = path.join(REPO_ROOT, "models", name);
  const dst = path.join(REPO_ROOT, "tmp", "bench-worker", tag, name);
  fs.rmSync(dst, { recursive: true, force: true });
  fs.cpSync(src, dst, {
    recursive: true,
    filter: (file) => {
      const base = path.basename(file);
      return base !== "__pycache__" && !(base.startsWith(".") && base !== ".");
    },
  });
  const rel = path.relative(REPO_ROOT, dst).split(path.sep).join("/");
  return { gen: `${rel}/${name}.py`, step: `${rel}/${name}.step` };
}

async function timed(label, fn) {
  const t0 = performance.now();
  const results = [].concat(await fn());
  const seconds = (performance.now() - t0) / 1000;
  const failed = results.find((r) => r.code !== 0);
  if (failed) {
    throw new Error(`${label} 失敗(exit code ${failed.code}):${String(failed.stderr).slice(-400)}`);
  }
  return seconds;
}

function operations(paths) {
  return {
    build: () => spawnPython(STEP, [paths.gen, "--force"]),
    validate: () => spawnPython(VALIDATE, [paths.gen]),
    inspect: () => spawnPython(INSPECT, ["refs", paths.step, "--facts", "--planes", "--positioning", "--format", "json"]),
    // runValidate 的形狀:inspect 與 validate 同時送出
    "validate+inspect": () =>
      Promise.all([
        spawnPython(INSPECT, ["refs", paths.step, "--facts", "--planes", "--positioning", "--format", "json"]),
        spawnPython(VALIDATE, [paths.gen]),
      ]),
  };
}

async function measure(mode, fixtures, runs) {
  if (mode === "cold") process.env.CADCHAT_WORKER = "0";
  else delete process.env.CADCHAT_WORKER;
  const report = {};
  let first = true;
  for (const name of fixtures) {
    const ops = operations(prepare(name, mode));
    report[name] = {};
    for (const [label, fn] of Object.entries(ops)) {
      const samples = [];
      let firstSeconds = null;
      if (mode === "warm" && first) {
        // 第一個請求要等 worker 啟動(import build123d);單獨記,不混進穩定值。
        firstSeconds = await timed(`${name} ${label}`, fn);
        first = false;
      }
      for (let i = 0; i < runs; i += 1) samples.push(await timed(`${name} ${label}`, fn));
      report[name][label] = {
        median: round(median(samples)),
        samples: samples.map(round),
        ...(firstSeconds != null ? { first: round(firstSeconds) } : {}),
      };
      process.stderr.write(`[${mode}] ${name} ${label}: ${report[name][label].median}s\n`);
    }
  }
  return report;
}

const opts = parseArgs(process.argv.slice(2));
const result = { createdAt: new Date().toISOString(), runs: opts.runs, fixtures: opts.fixtures };
try {
  if (opts.mode !== "warm") result.cold = await measure("cold", opts.fixtures, opts.runs);
  if (opts.mode !== "cold") {
    result.warm = await measure("warm", opts.fixtures, opts.runs);
    result.workers = pythonWorkerStats()?.workers.map((w) => ({ state: w.state, rssMb: w.rssMb })) ?? [];
  }
} finally {
  await disposePython();
}

const rows = [];
for (const name of opts.fixtures) {
  for (const label of Object.keys(result.cold?.[name] || result.warm?.[name] || {})) {
    const cold = result.cold?.[name]?.[label]?.median;
    const warm = result.warm?.[name]?.[label]?.median;
    rows.push({
      fixture: name,
      op: label,
      cold_s: cold ?? "",
      warm_s: warm ?? "",
      speedup: cold != null && warm ? `${round(cold / warm)}x` : "",
      warm_first_s: result.warm?.[name]?.[label]?.first ?? "",
    });
  }
}
console.table(rows);
if (opts.out) {
  fs.mkdirSync(path.dirname(path.resolve(opts.out)), { recursive: true });
  fs.writeFileSync(opts.out, `${JSON.stringify(result, null, 1)}\n`, "utf8");
  console.log(`已寫入 ${opts.out}`);
}
