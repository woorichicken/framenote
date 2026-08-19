import { describe, expect, it } from "vitest";
import type { Note, NoteStatus, StatusUpdate } from "../src/types.js";

// 계약 테스트 — 문서가 못박은 것이 타입에서 실제로 강제되는지 본다.
// 구현이 아직 없으므로 여기서 지키는 건 "형태"뿐이지만, 형태가 어긋나면 구현이 어긋난다.

describe("메모 계약", () => {
  it("점 제보와 구간 제보가 같은 타입이다", () => {
    const point: Note["range"] = [632, 632];
    const span: Note["range"] = [480, 810];
    expect(point[0]).toBe(point[1]);
    expect(span[0]).toBeLessThan(span[1]);
  });

  it("어떻게(want)는 비울 수 있고 무엇이(what)는 못 비운다", () => {
    // want 가 null 인 메모는 정당하다 — "왜 이상한지 모르겠고 그냥 이상해".
    const note: Pick<Note, "what" | "want"> = { what: "여기가 어색하다", want: null };
    expect(note.want).toBeNull();
    // what 은 string 이라 null 을 넣으면 타입에서 걸린다.
    expect(typeof note.what).toBe("string");
  });

  it("상태는 일곱 개뿐이다", () => {
    const all: NoteStatus[] = [
      "draft", "sent", "working", "applied", "failed", "closed", "stale",
    ];
    expect(new Set(all).size).toBe(7);
  });

  it("에이전트 상태 변경은 메모 단위이고 반영됨에는 새 파일 경로를 실을 수 있다", () => {
    // 묶음 단위로만 바꿀 수 있으면 5건 중 3건만 고쳐진 경우를 표현하지 못한다.
    const updates: StatusUpdate[] = [
      { noteId: "a1", status: "applied", renderedFile: "/abs/out/preview.mp4" },
      { noteId: "b2", status: "failed", reason: "폰트를 찾지 못했다" },
    ];
    expect(updates).toHaveLength(2);
    expect(updates[0]!.renderedFile).toBeTruthy();
    expect(updates[1]!.reason).toBeTruthy();
  });

  it("이미지는 경로 목록이지 그림 데이터가 아니다", () => {
    const images: Note["images"] = ["images/a1-0.png", "images/a1-1.png"];
    for (const p of images) expect(p.startsWith("data:")).toBe(false);
  });
});
