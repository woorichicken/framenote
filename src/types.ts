// framenote 계약 — 이 파일이 저장 형식과 접점의 정본이다.
//
// 요구사항 원본은 라쏘런 문서 「framenote — 영상 리뷰 메모를 에이전트에게 정확히 전달한다」다.
// 여기 타입과 문서가 어긋나면 문서가 맞다. 고칠 때 양쪽을 같이 옮긴다.

/** 메모의 상태. 문서의 일곱 상태와 1:1 이다. */
export type NoteStatus =
  | "draft" // 초안 — 아직 안 보냄. 자유롭게 고친다
  | "sent" // 보냄 — 묶음에 실려 나갔다
  | "working" // 작업중 — 에이전트가 집었다
  | "applied" // 반영됨 — 고치고 재렌더까지 끝났다. 사람이 확인할 차례
  | "failed" // 실패 — 못 고쳤거나 재렌더가 실패했다
  | "closed" // 닫힘 — 해결됐거나 버렸다
  | "stale"; // 낡음 — 재렌더로 좌표가 무효가 됐다

/** 영상의 종류. remotion 이어야만 씬 정보가 붙는다. */
export type SourceKind = "remotion" | "generic";

/**
 * 프레임 구간 `[시작, 끝]`.
 *
 * 점 제보와 구간 제보를 다른 타입으로 나누지 않는다 — 점은 시작과 끝이 같다.
 * 나누면 "이 부분이 빠르다" 류가 억지로 한 프레임에 눌려 담긴다.
 */
export type FrameRange = readonly [from: number, to: number];

/**
 * 화면 위 사각형. 영상 크기에 대한 0~1 비율이다.
 *
 * 픽셀이 아닌 이유: 창 크기를 바꿔도, 나중에 해상도가 달라져도 같은 자리를 가리킨다.
 */
export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

/** 메모 한 건. `notes.jsonl` 의 한 줄이 이 모양이다. */
export interface Note {
  /** 짧은 무작위 문자열. 순번이 아니다 — 순번은 파일을 끝까지 읽어야 하고 동시에 겹친다. */
  id: string;
  /** 프레임 구간. 점 제보는 `[n, n]`. */
  range: FrameRange;
  /** 구간 시작 프레임의 타임코드(`00:21.07`). 사람이 파일을 읽을 때 위치를 가늠하는 용도. */
  tc: string;
  /** 메모를 처음 확정한 일시(ISO 8601). 영상 안 시각과 다른 값이다. */
  createdAt: string;
  /** 화면 위 사각형. 위치가 없는 지적도 있으므로 null 이 될 수 있다. */
  rect: Rect | null;
  /** 사각형을 그린 시점의 프레임. 구간 메모에서 어느 화면을 보며 그렸는지 알려면 필요하다. */
  rectFrame: number | null;
  /** 씬 이름. `generic` 영상이면 null. */
  scene: string | null;
  /** 관찰한 것. 비울 수 없다. */
  what: string;
  /**
   * 원하는 것. **비울 수 있다** — "왜 이상한지 모르겠고 그냥 이상해"는 정당한 지적이다.
   * 막으면 사람이 지어내고, 지어낸 요청은 엉뚱한 수정을 부른다. 판단은 에이전트가 한다.
   */
  want: string | null;
  /** 첨부 이미지의 상대 경로 목록. 그림 데이터를 여기 담지 않는다. */
  images: string[];
  /** 이 메모를 남긴 영상의 렌더본 식별자. 재렌더 후 낡음 판정의 근거다. */
  render: string;
  /** 영상 종류. 에이전트가 "이 메모에 씬 정보가 있는지" 판단한다. */
  sourceKind: SourceKind;
  /** 보내기 단위. 보내기 전에는 null. */
  batch: string | null;
  status: NoteStatus;
  /** `failed` 일 때의 사유. 그 외에는 null. */
  failureReason: string | null;
}

/** 저장소가 두는 설정 — `.framenote/config.json`. 없어도 동작하고 기능이 준다. */
export interface ProjectConfig {
  /**
   * 에이전트가 재렌더할 때 실행할 명령 한 줄.
   *
   * 도구가 짐작하지 않는 이유: 무엇이 미리보기이고 무엇이 최종인지 저장소만 안다.
   * 없으면 에이전트는 재렌더하지 않고 사람이 직접 돌려야 함을 사유에 남긴다.
   */
  previewCommand?: string;
  /** 씬 목록. 없거나 비면 영상 종류가 `generic` 이 된다. */
  scenes?: SceneMark[];
}

export interface SceneMark {
  name: string;
  startFrame: number;
}

/** 지금 떠 있는 서버 하나 — `.framenote/server.json` 의 한 항목. */
export interface ServerEntry {
  /** 에이전트가 붙을 로컬 포트. */
  port: number;
  /** 이 서버가 열고 있는 영상의 절대 경로. 에이전트가 이걸로 자기 것을 고른다. */
  video: string;
  pid: number;
  startedAt: string;
}

/** 영상에서 읽어낸 규격. 브라우저가 아니라 서버가 파일에서 직접 구한다. */
export interface VideoInfo {
  width: number;
  height: number;
  /** 프레임 레이트. 브라우저는 이 값을 알려주지 않는다. */
  fps: number;
  totalFrames: number;
  /** 파일 **전체** 내용 해시의 앞 일부. 부분 해시는 낡음 판정을 무효로 만든다. */
  render: string;
  sourceKind: SourceKind;
}

/** 에이전트가 상태를 바꿀 때 보내는 항목. 묶음 단위가 아니라 **메모 단위**다. */
export interface StatusUpdate {
  noteId: string;
  status: Extract<NoteStatus, "working" | "applied" | "failed">;
  /** `applied` 일 때 새로 만들어진 영상 파일 경로. 파일 감시에 의존하지 않는 이유다. */
  renderedFile?: string;
  /** `failed` 일 때의 사유. */
  reason?: string;
}
