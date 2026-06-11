import { defineConfig } from "tsdown";

export default defineConfig({
  entry: "src/cli.ts",
  format: "esm",
  platform: "node",
  target: "esnext",
  clean: true,
  dts: false,
  deps: {
    neverBundle: ["@agentclientprotocol/sdk", "qrcode-terminal", "pino-pretty"],
  },
  outDir: "dist",
});
