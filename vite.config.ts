import { defineConfig } from "vite-plus";
import react from "@vitejs/plugin-react";
import electron from "vite-plugin-electron/simple";
import electronRenderer from "vite-plugin-electron-renderer";

export default defineConfig({
  base: "./",
  plugins: [
    react(),
    electron({
      main: {
        entry: "electron/main.ts",
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { external: ["electron"] },
          },
        },
      },
      preload: {
        input: {
          preload: "electron/preload.ts",
          studioCspPreload: "electron/studioCspPreload.ts",
        },
        vite: {
          build: {
            outDir: "dist-electron",
            rollupOptions: { external: ["electron"], output: { codeSplitting: true } },
          },
        },
      },
      renderer: {},
    }),
    electronRenderer(),
  ],
  staged: {
    "*": "vp check --fix",
  },
  fmt: {},
  lint: {
    jsPlugins: [{ name: "vite-plus", specifier: "vite-plus/oxlint-plugin" }],
    rules: { "vite-plus/prefer-vite-plus-imports": "error" },
    options: { typeAware: true, typeCheck: true },
  },
});
