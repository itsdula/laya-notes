import path from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  resolve: {
    alias: {
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  build: {
    rollupOptions: {
      external: ["onnxruntime-node"],
    },
  },
});
