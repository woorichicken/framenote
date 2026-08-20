#!/usr/bin/env node
// 요구사항 문서의 테스트케이스 목록을 저장소로 가져온다.
//
// 검사기(check-tc-coverage)가 네트워크 없이 돌아야 해서 스냅샷을 둔다. 이 스크립트는
// 로컬에서만 쓴다 — `dp` 가 있어야 한다.
//
//   node scripts/sync-testcases.mjs <docId>

import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const docId = process.argv[2];
if (!docId) {
  console.error("문서 id 가 필요합니다: node scripts/sync-testcases.mjs <docId>");
  process.exit(1);
}

let raw;
try {
  raw = execFileSync("dp", ["get-doc", docId], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
} catch (e) {
  console.error(`dp get-doc 실패: ${e.message}`);
  process.exit(1);
}
const doc = JSON.parse(raw);
const out = {
  source: doc.document?.title ?? "",
  note: "pnpm tc:sync 로 갱신한다. 손으로 고치지 않는다.",
  sections: doc.sections.map((s) => ({
    heading: s.heading,
    cases: (s.testCases ?? []).map((t) => ({ title: t.title, type: t.testType, kind: t.tcKind })),
  })),
};
writeFileSync(join(ROOT, "docs/testcases.json"), JSON.stringify(out, null, 2) + "\n", "utf8");
const n = out.sections.reduce((a, s) => a + s.cases.length, 0);
console.log(`docs/testcases.json 갱신 — ${n}건`);
