#!/usr/bin/env node
// 프레임 눈금 영상 생성기 — 프레임마다 그 번호를 크게 태운 영상을 만든다.
//
// 왜 필요한가: framenote 의 존재 이유는 "몇 번째 프레임"이 맞다는 것이다. 그런데 브라우저의
// 재생 시각 계산은 프레임이 어긋나고, **에러가 안 나서 아무도 모른다.** 사람이 화면에서 읽은
// 번호와 도구가 기록한 번호를 대조할 수 있어야 그 오차가 드러난다.
//
// 왜 ffmpeg 의 drawtext 를 안 쓰나: 실측(2026-08-19) 이 맥의 ffmpeg 8.1.2 에는 drawtext 가
// 없다(freetype 없이 빌드됨). 검증 도구가 환경에 따라 안 돌면 검증을 안 하게 된다. 그래서
// 숫자를 직접 픽셀로 그리고 rawvideo 로 파이프한다 — 필터도 폰트도 의존성도 없다.
//
//   node scripts/make-ruler-video.mjs [--out <경로>] [--fps 30] [--frames 300]
//                                     [--width 960] [--height 540] [--gop 30]

import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

// 5x7 비트맵 글리프. 한 줄로 이어 쓰면 세다가 틀린다(실제로 틀렸다) — 행 배열로 둔다.
const FONT = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
};
const GW = 5, GH = 7;

// 글리프가 규격에서 벗어나면 즉시 멈춘다. 조용히 어긋난 눈금으로 검증하면 검증이 거짓말을 한다.
for (const [d, rows] of Object.entries(FONT)) {
  if (rows.length !== GH) throw new Error(`글리프 '${d}' 행이 ${rows.length} 개다 (${GH} 이어야 함)`);
  for (const r of rows) {
    if (r.length !== GW) throw new Error(`글리프 '${d}' 행 '${r}' 길이가 ${r.length} 다 (${GW} 이어야 함)`);
  }
}

function parseArgs(argv) {
  const o = {
    out: "test/fixtures/ruler.mp4",
    fps: 30, frames: 300, width: 960, height: 540, gop: 30,
  };
  for (let i = 0; i < argv.length; i += 2) {
    const k = argv[i]?.replace(/^--/, "");
    const v = argv[i + 1];
    if (!k || v === undefined) continue;
    o[k] = k === "out" ? v : Number(v);
  }
  return o;
}

/** 프레임 하나를 RGB24 버퍼로 그린다. 배경은 프레임마다 조금씩 달라 인코더가 뭉개지 않는다. */
function drawFrame(n, { width, height, frames, gop }) {
  const buf = Buffer.alloc(width * height * 3);
  const bg = 16 + (n % 8) * 2;
  buf.fill(bg);

  const label = String(n);
  const scale = Math.max(4, Math.floor(height / (GH * 3)));
  const digitW = (GW + 1) * scale;
  const startX = Math.floor((width - digitW * label.length) / 2);
  const startY = Math.floor((height - GH * scale) / 2);

  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  };

  label.split("").forEach((ch, di) => {
    const rows = FONT[ch];
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        if (rows[gy][gx] !== "#") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            put(startX + di * digitW + gx * scale + sx, startY + gy * scale + sy, 245, 245, 250);
          }
        }
      }
    }
  });

  // 진행 막대 — 눈으로도 위치를 가늠할 수 있게. 마지막 프레임에서 끝까지 찬다.
  const barW = Math.round((width - 2) * (n / Math.max(1, frames - 1)));
  for (let y = height - 14; y < height - 6; y++) {
    for (let x = 1; x < 1 + barW; x++) put(x, y, 59, 130, 246);
  }

  // 키프레임 자리에 표식 — 오차는 보통 키프레임이 아닌 자리에서 난다. 눈으로 구분되게 한다.
  if (n % gop === 0) {
    for (let y = 6; y < 20; y++) for (let x = 6; x < 20; x++) put(x, y, 240, 166, 46);
  }
  return buf;
}

async function main() {
  const opt = parseArgs(process.argv.slice(2));
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
    const chunk = drawFrame(n, opt);
    if (!ff.stdin.write(chunk)) {
      await new Promise((r) => ff.stdin.once("drain", r));
    }
  }
  ff.stdin.end();

  const code = await new Promise((r) => ff.on("close", r));
  if (spawnError) {
    console.error(`ffmpeg 를 실행하지 못했습니다: ${spawnError.message}`);
    console.error("ffmpeg 가 설치돼 있는지 확인하세요 (brew install ffmpeg).");
    process.exit(1);
  }
  if (code !== 0) {
    console.error(`ffmpeg 가 ${code} 로 끝났습니다.`);
    process.exit(1);
  }
  console.log(`${out}  ${opt.width}x${opt.height} ${opt.fps}fps ${opt.frames}프레임 (GOP ${opt.gop})`);
}

main();
