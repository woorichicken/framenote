#!/usr/bin/env node
// 요구사항의 테스트케이스와 실제 테스트를 **기계가 짝지어** 검사한다.
//
// 왜 필요한가: 이 매핑이 사람 머릿속에만 있으면 세 가지가 조용히 무너진다.
//   1. 테스트가 다른 것을 검사해도 아무도 모른다.
//   2. TC 에 테스트가 아예 없어도 "검증됨" 으로 셀 수 있다.
//   3. 남이 내 판정을 확인할 방법이 없다.
// 실제로 무너졌다 — 실사용 하루에 세 건이 드러났다(2026-08-20). "화면 위치가 없는 지적도
// 저장된다" 는 작은 드래그가 작성창을 안 여는 것을 봤고, "세 가지 경로로 붙일 수 있다" 는
// 붙여넣기를 두 번 했다. 둘 다 초록이었다.
//
// 규칙: 테스트 제목은 TC 제목과 **글자까지 같아야** 한다. 한 테스트가 여러 TC 를 덮으면
// 본문에 `covers("<TC 제목>")` 을 적는다.

import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function testFiles() {
  const out = [];
  for (const dir of ["test", "e2e"]) {
    let entries;
    try { entries = readdirSync(join(ROOT, dir)); } catch { continue; }
    for (const name of entries) {
      if (name.endsWith(".ts") && !name.endsWith(".d.ts")) out.push(join(dir, name));
    }
  }
  return out;
}

const STRING = /"((?:[^"\\]|\\.)*)"/g;

export function collectTitles(sources) {
  const titles = new Map();          // 제목 → 파일
  const declared = new Map();        // covers() 로 선언한 제목 → 파일
  for (const { file, src } of sources) {
    for (const m of src.matchAll(/\b(?:it|test)\(\s*"((?:[^"\\]|\\.)*)"/g)) {
      titles.set(m[1].replace(/\\"/g, '"'), file);
    }
    // covers( "a", "b", "c" ) — **인자를 전부** 읽는다. 첫 인자만 읽으면 나머지가 조용히
    // 빠지고, 검사기가 실제보다 적게 세면서 통과시킨다(실측 2026-08-20에 그랬다).
    for (const m of src.matchAll(/\bcovers\(([\s\S]*?)\)/g)) {
      for (const s of m[1].matchAll(STRING)) {
        const title = s[1].replace(/\\"/g, '"');
        titles.set(title, file);
        declared.set(title, file);
      }
    }
  }
  return { titles, declared };
}

/**
 * 그 TC 를 덮는 테스트 블록의 소스를 잘라낸다.
 *
 * 파일 전체에서 찾으면 옆 테스트의 문장이 잡혀서 검사가 헐거워진다.
 */
export function blockOf(src, anchor) {
  const at = src.indexOf(anchor);
  if (at < 0) return "";
  const rest = src.slice(at + anchor.length);
  const next = rest.search(/\n\s*(?:it|test)\(/);
  return anchor + (next < 0 ? rest : rest.slice(0, next));
}

/**
 * TC 의 **실행·기대 문장이 그 테스트 안에 그대로 있는지** 본다.
 *
 * 왜: 짝이 있어도 테스트가 다른 것을 단언할 수 있다. 실제로 그랬다 — 구현을 보고 단언을
 * 쓰면 코드가 하는 일을 확인하게 되고, 그건 언제나 초록이다(2026-08-20 실측 3건).
 * 기대 문장을 옆에 적어야 하면 **읽지 않고는 쓸 수 없다.**
 */
export function checkSentences(cases, sources, titles) {
  const missing = [];
  for (const c of cases) {
    const file = titles.get(c.title);
    if (!file) continue;                       // 짝 없음은 위에서 따로 잡는다
    const src = sources.find((s) => s.file === file)?.src ?? "";
    // 제목으로 못 찾으면 covers 선언 자리를 기준으로 삼는다.
    let block = blockOf(src, `"${c.title}"`);
    if (block.length < 40) block = src;
    const want = [["실행", c.run], ["기대", c.expect]].filter(([, t]) => t);
    const gone = want.filter(([, t]) => !block.includes(t)).map(([label]) => label);
    if (gone.length) missing.push({ ...c, file, gone });
  }
  return missing;
}

export function compare(cases, titles, declared) {
  const uncovered = cases.filter((c) => !titles.has(c.title));
  const known = new Set(cases.map((c) => c.title));
  // covers() 로 가리켰는데 그런 TC 가 없는 것 — 제목이 바뀌었거나 오타다. 이걸 안 잡으면
  // 선언이 아무것도 안 가리키면서 초록이 된다.
  const dangling = [...declared.keys()].filter((t) => !known.has(t));
  return { uncovered, dangling };
}

function main() {
  const snap = JSON.parse(readFileSync(join(ROOT, "docs/testcases.json"), "utf8"));
  const cases = snap.sections.flatMap((s) => s.cases.map((c) => ({ ...c, section: s.heading })));
  const sources = testFiles().map((file) => ({ file, src: readFileSync(join(ROOT, file), "utf8") }));
  const { titles, declared } = collectTitles(sources);

  const { uncovered, dangling } = compare(cases, titles, declared);
  const sentenceGaps = checkSentences(cases, sources, titles);
  const covered = cases.length - uncovered.length;
  console.log(`테스트케이스 ${cases.length}건 · 짝이 있는 것 ${covered}건 · 없는 것 ${uncovered.length}건`);

  if (uncovered.length > 0) {
    console.error("\n짝이 없는 테스트케이스:");
    let last = "";
    for (const c of uncovered) {
      if (c.section !== last) { console.error(`\n  [${c.section}]`); last = c.section; }
      console.error(`    ${c.title}   (${c.type})`);
    }
    console.error(
      "\n테스트 제목을 TC 제목과 글자까지 같게 쓰거나, 이미 덮고 있으면 그 테스트 안에\n" +
      '  covers("<TC 제목>")\n을 적는다. 짝이 없으면 그 TC 는 검증된 것이 아니다.',
    );
  }
  if (dangling.length > 0) {
    console.error("\n없는 테스트케이스를 가리키는 covers() 선언:");
    for (const t of dangling) console.error(`    ${t}`);
    console.error("\n제목이 바뀌었으면 pnpm tc:sync 로 스냅샷을 갱신하고 선언을 맞춘다.");
  }
  if (sentenceGaps.length > 0) {
    console.error(`\n요구사항 문장이 테스트에 없는 것 ${sentenceGaps.length}건:`);
    for (const g of sentenceGaps) {
      console.error(`\n  ${g.title}  (${g.file})`);
      if (g.gone.includes("실행")) console.error(`    실행: ${g.run}`);
      if (g.gone.includes("기대")) console.error(`    기대: ${g.expect}`);
    }
    console.error(
      "\n위 문장을 그 테스트 안에 주석으로 그대로 적는다. 기대를 읽지 않고 쓴 테스트는\n" +
      "구현이 하는 일을 확인하게 되고, 그건 언제나 초록이다.",
    );
  }
  if (uncovered.length > 0 || dangling.length > 0 || sentenceGaps.length > 0) process.exit(1);
  console.log(`모든 테스트케이스에 짝이 있고, 요구사항 문장이 테스트 안에 있다. (${cases.length}건)`);
}

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) main();
