import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

import { startServer, type ServerHandle } from "../src/server.js";

// 패키지가 ESM 이라 __dirname 이 없다.
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 프레임 눈금 영상을 만든다. 실제 ffmpeg 를 쓴다 — mock 을 쓰면 프레임 검증이 무의미해진다. */
export function makeRuler(out: string, frames: number, size = "640x360"): void {
  mkdirSync(dirname(out), { recursive: true });
  const [w, h] = size.split("x");
  execFileSync("node", [
    join(ROOT, "scripts/make-ruler-video.mjs"),
    "--out", out, "--frames", String(frames), "--width", w!, "--height", h!,
  ], { cwd: ROOT, stdio: "ignore" });
}

export interface Fixture {
  dir: string;
  video: string;
  server: ServerHandle;
  cleanup(): Promise<void>;
}

export async function bootFixture(opts?: {
  frames?: number;
  scenes?: { name: string; startFrame: number }[];
  previewCommand?: string;
}): Promise<Fixture> {
  const dir = mkdtempSync(join(tmpdir(), "framenote-e2e-"));
  const video = join(dir, "out", "final.mp4");
  makeRuler(video, opts?.frames ?? 200);

  if (opts?.scenes || opts?.previewCommand) {
    // 설정은 **저장 루트** 기준이다. git 저장소가 아니면 영상이 있는 디렉터리가 루트다.
    const cfgDir = join(dir, "out", ".framenote");
    mkdirSync(cfgDir, { recursive: true });
    const cfg: Record<string, unknown> = {};
    if (opts.previewCommand) cfg["previewCommand"] = opts.previewCommand;
    if (opts.scenes) cfg["scenes"] = opts.scenes;
    writeFileSync(join(cfgDir, "config.json"), JSON.stringify(cfg, null, 2));
  }

  const server = await startServer({ videoPath: video, playerDir: join(ROOT, "player") });
  return {
    dir, video, server,
    async cleanup() {
      await server.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** 플레이어가 영상을 다 읽고 프레임 추적을 시작할 때까지 기다린다. */
export async function waitReady(page: Page): Promise<void> {
  await page.waitForFunction(() => {
    const w = window as unknown as { __currentFrame?: () => number };
    const v = document.getElementById("v") as HTMLVideoElement | null;
    return typeof w.__currentFrame === "function" && !!v && v.readyState >= 3;
  }, undefined, { timeout: 20_000 });
}

export async function seek(page: Page, frame: number): Promise<number> {
  return page.evaluate(
    (f) => (window as unknown as { __seekToFrame: (n: number) => Promise<number> }).__seekToFrame(f),
    frame,
  );
}

export const currentFrame = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as { __currentFrame: () => number }).__currentFrame());

/** 영상 요소 위의 비율 좌표를 실제 화면 좌표로 바꿔 끈다. */
export async function dragOnVideo(
  page: Page,
  from: [number, number],
  to: [number, number],
): Promise<void> {
  const box = await page.locator("#v").boundingBox();
  if (!box) throw new Error("영상 요소를 찾지 못했다");
  const x = (r: number): number => box.x + box.width * r;
  const y = (r: number): number => box.y + box.height * r;
  await page.mouse.move(x(from[0]), y(from[1]));
  await page.mouse.down();
  await page.mouse.move((x(from[0]) + x(to[0])) / 2, (y(from[1]) + y(to[1])) / 2);
  await page.mouse.move(x(to[0]), y(to[1]));
  await page.mouse.up();
}

/** 스크러버를 클릭하거나 끈다. 클릭=점, 드래그=구간. */
export async function scrub(page: Page, fromRatio: number, toRatio?: number): Promise<void> {
  const box = await page.locator("#scrub").boundingBox();
  if (!box) throw new Error("스크러버를 찾지 못했다");
  const y = box.y + box.height / 2;
  await page.mouse.move(box.x + box.width * fromRatio, y);
  await page.mouse.down();
  if (toRatio !== undefined) {
    await page.mouse.move(box.x + box.width * ((fromRatio + toRatio) / 2), y);
    await page.mouse.move(box.x + box.width * toRatio, y);
  }
  await page.mouse.up();
}

export const notesOf = async (server: ServerHandle): Promise<any[]> =>
  (await fetch(`${server.url}/api/notes`)).json() as Promise<any[]>;
