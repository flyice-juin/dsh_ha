import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

// The panel ships as one ES module that Home Assistant loads through
// `panel_custom`. `pnpm dev` serves index.html instead and proxies the bridge,
// so the browser never needs the bridge token or a CORS exception from it.
export default defineConfig({
  build: {
    target: "es2021",
    outDir: "dist",
    emptyOutDir: true,
    minify: "esbuild",
    sourcemap: false,
    lib: {
      entry: fileURLToPath(new URL("./src/main.ts", import.meta.url)),
      formats: ["es"],
      fileName: () => "dsh-panel.js",
    },
    rollupOptions: {
      output: { inlineDynamicImports: true },
    },
  },
  server: {
    port: 5174,
    strictPort: true,
    proxy: {
      "/bridge": {
        target: process.env.DSH_BRIDGE ?? "http://192.168.10.166:43131",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bridge/, ""),
      },
    },
  },
});
