import { existsSync, statSync } from "node:fs";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { readProjectConfig } from "./config.js";
import { VIDEO_EXTS, pickLatestVideo } from "./discover.js";
import { readNotes } from "./notes.js";
import { findStoreRoot, notesFileFor, storeDirFor } from "./paths.js";
import { startServer } from "./server.js";
import { defaultOutPath, exportStatic } from "./static.js";
import { readVideoInfo } from "./video.js";

const HERE = dirname(fileURLToPath(import.meta.url));

export interface CliOptions {
  video: string | null;
  port: number | undefined;
  open: boolean;
  help: boolean;
  /** 서버를 띄우지 않고 파일 한 장으로 내보낸다. */
  static: boolean;
  /** 내보낼 파일 경로. `--static` 과 함께만 쓴다. */
  out: string | null;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const o: CliOptions = { video: null, port: undefined, open: true, help: false, static: false, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "-h" || a === "--help") o.help = true;
    else if (a === "--no-open") o.open = false;
    else if (a === "--static") o.static = true;
    else if (a === "--out") { o.out = argv[++i] ?? null; }
    else if (a === "--port") { o.port = Number(argv[++i]); }
    else if (!a.startsWith("-") && o.video === null) o.video = a;
  }
  return o;
}

/** 플레이어 정적 파일 위치. 소스 실행과 빌드 실행 둘 다에서 찾는다. */
function findPlayerDir(): string {
  for (const c of [resolve(HERE, "../player"), resolve(HERE, "../../player")]) {
    if (existsSync(resolve(c, "index.html"))) return c;
  }
  throw new Error("플레이어 파일을 찾지 못했습니다 (player/index.html).");
}

function openBrowser(url: string): void {
  const cmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { stdio: "ignore", detached: true }).unref();
  } catch {
    // 못 열어도 주소를 찍었으니 사람이 연다.
  }
}

/**
 * 어떤 영상을 열지 정하고, 사람에게 뭐라고 알릴지까지 함께 돌려준다.
 *
 * `run` 에서 떼어낸 이유: `run` 은 종료 신호까지 살아 있어 테스트에서 부를 수 없다.
 * 고르는 규칙과 알리는 문구는 계약이라 따로 검사할 수 있어야 한다.
 */
export function resolveVideo(
  opt: CliOptions,
  cwd: string,
): { video: string; notice?: string } | { error: string } {
  if (opt.video) {
    const abs = resolve(cwd, opt.video);
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      return { error: `영상을 열 수 없습니다: ${abs}\n` };
    }
    return { video: abs };
  }
  const picked = pickLatestVideo(cwd);
  if (!picked) {
    return {
      error:
        `열 영상을 찾지 못했습니다.\n  찾은 곳: ${cwd} 와 그 하위\n` +
        `  찾은 확장자: ${VIDEO_EXTS.join(" · ")}\n` +
        `  (node_modules · .git · 점으로 시작하는 폴더는 건너뜁니다)\n`,
    };
  }
  return { video: picked, notice: `영상을 골랐습니다: ${picked}\n` };
}

/**
 * 서버를 띄우지 않고 파일 한 장을 쓴다.
 *
 * 규격을 못 읽으면 **내보내지 않는다**. 서버 모드는 창을 열고 작성을 잠그는 선택이 가능하지만,
 * 잠긴 채로 굳은 파일은 왜 안 되는지 알 길이 없는 껍데기가 된다.
 */
async function runStaticExport(opt: CliOptions, video: string): Promise<number> {
  const storeRoot = findStoreRoot(video);
  const { config, problems } = readProjectConfig(storeRoot);
  const sourceKind = config.scenes && config.scenes.length > 0 ? "remotion" : "generic";
  let info;
  try {
    info = await readVideoInfo(video, sourceKind);
  } catch (e) {
    process.stderr.write(
      `영상 규격을 읽지 못해 내보내지 않았습니다: ${(e as Error).message}\n` +
        `  → ffprobe 가 필요합니다. 규격 없이 만든 파일은 프레임을 확정할 수 없습니다.\n`,
    );
    return 1;
  }
  for (const p of problems) process.stderr.write(`framenote: ${p}\n`);

  const result = exportStatic({
    videoPath: video,
    outPath: opt.out ? resolve(process.cwd(), opt.out) : defaultOutPath(video),
    playerDir: findPlayerDir(),
    info,
    scenes: config.scenes ?? [],
    previewCommand: config.previewCommand ?? null,
    notes: readNotes(storeRoot, video),
    storeDir: storeDirFor(storeRoot, video),
    notesFile: notesFileFor(storeRoot, video),
  });
  process.stdout.write(
    `정적 파일  ${result.out}\n` +
      `영상       ${result.videoSrc} (같이 옮겨야 열립니다)\n` +
      `메모       ${result.notes}건 담김${result.images ? ` · 이미지 ${result.images}장 복사` : ""}\n` +
      `메모는 이 파일을 연 브라우저에 쌓이고, 「메모 파일로 내보내기」로 꺼내 에이전트에게 줍니다.\n`,
  );
  if (opt.open) openBrowser(`file://${result.out}`);
  return 0;
}

export async function run(argv: readonly string[]): Promise<number> {
  const opt = parseCliArgs(argv);

  // 창을 아예 안 띄우는 경우는 셋뿐이다. 셋 다 터미널에 사유를 출력하고 끝낸다.
  const resolved = resolveVideo(opt, process.cwd());
  if ("error" in resolved) {
    process.stderr.write(resolved.error);
    return 1;
  }
  const video = resolved.video;
  if (resolved.notice) process.stdout.write(resolved.notice);

  if (opt.static) return runStaticExport(opt, video);

  const handle = await startServer({
    videoPath: video,
    ...(opt.port === undefined ? {} : { port: opt.port }),
    playerDir: findPlayerDir(),
  });
  process.stdout.write(`framenote  ${handle.url}\n에이전트 통로  ${handle.url.replace("http", "ws")}/feed\n`);
  if (opt.open) openBrowser(handle.url);

  const stop = (): void => { void handle.close().then(() => process.exit(0)); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return new Promise<number>(() => { /* 종료 신호까지 산다 */ });
}
