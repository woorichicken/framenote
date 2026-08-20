import { expect, test, type Page } from "@playwright/test";
import { bootFixture, dragOnVideo, notesOf, seek, waitReady, type Fixture } from "./helpers.js";

// 복사·이미지·잠금. 브라우저 API(클립보드·붙여넣기·rVFC)가 얽혀 여기서만 검사된다.

let fx: Fixture;
const makeNote = async (page: Page, frame: number, what: string, want?: string): Promise<void> => {
  await seek(page, frame);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").fill(what);
  if (want) await page.locator("#want").fill(want);
  await page.locator("#save").click();
};

/** 클립보드에 이미지를 얹어 붙여넣기 이벤트를 만든다. */
const pasteImage = (page: Page, name = "shot.png", type = "image/png"): Promise<void> =>
  page.evaluate(async ({ name, type }) => {
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], name, { type }));
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  }, { name, type });

test.afterEach(async () => { await fx?.cleanup(); });

test("씬 정보를 못 읽으면 generic으로 낮추고 알린다", async ({ page }) => {
  // 실행: 그 영상을 연다.
  // 기대: 영상 종류가 generic으로 낮춰져 표시되고, 낮춘 사유가 화면에 보인다.
  // 씬 목록이 규격에서 벗어나면 절반만 맞는 경계를 그리지 않고 통째로 버린다.
  fx = await bootFixture({ frames: 120, scenes: [{ name: "", startFrame: -5 } as never] });
  const warnings: string[] = [];
  page.on("console", (m) => { if (m.type() === "warning") warnings.push(m.text()); });
  await page.goto(fx.server.url);
  await waitReady(page);

  await expect(page.locator("#kind")).toHaveText("generic");
  await expect(page.locator("#segs .seg")).toHaveCount(1);   // 씬 구분이 없다
  expect(warnings.join(" ")).toContain("generic");           // 왜 낮췄는지 알린다
});

test("커서가 입력칸 밖이어도 이미지 붙여넣기가 된다", async ({ page }) => {
  // 실행: 붙여넣기 단축키를 누른다.
  // 기대: 이미지가 첨부되어 미리보기에 나타난다.
  fx = await bootFixture({ frames: 120 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#coord").click();          // 커서를 입력칸 밖에 둔다
  await pasteImage(page);
  await expect(page.locator("#pastehint")).toContainText("이미지 1장 첨부됨");

  await page.locator("#what").fill("붙여넣기 확인");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);
  const [n] = await notesOf(fx.server);
  expect(n.images).toHaveLength(1);
  // 경로만 들어간다 — 그림 데이터가 아니다.
  expect(JSON.stringify(n)).not.toContain("iVBORw0");
});

test("세 가지 경로로 이미지를 여러 장 붙일 수 있다", async ({ page }) => {
  // 실행: 이미지 3장을 붙여넣기·끌어다 놓기·파일 고르기로 각각 하나씩 첨부한다.
  // 기대: 3장이 모두 첨부되어 미리보기에 나열되고, 저장하면 메모의 이미지 목록에 3개 경로가 기록된다.
  // 앞선 이 테스트는 붙여넣기만 두 번 하고 "세 경로"라고 했다 — 파일 고르기가 아예 구현돼
  // 있지 않은 것을 놓쳤다(실사용 2026-08-20에 드러났다). 이제 셋을 각각 쓴다.
  fx = await bootFixture({ frames: 120 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);

  // 1) 붙여넣기
  await pasteImage(page, "a.png");
  await expect(page.locator("#pastehint")).toContainText("1장");

  // 2) 끌어다 놓기
  await page.evaluate(() => {
    const png = Uint8Array.from(atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    ), (c) => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([png], "b.png", { type: "image/png" }));
    document.getElementById("draw")!.dispatchEvent(
      new DragEvent("drop", { dataTransfer: dt, bubbles: true, cancelable: true }),
    );
  });
  await expect(page.locator("#pastehint")).toContainText("2장");

  // 3) 파일 고르기 — 캡처가 파일로 저장된 경우 이게 유일한 길이다.
  await page.setInputFiles("#fileInput", {
    name: "c.png", mimeType: "image/png",
    buffer: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64"),
  });
  await expect(page.locator("#pastehint")).toContainText("3장");

  await page.locator("#what").fill("세 경로");
  await page.locator("#save").click();
  await expect(page.locator("#list .note")).toHaveCount(1);
  const [n] = await notesOf(fx.server);
  expect(n.images).toHaveLength(3);          // 셋 다 붙었고 서로 대체하지 않았다
});

test("이미지 없는 붙여넣기는 왜 안 붙었는지 말한다", async ({ page }) => {
  // 조용히 넘기면 사용자는 붙인 줄 알고 넘어간다 — 실제로 그 일이 있었다.
  fx = await bootFixture({ frames: 120 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);

  await page.evaluate(() => {
    document.dispatchEvent(new ClipboardEvent("paste", {
      clipboardData: new DataTransfer(), bubbles: true,
    }));
  });
  await expect(page.locator("#cmsg")).toBeVisible();
  await expect(page.locator("#cmsg")).toContainText("클립보드가 비어 있습니다");
  await expect(page.locator("#cmsg")).toContainText("파일 고르기");   // 대안을 알려준다
});

test("이미지가 아닌 붙여넣기는 글로 들어간다", async ({ page }) => {
  // 실행: 글 입력칸에 커서를 두고 붙여넣는다.
  // 기대: 텍스트가 글 입력칸에 그대로 들어가고 이미지 첨부가 일어나지 않는다.
  fx = await bootFixture({ frames: 120 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await seek(page, 30);
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await page.locator("#what").click();
  await page.evaluate(() => {
    const dt = new DataTransfer();
    dt.setData("text/plain", "그냥 텍스트");
    document.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true }));
  });
  await expect(page.locator("#pastehint")).not.toContainText("첨부됨");  // 이미지로 안 잡힌다
});

test("여러 건을 골라 복사하면 좌표와 이미지 경로가 함께 담긴다", async ({ page, context }) => {
  // 실행: 선택한 것을 복사한다.
  // 기대: 클립보드에 2건만 담기고, 각 건에 프레임 구간·씬·좌표·렌더본과 이미지 파일 경로가 포함된다.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  fx = await bootFixture({ frames: 200 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await makeNote(page, 30, "첫째", "이렇게");
  await makeNote(page, 90, "둘째");
  await makeNote(page, 150, "셋째");
  await expect(page.locator("#list .note")).toHaveCount(3);

  // 1·3번만 고른다.
  await page.locator("#list .note").nth(0).locator(".pick").check();
  await page.locator("#list .note").nth(2).locator(".pick").check();
  await expect(page.locator("#copy")).toHaveText("복사 (2)");
  await page.locator("#copy").click();
  await expect(page.locator("#copy")).toHaveText("복사됨");

  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toContain("첫째");
  expect(text).toContain("셋째");
  expect(text).not.toContain("둘째");        // 안 고른 건 빠진다
  expect(text).toMatch(/네모 \[[\d.]+, /);   // 좌표가 담긴다
  expect(text).toContain("f30");
});

test("복사본만으로 에이전트가 대상을 특정할 수 있다", async ({ page, context }) => {
  // 실행: 복사한 내용만 코딩 에이전트에게 전달한다.
  // 기대: 에이전트가 그 텍스트만으로 대상 프레임 구간과 화면 위치를 특정하고, 붙은 이미지 파일을 경로로 찾아 열 수 있다.
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  fx = await bootFixture({ frames: 200 });
  await page.goto(fx.server.url);
  await waitReady(page);
  await makeNote(page, 77, "여기가 이상하다", "이렇게 바꿔줘");
  await page.locator("#copy").click();
  // 클립보드는 기기 전체가 공유한다 — 쓰기가 끝난 걸 보고 읽지 않으면 앞 테스트의 내용을 읽는다.
  await expect(page.locator("#copy")).toHaveText("복사됨");
  const text = await page.evaluate(() => navigator.clipboard.readText());

  const [n] = await notesOf(fx.server);
  // 서버·파일 없이 이 글만으로 대상과 요청을 알 수 있어야 한다.
  for (const need of [n.id, "f77", n.tc, n.render, "여기가 이상하다", "이렇게 바꿔줘"]) {
    expect(text).toContain(String(need));
  }
});

test("클립보드가 거부되면 실패를 알리고 대체 수단을 준다", async ({ page }) => {
  // 실행: 메모를 골라 복사를 누른다.
  // 기대: 복사에 실패했다는 안내가 표시되고, 같은 내용을 직접 고를 수 있는 대체 수단이 함께 제시된다.
  fx = await bootFixture({ frames: 120 });
  await page.addInitScript(() => {
    // 브라우저가 클립보드 쓰기를 거부하는 상황을 만든다.
    Object.defineProperty(navigator, "clipboard", {
      value: { writeText: () => Promise.reject(new Error("denied")) },
      configurable: true,
    });
  });
  await page.goto(fx.server.url);
  await waitReady(page);
  await makeNote(page, 30, "복사 실패 확인");

  let alerted = "";
  page.on("dialog", async (d) => { alerted = d.message(); await d.accept(); });
  await page.locator("#copy").click();
  await expect.poll(() => alerted).toContain("클립보드");   // 성공한 척하지 않는다
  // 대체 수단 — 직접 고를 수 있는 글상자가 펼쳐진다.
  await expect(page.locator("body > textarea")).toHaveCount(1);
  const shown = await page.locator("body > textarea").inputValue();
  expect(shown).toContain("복사 실패 확인");
});

test("프레임을 확정할 수 없는 브라우저에서는 메모 작성을 잠근다", async ({ page }) => {
  // 실행: 영상을 연다.
  // 기대: 창은 열리되 메모 작성이 잠기고, 프레임 정확도를 보장할 수 없다는 사유와 지원되는 브라우저 안내가 표시된다.
  fx = await bootFixture({ frames: 120 });
  await page.addInitScript(() => {
    // 그려진 프레임을 알려주는 수단이 없는 브라우저를 흉내낸다.
    // @ts-expect-error — 일부러 지운다
    delete HTMLVideoElement.prototype.requestVideoFrameCallback;
  });
  await page.goto(fx.server.url);
  await page.waitForTimeout(2000);

  await expect(page.locator("#lock")).toBeVisible();
  await expect(page.locator("#lock")).toContainText("프레임");
  // 잠긴 상태에서는 끌어도 작성창이 안 열린다.
  await dragOnVideo(page, [0.2, 0.2], [0.5, 0.5]);
  await expect(page.locator("#composer")).not.toHaveClass(/on/);
  expect(await notesOf(fx.server)).toHaveLength(0);
});
