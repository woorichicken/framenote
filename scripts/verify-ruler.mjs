#!/usr/bin/env node
// 눈금 영상이 진짜로 맞는지 되읽어 확인한다 — 로컬 전용.
//
// 생성만 하고 "만들었다"로 끝내면 눈금이 틀려도 모른다. 여기서는 만든 영상을 **다시 디코드해서**
// 픽셀에서 숫자를 읽어내고, 그게 그 프레임 번호와 같은지 본다. 프레임 번호를 미리 알고 맞춰보는
// 게 아니라, 모르는 상태로 읽어서 대조한다.
//
// 키프레임이 아닌 자리를 반드시 포함한다 — 오차는 거기서 난다.
//
//   node scripts/verify-ruler.mjs [--frames 90] [--width 480] [--height 270] [--gop 30]

import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FONT, GH, GW, assertFontShape, layout } from "./ruler-font.mjs";
import { makeRulerVideo, parseArgs } from "./make-ruler-video.mjs";

/** 프레임 하나를 8비트 그레이 rawvideo 로 뽑는다. PNG 를 안 쓰는 이유: 디코더가 필요 없다. */
function grabGray(file, n, width, height) {
  return new Promise((resolve, reject) => {
    const ff = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", file,
      // -vsync 는 최신 ffmpeg 에서 제거됐다. 로컬은 받아주는데 CI 의 정적 빌드(master)가
      // "Unrecognized option 'vsync'" 로 거부했다(실측 2026-08-19). -fps_mode 가 5.1+ 대체다.
      "-vf", `select=eq(n\\,${n})`, "-fps_mode", "passthrough", "-frames:v", "1",
      "-f", "rawvideo", "-pix_fmt", "gray", "-",
    ], { stdio: ["ignore", "pipe", "inherit"] });

    const chunks = [];
    let spawnError = null;
    ff.on("error", (e) => { spawnError = e; });
    ff.stdout.on("data", (c) => chunks.push(c));
    ff.on("close", (code) => {
      if (spawnError) return reject(spawnError);
      if (code !== 0) return reject(new Error(`ffmpeg exit ${code}`));
      const buf = Buffer.concat(chunks);
      if (buf.length !== width * height) {
        return reject(new Error(`프레임 ${n} 크기가 ${buf.length} 다 (${width * height} 이어야 함)`));
      }
      resolve(buf);
    });
  });
}

/** 글리프 칸의 **중앙 픽셀**만 본다. 가장자리는 압축으로 번지지만 중앙은 안 번진다. */
function readGlyph(gray, width, x0, y0, scale) {
  const rows = [];
  for (let gy = 0; gy < GH; gy++) {
    let row = "";
    for (let gx = 0; gx < GW; gx++) {
      const px = x0 + gx * scale + (scale >> 1);
      const py = y0 + gy * scale + (scale >> 1);
      row += gray[py * width + px] > 128 ? "#" : ".";
    }
    rows.push(row);
  }
  return rows.join("");
}

const GLYPH_KEYS = new Map(Object.entries(FONT).map(([d, rows]) => [rows.join(""), d]));

/** 번호를 모르는 상태로 읽는다. 자릿수를 1~4 로 시도해 모든 칸이 글리프와 맞는 것만 채택한다. */
function decodeFrameNumber(gray, width, height) {
  // 긴 자릿수부터 본다. 1자리 배치가 3자리 라벨의 **가운데 숫자**와 같은 자리라
  // 짧은 쪽부터 보면 100 을 0 으로 읽는다(실측 2026-08-19).
  for (let len = 4; len >= 1; len--) {
    const { scale, digitW, startX, startY } = layout("0".repeat(len), width, height);
    let out = "";
    let ok = true;
    for (let di = 0; di < len; di++) {
      const key = readGlyph(gray, width, startX + di * digitW, startY, scale);
      const d = GLYPH_KEYS.get(key);
      if (d === undefined) { ok = false; break; }
      out += d;
    }
    // 앞자리 0 은 만들지 않으므로(String(n)) 그런 해석은 버린다.
    if (ok && (out.length === 1 || out[0] !== "0")) return out;
  }
  return null;
}

async function main() {
  assertFontShape();
  const opt = parseArgs(process.argv.slice(2));
  if (!process.argv.includes("--frames")) opt.frames = 320;
  if (!process.argv.includes("--width")) opt.width = 480;
  if (!process.argv.includes("--height")) opt.height = 270;

  const dir = mkdtempSync(join(tmpdir(), "framenote-ruler-"));
  const file = join(dir, "ruler.mp4");
  try {
    await makeRulerVideo({ ...opt, out: file });

    // 첫·마지막·키프레임·키프레임 아닌 자리·자릿수가 바뀌는 자리를 고루 본다.
    // 자릿수가 바뀌는 자리(9→10, 99→100)를 반드시 넣는다. 2자리만 보면 3자리 오독을 못 잡는다.
    const wanted = [...new Set([
      0, 1, 9, 10, opt.gop, opt.gop + 1, 47, 99, 100, 151, opt.frames - 2, opt.frames - 1,
    ])];
    const targets = wanted.filter((n) => n >= 0 && n < opt.frames).sort((a, b) => a - b);
    const dropped = wanted.length - targets.length;
    if (dropped > 0) {
      // 조용히 줄어들면 "9/9 일치" 가 실제보다 많은 것을 본 것처럼 읽힌다.
      console.log(`  (영상이 ${opt.frames} 프레임이라 대상 ${dropped} 개가 빠졌습니다)`);
    }
    if (!targets.some((n) => n >= 100)) {
      console.error("세 자리 프레임을 하나도 검사하지 못했습니다 — 영상을 100 프레임 이상으로 만드세요.");
      process.exit(1);
    }

    let bad = 0;
    for (const n of targets) {
      const gray = await grabGray(file, n, opt.width, opt.height);
      const read = decodeFrameNumber(gray, opt.width, opt.height);
      const isKey = n % opt.gop === 0;
      const okay = read === String(n);
      if (!okay) bad++;
      console.log(
        `  frame ${String(n).padStart(4)} ${isKey ? "[key]" : "     "}  읽음=${read ?? "실패"}  ${okay ? "OK" : "불일치"}`,
      );
    }
    if (bad > 0) {
      console.error(`\n${bad}/${targets.length} 불일치 — 눈금이 틀렸다. 이 영상으로 프레임 정확도를 검증하면 안 된다.`);
      process.exit(1);
    }
    console.log(`\n${targets.length}/${targets.length} 일치 — 눈금 영상을 프레임 정확도 검증에 쓸 수 있다.`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
