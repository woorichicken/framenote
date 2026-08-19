import type { SceneMark } from "./types.js";

/**
 * 프레임이 속한 씬 이름. 씬 목록이 없으면 null 이다(= `generic` 영상).
 *
 * 코드에서 씬을 추측하지 않는 이유: 절반만 맞히면 메모가 엉뚱한 씬에 붙고, 그게 틀렸다는 걸
 * 아무도 모른다. 저장소가 명시한 목록만 쓴다.
 */
export function sceneAt(frame: number, scenes: readonly SceneMark[] | undefined): string | null {
  if (!scenes || scenes.length === 0) return null;
  const sorted = [...scenes].sort((a, b) => a.startFrame - b.startFrame);
  let found: string | null = null;
  for (const s of sorted) {
    if (frame >= s.startFrame) found = s.name;
    else break;
  }
  return found;
}

/** 씬 목록이 쓸 만한지. 하나라도 이상하면 통째로 버린다 — 절반만 맞는 경계가 제일 나쁘다. */
export function isUsableSceneList(scenes: unknown): scenes is SceneMark[] {
  if (!Array.isArray(scenes) || scenes.length === 0) return false;
  return scenes.every(
    (s) =>
      s !== null &&
      typeof s === "object" &&
      typeof (s as SceneMark).name === "string" &&
      (s as SceneMark).name.length > 0 &&
      Number.isInteger((s as SceneMark).startFrame) &&
      (s as SceneMark).startFrame >= 0,
  );
}
