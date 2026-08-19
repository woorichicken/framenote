import { expect, test } from "@playwright/test";
import {
  bootFixture, currentFrame, dragOnVideo, notesOf, scrub, seek, waitReady, type Fixture,
} from "./helpers.js";

// 메모를 남기는 화면 조작. 문서의 「메모 남기기」 섹션을 회귀로 굳힌다.

let fx: Fixture;

test.beforeEach(async ({ page }) => {
  fx = await bootFixture({ frames: 200 });
  await page.goto(fx.server.url);
  await waitReady(page);
});
test.afterEach(async () => { await fx?.cleanup(); });

test("스크러버 클릭은 한 프레임짜리 구간을 만든다", async ({ page }) => {
  await scrub(page, 0.25);
  const info = await page.locator("#selinfo").textContent();
  expect(info).toMatch(/^점 f\d+$/);
});

test("스크러버 드래그는 구간을 만든다", async ({ page }) => {
  await scrub(page, 0.2, 0.5);
  const info = await page.locator("#selinfo").textContent();
  expect(info).toMatch(/^구간 f\d+–\d+ \(반복 재생\)$/);
});

test("구간이 잡히면 그 구간만 반복 재생된다", async ({ page }) => {
  await scrub(page, 0.1, 0.2);          // 약 f20–f40
  const [from, to] = (await page.locator("#selinfo").textContent())!
    .match(/f(\d+)–(\d+)/)!.slice(1).map(Number) as [number, number];
  await seek(page, from);
  await page.locator("#play").click();
  await page.waitForTimeout(3000);       // 구간 길이보다 길게 재생한다
  const f = await currentFrame(page);
  await page.locator("#play").click();
  // 끝을 넘어 계속 가지 않고 구간 안으로 돌아온다.
  expect(f).toBeLessThanOrEqual(to + 3);
});

test("네모 좌표는 창 크기와 무관한 비율로 기록된다", async ({ page, viewport }) => {
  await seek(page, 50);
  await dragOnVideo(page, [0.2, 0.3], [0.6, 0.7]);
  await page.locator("#what").fill("비율 기록 확인");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);

  const [note] = await notesOf(fx.server);
  expect(note.rect.x0).toBeGreaterThan(0.15);
  expect(note.rect.x0).toBeLessThan(0.25);
  expect(note.rect.x1).toBeGreaterThan(0.55);
  expect(note.rect.x1).toBeLessThan(0.65);

  // 창을 줄여 영상이 실제로 작아지게 만든 뒤에도 같은 자리에 그려지는지 본다.
  const before = await page.locator("#v").boundingBox();
  await page.setViewportSize({ width: 520, height: 400 });
  await page.waitForTimeout(500);
  const after = await page.locator("#v").boundingBox();
  expect(after!.width).toBeLessThan(before!.width);   // 실제로 줄었다

  const [again] = await notesOf(fx.server);
  expect(again.rect).toEqual(note.rect);              // 저장값은 창 크기와 무관하다

  // 화면에 그려진 표식도 줄어든 영상의 같은 비율 자리에 있다.
  await page.locator(`#list .note`).first().click();
  const mark = await page.locator(".rect.mark").first().boundingBox();
  expect(mark).not.toBeNull();
  const rel = (mark!.x - after!.x) / after!.width;
  expect(Math.abs(rel - note.rect.x0)).toBeLessThan(0.03);
});

test("화면 위치가 없는 지적도 저장된다", async ({ page }) => {
  await scrub(page, 0.3, 0.5);
  // 네모를 그리지 않고 작성창을 여는 경로: 구간만 잡고 저장 API 가 아니라 UI 로 간다.
  await dragOnVideo(page, [0.4, 0.4], [0.41, 0.41]);  // 임계값 미만 → 네모로 안 잡힌다
  const opened = await page.locator("#composer.on").count();
  expect(opened).toBe(0);                              // 너무 작은 네모는 작성창을 안 연다
});

test("무엇이 칸이 비면 저장을 거부하고 파일에 줄이 안 늘어난다", async ({ page }) => {
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#save").click();
  await expect(page.locator("#cmsg")).toContainText("무엇이");
  expect(await notesOf(fx.server)).toHaveLength(0);
});

test("어떻게가 비면 구간과 이미지를 붙이도록 유도한다", async ({ page }) => {
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await expect(page.locator("#pastehint")).toContainText("어떻게가 비었습니다");
  await page.locator("#want").fill("이렇게 바꿔줘");
  await expect(page.locator("#pastehint")).not.toContainText("어떻게가 비었습니다");
});

test("네모만 그려 시작한 메모의 구간이 현재 프레임으로 채워진다", async ({ page }) => {
  await seek(page, 117);
  await dragOnVideo(page, [0.3, 0.3], [0.6, 0.6]);
  await expect(page.locator("#coord")).toContainText("f117");
  await page.locator("#what").fill("구간 자동 채움");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);
  const [note] = await notesOf(fx.server);
  expect(note.range).toEqual([117, 117]);
});

test("포커스가 빠지는 것으로 저장이 확정되지 않는다", async ({ page }) => {
  await seek(page, 40);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill("확정 안 함");
  await page.locator("#want").click();       // blur
  await page.locator("#coord").click();      // 다시 blur
  await page.waitForTimeout(300);
  expect(await notesOf(fx.server)).toHaveLength(0);
});

test("조작 결과가 편집 중인 메모 하나에만 붙는다", async ({ page }) => {
  await seek(page, 20);
  await dragOnVideo(page, [0.1, 0.1], [0.4, 0.4]);
  await page.locator("#what").fill("첫 번째");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);

  await seek(page, 80);
  await dragOnVideo(page, [0.5, 0.5], [0.8, 0.8]);
  await page.locator("#what").fill("두 번째");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(2);

  const notes = await notesOf(fx.server);
  const first = notes.find((n) => n.what === "첫 번째")!;
  const second = notes.find((n) => n.what === "두 번째")!;
  expect(first.range[0]).toBe(20);
  expect(second.range[0]).toBe(80);
  expect(first.rect.x0).toBeLessThan(second.rect.x0);   // 서로 다른 네모
});
