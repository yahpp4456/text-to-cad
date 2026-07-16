import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "..", "..");
const clientRoot = path.join(appRoot, "src");
const nodeModules = path.join(appRoot, "node_modules");
const cadJsPackageRoot = path.join(repoRoot, "packages", "cadjs", "src");

function normalizeBase(raw) {
  const s = String(raw || "").trim();
  if (!s || s === "/") return "/";
  return "/" + s.replace(/^\/+|\/+$/g, "") + "/"; // "cad" or "/cad" -> "/cad/"
}

// Single shared three.js copy (app + cadjs) — a duplicate breaks instanceof / OrbitControls.
export default defineConfig({
  root: appRoot,
  base: normalizeBase(process.env.CADCHAT_BASE_PATH),
  plugins: [react()],
  resolve: {
    alias: {
      "@": clientRoot,
      cadjs: cadJsPackageRoot,
      gifenc: path.join(nodeModules, "gifenc", "dist", "gifenc.esm.js"),
      three: path.join(nodeModules, "three"),
      "three/examples": path.join(nodeModules, "three", "examples"),
    },
  },
  esbuild: {
    loader: "jsx",
    include: /.*\.[jt]sx?$/,
    exclude: [],
  },
  optimizeDeps: {
    esbuildOptions: {
      loader: { ".js": "jsx" },
    },
  },
  worker: { format: "es" },
  server: {
    host: "127.0.0.1",
    // Parallel dev instances (e.g. a second test server via CADCHAT_PORT) fight
    // over the default HMR ws port (24678); the loser's pages keep throwing
    // "WebSocket closed without opened.", polluting smoke-test JS-error
    // assertions. Give the extra instance its own port via CADCHAT_HMR_PORT.
    hmr: process.env.CADCHAT_HMR_PORT
      ? { port: Number(process.env.CADCHAT_HMR_PORT) }
      : undefined,
    fs: {
      // cadjs source lives outside the app root — allow Vite to serve it.
      allow: [appRoot, cadJsPackageRoot],
    },
  },
});
