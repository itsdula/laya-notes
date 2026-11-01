import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/** React Refresh injects an inline script during development, which the production policy forbids. */
function devContentSecurityPolicy(): Plugin {
  return {
    name: "laya-dev-csp",
    apply: "serve",
    transformIndexHtml(html) {
      return html.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), devContentSecurityPolicy()],
  resolve: {
    alias: {
      "@": path.resolve(import.meta.dirname, "src/renderer"),
      "@shared": path.resolve(import.meta.dirname, "src/shared"),
    },
  },
  // A notes folder inside the checkout must not trigger page reloads while testing.
  server: { watch: { ignored: ["**/.scratch/**", "**/data/**", "**/*.md"] } },
});
