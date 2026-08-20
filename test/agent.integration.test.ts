import { execFileSync } from "node:child_process";
import { covers } from "./covers.js";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { listServers } from "../src/config.js";
import { readNotes } from "../src/notes.js";
import { findStoreRoot } from "../src/paths.js";
import { startServer, type ServerHandle } from "../src/server.js";
import type { Note } from "../src/types.js";

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

/** 통로에 붙어 신호를 모은다. 실제 WebSocket 을 쓴다 — 직접 만든 클라이언트로는 계약을 못 지킨다. */
function attach(url: string): { got: unknown[]; ready: Promise<void>; close: () => void } {
  const ws = new WebSocket(`${url.replace("http", "ws")}/feed`);
  const got: unknown[] = [];
  ws.onmessage = (e) => got.push(JSON.parse(String(e.data)));
  return {
    got,
    ready: new Promise<void>((r) => { ws.onopen = () => r(); }),
    close: () => ws.close(),
  };
}
const settle = (ms = 400): Promise<void> => new Promise((r) => setTimeout(r, ms));

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "framenote-agent-")); });
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("에이전트 접점", () => {
  it("서버 목록 파일로 자기 영상의 주소를 찾는다", async () => {
  covers(
    "에이전트가 서버 목록 파일로 자기 영상의 주소를 찾는다",
  );
    execFileSync("git", ["init", "-q"], { cwd: dir });
    const a = join(dir, "a", "out", "final.mp4");
    const b = join(dir, "b", "out", "final.mp4");
    makeRuler(a, 20); makeRuler(b, 20);
    const sa = await startServer({ videoPath: a, playerDir: PLAYER });
    const sb = await startServer({ videoPath: b, playerDir: PLAYER });
    servers.push(sa, sb);

    const listed = listServers(dir);
    expect(listed.length).toBeGreaterThanOrEqual(2);
    // 에이전트는 영상 경로로 자기 것을 고른다 — 터미널 출력을 긁지 않는다.
    const mine = listed.find((e) => e.video === a);
    expect(mine?.port).toBe(sa.port);
    expect(listed.find((e) => e.video === b)?.port).toBe(sb.port);
  });

  it("서버가 정상 종료하면 목록에서 자기 항목을 지운다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 20);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    const root = findStoreRoot(v);
    expect(listServers(root).some((e) => e.port === s.port)).toBe(true);
    await s.close();
    expect(listServers(root).some((e) => e.port === s.port)).toBe(false);
  });

  it("새 묶음과 취소가 같은 통로로 오되 구분된다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const ws = attach(s.url);
    await ws.ready;

    const n = await post(s, { range: [5, 5], what: "취소될 것" });
    await fetch(`${s.url}/api/send`, { method: "POST" });
    await fetch(`${s.url}/api/status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: [{ noteId: n.id, status: "working" }] }),
    });
    // 사람이 작업중 메모를 고치면 취소가 나간다.
    await fetch(`${s.url}/api/notes/${n.id}`, {
      method: "PATCH", headers: { "content-type": "application/json" },
      body: JSON.stringify({ what: "고쳤다" }),
    });
    await settle();
    ws.close();

    const kinds = (ws.got as { type: string; noteId?: string }[]).map((g) => g.type);
    expect(kinds).toContain("batch");
    expect(kinds).toContain("cancel");
    const cancel = (ws.got as { type: string; noteId?: string }[]).find((g) => g.type === "cancel");
    expect(cancel?.noteId).toBe(n.id);   // 어느 메모인지 실려 온다
  });

  it("통로가 끊겨도 메모는 남고 재연결 후 이어받는다", async () => {
    covers("에이전트가 없어도 메모가 남고 나중에 이어받는다");
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const first = attach(s.url);
    await first.ready;
    first.close();               // 에이전트가 끊긴다
    await settle(200);

    await post(s, { range: [1, 1], what: "끊긴 동안 쓴 것" });
    const { batch } = (await (await fetch(`${s.url}/api/send`, { method: "POST" })).json()) as { batch: string };
    expect(batch).toBeTruthy();  // 신호를 받을 사람이 없어도 묶음은 만들어진다

    // 다시 붙은 에이전트가 아직 처리 안 된 묶음을 읽어 이어서 한다.
    const again = attach(s.url);
    await again.ready;
    const pending = (await (await fetch(`${s.url}/api/notes?batch=${batch}`)).json()) as Note[];
    expect(pending).toHaveLength(1);
    expect(pending[0]!.status).toBe("sent");
    again.close();
  });

  it("메모를 저장하는 것만으로는 에이전트를 부르지 않는다", async () => {
    // 쓰는 대로 계속 부르면 에이전트가 덜 쓴 메모에 반응하고, 알림이 잦으면 감시가 끊긴다.
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const ws = attach(s.url);
    await ws.ready;

    for (let i = 1; i <= 5; i++) await post(s, { range: [i, i], what: `메모 ${i}` });
    await settle(600);
    expect(readNotes(findStoreRoot(v), v)).toHaveLength(5);   // 파일에는 다 있다
    expect(ws.got).toHaveLength(0);                            // 신호는 한 번도 안 갔다

    await fetch(`${s.url}/api/send`, { method: "POST" });
    await settle(400);
    expect(ws.got).toHaveLength(1);                            // 보내기를 눌러야 간다
    ws.close();
  });

  it("서버 없이 파일만으로 에이전트가 일할 수 있다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    const made = await post(s, {
      range: [12, 20], rect: { x0: .1, y0: .1, x1: .4, y1: .4 }, rectFrame: 15,
      what: "서버 없이 읽을 것", want: "이렇게",
    });
    await s.close();             // 서버를 완전히 내린다

    const notes = readNotes(findStoreRoot(v), v);
    expect(notes).toHaveLength(1);
    const n = notes[0]!;
    // 대상과 요청을 특정할 수 있어야 한다.
    expect(n.id).toBe(made.id);
    expect(n.range).toEqual([12, 20]);
    expect(n.rect).not.toBeNull();
    expect(n.rectFrame).toBe(15);
    expect(n.what).toBe("서버 없이 읽을 것");
    expect(n.render).toMatch(/^[0-9a-f]{7}$/);
  });

  it("서버가 꺼져 상태를 못 남기면 조용히 끝나지 않는다", async () => {
  covers(
    "서버가 꺼져 상태를 못 남기면 조용히 끝내지 않는다",
  );
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    const n = await post(s, { range: [1, 1], what: "상태를 못 남길 것" });
    const url = s.url;
    await s.close();

    // 에이전트가 상태를 바꾸려 하면 실패가 드러난다 — 성공한 척 넘어가지 않는다.
    let failed = false;
    try {
      await fetch(`${url}/api/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: [{ noteId: n.id, status: "applied" }] }),
      });
    } catch { failed = true; }
    expect(failed).toBe(true);
    // 파일의 상태는 그대로다 — 반영됨으로 잘못 기록되지 않았다.
    expect(readNotes(findStoreRoot(v), v)[0]!.status).toBe("draft");
  });

  it("리뷰 서버와 통로가 같은 네트워크에 노출되지 않는다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 20);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    expect(s.url.startsWith("http://127.0.0.1:")).toBe(true);

    // 이 기기의 외부 주소로는 안 붙어야 한다.
    const { networkInterfaces } = await import("node:os");
    const external = Object.values(networkInterfaces()).flat()
      .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
    if (!external) return;    // 외부 인터페이스가 없는 환경이면 확인할 게 없다

    let refused = false;
    try {
      await fetch(`http://${external}:${s.port}/api/info`, { signal: AbortSignal.timeout(2000) });
    } catch { refused = true; }
    expect(refused).toBe(true);
  });

  it("렌더 명령이 없으면 에이전트가 그 사실을 알 수 있다", async () => {
  covers(
    "렌더 명령이 없으면 재렌더하지 않고 사유를 남긴다",
  );
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 20);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const info = (await (await fetch(`${s.url}/api/info`)).json()) as { previewCommand: string | null };
    expect(info.previewCommand).toBeNull();   // 설정이 없으면 null — 짐작하지 않는다
  });

  it("렌더 명령이 있으면 그것만 알려준다 — 최종 렌더 명령은 없다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 20);
    const cfgDir = join(dirname(v), ".framenote");
    mkdirSync(cfgDir, { recursive: true });
    writeFileSync(join(cfgDir, "config.json"),
      JSON.stringify({ previewCommand: "pnpm render:preview" }));
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const info = (await (await fetch(`${s.url}/api/info`)).json()) as
      { previewCommand: string | null } & Record<string, unknown>;
    expect(info.previewCommand).toBe("pnpm render:preview");
    expect(JSON.stringify(info)).not.toContain("render:final");
  });
});
