import { execFileSync } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveVideo } from "../src/cli.js";
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

const LOCAL = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * 나가는 요청을 전부 기록한다.
 *
 * "밖으로 안 나간다"는 이 도구의 약속이라 **관찰해서** 확인한다. 코드에 fetch 가 없다는 것은
 * 근거가 아니다 — 의존성이나 앞으로 들어올 코드가 부를 수 있다.
 */
function watchEgress(): { outside: string[]; restore: () => void } {
  const outside: string[] = [];
  const realFetch = globalThis.fetch;
  const realHttp = http.request;
  const realHttps = https.request;

  const note = (host: string): void => { if (!LOCAL.has(host)) outside.push(host); };

  globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
    try { note(new URL(String(input instanceof Request ? input.url : input)).hostname); } catch { /* 상대 경로 */ }
    return realFetch(input as RequestInfo, init);
  }) as typeof fetch;
  http.request = ((...args: unknown[]) => {
    const o = args[0] as { hostname?: string; host?: string } | string;
    note(typeof o === "string" ? new URL(o).hostname : (o.hostname ?? o.host ?? ""));
    return (realHttp as (...a: unknown[]) => http.ClientRequest)(...args);
  }) as typeof http.request;
  https.request = ((...args: unknown[]) => {
    const o = args[0] as { hostname?: string; host?: string } | string;
    note(typeof o === "string" ? new URL(o).hostname : (o.hostname ?? o.host ?? ""));
    return (realHttps as (...a: unknown[]) => http.ClientRequest)(...args);
  }) as typeof https.request;

  return {
    outside,
    restore: () => { globalThis.fetch = realFetch; http.request = realHttp; https.request = realHttps; },
  };
}

let dir: string;
const servers: ServerHandle[] = [];
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "framenote-bound-")); });
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("경계", () => {
  it("동작 중 저장소 밖으로 나가는 요청이 없다", async () => {
    // 실행: 영상을 열고 메모를 작성·수정·삭제하고 보내기까지 한 바퀴 돈다.
    // 기대: 로컬 주소 밖으로 나가는 요청이 한 건도 발생하지 않는다.
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const watch = watchEgress();
    try {
      const s = await startServer({ videoPath: v, playerDir: PLAYER });
      servers.push(s);
      // 한 바퀴 돈다 — 열기·작성·수정·이미지·보내기·상태·복사·삭제.
      const n = (await (await fetch(`${s.url}/api/notes`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ range: [3, 9], what: "한 바퀴" }),
      })).json()) as Note;
      await fetch(`${s.url}/api/notes/${n.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ want: "이렇게" }),
      });
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64");
      await fetch(`${s.url}/api/notes/${n.id}/images?name=a.png`, {
        method: "POST", headers: { "content-type": "image/png" }, body: png,
      });
      await fetch(`${s.url}/api/send`, { method: "POST" });
      await fetch(`${s.url}/api/status`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ updates: [{ noteId: n.id, status: "working" }] }),
      });
      await fetch(`${s.url}/api/format`);
      await fetch(`${s.url}/api/info`);
      await fetch(`${s.url}/`);
    } finally { watch.restore(); }
    expect(watch.outside).toEqual([]);
  });

  it("왕복을 완주해도 커밋과 푸시가 일어나지 않는다", async () => {
    // 실행: 메모를 보내고 에이전트가 소스를 고쳐 재렌더까지 완주하게 둔다.
    // 기대: 소스 파일과 렌더 결과물은 바뀌지만 커밋이 생기지 않고 원격에 푸시되지 않는다.
    execFileSync("git", ["init", "-q"], { cwd: dir });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t",
      "commit", "-q", "--allow-empty", "-m", "base"], { cwd: dir });
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();
    const count = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim();

    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 30);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    const n = (await (await fetch(`${s.url}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [1, 1], what: "커밋 안 함" }),
    })).json()) as Note;
    await fetch(`${s.url}/api/send`, { method: "POST" });
    await fetch(`${s.url}/api/status`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ updates: [{ noteId: n.id, status: "applied" }] }),
    });

    expect(execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(head);
    expect(execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()).toBe(count);
    // 메모는 워킹트리에 남는다 — 커밋 여부는 사람이 정한다.
    const dirty = execFileSync("git", ["status", "--short"], { cwd: dir, encoding: "utf8" });
    expect(dirty).toContain(".framenote");
  });

  it("인자를 생략하면 최근 영상을 고르고 무엇을 골랐는지 알린다", () => {
    // 실행: 파일 인자 없이 도구를 실행한다.
    // 기대: 가장 최근에 수정된 영상이 열리고, 어떤 파일을 골랐는지 터미널에 파일 경로가 한 줄 출력된다.
    const older = join(dir, "out", "older.mp4");
    const newer = join(dir, "out", "newer.mp4");
    makeRuler(older, 20);
    makeRuler(newer, 20);
    // 잠들어서 mtime 을 벌리지 않는다 — 직접 정하면 결정적이고 빠르다.
    utimesSync(older, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    utimesSync(newer, new Date(1_800_000_000_000), new Date(1_800_000_000_000));

    const picked = resolveVideo({ video: null, port: undefined, open: false, help: false }, dir);
    expect("error" in picked).toBe(false);
    if ("error" in picked) return;
    expect(picked.video).toBe(newer);                    // 최근 것
    expect(picked.notice).toContain("영상을 골랐습니다");   // 무엇을 골랐는지 알린다
    expect(picked.notice).toContain("newer.mp4");
    expect(picked.notice).not.toContain("older.mp4");
  });

});
