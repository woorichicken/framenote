import { defineConfig } from "@playwright/test";

// 브라우저 UI 조작을 회귀로 굳힌다.
//
// 이 스위트가 존재하는 이유: 기능은 구현돼 있는데 **실행 증거가 없어서** 문서의 TC 를 초록으로
// 못 올리는 것이 29건이었다. 사람이 한 번 눌러본 것은 다음 커밋에서 깨져도 아무도 모른다.
//
// Chromium 만 돈다. framenote 는 그려진 프레임을 알려주는 브라우저에서만 메모를 허용하고,
// 그 API 가 없는 브라우저에서는 작성이 잠기는 것이 설계다(그 잠금 자체도 여기서 검사한다).
export default defineConfig({
  testDir: "e2e",
  fullyParallel: false, // 서버·파일 상태를 공유한다
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: process.env["CI"] ? [["list"], ["github"]] : [["list"]],
  use: {
    trace: "retain-on-failure",
    video: "off",
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }],
});
