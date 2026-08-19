import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    // 서버·파일을 실제로 쓰는 테스트가 섞이므로 한 번에 하나만 돌린다.
    fileParallelism: false,
  },
});
