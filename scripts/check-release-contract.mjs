#!/usr/bin/env node
// 지금 버전에 해당하는 릴리스 계약(releases/<version>.json)이 있는지 본다.
//
// 왜 필요한가: 버전을 올린 커밋이 main 에 들어가면 그게 곧 배포다. 계약이 없으면 쓰는 쪽은
// **무엇이 바뀌었는지 모른 채** 새 버전을 받는다. 사람이 "이번엔 작으니까"로 건너뛰기 쉬운
// 자리라 기계가 막는다.
//
// 게이트는 "파일이 있다"에서 멈추지 않는다 — 버전이 어긋나거나 칸이 비면 실패한다.
// 빈 배열을 통과시키면 파일만 만들고 내용을 안 채우게 된다.
//
// feedback-kit 의 같은 이름 스크립트를 단일 패키지에 맞게 줄인 것이다(소비처 감사는 없다).

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/** 비어 있으면 안 되는 칸. 하나라도 비면 계약을 안 쓴 것과 같다. */
export const REQUIRED_LISTS = ["automaticChanges", "verification"];
export const REQUIRED_TEXT = ["version", "urgency", "summary"];

export function checkContract(version, contractPath, exists, raw) {
  const problems = [];
  if (!exists) {
    problems.push(
      `릴리스 계약이 없다: ${contractPath}\n` +
        `  → 무엇이 바뀌는지 쓰는 쪽이 알 방법이 없다. 버전을 올린 같은 커밋에서 만든다.`,
    );
    return problems;
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    problems.push(`${contractPath} 가 JSON 이 아니다: ${String(error)}`);
    return problems;
  }
  if (parsed.version !== version) {
    problems.push(`${contractPath} 의 version(${parsed.version}) 이 package.json(${version}) 과 다르다.`);
  }
  for (const key of REQUIRED_TEXT) {
    if (typeof parsed[key] !== "string" || parsed[key].trim() === "") {
      problems.push(`${contractPath}: "${key}" 가 비었다.`);
    }
  }
  for (const key of REQUIRED_LISTS) {
    if (!Array.isArray(parsed[key]) || parsed[key].length === 0) {
      problems.push(`${contractPath}: "${key}" 가 비었다 — 파일만 만들고 내용을 안 채운 것이다.`);
    }
  }
  return problems;
}

function main() {
  const version = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version;
  const contractPath = `releases/${version}.json`;
  const absolute = join(ROOT, contractPath);
  const exists = existsSync(absolute);
  const problems = checkContract(version, contractPath, exists, exists ? readFileSync(absolute, "utf8") : "");
  if (problems.length > 0) {
    console.error(`릴리스 계약 문제 ${problems.length}건:`);
    for (const p of problems) console.error(`  - ${p}`);
    process.exit(1);
  }
  console.log(`${contractPath} 확인 — 버전 일치, 필수 칸 채워짐.`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
