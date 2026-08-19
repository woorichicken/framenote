#!/usr/bin/env node
// 브라우저에서 프레임 정확도를 검증한다 — 로컬 전용.
//
// `verify-ruler.mjs` 는 **눈금 영상 자체**가 맞는지 본다. 이 스크립트는 **플레이어가** 그 눈금을
// 제대로 읽는지 본다. 둘 다 필요하다 — 눈금이 맞아도 플레이어가 프레임을 잘못 세면 소용없고,
// 플레이어가 맞아도 눈금이 틀리면 검증이 거짓말을 한다.
//
// 요청한 프레임 · 플레이어가 보고한 프레임 · 화면에 실제로 그려진 숫자, 셋이 같아야 통과다.
//
//   node scripts/verify-frames.mjs [--port 7799] [--frames 320]
//
// 전제: agent-browser 가 설치돼 있어야 한다.

import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
};
const PORT = Number(arg("port", "7799"));
const FRAMES = Number(arg("frames", "320"));

// 자릿수가 바뀌는 자리와 키프레임 경계를 반드시 포함한다.
const TARGETS = [0, 1, 9, 10, 30, 31, 47, 99, 100, 151, 200, FRAMES - 2, FRAMES - 1]
  .filter((n) => n >= 0 && n < FRAMES);

const ab = (...args) => execFileSync("agent-browser", args, { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  if (!TARGETS.some((n) => n >= 100)) {
    console.error("세 자리 프레임을 검사하지 못합니다 — --frames 를 100 이상으로 주세요.");
    process.exit(1);
  }
  try {
    execFileSync("agent-browser", ["--help"], { stdio: "ignore" });
  } catch {
    console.error("agent-browser 를 찾지 못했습니다. 이 검증은 로컬 전용입니다.");
    process.exit(1);
  }

  const dir = mkdtempSync(join(tmpdir(), "framenote-frames-"));
  const video = join(dir, "out", "ruler.mp4");
  let server;
  try {
    execFileSync("node", [join(ROOT, "scripts/make-ruler-video.mjs"),
      "--out", video, "--frames", String(FRAMES), "--width", "640", "--height", "360"],
      { cwd: ROOT, stdio: "ignore" });

    server = spawn("node", [join(ROOT, "bin/framenote.mjs"), video, "--no-open", "--port", String(PORT)],
      { cwd: ROOT, stdio: "ignore", detached: false });
    await sleep(2000);

    ab("open", `http://127.0.0.1:${PORT}/?verify=1`);
    await sleep(3500);

    ab("eval", "window.__r='running'; window.__verifyFrames(" + JSON.stringify(TARGETS) +
      ").then(function(r){window.__r=r}).catch(function(e){window.__r={error:String(e&&e.message||e)}}); 'go'");

    let result = null;
    for (let i = 0; i < 15; i++) {
      await sleep(2000);
      const raw = ab("eval", "JSON.stringify(typeof window.__r==='object'?window.__r:{state:window.__r})");
      const parsed = JSON.parse(JSON.parse(raw.split("\n").pop()));
      if (parsed.rows) { result = parsed; break; }
      if (parsed.error) { console.error(parsed.error); process.exit(1); }
    }
    if (!result) { console.error("검증이 끝나지 않았습니다."); process.exit(1); }

    for (const r of result.rows) {
      console.log(`  요청 ${String(r.asked).padStart(4)}  보고 ${String(r.reported).padStart(4)}` +
        `  화면 ${String(r.drawn).padStart(4)}  ${r.ok ? "OK" : "불일치"}`);
    }
    if (result.bad > 0) {
      console.error(`\n${result.bad}/${result.total} 불일치 — 플레이어가 가리키는 프레임이 화면과 다릅니다.`);
      process.exit(1);
    }
    console.log(`\n${result.total}/${result.total} 일치 — 요청·보고·화면이 같은 프레임을 가리킵니다.`);
  } finally {
    if (server) server.kill();
    try { ab("close"); } catch { /* 브라우저가 이미 닫혔을 수 있다 */ }
    rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
