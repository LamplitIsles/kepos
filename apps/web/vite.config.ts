import { resolve } from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
  // Artifact tests do not need the Cloudflare local runtime.
  plugins: process.env.VITEST ? [] : [cloudflare()],
  build: {
    rollupOptions: {
      input: {
        main: resolve(import.meta.dirname, "index.html"),
        docs: resolve(import.meta.dirname, "docs/index.html"),
        notFound: resolve(import.meta.dirname, "404.html"),
      },
    },
  },
});
