import { defineConfig } from "tsup";

// 의존성이 0이라 번들이 곧 소스다. CJS 는 만들지 않는다 — Node 20+ ESM 전용.
export default defineConfig({
  entry: ["src/index.ts", "src/cli.ts"],
  format: ["esm"],
  dts: true,
  sourcemap: true,
  clean: true,
  target: "node20",
});
