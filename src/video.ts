import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, statSync } from "node:fs";

import type { SourceKind, VideoInfo } from "./types.js";

export class MissingToolError extends Error {
  constructor(public readonly tool: string) {
    super(
      `${tool} 를 찾지 못했습니다. 영상 규격을 읽으려면 ffmpeg 가 필요합니다.\n` +
        `  macOS:  brew install ffmpeg\n` +
        `  Ubuntu: sudo apt-get install ffmpeg`,
    );
    this.name = "MissingToolError";
  }
}

export class UnreadableVideoError extends Error {
  constructor(public readonly detail: string) {
    super(detail);
    this.name = "UnreadableVideoError";
  }
}

function runFfprobe(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", args, { stdio: ["ignore", "pipe", "pipe"] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    // listener 안에서 throw 하지 않는다 — await 와 연결되지 않아 uncaughtException 으로 샌다.
    let spawnError: NodeJS.ErrnoException | null = null;
    p.on("error", (e) => { spawnError = e as NodeJS.ErrnoException; });
    p.stdout.on("data", (c: Buffer) => out.push(c));
    p.stderr.on("data", (c: Buffer) => err.push(c));
    p.on("close", (code) => {
      if (spawnError) {
        if ((spawnError as NodeJS.ErrnoException).code === "ENOENT") return reject(new MissingToolError("ffprobe"));
        return reject(spawnError);
      }
      if (code !== 0) {
        return reject(new UnreadableVideoError(Buffer.concat(err).toString("utf8").trim() || `ffprobe exit ${code}`));
      }
      resolve(Buffer.concat(out).toString("utf8"));
    });
  });
}

/** `30000/1001` 같은 분수를 실수로. 브라우저는 이 값을 아예 알려주지 않는다. */
export function parseRate(text: string): number | null {
  const m = /^(\d+)\/(\d+)$/.exec(text.trim());
  if (!m) {
    const n = Number(text);
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  const num = Number(m[1]);
  const den = Number(m[2]);
  if (!den || !Number.isFinite(num / den) || num / den <= 0) return null;
  return num / den;
}

/**
 * 렌더본 식별자 — 파일 **전체** 내용 해시의 앞 일부.
 *
 * 일부 구간만 읽어 만들면 앞이 같고 뒤가 다른 두 렌더본이 같은 식별자를 받아 낡음 판정이
 * 통째로 무효가 된다.
 */
export function renderIdOf(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(file);
    stream.on("error", reject);
    stream.on("data", (c) => hash.update(c));
    stream.on("end", () => resolve(hash.digest("hex").slice(0, 7)));
  });
}

/** 영상 규격을 파일에서 직접 읽는다. 브라우저의 영상 요소가 아니다. */
export async function readVideoInfo(file: string, sourceKind: SourceKind): Promise<VideoInfo> {
  statSync(file); // 없으면 여기서 ENOENT
  const text = await runFfprobe([
    "-v", "error",
    "-select_streams", "v:0",
    "-show_entries", "stream=width,height,r_frame_rate,nb_frames,duration",
    "-show_entries", "format=duration",
    "-of", "json",
    file,
  ]);

  let parsed: {
    streams?: { width?: number; height?: number; r_frame_rate?: string; nb_frames?: string; duration?: string }[];
    format?: { duration?: string };
  };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    throw new UnreadableVideoError("ffprobe 출력을 해석하지 못했습니다.");
  }

  const s = parsed.streams?.[0];
  if (!s) throw new UnreadableVideoError("영상 스트림이 없습니다.");

  const width = Number(s.width);
  const height = Number(s.height);
  const fps = s.r_frame_rate ? parseRate(s.r_frame_rate) : null;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new UnreadableVideoError("가로세로를 읽지 못했습니다.");
  }
  if (fps === null) throw new UnreadableVideoError("프레임 레이트를 읽지 못했습니다.");

  const duration = Number(s.duration ?? parsed.format?.duration ?? NaN);
  const declared = Number(s.nb_frames ?? NaN);
  const totalFrames = Number.isFinite(declared) && declared > 0
    ? Math.round(declared)
    : Number.isFinite(duration) && duration > 0
      ? Math.round(duration * fps)
      : NaN;
  if (!Number.isFinite(totalFrames) || totalFrames <= 0) {
    throw new UnreadableVideoError("총 프레임 수를 구하지 못했습니다.");
  }

  return { width, height, fps, totalFrames, render: await renderIdOf(file), sourceKind };
}
