// 서버 없이 여는 파일 한 장으로 내보낸다.
//
// 왜 필요한가: 리뷰를 **실시간으로 보지 않는 사람**이 있다. 띄워 둔 서버는 그 사이에 꺼지고
// (실측 2026-09-15: 메모리가 부족한 맥에서 세 번 죽었다), 돌아왔을 때 주소는 이미 죽어 있다.
// 그런 리뷰에 필요한 건 살아 있는 프로세스가 아니라 **가끔 열어도 그대로인 파일**이다.
//
// 내보낸 파일이 지키는 것:
//   - 프레임 확정은 서버 모드와 **같은 플레이어**가 한다. 여기서 만드는 것은 그 플레이어를
//     감싸는 껍데기뿐이라, 프레임이 어긋나는 새 표면이 생기지 않는다.
//   - 밖으로 나가지 않는다. 담는 것은 페이지·영상 경로·메모뿐이고 주소는 전부 로컬이다.
//   - 메모는 브라우저에 쌓이고 `notes.jsonl` 과 같은 줄로 꺼낸다. 형식이 같아서 서버 모드의
//     파일에 그대로 이어 붙일 수 있다.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";

import type { Note, SceneMark, VideoInfo } from "./types.js";

/** 플레이어를 통째로 끼워 넣을 자리. 없어지면 내보내기가 **즉시 실패**해야 한다 —
 *  조용히 빠지면 서버 주소를 부르는 죽은 페이지가 만들어진다. */
const PLAYER_TAG = '<script src="/player.js"></script>';
/** 프레임 눈금 검사기는 서버에서만 쓴다(`/verify.js`). 정적 파일에서는 부를 곳이 없다. */
const VERIFY_TAG = /\n?<script>if\(new URLSearchParams[\s\S]*?<\/script>/;

export interface StaticPageInput {
  playerHtml: string;
  playerJs: string;
  adapterJs: string;
  /** 영상 파일 이름(표시용)과 페이지에서 가리킬 상대 주소. */
  video: { name: string; src: string };
  /** 첨부 이미지의 기준 경로. 끝에 `/` 가 붙는다. */
  fileBase: string;
  /** 브라우저 저장소 열쇠. 같은 영상이면 다시 내보내도 메모가 이어진다. */
  storeKey: string;
  info: VideoInfo;
  scenes: readonly SceneMark[];
  previewCommand: string | null;
  notes: readonly Note[];
  /** 서버 모드에서 메모가 쌓이는 파일. 사람이 어디에 이어 붙일지 알 수 있게 싣는다. */
  notesFile: string;
  /** 내려받을 파일 이름. */
  exportName: string;
  exportedAt: string;
  problems?: readonly string[];
}

/**
 * 메모 글의 `</script>` 가 페이지를 끊지 못하게 막는다.
 *
 * 줄 구분자(U+2028·U+2029)는 따로 다루지 않는다 — ES2019 부터 문자열 안에서 합법이고,
 * 이 페이지는 그 API 가 있는 브라우저에서만 메모를 허용한다.
 */
function embed(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

export function buildStaticPage(input: StaticPageInput): string {
  if (!input.playerHtml.includes(PLAYER_TAG)) {
    throw new Error(`플레이어 HTML 에서 ${PLAYER_TAG} 를 찾지 못했습니다 — 정적 내보내기가 낡았습니다.`);
  }
  const data = {
    video: input.video.name,
    videoSrc: input.video.src,
    fileBase: input.fileBase,
    storeKey: input.storeKey,
    info: input.info,
    scenes: input.scenes,
    previewCommand: input.previewCommand,
    notes: input.notes,
    notesFile: input.notesFile,
    exportName: input.exportName,
    exportedAt: input.exportedAt,
    problems: input.problems ?? [],
  };
  // 순서가 계약이다: 씨앗 → 어댑터(접점을 가로챈다) → 플레이어(가로채진 접점을 부른다).
  const scripts =
    `<script>window.__FRAMENOTE_STATIC__ = ${embed(data)};</script>\n` +
    `<script>\n${input.adapterJs}\n</script>\n` +
    `<script>\n${input.playerJs}\n</script>`;
  return input.playerHtml
    .replace(PLAYER_TAG, () => scripts)
    .replace(VERIFY_TAG, "")
    .replace("<title>framenote</title>", () => `<title>framenote — ${input.video.name}</title>`);
}

/** 상대 경로를 주소로. 한글·공백이 든 파일 이름이 흔하다. */
export function toUrlPath(path: string): string {
  return path.split("/").map((part) => (part === ".." ? part : encodeURIComponent(part))).join("/");
}

export interface ExportInput {
  videoPath: string;
  /** 쓸 파일. 없으면 영상 옆에 `<영상이름>.framenote.html`. */
  outPath: string;
  playerDir: string;
  info: VideoInfo;
  scenes: readonly SceneMark[];
  previewCommand: string | null;
  notes: readonly Note[];
  /** `.framenote/<영상>` — 첨부 이미지를 가져올 곳. */
  storeDir: string;
  notesFile: string;
  now?: Date;
}

export interface ExportResult {
  out: string;
  videoSrc: string;
  notes: number;
  images: number;
}

export function exportStatic(input: ExportInput): ExportResult {
  const out = resolve(input.outPath);
  const video = resolve(input.videoPath);
  const playerHtml = readFileSync(join(input.playerDir, "index.html"), "utf8");
  const playerJs = readFileSync(join(input.playerDir, "player.js"), "utf8");
  const adapterJs = readFileSync(join(input.playerDir, "static-adapter.js"), "utf8");

  // 첨부가 있으면 페이지 옆 폴더로 복사한다. 원본을 가리키면 파일을 옮기는 순간 깨진다.
  const base = basename(out).replace(/\.html?$/i, "");
  const filesDir = join(dirname(out), `${base}.files`);
  const sourceImages = join(input.storeDir, "images");
  let images = 0;
  const wanted = new Set(input.notes.flatMap((n) => n.images.map((p) => basename(p))));
  if (wanted.size > 0 && existsSync(sourceImages)) {
    mkdirSync(join(filesDir, "images"), { recursive: true });
    for (const name of readdirSync(sourceImages)) {
      if (!wanted.has(name)) continue;
      copyFileSync(join(sourceImages, name), join(filesDir, "images", name));
      images += 1;
    }
  }

  const html = buildStaticPage({
    playerHtml,
    playerJs,
    adapterJs,
    video: { name: basename(video), src: toUrlPath(relative(dirname(out), video)) },
    fileBase: `${toUrlPath(`${base}.files`)}/`,
    storeKey: basename(video),
    info: input.info,
    scenes: input.scenes,
    previewCommand: input.previewCommand,
    notes: input.notes,
    notesFile: input.notesFile,
    exportName: `${base}-notes.jsonl`,
    exportedAt: (input.now ?? new Date()).toISOString(),
  });
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, html, "utf8");
  return { out, videoSrc: toUrlPath(relative(dirname(out), video)), notes: input.notes.length, images };
}

/** 영상 경로에서 기본 출력 파일 이름을 만든다. */
export function defaultOutPath(videoPath: string): string {
  const video = resolve(videoPath);
  return join(dirname(video), `${basename(video).replace(/\.[^.]+$/, "")}.framenote.html`);
}
