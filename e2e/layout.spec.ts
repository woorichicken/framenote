import { expect, test, type Page } from "@playwright/test";
import { bootFixture, dragOnVideo, notesOf, seek, waitReady, type Fixture } from "./helpers.js";
import type { ServerHandle } from "../src/server.js";

// 리뷰 화면의 크기. 문서의 「리뷰 화면의 크기」를 회귀로 굳힌다.
//
// 이 파일이 지키는 것은 하나다: **페이지는 세로로 자라지 않는다.** 예전 화면은 `.body` 높이를
// `calc(100vh - 37px)` 로 못박고 행 높이를 auto 로 뒀는데, 메모가 쌓이면 목록이 그 상자를 뚫고
// 나가 문서가 창보다 길어졌다(실측 2026-09-06: 메모 12건에 문서 1374px · 창 900px, 영상이
// y=338 로 밀려 스크롤해야 보였다). 창을 줄여도 영상 크기가 그대로여서 "줄였는데 커진다"로
// 느껴졌다 — 높이가 창에 묶여 있지 않으면 영상은 가로폭만 따라간다.

let fx: Fixture;

interface Metrics {
  docHeight: number;
  winHeight: number;
  videoW: number;
  videoH: number;
  listScrolls: boolean;
}

const measure = (page: Page): Promise<Metrics> =>
  page.evaluate(() => {
    const v = document.getElementById("v") as HTMLVideoElement;
    const list = document.getElementById("list") as HTMLElement;
    const box = v.getBoundingClientRect();
    return {
      docHeight: document.documentElement.scrollHeight,
      winHeight: document.documentElement.clientHeight,
      videoW: Math.round(box.width),
      videoH: Math.round(box.height),
      listScrolls: list.scrollHeight > list.clientHeight + 1,
    };
  });

/** 화면 조작 없이 메모를 쌓는다 — 여기서 검사하는 건 쓰는 방법이 아니라 쌓인 뒤의 크기다. */
const seedNotes = async (s: ServerHandle, count: number): Promise<void> => {
  for (let i = 0; i < count; i++) {
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        range: [i * 5, i * 5 + 2],
        what: `쌓이는 메모 ${i + 1} — 자막이 안전영역 아래로 나감`,
        want: "하단 100px 안으로 올리기",
      }),
    });
  }
};

test.beforeEach(async ({ page }) => {
  // 창보다 큰 영상이어야 "창을 줄이면 영상도 줄어든다"가 의미를 갖는다.
  fx = await bootFixture({ frames: 200, size: "1280x720" });
  await page.goto(fx.server.url);
  await waitReady(page);
});
test.afterEach(async () => { await fx?.cleanup(); });

test("메모가 쌓여도 영상과 조작 줄이 화면 안에 남는다", async ({ page }) => {
  // 실행: 메모를 12건 만들고 페이지를 스크롤하지 않는다.
  // 기대: 문서 높이가 창 높이를 넘지 않고, 늘어난 목록은 목록 칸 안에서만 스크롤한다.
  await page.setViewportSize({ width: 1280, height: 720 });
  await seedNotes(fx.server, 12);
  await expect(page.locator("#list .note")).toHaveCount(12);

  const m = await measure(page);
  expect(m.docHeight).toBeLessThanOrEqual(m.winHeight);
  expect(m.listScrolls).toBe(true);          // 넘치는 건 목록 칸 안에서만 움직인다

  // 영상·재생 줄·보내기 버튼이 스크롤 없이 창 안에 다 있다.
  for (const sel of ["#v", "#play", "#send"]) {
    const box = (await page.locator(sel).boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(0);
    expect(box.y + box.height).toBeLessThanOrEqual(m.winHeight + 1);
  }
});

test("창을 줄이면 영상도 같이 줄어든다", async ({ page }) => {
  // 실행: 창을 1440x900에서 640x520까지 단계적으로 줄인다.
  // 기대: 영상의 가로와 세로가 단계마다 작아지고 문서 높이는 창 높이를 넘지 않는다.
  await seedNotes(fx.server, 8);
  await expect(page.locator("#list .note")).toHaveCount(8);

  const steps = [
    { width: 1440, height: 900 },
    { width: 1100, height: 700 },
    { width: 820, height: 620 },
    { width: 640, height: 520 },
  ];
  let prev: Metrics | null = null;
  for (const size of steps) {
    await page.setViewportSize(size);
    await page.waitForTimeout(250);
    const m = await measure(page);
    expect(m.docHeight).toBeLessThanOrEqual(m.winHeight);
    if (prev) {
      expect(m.videoW).toBeLessThan(prev.videoW);
      expect(m.videoH).toBeLessThan(prev.videoH);
    }
    prev = m;
  }
});

test("좁은 창에서는 목록이 영상 아래로 내려가고 높이는 창 안에 남는다", async ({ page }) => {
  // 실행: 창 너비를 820px로 줄인다.
  // 기대: 메모 목록이 영상 아래로 내려가고 문서 높이가 창 높이를 넘지 않는다.
  await seedNotes(fx.server, 6);
  await expect(page.locator("#list .note")).toHaveCount(6);

  await page.setViewportSize({ width: 820, height: 620 });
  await page.waitForTimeout(250);
  const video = (await page.locator("#v").boundingBox())!;
  const rail = (await page.locator(".rail").boundingBox())!;
  expect(rail.y).toBeGreaterThanOrEqual(video.y + video.height - 1);   // 옆이 아니라 아래다
  expect(rail.width).toBeGreaterThan(700);                             // 한 칸을 다 쓴다

  const m = await measure(page);
  expect(m.docHeight).toBeLessThanOrEqual(m.winHeight);
  expect(m.listScrolls).toBe(true);
});

test("창 크기가 바뀌면 네모 표식이 새 영상 자리로 따라간다", async ({ page }) => {
  // 실행: 그 메모를 고른 채 창 너비를 절반으로 줄인다.
  // 기대: 표식이 줄어든 영상의 같은 비율 자리에 다시 그려진다.
  await page.setViewportSize({ width: 1280, height: 800 });
  await seek(page, 50);
  await dragOnVideo(page, [0.2, 0.3], [0.6, 0.7]);
  await page.locator("#what").fill("표식 따라오기");
  await page.locator("#save").click();
  await expect(page.locator(".rect.mark")).toHaveCount(1);
  const [note] = await notesOf(fx.server);

  // 다시 누르지 않는다 — 창 크기가 바뀐 것만으로 따라와야 한다.
  await page.setViewportSize({ width: 640, height: 800 });
  await page.waitForTimeout(300);
  const video = (await page.locator("#v").boundingBox())!;
  const mark = (await page.locator(".rect.mark").boundingBox())!;
  expect(Math.abs((mark.x - video.x) / video.width - note.rect.x0)).toBeLessThan(0.03);
  expect(Math.abs((mark.y - video.y) / video.height - note.rect.y0)).toBeLessThan(0.03);
});
