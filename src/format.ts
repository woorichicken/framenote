import type { Note, VideoInfo } from "./types.js";

// 메모를 사람이 읽는 글로 만든다.
//
// **이 파일이 유일한 만드는 자리다.** 클립보드 복사도, 에이전트에게 주는 글도 여기서 나온다.
// 브라우저와 서버가 각자 만들면 한쪽만 고쳐져서 갈라진다 — 문서가 "같은 한 곳에서 만든다"를
// 요구하는 이유다. 그래서 플레이어는 자기가 조립하지 않고 서버에 물어본다.

const KO: Record<Note["status"], string> = {
  draft: "초안", sent: "보냄", working: "작업중", applied: "반영됨",
  failed: "실패", closed: "닫힘", stale: "낡음",
};

/** 메모 한 건에 실리는 정보 항목. 복사본과 전달본이 같은지 비교하는 기준이다. */
export function noteFields(note: Note): Record<string, unknown> {
  return {
    id: note.id,
    range: note.range,
    tc: note.tc,
    scene: note.scene,
    rect: note.rect,
    rectFrame: note.rectFrame,
    what: note.what,
    want: note.want,
    images: note.images,
    render: note.render,
    status: note.status,
  };
}

const span = (n: Note): string =>
  n.range[0] === n.range[1] ? `f${n.range[0]}` : `f${n.range[0]}–${n.range[1]}`;

const rectOf = (n: Note): string =>
  n.rect
    ? ` · 네모 [${[n.rect.x0, n.rect.y0, n.rect.x1, n.rect.y1].map((x) => x.toFixed(2)).join(", ")}] @f${n.rectFrame}`
    : "";

/**
 * 사람이 읽는 글. 붙여넣기만 해도 에이전트가 대상을 특정할 수 있어야 한다 —
 * 프레임 구간·씬·좌표·렌더본·이미지 경로가 모두 들어간다.
 */
export function formatNotes(notes: readonly Note[], video: string, info: VideoInfo): string {
  const head =
    `# framenote — ${video}\n` +
    `렌더본 ${info.render} · ${info.width}x${info.height} ${info.fps}fps\n`;
  return head + notes.map((n) =>
    `\n## ${n.id} · ${span(n)} (${n.tc})${n.scene ? " · " + n.scene : ""}${rectOf(n)}\n` +
    `무엇이: ${n.what}\n` +
    `어떻게: ${n.want ?? "(비어 있음 — 판단 필요)"}\n` +
    (n.images.length ? `이미지: ${n.images.join(", ")}\n` : "") +
    `상태: ${KO[n.status]} · 렌더본 ${n.render}\n`,
  ).join("");
}
