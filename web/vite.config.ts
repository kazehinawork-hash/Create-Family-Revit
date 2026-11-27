import { fileURLToPath } from "node:url";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const webPort = Number(process.env.VITE_PORT) || 5173;
const webHost = process.env.VITE_HOST || undefined;
const apiTarget = process.env.VITE_API_TARGET || "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  ...(process.env.VITE_CACHE_DIR ? { cacheDir: process.env.VITE_CACHE_DIR } : {}),
  resolve: {
    alias: {
      "@family/spec-core": fileURLToPath(
        new URL("../packages/spec-core/src/index.ts", import.meta.url),
      ),
    },
  },
  server: {
    host: webHost,
    port: webPort,
    strictPort: Boolean(process.env.VITE_PORT),
    fs: { allow: [".."] },
    proxy: {
      "/api": {
        target: apiTarget,
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2022",
    chunkSizeWarningLimit: 1200,
    rollupOptions: {
      output: {
        // three.js is the bulk of the bundle and changes rarely: keep it in its own chunk
        // so app edits do not invalidate the whole download.
        manualChunks(id) {
          if (id.includes("node_modules/three-bvh-csg") || id.includes("node_modules/three")) {
            return "three";
          }
          if (
            id.includes("node_modules/react") ||
            id.includes("node_modules/react-dom") ||
            id.includes("node_modules/scheduler")
          ) {
            return "react";
          }
          if (id.includes("packages/spec-core")) return "spec-core";
          if (id.includes("node_modules/read-excel-file")) return "xlsx";
          return undefined;
        },
      },
    },
  },
});
