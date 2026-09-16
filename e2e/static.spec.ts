import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "@playwright/test";

import { exportStatic } from "../src/static.js";
import { readVideoInfo } from "../src/video.js";
import { makeRuler, scrub, waitReady } from "./helpers.js";

// 서버 없이 파일 한 장으로 연 창. 서버 모드와 **같은 플레이어**가 도는지, 메모가 그 창에
// 남는지, 꺼낸 파일이 notes.jsonl 과 같은 줄인지를 굳힌다.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCENES = [{ name: "01 도입", startFrame: 0 }, { name: "02 본문", startFrame: 100 }];

let dir: string;
let out: string;

test.beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "framenote-static-e2e-"));
  const video = join(dir, "out", "final.mp4");
  makeRuler(video, 200, "320x180");
  mkdirSync(join(dir, "out", ".framenote"), { recursive: true });
  writeFileSync(join(dir, "out", ".framenote", "config.json"), JSON.stringify({ scenes: SCENES }));
  const info = await readVideoInfo(video, "remotion");
  out = exportStatic({
    videoPath: video,
    outPath: join(dir, "review.html"),
    playerDir: join(ROOT, "player"),
    info,
    scenes: SCENES,
    previewCommand: null,
    notes: [],
    storeDir: join(dir, "out", ".framenote", "final.mp4"),
    notesFile: join(dir, "out", ".framenote", "final.mp4", "notes.jsonl"),
  }).out;
});
test.afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 작성창을 채워 저장한다. 서버 모드의 조작과 같다. */
async function writeNote(page: import("@playwright/test").Page, what: string): Promise<void> {
  await scrub(page, 0.6);
  await page.locator("#noteHere").click();
  await page.locator("#what").fill(what);
  await page.locator("#save").click();
  await expect(page.locator(".note")).toContainText(what);
}

test("서버 없이 연 파일에서도 프레임을 확정하고 메모를 남긴다", async ({ page }) => {
  const outside: string[] = [];
  page.on("request", (r) => { if (!r.url().startsWith("file://") && !r.url().startsWith("blob:")) outside.push(r.url()); });

  await page.goto(`file://${out}`);
  await waitReady(page);
  // 작성 잠금이 걸리지 않는다 = 파일에서 연 창에서도 그려진 프레임을 확정했다.
  await expect(page.locator("#lock")).toBeHidden();
  await writeNote(page, "자막이 안전영역 아래로 나감");

  const note = await page.evaluate(() => JSON.parse(localStorage.getItem("framenote:notes:final.mp4")!)[0]);
  expect(note.what).toBe("자막이 안전영역 아래로 나감");
  expect(note.scene).toBe("02 본문");                 // 씬 목록이 그대로 붙는다
  expect(note.range[0]).toBeGreaterThan(100);
  expect(note.tc).toMatch(/^\d\d:\d\d\.\d\d$/);      // 타임코드 형식이 서버와 같다
  expect(note.status).toBe("draft");
  // 로컬 파일 밖으로 나가는 요청이 없다.
  expect(outside).toEqual([]);
});

test("창을 닫았다 다시 열어도 메모가 남아 있다", async ({ page }) => {
  await page.goto(`file://${out}`);
  await waitReady(page);
  await writeNote(page, "여기 색이 튄다");

  await page.reload();
  await waitReady(page);
  await expect(page.locator(".note")).toContainText("여기 색이 튄다");
});

test("메모를 파일로 꺼내면 notes.jsonl 과 같은 줄이 나온다", async ({ page }) => {
  await page.goto(`file://${out}`);
  await waitReady(page);
  await writeNote(page, "장면 전환이 급하다");

  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.locator("#send").click(),
  ]);
  expect(download.suggestedFilename()).toBe("review-notes.jsonl");
  const file = await download.path();
  const lines = (await import("node:fs")).readFileSync(file!, "utf8").trim().split("\n");
  expect(lines).toHaveLength(1);
  const note = JSON.parse(lines[0]!);
  expect(note.what).toBe("장면 전환이 급하다");
  expect(note.status).toBe("sent");                  // 꺼낸 메모는 보냄으로 바뀐다
  expect(note.batch).toMatch(/^[a-z2-9]{6}$/);
  expect(Object.keys(note).sort()).toEqual([
    "batch", "createdAt", "failureReason", "id", "images", "range", "rect", "rectFrame",
    "render", "scene", "sourceKind", "status", "tc", "want", "what",
  ]);
});

test("이미지 첨부는 저장할 자리가 없다고 알린다", async ({ page }) => {
  await page.goto(`file://${out}`);
  await waitReady(page);
  // 파일 고르기 버튼은 감추고, 왜 안 되는지 작성창에 적어 둔다 — 조용히 실패하지 않는다.
  await expect(page.locator("#pickFile")).toBeHidden();
  await expect(page.locator("#pastehint")).toContainText("이미지 첨부는 저장되지 않습니다");
  // 보낼 것이 생기면 버튼이 "보내기"가 아니라 "내보내기"라고 말한다 — 받을 에이전트가 없다.
  await writeNote(page, "이미지 대신 글로 적는다");
  await expect(page.locator("#send")).toHaveText("메모 파일로 내보내기 (1)");
});
