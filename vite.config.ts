import path from "path";
import { fileURLToPath } from "url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { viteSingleFile } from "vite-plugin-singlefile";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss(), viteSingleFile()],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
  worker: {
    // Bundle workers as ES modules — Vite's ?worker import suffix handles this
    format: "es",
  },
  optimizeDeps: {
    // Exclude heavy geospatial libs from pre-bundling (they work better as ESM)
    exclude: ["@turf/bbox", "@turf/centroid", "@turf/helpers"],
  },
});
