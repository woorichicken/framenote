/**
 * 프레임 번호를 사람이 읽는 타임코드로. `632` @30fps → `"00:21.07"`.
 *
 * 이 값은 파일을 눈으로 읽을 때 위치를 가늠하는 용도다. 계산의 근거는 언제나 프레임 번호이지
 * 타임코드가 아니다 — 반대로 하면 반올림에서 프레임이 어긋난다.
 */
export function frameToTimecode(frame: number, fps: number): string {
  if (!Number.isFinite(fps) || fps <= 0) throw new Error(`fps 가 이상하다: ${fps}`);
  const totalSeconds = frame / fps;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds - minutes * 60;
  return `${String(minutes).padStart(2, "0")}:${seconds.toFixed(2).padStart(5, "0")}`;
}
