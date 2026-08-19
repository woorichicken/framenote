import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv"] as const;

/** 들어가지 않는 폴더. 남의 영상을 열지 않기 위해서다. */
const SKIP_DIRS = new Set(["node_modules", ".git"]);

export interface Candidate {
  path: string;
  mtimeMs: number;
}

/**
 * 현재 디렉터리와 **하위 전부**에서 영상을 찾는다.
 *
 * 한 단계만 보면 늘 실패한다 — 렌더 결과는 보통 `out/` 같은 하위 폴더에 있다.
 * 점으로 시작하는 폴더는 건너뛴다.
 */
export function findVideos(root: string, maxDepth = 6): Candidate[] {
  const found: Candidate[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (SKIP_DIRS.has(e.name) || e.name.startsWith(".")) continue;
        walk(full, depth + 1);
        continue;
      }
      const ext = e.name.split(".").pop()?.toLowerCase();
      if (!ext || !(VIDEO_EXTS as readonly string[]).includes(ext)) continue;
      try {
        found.push({ path: resolve(full), mtimeMs: statSync(full).mtimeMs });
      } catch {
        // 읽을 수 없는 파일은 후보가 아니다.
      }
    }
  };
  walk(resolve(root), 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

/** 가장 최근에 수정된 영상. 없으면 null — 부르는 쪽이 찾은 범위를 알린다. */
export function pickLatestVideo(root: string): string | null {
  return findVideos(root)[0]?.path ?? null;
}
