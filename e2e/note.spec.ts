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
  // 실행: 스크러버의 632프레임 지점을 한 번 클릭하고 메모를 저장한다.
  // 기대: 저장된 메모의 구간이 시작 632, 끝 632로 기록된다.
  await scrub(page, 0.25);
  const info = await page.locator("#selinfo").textContent();
  expect(info).toMatch(/^점 f\d+$/);
});

test("스크러버 드래그는 구간을 만든다", async ({ page }) => {
  // 실행: 스크러버에서 480프레임부터 810프레임까지 드래그하고 메모를 저장한다.
  // 기대: 저장된 메모의 구간이 시작 480, 끝 810으로 기록된다.
  await scrub(page, 0.2, 0.5);
  const info = await page.locator("#selinfo").textContent();
  expect(info).toMatch(/^구간 f\d+–\d+ \(반복 재생\)$/);
});

test("구간이 잡히면 그 구간만 반복 재생된다", async ({ page }) => {
  // 실행: 재생을 누르고 20초 이상 둔다.
  // 기대: 재생이 810프레임에 닿으면 480프레임으로 돌아가 반복되고, 810을 넘어 진행하지 않는다.
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
  // 실행: 영상의 특정 지점에 네모를 그려 저장한 뒤, 창 너비를 절반으로 줄이고 같은 메모를 다시 표시한다.
  // 기대: 저장된 좌표 값이 0~1 사이 비율로 기록되어 있고, 창 크기가 달라져도 네모가 영상의 같은 자리에 그려진다.
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
  // 실행: 무엇이 칸만 채우고 저장한다.
  // 기대: 메모가 저장되고 좌표 값이 비어 있다.
  // 앞선 이 테스트는 "작은 네모는 작성창을 안 연다"를 봤다 — TC 가 요구하는 것과 다른 것이라
  // 스크러버만으로는 메모를 못 만든다는 사실을 놓쳤다(실사용 2026-08-20에 드러났다).
  await scrub(page, 0.3, 0.5);
  await expect(page.locator("#noteHere")).toBeEnabled();
  await expect(page.locator("#noteHere")).toHaveText("이 구간에 메모");

  await page.locator("#noteHere").click();
  await expect(page.locator("#composer")).toHaveClass(/on/);
  await expect(page.locator("#coord")).toContainText("네모 없음");

  await page.locator("#what").fill("이 구간이 너무 빠르다");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);

  const [note] = await notesOf(fx.server);
  expect(note.rect).toBeNull();          // 네모 없이 저장됐다
  expect(note.rectFrame).toBeNull();
  expect(note.range[0]).toBeLessThan(note.range[1]);   // 구간은 살아 있다
  expect(note.what).toBe("이 구간이 너무 빠르다");
});

test("스크러버를 클릭만 해도 그 프레임에 메모를 쓸 수 있다", async ({ page }) => {
  await scrub(page, 0.25);
  await expect(page.locator("#noteHere")).toHaveText("이 자리에 메모");
  await page.locator("#noteHere").click();
  await page.locator("#what").fill("이 프레임만");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);
  const [note] = await notesOf(fx.server);
  expect(note.range[0]).toBe(note.range[1]);   // 점 제보
  expect(note.rect).toBeNull();
});

test("고른 자리가 없으면 메모 버튼이 꺼져 있다", async ({ page }) => {
  await expect(page.locator("#noteHere")).toBeDisabled();
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
  // 실행: 구간을 잡지 않고 영상 위에 네모만 그린다.
  // 기대: 새 메모가 시작되고 그 구간이 시작 917, 끝 917로 채워진다.
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
  // 실행: 글 입력칸 밖을 클릭해 포커스를 뺀다.
  // 기대: 저장 파일에 줄이 추가되지 않는다.
  await seek(page, 40);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill("확정 안 함");
  await page.locator("#want").click();       // blur
  await page.locator("#coord").click();      // 다시 blur
  await page.waitForTimeout(300);
  expect(await notesOf(fx.server)).toHaveLength(0);
});

test("조작 결과가 편집 중인 메모 하나에만 붙는다", async ({ page }) => {
  // 실행: 스크러버로 구간을 다시 잡고 영상 위에 네모를 그리고 이미지를 붙인다.
  // 기대: 세 값이 모두 편집 중인 그 메모에만 반영되고 다른 메모는 그대로다.
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
