import fs from "node:fs";
import path from "node:path";
import { BASE_PATH } from "./config.mjs";
import {
  paramDefsFromGenerator,
  paramValuesFromGenerator,
} from "./cad/pipeline.mjs";

const bookmark = ".desktop-last-session";

export function markLocalSession(session) {
  if (session.user || !process.env.CADCHAT_PROVIDER) return;
  const target = path.join(path.dirname(session.workdir), bookmark);
  try {
    fs.writeFileSync(target + ".tmp", session.sessionId);
    fs.renameSync(target + ".tmp", target);
  } catch {
    /* the browser still has its own bookmark */
  }
}
export function lastLocalSession(root) {
  try {
    return fs.readFileSync(path.join(root, bookmark), "utf8");
  } catch {
    return null;
  }
}

export function recoverySnapshot(session) {
  const saved = session.uiSnapshot;
  const name = session.lastName;
  const ver = "v" + session.version;
  if (saved && (!name || saved.versions?.some((v) => v.id === ver)))
    return saved;
  const sketch = session.mode === "sketch";
  const versions = [];
  function addVersion(id, part, type, dir = "") {
    const asset = dir + (sketch ? part + ".sketch.json" : "." + part + ".step.glb");
    if (!fs.existsSync(path.join(session.workdir, asset))) return;
    const file = session.workdirRel + "/" + asset;
    const url = BASE_PATH + "/api/asset?file=" + encodeURIComponent(file);
    versions.push({ id, name: part, type, file, snapshot: !!dir, source: "generated",
      formats: sketch ? [] : ["STEP", "GLB"], [sketch ? "sceneUrl" : "glbUrl"]: url });
  }
  const directory = path.join(session.workdir, "versions");
  if (fs.existsSync(directory)) {
    const ids = fs.readdirSync(directory).filter(id => /^v[1-9]\d*$/.test(id) && Number(id.slice(1)) <= session.version);
    for (const id of ids.sort((a,b) => Number(a.slice(1))-Number(b.slice(1)))) {
      try {
        const meta = JSON.parse(fs.readFileSync(path.join(directory,id,"meta.json"),"utf8"));
        if (/^[a-zA-Z0-9_-]+$/.test(meta.name)) addVersion(id,meta.name,meta.type,"versions/"+id+"/");
      } catch { /* An incomplete snapshot can be skipped independently. */ }
    }
  }
  if (name && !versions.some(v => v.id === ver)) addVersion(ver,name,sketch ? "sketch" : undefined);
  const latest = versions.at(-1);
  const items = session.history?.length
    ? session.history.flatMap((entry, i) => {
      const [kind, ...rest] = entry.split(" ");
      if (!["user", "ai", "clarify", "spec"].includes(kind)) return [];
      const text = rest.join(" ");
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        /* legacy plain text */
      }
      if (kind === "clarify" && data?.q)
        return [{ type: kind, id: "restored" + i, ...data }];
      if (kind === "spec" && data?.chips)
        return [{ type: kind, id: "restored" + i, chips: data.chips }];
      if (kind === "user" || kind === "ai")
        return [
          { type: kind, id: "restored" + i, text: data?.message || text },
        ];
      return [];
    }) : saved?.items || [];

  return {
    sessionId: session.sessionId,
    mode: session.mode,
    items,
    _seq: items.length,
    versions,
    activeVer: latest?.id || null,
    canvas: latest ? { ...latest, ver:latest.id } : null,
    params:
      name && !sketch
        ? {
            defs: paramDefsFromGenerator(session, name),
            values: paramValuesFromGenerator(session, name),
          }
        : null,
    savedAt: Date.now(),
  };
}
