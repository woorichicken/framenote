import { describe, expect, it } from "vitest";
// @ts-expect-error — 스크립트는 JS 다.
import { checkContract } from "../scripts/check-release-contract.mjs";

// 검사기를 만들면 **대상을 지워 보고 실제로 실패하는지까지** 확인한다.
// 통과만 보고 넘기면 아무것도 안 보는 검사를 "있다"고 세게 된다.

const good = JSON.stringify({
  version: "0.1.0",
  urgency: "initial",
  summary: "첫 배포",
  automaticChanges: ["무엇이 바뀌는지"],
  verification: ["어떻게 확인했는지"],
});

describe("릴리스 계약 검사", () => {
  it("제대로 된 계약은 통과한다", () => {
    expect(checkContract("0.1.0", "releases/0.1.0.json", true, good)).toHaveLength(0);
  });

  it("파일이 없으면 잡는다", () => {
    const p = checkContract("0.1.0", "releases/0.1.0.json", false, "");
    expect(p).toHaveLength(1);
    expect(p[0]).toContain("계약이 없다");
  });

  it("버전이 어긋나면 잡는다", () => {
    const p = checkContract("0.2.0", "releases/0.2.0.json", true, good);
    expect(p.some((x: string) => x.includes("version"))).toBe(true);
  });

  it("칸이 비면 잡는다 — 파일만 만들고 안 채우는 것을 막는다", () => {
    const empty = JSON.stringify({ ...JSON.parse(good), automaticChanges: [], summary: "  " });
    const p = checkContract("0.1.0", "releases/0.1.0.json", true, empty);
    expect(p.some((x: string) => x.includes("automaticChanges"))).toBe(true);
    expect(p.some((x: string) => x.includes("summary"))).toBe(true);
  });

  it("JSON 이 아니면 잡는다", () => {
    const p = checkContract("0.1.0", "releases/0.1.0.json", true, "{ not json");
    expect(p[0]).toContain("JSON");
  });
});
