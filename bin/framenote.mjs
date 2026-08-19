#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

const USAGE = `framenote — 영상에 프레임 단위로 메모를 남기고 에이전트에게 넘긴다

  framenote [<영상 파일>] [옵션]

옵션
  --port <n>    쓸 포트를 지정한다. 생략하면 비어 있는 것을 고른다
  --no-open     브라우저를 자동으로 열지 않는다
  -h, --help    이 도움말

영상 파일을 생략하면 현재 디렉터리와 하위에서 가장 최근에 수정된 영상을 고른다.
찾는 확장자: mp4 · webm · mov · mkv
`;

const argv = process.argv.slice(2);
if (argv.includes("-h") || argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

const dist = resolve(HERE, "../dist/cli.js");
if (!existsSync(dist)) {
  process.stderr.write("빌드된 파일이 없습니다. pnpm build 를 먼저 실행하세요.\n");
  process.exit(1);
}
const { run } = await import(dist);
process.exit(await run(argv));
