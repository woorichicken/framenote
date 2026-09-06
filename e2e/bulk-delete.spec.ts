import { expect, test } from "@playwright/test";
import { bootFixture, notesOf, waitReady, type Fixture } from "./helpers.js";
import type { ServerHandle } from "../src/server.js";

// 고른 메모를 한 번에 지우기. 문서의 「보내기 전 고치기와 복사」 중 일괄 삭제를 회귀로 굳힌다.
//
// 리뷰를 한 바퀴 돌면 지울 메모가 무더기로 남는데, 한 건씩 지우면 지우는 일이 리뷰보다
// 오래 걸린다. 되돌릴 수 없으므로 **건수를 보여주고 한 번 더 묻는** 것까지가 이 기능이다.

let fx: Fixture;

const seed = async (s: ServerHandle, whats: string[]): Promise<void> => {
  for (const [i, what] of whats.entries()) {
    await fetch(`${s.url}/api/notes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [i * 10, i * 10 + 3], what }),
    });
  }
};

test.beforeEach(async ({ page }) => {
  fx = await bootFixture({ frames: 200 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await seed(fx.server, ["메모 1", "메모 2", "메모 3"]);
  await expect(page.locator("#list .note")).toHaveCount(3);
});
test.afterEach(async () => { await fx?.cleanup(); });

test("고른 메모를 한 번에 지운다", async ({ page }) => {
  // 실행: 그중 2건을 골라 삭제를 누르고 확인 창에서 계속을 고른다.
  // 기대: 고른 2건만 목록과 파일에서 사라지고 나머지 1건은 남는다.
  await page.locator("#list .pick").nth(0).check();
  await page.locator("#list .pick").nth(1).check();
  await expect(page.locator("#del")).toHaveText("삭제 (2)");

  page.once("dialog", async (d) => {
    expect(d.message()).toContain("2건");     // 몇 건을 지우는지 먼저 보여준다
    await d.accept();
  });
  await page.locator("#del").click();

  await expect(page.locator("#list .note")).toHaveCount(1);
  expect((await notesOf(fx.server)).map((n) => n.what)).toEqual(["메모 3"]);
  await expect(page.locator("#del")).toHaveText("삭제");   // 고른 게 없으면 건수도 없다
  await expect(page.locator("#del")).toBeDisabled();
});

test("일괄 삭제를 확인 창에서 취소하면 한 건도 지워지지 않는다", async ({ page }) => {
  // 실행: 2건을 골라 삭제를 누르고 확인 창에서 취소한다.
  // 기대: 메모 3건이 그대로 남는다.
  await page.locator("#list .pick").nth(0).check();
  await page.locator("#list .pick").nth(1).check();

  page.once("dialog", async (d) => { await d.dismiss(); });
  await page.locator("#del").click();

  await expect(page.locator("#list .note")).toHaveCount(3);
  expect((await notesOf(fx.server)).map((n) => n.what)).toEqual(["메모 1", "메모 2", "메모 3"]);
  await expect(page.locator("#del")).toHaveText("삭제 (2)");   // 고른 것도 그대로다
});

test("모두 고르기로 열린 메모를 한 번에 고른다", async ({ page }) => {
  // 실행: 목록 머리의 모두를 켠 뒤 그중 한 건을 다시 푼다.
  // 기대: 처음에 열린 메모가 전부 골라지고, 한 건을 풀면 삭제 라벨의 건수가 하나 줄어든다.
  await page.locator("#pickAll").check();
  await expect(page.locator("#del")).toHaveText("삭제 (3)");
  await expect(page.locator("#copy")).toHaveText("복사 (3)");
  expect(await page.locator("#list .pick:checked").count()).toBe(3);

  await page.locator("#list .pick").nth(0).uncheck();
  await expect(page.locator("#del")).toHaveText("삭제 (2)");
  // 일부만 골랐으면 반쯤 켠 상태다 — 꺼진 채로 두면 "아무것도 안 골랐다"로 읽힌다.
  expect(await page.locator("#pickAll").evaluate((el) => (el as HTMLInputElement).indeterminate)).toBe(true);
});
