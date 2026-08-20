import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { formatNotes, noteFields } from "../src/format.js";
import { readNotes } from "../src/notes.js";
import { findStoreRoot, notesFileFor, videoKey } from "../src/paths.js";
import { startServer, type ServerHandle } from "../src/server.js";
import type { Note } from "../src/types.js";
import { renderIdOf } from "../src/video.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYER = join(ROOT, "player");

const makeRuler = (out: string, frames: number): void => {
  mkdirSync(dirname(out), { recursive: true });
  execFileSync("node", [join(ROOT, "scripts/make-ruler-video.mjs"),
    "--out", out, "--frames", String(frames), "--width", "320", "--height", "180"],
    { cwd: ROOT, stdio: "ignore" });
};

let dir: string;
const servers: ServerHandle[] = [];
const post = async (s: ServerHandle, body: unknown): Promise<Note> =>
  (await (await fetch(`${s.url}/api/notes`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  })).json()) as Note;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "framenote-store-")); });
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("저장 형식", () => {
  it("이름이 같은 두 영상의 메모가 섞이지 않는다", async () => {
    // git 저장소로 만들어 둘의 저장 루트를 같게 한다 — 그래야 키가 정말 갈리는지 본다.
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const a = join(dir, "a", "out", "final.mp4");
    const b = join(dir, "b", "out", "final.mp4");
    makeRuler(a, 20); makeRuler(b, 20);
    expect(findStoreRoot(a)).toBe(findStoreRoot(b));          // 같은 루트인데
    expect(videoKey(dir, a)).not.toBe(videoKey(dir, b));      // 키는 다르다

    const sa = await startServer({ videoPath: a, playerDir: PLAYER });
    const sb = await startServer({ videoPath: b, playerDir: PLAYER });
    servers.push(sa, sb);
    await post(sa, { range: [1, 1], what: "A" });
    await post(sb, { range: [2, 2], what: "B" });

    expect(readNotes(dir, a).map((n) => n.what)).toEqual(["A"]);
    expect(readNotes(dir, b).map((n) => n.what)).toEqual(["B"]);
  });

  it("앞부분이 같고 뒤가 다른 두 렌더본이 구분된다", async () => {
    const base = Buffer.alloc(3 * 1024 * 1024, 7);
    const one = join(dir, "one.bin");
    const two = join(dir, "two.bin");
    writeFileSync(one, Buffer.concat([base, Buffer.from("AAAA")]));
    writeFileSync(two, Buffer.concat([base, Buffer.from("BBBB")]));
    // 부분 해시라면 같은 값이 나온다.
    expect(await renderIdOf(one)).not.toBe(await renderIdOf(two));
  });

  it("영상 안 시각과 메모를 만든 때가 따로 기록된다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 60);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const n = await post(s, { range: [45, 45], what: "시각 분리" });
    expect(n.tc).toBe("00:01.50");                       // 45 / 30fps
    expect(n.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);  // 만든 때는 ISO 일시
    expect(n.createdAt).not.toBe(n.tc);
  });

  it("파일에서 읽은 프레임 레이트가 실제 메모 프레임 번호에 쓰인다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 90);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const info = (await (await fetch(`${s.url}/api/info`)).json()) as { info: { fps: number } };
    expect(info.info.fps).toBe(30);           // 브라우저가 아니라 파일에서 읽은 값
    const n = await post(s, { range: [75, 75], what: "레이트 확인" });
    expect(n.tc).toBe("00:02.50");            // 75 / 30 — 그 값으로 계산됐다
  });

  it("쓰는 중 중단돼도 앞선 메모가 깨지지 않는다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    await post(s, { range: [1, 1], what: "첫째" });
    await post(s, { range: [2, 2], what: "둘째" });
    await post(s, { range: [3, 3], what: "셋째" });
    await s.close();
    servers.length = 0;

    // 네 번째를 쓰다 죽은 상태를 만든다 — 마지막 줄이 잘린다.
    const root = findStoreRoot(v);   // 손으로 계산하면 규칙이 바뀔 때 테스트가 먼저 틀린다
    const file = notesFileFor(root, v);
    appendFileSync(file, '{"id":"broken","range":[4,4],"what":"쓰다 말');

    const notes = readNotes(root, v);
    expect(notes.map((n) => n.what)).toEqual(["첫째", "둘째", "셋째"]);  // 앞 셋은 살았다
  });

  it("서버를 죽였다 켜도 메모가 그대로 남는다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s1 = await startServer({ videoPath: v, playerDir: PLAYER });
    const made = await post(s1, { range: [7, 9], what: "살아남을 것", want: "그대로" });
    await s1.close();

    const s2 = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s2);
    const again = (await (await fetch(`${s2.url}/api/notes`)).json()) as Note[];
    expect(again).toHaveLength(1);
    expect(again[0]!.id).toBe(made.id);
    expect(again[0]!.range).toEqual([7, 9]);
    expect(again[0]!.status).toBe("draft");
  });

  it("메모를 지우면 붙은 이미지 파일도 함께 지운다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const n = await post(s, { range: [1, 1], what: "이미지 붙은 것" });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    const withImg = (await (await fetch(`${s.url}/api/notes/${n.id}/images?name=a.png`, {
      method: "POST", headers: { "content-type": "image/png" }, body: png,
    })).json()) as Note;
    const imgPath = join(dirname(v), ".framenote", "final.mp4", withImg.images[0]!);
    expect(existsSync(imgPath)).toBe(true);

    await fetch(`${s.url}/api/notes/${n.id}`, { method: "DELETE" });
    expect(existsSync(imgPath)).toBe(false);
  });

  it("형식 정보가 없는 이미지도 확장자로 알아본다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const n = await post(s, { range: [1, 1], what: "확장자 인식" });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64");
    // 클립보드가 형식을 안 알려주는 경우 — 파일 이름만 있다.
    const res = await fetch(`${s.url}/api/notes/${n.id}/images?name=shot.png`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: png,
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as Note).images[0]).toMatch(/\.png$/);
  });

  it("복사본과 에이전트 전달본이 같은 정보를 담는다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 60);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const n = await post(s, {
      range: [10, 40], rect: { x0: .1, y0: .2, x1: .5, y1: .6 }, rectFrame: 20,
      what: "무엇", want: "어떻게",
    });
    // 복사본은 서버에서 나온다 — 브라우저가 따로 조립하지 않는다.
    const copy = await (await fetch(`${s.url}/api/format`)).text();
    for (const value of [n.id, "f10–40", n.tc, "무엇", "어떻게", n.render]) {
      expect(copy).toContain(String(value));
    }
    // 항목 집합이 같은지도 본다 — 한쪽에만 있는 항목이 없어야 한다.
    const keys = Object.keys(noteFields(n));
    expect(keys).toContain("rectFrame");
    expect(copy).toContain("@f20");
    expect(formatNotes([n], v, {
      width: 320, height: 180, fps: 30, totalFrames: 60, render: n.render, sourceKind: "generic",
    })).toBe(copy);          // 같은 함수가 만든다
  });
});
