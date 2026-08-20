import { expect, test, type Page } from "@playwright/test";
import { covers } from "../test/covers.js";
import { bootFixture, dragOnVideo, notesOf, seek, waitReady, type Fixture } from "./helpers.js";
import type { ServerHandle } from "../src/server.js";

// 작업중 메모를 사람이 고쳤을 때. 문서의 「보내기 전에는 자유롭게 고친다」를 회귀로 굳힌다.

let fx: Fixture;
const makeNote = async (page: Page, frame: number, what: string): Promise<void> => {
  await seek(page, frame);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill(what);
  await page.locator("#save").click();
};
const send = async (s: ServerHandle): Promise<{ batch: string; count: number }> =>
  (await (await fetch(`${s.url}/api/send`, { method: "POST" })).json()) as { batch: string; count: number };
const setStatus = async (s: ServerHandle, updates: unknown[]): Promise<void> => {
  await fetch(`${s.url}/api/status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  });
};
/** 에이전트 역할로 통로에 붙어 신호를 모은다. */
function attach(url: string): { got: { type: string; noteId?: string }[]; ready: Promise<void>; close: () => void } {
  const ws = new WebSocket(`${url.replace("http", "ws")}/feed`);
  const got: { type: string; noteId?: string }[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)) as { type: string; noteId?: string });
  return { got, ready: new Promise<void>((r) => { ws.onopen = () => r(); }), close: () => ws.close() };
}

test.beforeEach(async ({ page }) => {
  fx = await bootFixture({ frames: 200 });
  await page.goto(fx.server.url);
  await waitReady(page);
});
test.afterEach(async () => { await fx?.cleanup(); });

test("작업중 메모를 고치면 경고 후 초안으로 되돌린다", async ({ page }) => {
  // 실행: 그 메모의 글을 고치려 한다.
  // 기대: 에이전트가 그 내용으로 작업 중이라는 경고가 먼저 표시된다.
  await makeNote(page, 40, "고칠 것");
  await send(fx.server);
  const [n] = await notesOf(fx.server);
  await setStatus(fx.server, [{ noteId: n.id, status: "working" }]);
  await expect(page.locator("#list .note")).toContainText("작업중");

  // 먼저 거절해 본다 — 그러면 아무것도 안 바뀐다.
  page.once("dialog", async (d) => {
    expect(d.message()).toContain("작업 중");
    await d.dismiss();
  });
  await page.locator('.act[data-act="수정"]').click();
  await expect(page.locator("#composer")).not.toHaveClass(/on/);
  expect((await notesOf(fx.server))[0]!.status).toBe("working");

  // 이번엔 강행한다.
  page.once("dialog", async (d) => { await d.accept(); });
  await page.locator('.act[data-act="수정"]').click();
  await expect(page.locator("#composer")).toHaveClass(/on/);
  await expect(page.locator("#list .note")).toContainText("초안");
  expect((await notesOf(fx.server))[0]!.status).toBe("draft");
});

test("작업중 메모를 고치면 에이전트가 실제로 중단 신호를 받는다", async ({ page }) => {
  covers(
    "작업중 메모를 고치면 에이전트가 실제로 중단한다",
  );
  // 실행: 그 메모의 글을 고치고 경고를 확인한 뒤 강행한다.
  // 기대: 메모 상태가 초안이 되고, 에이전트가 그 메모 식별자를 담은 취소 신호를 받는다.
  const agent = attach(fx.server.url);
  await agent.ready;

  await makeNote(page, 40, "취소될 것");
  await send(fx.server);
  const [n] = await notesOf(fx.server);
  await setStatus(fx.server, [{ noteId: n.id, status: "working" }]);
  await expect(page.locator("#list .note")).toContainText("작업중");

  page.once("dialog", async (d) => { await d.accept(); });
  await page.locator('.act[data-act="수정"]').click();
  await expect(page.locator("#list .note")).toContainText("초안");

  await expect.poll(() => agent.got.some((g) => g.type === "cancel")).toBe(true);
  const cancel = agent.got.find((g) => g.type === "cancel");
  expect(cancel?.noteId).toBe(n.id);   // 어느 메모를 멈춰야 하는지 알려준다
  agent.close();
});

test("한 건을 취소해도 같은 묶음의 나머지는 계속 처리된다", async ({ page }) => {
  // 실행: 사람이 그중 1건을 고쳐 취소시킨다.
  // 기대: 그 1건만 초안이 되고 나머지 4건은 작업중을 유지한다.
  await makeNote(page, 30, "취소될 것");
  await makeNote(page, 80, "계속 갈 것 A");
  await makeNote(page, 130, "계속 갈 것 B");
  const sent = await send(fx.server);
  expect(sent.count).toBe(3);

  const all = await notesOf(fx.server);
  await setStatus(fx.server, all.map((n) => ({ noteId: n.id, status: "working" })));
  await expect(page.locator("#list .note")).toHaveCount(3);

  // 하나만 고쳐 취소시킨다.
  const target = all.find((n) => n.what === "취소될 것")!;
  const idx = (await notesOf(fx.server)).findIndex((n) => n.id === target.id);
  page.once("dialog", async (d) => { await d.accept(); });
  await page.locator("#list .note").nth(idx).locator('.act[data-act="수정"]').click();
  await page.locator("#cancel").click();   // 작성창은 닫는다 — 상태는 이미 초안으로 갔다

  const after = await notesOf(fx.server);
  expect(after.find((n) => n.id === target.id)!.status).toBe("draft");
  // 나머지 둘은 그대로 작업중이고 묶음도 유지된다.
  for (const what of ["계속 갈 것 A", "계속 갈 것 B"]) {
    const n = after.find((x) => x.what === what)!;
    expect(n.status).toBe("working");
    expect(n.batch).toBe(sent.batch);
  }
});
