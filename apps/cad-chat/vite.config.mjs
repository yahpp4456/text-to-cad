import path from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const appRoot = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(appRoot, "..", "..");
const clientRoot = path.join(appRoot, "src");
const nodeModules = path.join(appRoot, "node_modules");
const cadJsPackageRoot = path.join(repoRoot, "packages", "cadjs", "src");

// Single shared three.js copy (app + cadjs) — a duplicate breaks instanceof / OrbitControls.
export default defineConfig({
  root: appRoot,
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
    fs: {
      // cadjs source lives outside the app root — allow Vite to serve it.
      allow: [appRoot, cadJsPackageRoot],
    },
  },
});
