import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildStaticPage, defaultOutPath, exportStatic, toUrlPath } from "../src/static.js";
import type { Note, VideoInfo } from "../src/types.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYER = join(ROOT, "player");

const INFO: VideoInfo = {
  width: 1920, height: 1080, fps: 30, totalFrames: 3531, render: "abc123", sourceKind: "remotion",
};

const note = (over: Partial<Note> = {}): Note => ({
  id: "n1",
  range: [10, 20],
  tc: "00:00.33",
  createdAt: "2026-09-16T00:00:00.000Z",
  rect: null,
  rectFrame: null,
  scene: "01 도입",
  what: "자막이 잘린다",
  want: null,
  images: [],
  render: "abc123",
  sourceKind: "remotion",
  batch: null,
  status: "draft",
  failureReason: null,
  ...over,
});

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "framenote-static-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/** 페이지에 심은 씨앗을 도로 읽는다. 브라우저가 읽는 것과 같은 값인지 보기 위해서다. */
function seedOf(html: string): Record<string, unknown> {
  const m = /window\.__FRAMENOTE_STATIC__ = (\{[\s\S]*?\});<\/script>/.exec(html);
  if (!m) throw new Error("씨앗을 찾지 못했다");
  return JSON.parse(m[1]!) as Record<string, unknown>;
}

function runExport(over: Partial<Parameters<typeof exportStatic>[0]> = {}) {
  const video = join(dir, "out", "final.mp4");
  mkdirSync(dirname(video), { recursive: true });
  writeFileSync(video, "not-a-real-video");         // 규격은 주입한다 — 여기서 보는 것은 페이지다
  return exportStatic({
    videoPath: video,
    outPath: join(dir, "review", "final.framenote.html"),
    playerDir: PLAYER,
    info: INFO,
    scenes: [{ name: "01 도입", startFrame: 0 }, { name: "02 본문", startFrame: 300 }],
    previewCommand: null,
    notes: [note()],
    storeDir: join(dir, "out", ".framenote", "final.mp4"),
    notesFile: join(dir, "out", ".framenote", "final.mp4", "notes.jsonl"),
    ...over,
  });
}

describe("정적 내보내기", () => {
  it("서버 없이 여는 파일에는 서버로만 되는 주소가 남지 않는다", () => {
    const result = runExport();
    const html = readFileSync(result.out, "utf8");
    // 서버가 주던 것 셋이 전부 파일 안으로 들어왔는지 본다.
    expect(html).not.toContain('<script src="/player.js">');
    expect(html).not.toContain("/verify.js");
    expect(html).toContain("window.__FRAMENOTE_STATIC__");
    expect(html).toContain("framenote 플레이어");            // 플레이어 원본이 통째로 들어있다
    expect(html).toContain("서버 없이 여는 정적 모드");        // 어댑터도 들어있다
    // 영상은 파일 옆 상대 경로로 가리킨다. 절대 경로면 다른 사람 맥에서 안 열린다.
    expect(seedOf(html)["videoSrc"]).toBe("../out/final.mp4");
    expect(html).not.toContain("http://127.0.0.1");
  });

  it("플레이어 틀이 바뀌면 내보내기가 그 자리에서 실패한다", () => {
    // 조용히 지나가면 서버 주소를 부르는 죽은 페이지가 만들어진다.
    expect(() =>
      buildStaticPage({
        playerHtml: "<html><body>플레이어 태그가 없다</body></html>",
        playerJs: "", adapterJs: "",
        video: { name: "a.mp4", src: "a.mp4" }, fileBase: "a.files/", storeKey: "a.mp4",
        info: INFO, scenes: [], previewCommand: null, notes: [],
        notesFile: "", exportName: "a-notes.jsonl", exportedAt: "2026-09-16T00:00:00.000Z",
      }),
    ).toThrow(/player\.js/);
  });

  it("메모와 씬이 파일 안에 담기고 메모 글이 페이지를 끊지 못한다", () => {
    const evil = note({ id: "n2", what: "여기서 </script> 가 나온다" });
    const result = runExport({ notes: [note(), evil] });
    const html = readFileSync(result.out, "utf8");
    const seed = seedOf(html);
    expect((seed["notes"] as Note[]).map((n) => n.id)).toEqual(["n1", "n2"]);
    expect((seed["scenes"] as { name: string }[])[1]!.name).toBe("02 본문");
    expect((seed["info"] as VideoInfo).fps).toBe(30);
    // 글에 든 닫는 태그는 이스케이프돼 페이지를 끊지 않는다.
    expect(html).not.toContain("여기서 </script> 가 나온다");
    expect((seed["notes"] as Note[])[1]!.what).toBe("여기서 </script> 가 나온다");
    expect(result.notes).toBe(2);
  });

  it("첨부 이미지는 페이지 옆으로 복사돼 옮겨도 열린다", () => {
    const storeDir = join(dir, "out", ".framenote", "final.mp4");
    mkdirSync(join(storeDir, "images"), { recursive: true });
    writeFileSync(join(storeDir, "images", "n1-0.png"), "png-bytes");
    writeFileSync(join(storeDir, "images", "other-0.png"), "안 쓰는 그림");
    const result = runExport({ notes: [note({ images: ["images/n1-0.png"] })], storeDir });
    expect(result.images).toBe(1);                                  // 쓰는 것만 옮긴다
    const copied = join(dir, "review", "final.framenote.files", "images", "n1-0.png");
    expect(existsSync(copied)).toBe(true);
    expect(existsSync(join(dir, "review", "final.framenote.files", "images", "other-0.png"))).toBe(false);
    expect(seedOf(readFileSync(result.out, "utf8"))["fileBase"]).toBe("final.framenote.files/");
  });

  it("한글·공백이 든 파일 이름도 주소로 바뀐다", () => {
    expect(toUrlPath("../내 영상/r3 최종.mp4")).toBe("../%EB%82%B4%20%EC%98%81%EC%83%81/r3%20%EC%B5%9C%EC%A2%85.mp4");
    expect(defaultOutPath("/tmp/a/final.mp4")).toBe("/tmp/a/final.framenote.html");
  });
});
