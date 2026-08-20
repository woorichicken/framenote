import { join } from "node:path";
import { covers } from "../test/covers.js";
import { expect, test, type Page } from "@playwright/test";
import {
  bootFixture, currentFrame, dragOnVideo, makeRuler, notesOf, seek, waitReady, type Fixture,
} from "./helpers.js";

// 상태 전이와 영상 교체. 문서의 「작업 상태와 영상 교체」를 회귀로 굳힌다.
// 에이전트 역할은 실제 HTTP·WebSocket 으로 흉내낸다 — mock 을 쓰면 계약이 안 지켜져도 통과한다.

let fx: Fixture;
let preview: string;

const makeNote = async (page: Page, frame: number, what: string): Promise<void> => {
  await seek(page, frame);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill(what);
  await page.locator("#save").click();
};
const send = async (): Promise<any> =>
  (await fetch(`${fx.server.url}/api/send`, { method: "POST" })).json();
const status = async (updates: unknown[]): Promise<any> =>
  (await fetch(`${fx.server.url}/api/status`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ updates }),
  })).json();
const card = (page: Page, i = 0) => page.locator("#list .note").nth(i);
const act = (page: Page, label: string, i = 0) =>
  card(page, i).locator(`.act[data-act="${label}"]`);

test.beforeEach(async ({ page }) => {
  fx = await bootFixture({ frames: 200 });
  preview = join(fx.dir, "out", "preview.mp4");
  makeRuler(preview, 240);   // 다른 렌더본 — 프레임 수가 달라 해시가 확실히 다르다
  await page.goto(fx.server.url);
  await waitReady(page);
});
test.afterEach(async () => { await fx?.cleanup(); });

test("에이전트가 바꾼 상태가 화면에 즉시 나타난다", async ({ page }) => {
  covers(
    "보내기 직후 상단과 메모 카드에 동시에 작업중이 표시된다",
  );
  await makeNote(page, 40, "상태 반영 확인");
  const { batch } = await send();
  expect(batch).toBeTruthy();
  await expect(card(page)).toContainText("보냄");

  const [n] = await notesOf(fx.server);
  await status([{ noteId: n.id, status: "working" }]);
  // 새로 고침 없이 바뀐다.
  await expect(card(page)).toContainText("작업중");
  await expect(page.locator("#work")).toContainText("작업 중");
});

test("재렌더가 실패하면 작업중에 머물지 않고 사유가 보인다", async ({ page }) => {
  await makeNote(page, 40, "실패 경로");
  await send();
  const [n] = await notesOf(fx.server);
  await status([{ noteId: n.id, status: "working" }]);
  await expect(card(page)).toContainText("작업중");

  await status([{ noteId: n.id, status: "failed", reason: "폰트를 찾지 못했다" }]);
  await expect(card(page)).toContainText("실패");
  await expect(card(page)).toContainText("폰트를 찾지 못했다");
  await expect(page.locator("#work")).toHaveText("");
});

test("실패 메모 다시 보내기가 대기 중인 초안을 끌고 나가지 않는다", async ({ page }) => {
  await makeNote(page, 30, "실패할 것");
  await send();
  const [sent] = await notesOf(fx.server);
  await status([{ noteId: sent.id, status: "failed", reason: "실패" }]);
  await makeNote(page, 90, "아직 초안");
  await expect(page.locator("#list .note")).toHaveCount(2);

  await act(page, "다시 보내기", 0).click();
  await expect(card(page, 0)).toContainText("보냄");

  const notes = await notesOf(fx.server);
  const draft = notes.find((n) => n.what === "아직 초안")!;
  expect(draft.status).toBe("draft");        // 딸려 나가지 않았다
  expect(draft.batch).toBeNull();
});

test("새 렌더본이 오면 미완 메모가 낡음이 되고 반영됨은 넘어가지 않는다", async ({ page }) => {
  covers(
    "새 렌더본이 오면 이전 렌더본의 미완 메모가 낡음이 된다",
    "반영됨 메모는 낡음으로 넘어가지 않는다",
    "재렌더 결과가 같은 창에서 교체되고 새 창이 뜨지 않는다",
  );
  await makeNote(page, 30, "고쳐질 것");
  await makeNote(page, 60, "안 고쳐질 것");
  await send();
  const notes = await notesOf(fx.server);
  const fixed = notes.find((n) => n.what === "고쳐질 것")!;

  await status([{ noteId: fixed.id, status: "applied", renderedFile: preview }]);
  await expect(page.locator("#render")).not.toHaveText(/^$/);

  const after = await notesOf(fx.server);
  expect(after.find((n) => n.what === "고쳐질 것")!.status).toBe("applied");
  expect(after.find((n) => n.what === "안 고쳐질 것")!.status).toBe("stale");
  // 영상이 교체됐다 — 같은 창에서.
  await expect(page.locator("#file")).toHaveText("preview.mp4");
  expect(page.context().pages()).toHaveLength(1);
});

test("반영됨 메모를 고르면 그 구간으로 이동하고 해결됨으로 닫을 수 있다", async ({ page }) => {
  covers(
    "반영됨 메모를 고르면 그 구간으로 이동하고 닫을 수 있다",
    "영상이 교체돼도 보던 프레임 위치를 유지한다",
  );
  await makeNote(page, 123, "확인할 것");
  await send();
  const [n] = await notesOf(fx.server);
  await status([{ noteId: n.id, status: "applied", renderedFile: preview }]);
  await expect(card(page)).toContainText("반영됨");

  await seek(page, 5);
  await card(page).click();
  await expect.poll(() => currentFrame(page)).toBe(123);   // 그 구간으로 이동

  await act(page, "해결됨").click();
  await expect(page.locator("#list .note")).toHaveCount(0); // 기본 목록에서 빠진다
  expect((await notesOf(fx.server))[0]!.status).toBe("closed");
});

test("닫은 메모는 이후 보내기 묶음에서 빠진다", async ({ page }) => {
  await makeNote(page, 30, "닫을 것");
  await send();
  const [a] = await notesOf(fx.server);
  await status([{ noteId: a.id, status: "applied", renderedFile: preview }]);
  await act(page, "해결됨").click();
  await expect(page.locator("#list .note")).toHaveCount(0);

  await makeNote(page, 70, "새 메모");
  const r = await send();
  expect(r.count).toBe(1);      // 닫은 것은 안 들어간다
});

test("고쳐지지 않은 메모를 다시 열면 새 렌더본 기준으로 되살아난다", async ({ page }) => {
  await makeNote(page, 50, "여전히 문제");
  await send();
  const [n] = await notesOf(fx.server);
  const oldRender = n.render;
  await status([{ noteId: n.id, status: "applied", renderedFile: preview }]);
  await expect(card(page)).toContainText("반영됨");

  await act(page, "다시 열기").click();
  await expect(card(page)).toContainText("보냄");
  const [again] = await notesOf(fx.server);
  expect(again.render).not.toBe(oldRender);   // 지금 보는 렌더본으로 갱신
});

test("낡은 메모를 다시 찍으면 글과 이미지는 남고 좌표만 갱신된다", async ({ page }) => {
  covers(
    "낡은 메모를 다시 찍으면 구간·좌표·렌더본이 갱신되고 글과 이미지는 남는다",
  );
  await makeNote(page, 40, "낡을 것");
  await send();
  const [first] = await notesOf(fx.server);
  // 다른 메모를 반영시켜 렌더본을 바꾼다 → 위 메모가 낡음이 된다
  await makeNote(page, 80, "고쳐질 것");
  await send();
  const other = (await notesOf(fx.server)).find((n) => n.what === "고쳐질 것")!;
  await status([{ noteId: other.id, status: "applied", renderedFile: preview }]);
  await expect(card(page, 0)).toContainText("낡음");

  await act(page, "다시 찍음", 0).click();
  await expect(page.locator("#composer")).toHaveClass(/on/);
  await dragOnVideo(page, [0.6, 0.6], [0.9, 0.9]);
  await page.locator("#save").click();

  const after = (await notesOf(fx.server)).find((n) => n.id === first.id)!;
  expect(after.status).toBe("draft");
  expect(after.what).toBe("낡을 것");            // 글은 그대로
  expect(after.rect.x0).toBeGreaterThan(0.5);    // 좌표는 새로 잡힌 것
  expect((await notesOf(fx.server)).length).toBe(2);  // 새 메모가 생기지 않았다
});

test("보내기 전 메모는 글과 구간을 고칠 수 있다", async ({ page }) => {
  covers(
    "보내기 전 메모는 글·구간·이미지를 모두 고칠 수 있다",
  );
  await makeNote(page, 30, "고치기 전");
  await act(page, "수정").click();
  await expect(page.locator("#what")).toHaveValue("고치기 전");
  await page.locator("#what").fill("고친 뒤");
  await page.locator("#save").click();

  const notes = await notesOf(fx.server);
  expect(notes).toHaveLength(1);           // 새 메모가 생기지 않았다
  expect(notes[0]!.what).toBe("고친 뒤");
});

test("한 프레임 이동이 정확히 한 프레임씩 움직인다", async ({ page }) => {
  await seek(page, 100);
  await page.locator("body").click({ position: { x: 5, y: 5 } });
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowRight");
  await expect.poll(() => currentFrame(page)).toBe(105);
  for (let i = 0; i < 5; i++) await page.keyboard.press("ArrowLeft");
  await expect.poll(() => currentFrame(page)).toBe(100);
});
