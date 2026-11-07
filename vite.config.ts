import { defineConfig } from "vite";
import type { Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { cp, rm } from "node:fs/promises";
import { resolve } from "node:path";

const releasePublicDirectories = ["icons", "vendor"] as const;

function copyReleasePublicAssets(): Plugin {
  return {
    name: "copy-release-public-assets",
    apply: "build",
    async closeBundle() {
      const publicRoot = resolve(__dirname, "public");
      const rendererOutputRoot = resolve(__dirname, "dist/renderer");

      // Local development models may live under public/live2d, but release builds
      // must only contain the explicitly approved framework assets above.
      await rm(resolve(rendererOutputRoot, "live2d"), { recursive: true, force: true });
      await Promise.all(
        releasePublicDirectories.map((directoryName) =>
          cp(
            resolve(publicRoot, directoryName),
            resolve(rendererOutputRoot, directoryName),
            { recursive: true, force: true }
          )
        )
      );
    }
  };
}

export default defineConfig({
  plugins: [react(), copyReleasePublicAssets()],
  base: "./",
  optimizeDeps: {
    include: ["react", "react-dom/client", "lucide-react"]
  },
  build: {
    copyPublicDir: false,
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: {
        main: resolve(__dirname, "index.html"),
        pet: resolve(__dirname, "pet.html"),
        help: resolve(__dirname, "help.html")
      }
    }
  },
  server: {
    host: "127.0.0.1",
    port: 7654,
    strictPort: false,
    watch: {
      // M9.5 development resources are runtime inputs, not renderer source.
      // Watching their large Python/ONNX/BGE tree starves Vite's first module
      // transforms on Windows.
      ignored: ["**/.cache/**"]
    },
    warmup: {
      clientFiles: [
        "./src/renderer/main.tsx",
        "./src/renderer/app/App.tsx",
        "./src/renderer/styles.css",
        "./src/renderer/styles/**/*.css",
        "./src/renderer/components/PetSelector/PetSelector.tsx",
        "./src/renderer/components/StartupSplash/StartupSplash.tsx",
        "./src/renderer/pets/petSources.ts",
        "./src/renderer/help/main.tsx",
        "./src/renderer/help/HelpApp.tsx",
        "./src/renderer/help/help.css",
        "./docs/help/nav.ts"
      ]
    }
  }
});
