import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/cli.ts",
  format: "esm",
  platform: "node",
  target: "esnext",
  clean: true,
  deps: {
    neverBundle: ["@agentclientprotocol/sdk", "qrcode-terminal"],
  },
  outDir: "dist",
});
