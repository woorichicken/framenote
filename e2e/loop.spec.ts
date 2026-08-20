import { join } from "node:path";
import { expect, test } from "@playwright/test";
import { covers } from "../test/covers.js";
import {
  bootFixture, currentFrame, dragOnVideo, makeRuler, notesOf, seek, waitReady, type Fixture,
} from "./helpers.js";

// 문서의 최상위 수용 기준과 프레임 정확도. 이 파일이 초록이면 도구가 목적을 다한다.

let fx: Fixture;
test.afterEach(async () => { await fx?.cleanup(); });

test("메모 한 건이 사람 개입 없이 수정·재렌더까지 완주한다", async ({ page }) => {
  covers(
    "재렌더 결과가 같은 창에서 교체되고 새 창이 뜨지 않는다",
    "영상이 교체돼도 보던 프레임 위치를 유지한다",
    "반영됨 메모는 낡음으로 넘어가지 않는다",
  );
  fx = await bootFixture({ frames: 200 });
  const preview = join(fx.dir, "out", "preview.mp4");
  makeRuler(preview, 240);   // 다른 렌더본
  await page.goto(fx.server.url);
  await waitReady(page);

  // 에이전트 역할로 통로에 붙는다 — 신호를 받아야 왕복이 성립한다.
  const feed: { type: string; batch?: string; count?: number }[] = [];
  const attached = page.evaluate((url) => new Promise<void>((r) => {
    const ws = new WebSocket(url);
    (window as unknown as { __feed: unknown[] }).__feed = [];
    ws.onmessage = (e) => (window as unknown as { __feed: unknown[] }).__feed.push(JSON.parse(String(e.data)));
    ws.onopen = () => r();
  }), `${fx.server.url.replace("http", "ws")}/feed`);
  await attached;

  // ① 사람이 화면에 네모를 치고 메모를 쓴다
  await seek(page, 120);
  await dragOnVideo(page, [0.2, 0.3], [0.6, 0.7]);
  await page.locator("#what").fill("자막이 안전영역 밖으로 나간다");
  await page.locator("#want").fill("하단 안으로");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);

  // ② 보낸다
  const beforeRender = await page.locator("#render").textContent();
  await page.locator("#send").click();
  await expect(page.locator("#list .note")).toContainText("보냄");

  // ③ 에이전트가 신호를 받는다
  await expect.poll(async () =>
    (await page.evaluate(() => (window as unknown as { __feed: { type: string }[] }).__feed)).length,
  ).toBeGreaterThan(0);
  feed.push(...(await page.evaluate(() => (window as unknown as { __feed: never[] }).__feed)));
  expect(feed[0]!.type).toBe("batch");
  expect(feed[0]!.count).toBe(1);

  // ④ 에이전트가 전문을 읽고, 고치고, 재렌더한 결과를 알린다
  const pulled = (await (await fetch(`${fx.server.url}/api/notes?batch=${feed[0]!.batch}`)).json()) as any[];
  expect(pulled).toHaveLength(1);
  expect(pulled[0].rect).not.toBeNull();
  expect(pulled[0].range).toEqual([120, 120]);

  await fetch(`${fx.server.url}/api/status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates: [{ noteId: pulled[0].id, status: "working" }] }),
  });
  await expect(page.locator("#work")).toContainText("작업 중");
  await fetch(`${fx.server.url}/api/status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates: [{ noteId: pulled[0].id, status: "applied", renderedFile: preview }] }),
  });

  // ⑤ 같은 창에서 영상이 바뀌고, 보던 프레임이 유지된다
  await expect(page.locator("#render")).not.toHaveText(beforeRender!);
  await expect(page.locator("#file")).toHaveText("preview.mp4");
  expect(page.context().pages()).toHaveLength(1);          // 새 창이 안 뜬다
  await expect.poll(() => currentFrame(page)).toBe(120);   // 프레임 유지

  const [after] = await notesOf(fx.server);
  expect(after.status).toBe("applied");                    // 낡음으로 안 넘어갔다
});

test("화면에 보이는 프레임 번호와 도구가 기록한 번호가 같다", async ({ page }) => {
  covers("첫 프레임과 마지막 프레임의 번호가 어긋나지 않는다");
  // 눈금 영상은 프레임마다 그 번호가 찍혀 있다. 화면을 캔버스로 읽어 대조한다 —
  // 이게 없으면 프레임이 1~2개 어긋나도 에러가 안 나서 아무도 모른다.
  fx = await bootFixture({ frames: 320 });
  await page.goto(`${fx.server.url}/?verify=1`);
  await waitReady(page);
  await page.waitForFunction(() => (window as unknown as { __verifyReady?: boolean }).__verifyReady === true);

  const targets = [0, 1, 9, 10, 30, 31, 47, 99, 100, 151, 200, 318, 319];
  const result = await page.evaluate(
    (t) => (window as unknown as {
      __verifyFrames: (x: number[]) => Promise<{ total: number; bad: number; rows: unknown[] }>;
    }).__verifyFrames(t),
    targets,
  );
  expect(result.total).toBe(targets.length);
  expect(result.bad).toBe(0);   // 요청·보고·화면이 셋 다 같은 프레임
});

test("Remotion 프로젝트 영상은 씬 이름과 경계가 보인다", async ({ page }) => {
  fx = await bootFixture({
    frames: 300,
    scenes: [
      { name: "problem-core", startFrame: 0 },
      { name: "connection", startFrame: 100 },
      { name: "product-ui", startFrame: 200 },
    ],
  });
  await page.goto(fx.server.url);
  await waitReady(page);

  await expect(page.locator("#kind")).toHaveText("remotion");
  await expect(page.locator("#segs .seg")).toHaveCount(3);
  await expect(page.locator("#segs .seg").nth(0)).toHaveText("problem-core");
  await expect(page.locator("#segs .seg").nth(2)).toHaveText("product-ui");

  // 프레임을 옮기면 그 프레임이 속한 씬이 보이고, 메모에도 그 씬이 붙는다.
  await seek(page, 150);
  await expect(page.locator("#fr")).toContainText("connection");
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill("씬이 붙는지");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);
  const [n] = await notesOf(fx.server);
  expect(n.scene).toBe("connection");
});
