import fs from "node:fs/promises";
import path from "node:path";
import { isReadAllowed, readScopeFor, READ_DENY_MSG } from "./readScope.mjs";

export const fileTools = [
  [
    "Read",
    "Read UTF-8 text in the current CAD workspace.",
    { file_path: "string", offset: "integer", limit: "integer" },
    ["file_path"],
  ],
  [
    "Glob",
    "List matching files under path. Pattern is relative to path.",
    { path: "string", pattern: "string" },
    ["path", "pattern"],
  ],
  [
    "Grep",
    "Find literal text in files under path.",
    { path: "string", pattern: "string" },
    ["path", "pattern"],
  ],
].map(([name, description, fields, required]) => ({
  type: "function",
  name,
  description,
  inputSchema: {
    type: "object",
    required,
    additionalProperties: false,
    properties: Object.fromEntries(
      Object.entries(fields).map(([key, type]) => [key, { type }]),
    ),
  },
}));

export async function queryFiles(name, args, session, signal) {
  const scope = readScopeFor(session);
  async function checked(file) {
    if (!isReadAllowed(file, scope)) throw new Error(READ_DENY_MSG);
    const real = await fs.realpath(file);
    if (!isReadAllowed(real, scope)) throw new Error(READ_DENY_MSG);
    return real;
  }
  const input = name === "Read" ? args.file_path : args.path;
  if (!input || typeof input !== "string")
    throw new Error("Specify a file or directory");
  const root = await checked(path.resolve(scope.cwd, input));
  async function read(file) {
    signal.throwIfAborted();
    const handle = await fs.open(await checked(file));
    try {
      const st = await handle.stat();
      if (!st.isFile() || st.size > 4_000_000)
        throw new Error("Select a text file under 4 MB");
      const data = await handle.readFile();
      if (data.includes(0)) throw new Error("Select a text file");
      return data.toString("utf8");
    } finally {
      await handle.close();
    }
  }
  if (name === "Read") {
    const start = Math.max(0, (Number(args.offset) || 1) - 1);
    const count = Math.max(1, Math.min(600, Number(args.limit) || 200));
    return (await read(root))
      .split(/\r?\n/)
      .slice(start, start + count)
      .join("\n")
      .slice(0, 40000);
  }
  const hits = [];
  let visited = 0;
  const pattern = String(args.pattern || "");
  if (!pattern) throw new Error("Specify a pattern");
  async function walk(file) {
    signal.throwIfAborted();
    if (++visited > 4000 || hits.length >= 100 || !isReadAllowed(file, scope))
      return;
    const stat = await fs.lstat(file);
    if (stat.isSymbolicLink()) return;
    if (stat.isDirectory()) {
      for (const child of await fs.readdir(await checked(file))) {
        if (visited >= 4000 || hits.length >= 100) break;
        await walk(path.join(file, child));
      }
    } else if (name === "Glob") {
      if (path.matchesGlob(path.relative(root, file), pattern)) hits.push(file);
    } else if (
      stat.isFile() &&
      stat.size <= 1_000_000 &&
      /\.(md|txt|json|py|js|mjs|urdf|xml)$/i.test(file)
    ) {
      const lines = (await read(file)).split(/\r?\n/);
      for (let i = 0; i < lines.length && hits.length < 100; i++) {
        if (lines[i].includes(pattern))
          hits.push(`${file}:${i + 1}: ${lines[i].slice(0, 320)}`);
      }
    }
  }
  await walk(root);
  return hits.join("\n").slice(0, 40000);
}
