import { existsSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const STORE_DIR = ".framenote";

/**
 * 저장 루트 — 영상이 있는 곳부터 위로 올라가며 찾은 git 저장소 최상단.
 *
 * 렌더 결과물 폴더(`out/` 등) 안에 두지 않는 이유: 재렌더 스크립트가 그 폴더를 비우면 메모가
 * 통째로 사라진다. git 저장소가 아니면 영상이 있는 디렉터리를 최상단으로 본다.
 */
export function findStoreRoot(videoPath: string): string {
  let dir = dirname(resolve(videoPath));
  const stopAt = resolve("/");
  while (true) {
    if (existsSync(resolve(dir, ".git"))) return dir;
    if (dir === stopAt) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return dirname(resolve(videoPath));
}

/**
 * 영상 키 — 저장소 최상단 기준 **전체 경로**에서 만든다.
 *
 * 파일 이름만 쓰면 `a/out/final.mp4` 와 `b/out/final.mp4` 의 메모가 한 폴더로 합쳐진다.
 * 문서가 "영상마다 폴더를 나눈다" 를 보장하므로 그 보장이 조용히 깨지면 안 된다.
 */
export function videoKey(storeRoot: string, videoPath: string): string {
  const abs = resolve(videoPath);
  let rel = relative(resolve(storeRoot), abs);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    // 저장소 밖의 영상. 경로 전체를 키로 쓴다(충돌하지 않게).
    rel = abs;
  }
  return rel.split(sep).join("__").replace(/[^A-Za-z0-9._-]/g, "_");
}

export function storeDirFor(storeRoot: string, videoPath: string): string {
  return resolve(storeRoot, STORE_DIR, videoKey(storeRoot, videoPath));
}

export function notesFileFor(storeRoot: string, videoPath: string): string {
  return resolve(storeDirFor(storeRoot, videoPath), "notes.jsonl");
}

export function imagesDirFor(storeRoot: string, videoPath: string): string {
  return resolve(storeDirFor(storeRoot, videoPath), "images");
}

export function configFileFor(storeRoot: string): string {
  return resolve(storeRoot, STORE_DIR, "config.json");
}

export function serverFileFor(storeRoot: string): string {
  return resolve(storeRoot, STORE_DIR, "server.json");
}
