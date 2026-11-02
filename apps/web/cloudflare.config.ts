import { defineConfig } from "cf/config";

export default defineConfig({
  accountId: "4a7d2cc3b61181986870b57848eff910",
  worker: {
    name: "kepos-web",
    compatibilityDate: "2026-07-22",
    compatibilityFlags: ["nodejs_compat"],
    assets: {
      notFoundHandling: "404-page",
      htmlHandling: "drop-trailing-slash",
    },
    domains: ["kepos.guion.io"],
    observability: { enabled: true, headSamplingRate: 1 },
    workersDev: false,
  },
});
