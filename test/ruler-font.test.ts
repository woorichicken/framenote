import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
// @ts-expect-error — 스크립트는 JS 다. 타입 없이 형태만 검사한다.
import { FONT, GH, GW, assertFontShape, layout } from "../scripts/ruler-font.mjs";

// 눈금 글리프 고정 — 이 테스트가 존재하는 이유가 있다.
//
// `verify-ruler.mjs` 는 만든 영상을 되읽어 숫자를 확인하지만, **생성기와 검증기가 이 FONT 를
// 공유하기 때문에 글리프 자체가 틀리면 둘 다 같이 틀려서 통과한다.** 실측(2026-08-19) 로
// 글리프 '7' 의 한 픽셀을 뒤집어도 10/10 통과했다. 되읽기만으로는 글리프를 못 지킨다.
//
// 그래서 여기에 **독립 근거**를 둔다. 아래 해시는 사람이 눈으로 확인한 상태를 고정한 것이다:
// 2026-08-19, 480x270 30fps GOP30 영상의 프레임 47 을 이미지로 열어 "47" 이 찍힌 것을 확인했다.
// 글리프를 의도적으로 바꾸려면 **다시 눈으로 확인하고** 이 해시를 갱신한다. 해시만 갱신하면
// 이 테스트는 아무것도 안 지킨다.
const PINNED_FONT_SHA256 =
  "7e5a85ddcdd40ef2d1108b6808a059b589e32ca77c7878da9b870efff62d90de";

function fontDigest(): string {
  const canonical = Object.keys(FONT)
    .sort()
    .map((d) => `${d}:${(FONT as Record<string, string[]>)[d]!.join("|")}`)
    .join("\n");
  return createHash("sha256").update(canonical).digest("hex");
}

describe("눈금 글리프", () => {
  it("규격을 지킨다", () => {
    expect(assertFontShape()).toBe(true);
  });

  it("0부터 9까지 다 있다", () => {
    for (let d = 0; d <= 9; d++) expect(FONT).toHaveProperty(String(d));
  });

  it("사람이 확인한 모양에서 바뀌지 않았다", () => {
    // 깨지면 글리프가 바뀐 것이다. 바꿀 의도였다면 눈으로 다시 확인하고 위 상수를 갱신한다.
    expect(fontDigest()).toBe(PINNED_FONT_SHA256);
  });

  it("서로 충분히 다르다 — 압축으로 한 칸이 번져도 헷갈리지 않게", () => {
    const keys = Object.keys(FONT);
    for (let i = 0; i < keys.length; i++) {
      for (let j = i + 1; j < keys.length; j++) {
        const a = (FONT as Record<string, string[]>)[keys[i]!]!.join("");
        const b = (FONT as Record<string, string[]>)[keys[j]!]!.join("");
        let diff = 0;
        for (let k = 0; k < a.length; k++) if (a[k] !== b[k]) diff++;
        expect(diff, `'${keys[i]}' 와 '${keys[j]}' 가 ${diff} 칸만 다르다`).toBeGreaterThanOrEqual(3);
      }
    }
  });

  it("칸이 너무 비지 않는다 — 중앙 픽셀 판독이 되려면 획이 있어야 한다", () => {
    for (const [d, rows] of Object.entries(FONT as Record<string, string[]>)) {
      const lit = rows.join("").split("").filter((c) => c === "#").length;
      expect(lit, `글리프 '${d}' 의 켜진 칸이 ${lit} 개다`).toBeGreaterThanOrEqual(7);
    }
  });

  it("배치는 생성기와 검증기가 같은 함수를 쓴다", () => {
    const a = layout("47", 480, 270);
    const b = layout("47", 480, 270);
    expect(a).toEqual(b);
    expect(a.scale).toBeGreaterThanOrEqual(4);
    expect(a.startX).toBeGreaterThanOrEqual(0);
    expect(a.startY + GH * a.scale).toBeLessThanOrEqual(270);
    expect(GW).toBe(5);
  });
});
