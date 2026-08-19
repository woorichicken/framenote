#!/usr/bin/env node
// 프레임 눈금 영상 생성기 — 프레임마다 그 번호를 크게 태운 영상을 만든다.
//
// 왜 필요한가: framenote 의 존재 이유는 "몇 번째 프레임"이 맞다는 것이다. 브라우저의 재생 시각
// 계산은 프레임이 어긋나는데 **에러가 안 나서 아무도 모른다.** 사람이 화면에서 읽은 번호와
// 도구가 기록한 번호를 대조할 수 있어야 그 오차가 드러난다.
//
// 왜 ffmpeg 의 drawtext 를 안 쓰나: 실측(2026-08-19) 이 맥의 ffmpeg 8.1.2 에는 drawtext 가 없다
// (freetype 없이 빌드됨). 검증 도구가 환경에 따라 안 돌면 검증을 안 하게 된다. 그래서 숫자를
// 직접 픽셀로 그리고 rawvideo 로 파이프한다 — 필터도 폰트도 의존성도 없다.
//
//   node scripts/make-ruler-video.mjs [--out <경로>] [--fps 30] [--frames 300]
//                                     [--width 960] [--height 540] [--gop 30]

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { assertFontShape, drawFrame } from "./ruler-font.mjs";

export function parseArgs(argv) {
  const o = { out: "test/fixtures/ruler.mp4", fps: 30, frames: 300, width: 960, height: 540, gop: 30 };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (!k || v === undefined) continue;
    o[k] = k === "out" ? v : Number(v);
  }
  return o;
}

export async function makeRulerVideo(opt) {
  assertFontShape();
  const out = resolve(process.cwd(), opt.out);
  mkdirSync(dirname(out), { recursive: true });

  const ff = spawn("ffmpeg", [
    "-hide_banner", "-loglevel", "error",
    "-f", "rawvideo", "-pix_fmt", "rgb24",
    "-s", `${opt.width}x${opt.height}`, "-r", String(opt.fps),
    "-i", "-",
    "-c:v", "libx264", "-pix_fmt", "yuv420p",
    "-g", String(opt.gop), "-crf", "18",
    "-y", out,
  ], { stdio: ["pipe", "inherit", "inherit"] });

  // spawn 실패를 listener 안에서 throw 하지 않는다 — 그 throw 는 await 와 연결되지 않아
  // uncaughtException 으로 새어나간다. 캡처해서 close 뒤에 판정한다.
  let spawnError = null;
  ff.on("error", (e) => { spawnError = e; });

  for (let n = 0; n < opt.frames; n++) {
    if (!ff.stdin.write(drawFrame(n, opt))) {
      await new Promise((r) => ff.stdin.once("drain", r));
    }
  }
  ff.stdin.end();

  const code = await new Promise((r) => ff.on("close", r));
  if (spawnError) {
    throw new Error(`ffmpeg 를 실행하지 못했습니다: ${spawnError.message} (brew install ffmpeg)`);
  }
  if (code !== 0) throw new Error(`ffmpeg 가 ${code} 로 끝났습니다.`);
  return out;
}

const isMain = process.argv[1] && import.meta.url.endsWith(process.argv[1].split("/").pop());
if (isMain) {
  const opt = parseArgs(process.argv.slice(2));
  makeRulerVideo(opt).then(
    (out) => console.log(`${out}  ${opt.width}x${opt.height} ${opt.fps}fps ${opt.frames}프레임 (GOP ${opt.gop})`),
    (e) => { console.error(e.message); process.exit(1); },
  );
}
