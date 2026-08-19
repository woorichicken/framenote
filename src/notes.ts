import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { imagesDirFor, notesFileFor, storeDirFor } from "./paths.js";
import type { Note } from "./types.js";

/**
 * 메모를 읽는다. **마지막 줄이 불완전하면 그 줄만 버리고** 나머지를 살린다.
 *
 * 이어 붙이기 형식이라 쓰는 도중 프로세스가 죽으면 마지막 줄이 잘릴 수 있다. 파일 전체를
 * 버리면 그동안 쌓은 메모가 통째로 날아간다.
 */
export function readNotes(storeRoot: string, videoPath: string): Note[] {
  let raw: string;
  try {
    raw = readFileSync(notesFileFor(storeRoot, videoPath), "utf8");
  } catch {
    return [];
  }
  const lines = raw.split("\n");
  const notes: Note[] = [];
  lines.forEach((line, index) => {
    const text = line.trim();
    if (text === "") return;
    try {
      notes.push(JSON.parse(text) as Note);
    } catch {
      const isLast = index >= lines.length - 2; // 끝의 빈 줄을 감안
      if (!isLast) {
        // 중간 줄이 깨진 건 이어붙이기로 설명되지 않는다. 조용히 넘기지 않는다.
        process.stderr.write(`framenote: ${index + 1}번째 줄을 읽지 못해 건너뜁니다.\n`);
      }
    }
  });
  // 같은 id 가 여러 번 나오면 마지막 것이 최신이다(수정은 이어붙이기로 기록한다).
  const byId = new Map<string, Note>();
  for (const n of notes) byId.set(n.id, n);
  return [...byId.values()];
}

export function appendNote(storeRoot: string, videoPath: string, note: Note): void {
  const dir = storeDirFor(storeRoot, videoPath);
  mkdirSync(dir, { recursive: true });
  appendFileSync(notesFileFor(storeRoot, videoPath), JSON.stringify(note) + "\n", "utf8");
}

/**
 * 전체를 다시 쓴다(상태 갱신·삭제용). 임시 파일에 쓰고 바꿔치기해서 중간에 죽어도
 * 반쪽짜리 파일이 남지 않게 한다.
 */
export function writeNotes(storeRoot: string, videoPath: string, notes: readonly Note[]): void {
  const file = notesFileFor(storeRoot, videoPath);
  mkdirSync(storeDirFor(storeRoot, videoPath), { recursive: true });
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, notes.map((n) => JSON.stringify(n)).join("\n") + (notes.length ? "\n" : ""), "utf8");
  renameSync(tmp, file);
}

export const IMAGE_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};
export const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
export const MAX_IMAGES_PER_NOTE = 10;

/** 확장자로 형식을 알아본다. 클립보드가 형식을 안 알려주는 경우가 흔하다. */
export function extensionFor(contentType: string | undefined, fileName: string | undefined): string | null {
  if (contentType && IMAGE_TYPES[contentType]) return IMAGE_TYPES[contentType]!;
  const ext = fileName ? basename(fileName).split(".").pop()?.toLowerCase() : undefined;
  if (!ext) return null;
  const normalized = ext === "jpeg" ? "jpg" : ext;
  return Object.values(IMAGE_TYPES).includes(normalized) ? normalized : null;
}

/** 이미지를 파일로 저장하고 **상대 경로**를 돌려준다. 그림 데이터를 메모에 담지 않는다. */
export function saveImage(
  storeRoot: string,
  videoPath: string,
  noteId: string,
  index: number,
  ext: string,
  data: Buffer,
): string {
  const dir = imagesDirFor(storeRoot, videoPath);
  mkdirSync(dir, { recursive: true });
  const name = `${noteId}-${index}.${ext}`;
  writeFileSync(join(dir, name), data);
  return `images/${name}`;
}

/** 메모를 지우면 붙은 이미지도 같이 지운다. */
export function removeImages(storeRoot: string, videoPath: string, note: Note): void {
  const dir = storeDirFor(storeRoot, videoPath);
  for (const rel of note.images) {
    try {
      rmSync(join(dir, rel), { force: true });
    } catch {
      // 이미 없으면 그만이다.
    }
  }
}
