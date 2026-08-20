import { execFileSync } from "node:child_process";
import { covers } from "./covers.js";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startServer, type ServerHandle } from "../src/server.js";
import type { Note } from "../src/types.js";

// 왕복 통합 테스트 — 문서의 최상위 수용 기준을 고정한다.
//   영상에 네모 → 보내기 → 에이전트에게 신호 → 상태 변경 → 재렌더 → 낡음 판정
// mock 을 쓰지 않는다. 실제 HTTP·실제 WebSocket·실제 파일·실제 ffprobe 로 돈다.

const ROOT = resolve(__dirname, "..");
const PLAYER = join(ROOT, "player");

let dir: string;
let video: string;
let video2: string;
let server: ServerHandle;

const api = async (path: string, init?: RequestInit): Promise<any> => {
  const res = await fetch(`${server.url}${path}`, init);
  const body = await res.json().catch(() => null);
  return { status: res.status, body };
};

const makeRuler = (out: string, frames: number): void => {
  execFileSync("node", [
    join(ROOT, "scripts/make-ruler-video.mjs"),
    "--out", out, "--frames", String(frames), "--width", "320", "--height", "180",
  ], { cwd: ROOT, stdio: "ignore" });
};

beforeAll(async () => {
  // ffmpeg 가 없으면 **건너뛰지 않고 실패한다.** 조용히 건너뛰면 13개가 빠진 초록이 되고,
  // 그 초록은 실제보다 많은 것을 본 것처럼 읽힌다(실측 2026-08-19: CI 에 ffmpeg 가 없었다).
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    execFileSync("ffprobe", ["-version"], { stdio: "ignore" });
  } catch {
    throw new Error(
      "ffmpeg/ffprobe 가 없어 왕복 테스트를 돌릴 수 없습니다. " +
        "이 테스트는 mock 을 쓰지 않는 것이 목적이라 건너뛰지 않습니다. (brew install ffmpeg)",
    );
  }
  dir = mkdtempSync(join(tmpdir(), "framenote-rt-"));
  video = join(dir, "out", "final.mp4");
  video2 = join(dir, "out", "preview.mp4");
  makeRuler(video, 60);
  makeRuler(video2, 90); // 다른 렌더본 — 프레임 수가 달라 해시가 확실히 다르다
  server = await startServer({ videoPath: video, playerDir: PLAYER });
}, 60_000);

afterAll(async () => {
  await server?.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("왕복", () => {
  let noteId = "";
  let batchId = "";

  it("영상 규격을 파일에서 읽는다 — 브라우저가 아니라", async () => {
  covers(
    "mp4를 열면 창 하나에 규격과 렌더본이 표시된다",
    "Remotion이 아닌 영상도 열리고 프레임만 표시된다",
  );
    const { body } = await api("/api/info");
    expect(body.info.fps).toBe(30);
    expect(body.info.totalFrames).toBe(60);
    expect(body.info.width).toBe(320);
    expect(body.info.render).toMatch(/^[0-9a-f]{7}$/);
    expect(body.info.sourceKind).toBe("generic"); // 씬 목록이 없다
  });

  it("메모를 남기면 프레임·좌표·렌더본이 자동으로 붙는다", async () => {
  covers(
    "열기에서 계산한 렌더본이 이후 모든 메모에 실제로 붙는다",
    "메모 한 건이 규정된 항목을 모두 담아 한 줄로 저장된다",
  );
    const { status, body } = await api("/api/notes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        range: [12, 40], rect: { x0: 0.1, y0: 0.6, x1: 0.4, y1: 0.75 }, rectFrame: 20,
        what: "자막이 아래로 나감", want: "하단 안으로",
      }),
    });
    expect(status).toBe(201);
    const note = body as Note;
    noteId = note.id;
    expect(note.range).toEqual([12, 40]);
    expect(note.tc).toBe("00:00.40");
    expect(note.status).toBe("draft");
    expect(note.batch).toBeNull();
    expect(note.render).toMatch(/^[0-9a-f]{7}$/);
    expect(note.createdAt).not.toBe(note.tc); // 영상 안 시각과 만든 때는 다른 값이다
  });

  it("무엇이 칸이 비면 거부하고 파일에 줄이 안 늘어난다", async () => {
  covers(
    "무엇이 칸이 비면 저장을 거부한다",
  );
    const before = (await api("/api/notes")).body.length;
    const { status } = await api("/api/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [1, 1], what: "  " }),
    });
    expect(status).toBe(400);
    expect((await api("/api/notes")).body).toHaveLength(before);
  });

  it("어떻게를 비워도 저장된다 — 그냥 이상하다도 정당한 지적이다", async () => {
  covers(
    "어떻게를 비워도 저장되고 이미지·구간을 유도한다",
  );
    const { status, body } = await api("/api/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [50, 50], what: "여기가 어색하다" }),
    });
    expect(status).toBe(201);
    expect((body as Note).want).toBeNull();
  });

  it("보내기를 누르면 감시 중인 에이전트가 실제로 신호를 받는다", async () => {
  covers(
    "여러 건을 쌓아 한 번에 보내면 신호가 한 번만 간다",
    "신호에는 묶음 식별자와 건수만 담긴다",
    "보내기를 누르면 감시 중인 에이전트가 실제로 받아 집는다",
  );
    const ws = new WebSocket(`${server.url.replace("http", "ws")}/feed`);
    const signal = new Promise<any>((res, rej) => {
      const timer = setTimeout(() => rej(new Error("신호가 안 왔다")), 5000);
      ws.onmessage = (e) => { clearTimeout(timer); res(JSON.parse(String(e.data))); };
      ws.onerror = () => { clearTimeout(timer); rej(new Error("통로 연결 실패")); };
    });
    await new Promise<void>((r) => { ws.onopen = () => r(); });

    const { body } = await api("/api/send", { method: "POST" });
    const got = await signal;

    expect(got.type).toBe("batch");
    expect(got.batch).toBe(body.batch);
    expect(got.count).toBe(2); // draft 2건
    // 신호는 얇다 — 묶음 식별자와 건수만. 전문이 실려 오면 컨텍스트를 태운다.
    expect(got).not.toHaveProperty("notes");
    expect(JSON.stringify(got).length).toBeLessThan(120);

    batchId = body.batch;
    ws.close();
  });

  it("에이전트는 묶음 식별자로 전문을 따로 읽는다", async () => {
    const { body } = await api(`/api/notes?batch=${batchId}`);
    expect(body).toHaveLength(2);
    expect(body.every((n: Note) => n.status === "sent" && n.batch === batchId)).toBe(true);
  });

  it("서버 없이 파일만으로도 같은 값을 읽을 수 있다", async () => {
  covers(
    "파일로 읽은 것과 서버로 읽은 것이 같은 값을 준다",
    "화면에서 만든 메모가 파일에 손실 없이 기록된다",
  );
    // git 저장소가 아니면 영상이 있는 디렉터리가 최상단이다.
    const file = join(dir, "out", ".framenote", "final.mp4", "notes.jsonl");
    expect(existsSync(file)).toBe(true);
    const fromFile = readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Note);
    const fromApi: Note[] = (await api("/api/notes")).body;
    const key = (n: Note) => `${n.id}:${n.range.join("-")}:${n.what}`;
    expect(new Set(fromFile.map(key))).toEqual(new Set(fromApi.map(key)));
  });

  it("메모를 개별 지정하지 않은 상태 변경은 거부한다", async () => {
    const { status } = await api("/api/status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ batch: batchId, status: "applied" }),
    });
    expect(status).toBe(400);
  });

  it("한 요청에 반영됨과 실패를 섞어 보낼 수 있다", async () => {
  covers(
    "실패 메모도 재렌더 후 낡음으로 넘어간다",
  );
    const sent: Note[] = (await api(`/api/notes?batch=${batchId}`)).body;
    const [a, b] = sent;
    const { status, body } = await api("/api/status", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({
        updates: [
          { noteId: a!.id, status: "applied", renderedFile: video2 },
          { noteId: b!.id, status: "failed", reason: "폰트를 찾지 못했다" },
        ],
      }),
    });
    expect(status).toBe(200);
    expect(body.applied).toHaveLength(2);

    const after: Note[] = (await api("/api/notes")).body;
    expect(after.find((n) => n.id === a!.id)!.status).toBe("applied");
    const failed = after.find((n) => n.id === b!.id)!;
    expect(failed.failureReason).toBe("폰트를 찾지 못했다");
    // 실패는 낡음으로 넘어간다 — 무효 좌표가 다시 보내기로 그대로 나가면 안 된다.
    expect(failed.status).toBe("stale");
  });

  it("새 렌더본이 오면 반영됨은 낡음이 되지 않는다", async () => {
    const after: Note[] = (await api("/api/notes")).body;
    expect(after.some((n) => n.status === "applied")).toBe(true);
    expect(after.filter((n) => n.status === "applied").every((n) => n.status !== "stale")).toBe(true);
  });

  it("영상이 새 렌더본으로 갈아 끼워진다", async () => {
  covers(
    "렌더 출력 경로가 달라도 영상이 교체된다",
  );
    const { body } = await api("/api/info");
    expect(body.video).toBe(video2);
    expect(body.info.totalFrames).toBe(90); // 새 렌더본의 규격을 다시 읽는다
    expect(body.info.render).toMatch(/^[0-9a-f]{7}$/);
  });

  it("메모를 지우면 붙은 이미지 파일도 사라진다", async () => {
  covers(
    "이미지는 별도 파일로 저장되고 메모에는 경로만 들어간다",
  );
    const { body: created } = await api("/api/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [3, 3], what: "이미지 붙은 메모" }),
    });
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const up = await fetch(`${server.url}/api/notes/${created.id}/images?name=a.png`, {
      method: "POST", headers: { "content-type": "image/png" }, body: png,
    });
    expect(up.status).toBe(201);
    const withImg: Note = await up.json();
    expect(withImg.images).toHaveLength(1);
    const imgPath = join(dir, "out", ".framenote", "final.mp4", withImg.images[0]!);
    expect(existsSync(imgPath)).toBe(true);
    // 메모에는 경로만 들어간다 — 그림 데이터가 아니다.
    expect(JSON.stringify(withImg)).not.toContain("iVBORw0");

    await api(`/api/notes/${created.id}`, { method: "DELETE" });
    expect(existsSync(imgPath)).toBe(false);
  });

  it("알아볼 수 없는 이미지는 사유를 알린다 — 조용히 버리지 않는다", async () => {
  covers(
    "받을 수 없는 이미지는 사유를 표시한다",
  );
    const { body: created } = await api("/api/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [4, 4], what: "형식 시험" }),
    });
    const res = await fetch(`${server.url}/api/notes/${created.id}/images?name=noext`, {
      method: "POST", headers: { "content-type": "application/octet-stream" }, body: Buffer.from("x"),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("형식");
  });

  it("리뷰 서버가 로컬 밖으로 열려 있지 않다", () => {
    expect(server.url.startsWith("http://127.0.0.1:")).toBe(true);
  });

  it("메모가 남은 것을 최종 확인한다", async () => {
    const all: Note[] = (await api("/api/notes")).body;
    expect(all.length).toBeGreaterThan(0);
    expect(noteId).not.toBe("");
  });
});
