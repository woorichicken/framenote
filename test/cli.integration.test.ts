import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { findVideos, pickLatestVideo, VIDEO_EXTS } from "../src/discover.js";
import { run } from "../src/cli.js";
import { startServer, type ServerHandle } from "../src/server.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PLAYER = join(ROOT, "player");

const makeRuler = (out: string, frames: number, size = "320x180"): void => {
  mkdirSync(dirname(out), { recursive: true });
  const [w, h] = size.split("x");
  execFileSync("node", [join(ROOT, "scripts/make-ruler-video.mjs"),
    "--out", out, "--frames", String(frames), "--width", w!, "--height", h!],
    { cwd: ROOT, stdio: "ignore" });
};

let dir: string;
let cwd: string;
const servers: ServerHandle[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "framenote-cli-"));
  cwd = process.cwd();
});
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
  process.chdir(cwd);
  rmSync(dir, { recursive: true, force: true });
});

/** stderr/stdout 을 가로채 무엇을 알렸는지 본다. 조용한 실패를 잡기 위해서다. */
function capture(): { out: string[]; err: string[]; restore: () => void } {
  const out: string[] = [];
  const err: string[] = [];
  const so = process.stdout.write.bind(process.stdout);
  const se = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((c: string) => { out.push(String(c)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((c: string) => { err.push(String(c)); return true; }) as typeof process.stderr.write;
  return { out, err, restore: () => { process.stdout.write = so; process.stderr.write = se; } };
}

describe("진입", () => {
  it("없는 파일을 주면 창을 띄우지 않고 경로와 사유를 출력한다", async () => {
    const missing = join(dir, "no-such", "clip.mp4");
    const cap = capture();
    const code = await run([missing, "--no-open"]);
    cap.restore();
    expect(code).toBe(1);
    expect(cap.err.join("")).toContain(missing);   // 무엇을 찾으려 했는지 보인다
    expect(cap.out.join("")).not.toContain("http://");  // 서버를 안 띄웠다
  });

  it("열 영상이 없으면 찾은 범위와 확장자를 알리고 끝낸다", async () => {
    mkdirSync(join(dir, "empty"), { recursive: true });
    process.chdir(join(dir, "empty"));
    const cap = capture();
    const code = await run(["--no-open"]);
    cap.restore();
    expect(code).toBe(1);
    const msg = cap.err.join("");
    expect(msg).toContain(join(dir, "empty"));
    for (const ext of VIDEO_EXTS) expect(msg).toContain(ext);
  });

  it("하위 폴더는 찾되 node_modules 는 건너뛴다", () => {
    makeRuler(join(dir, "out", "wanted.mp4"), 20);
    // node_modules 안의 것을 더 최근으로 만든다 — 그래도 안 골라야 한다.
    makeRuler(join(dir, "node_modules", "pkg", "newer.mp4"), 20);
    const found = findVideos(dir).map((c) => c.path);
    expect(found.some((p) => p.endsWith("wanted.mp4"))).toBe(true);
    expect(found.some((p) => p.includes("node_modules"))).toBe(false);
    expect(pickLatestVideo(dir)).toContain("wanted.mp4");
  });

  it("점으로 시작하는 폴더도 건너뛴다", () => {
    makeRuler(join(dir, "out", "ok.mp4"), 20);
    makeRuler(join(dir, ".cache", "hidden.mp4"), 20);
    const found = findVideos(dir).map((c) => c.path);
    expect(found.some((p) => p.includes(".cache"))).toBe(false);
  });

  it("두 영상을 동시에 리뷰해도 서로 방해하지 않는다", async () => {
    const a = join(dir, "a", "final.mp4");
    const b = join(dir, "b", "final.mp4");
    makeRuler(a, 20);
    makeRuler(b, 30);
    const sa = await startServer({ videoPath: a, playerDir: PLAYER });
    const sb = await startServer({ videoPath: b, playerDir: PLAYER });
    servers.push(sa, sb);
    expect(sa.port).not.toBe(sb.port);

    await fetch(`${sa.url}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [1, 1], what: "A 의 메모" }),
    });
    const inA = (await (await fetch(`${sa.url}/api/notes`)).json()) as unknown[];
    const inB = (await (await fetch(`${sb.url}/api/notes`)).json()) as unknown[];
    expect(inA).toHaveLength(1);
    expect(inB).toHaveLength(0);   // 서로 안 보인다
  });

  it("규격을 못 읽는 파일은 창을 열되 메모 작성을 잠근다", async () => {
    // 확장자만 영상인 쓰레기 파일 — ffprobe 가 스트림을 못 찾는다.
    const broken = join(dir, "out", "broken.mp4");
    mkdirSync(dirname(broken), { recursive: true });
    writeFileSync(broken, Buffer.from("이건 영상이 아니다"));
    const s = await startServer({ videoPath: broken, playerDir: PLAYER });
    servers.push(s);

    const info = (await (await fetch(`${s.url}/api/info`)).json()) as { locked: boolean; lockReason: string };
    expect(info.locked).toBe(true);
    expect(info.lockReason.length).toBeGreaterThan(0);   // 왜 잠겼는지 알린다

    const res = await fetch(`${s.url}/api/notes`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: [0, 0], what: "만들면 안 된다" }),
    });
    expect(res.status).toBe(409);   // 프레임 없는 메모를 만들지 않는다
  });

  it("확정 전에는 파일이 아예 생기지 않는다", async () => {
    const v = join(dir, "out", "final.mp4");
    makeRuler(v, 20);
    const s = await startServer({ videoPath: v, playerDir: PLAYER });
    servers.push(s);
    // 창을 열고 정보를 읽는 것만으로는 메모 파일이 생기지 않는다.
    await fetch(`${s.url}/api/info`);
    await fetch(`${s.url}/api/notes`);
    const { existsSync } = await import("node:fs");
    expect(existsSync(join(dir, "out", ".framenote", "final.mp4", "notes.jsonl"))).toBe(false);
  });
});
