#!/usr/bin/env node
// CLI 계약. 인자 표면은 공개 계약이라 구현보다 먼저 못박는다.
//
//   framenote [<영상 파일>] [--port <n>] [--no-open]
//
// 인자를 생략하면 현재 디렉터리와 하위에서 가장 최근에 수정된 영상을 고른다.
// (node_modules · .git · 점으로 시작하는 폴더는 건너뛴다)

const VIDEO_EXTS = ["mp4", "webm", "mov", "mkv"];

const USAGE = `framenote — 영상에 프레임 단위로 메모를 남기고 에이전트에게 넘긴다

  framenote [<영상 파일>] [옵션]

옵션
  --port <n>    쓸 포트를 지정한다. 생략하면 비어 있는 것을 고른다
  --no-open     브라우저를 자동으로 열지 않는다
  -h, --help    이 도움말

영상 파일을 생략하면 현재 디렉터리와 하위에서 가장 최근에 수정된 영상을 고른다.
찾는 확장자: ${VIDEO_EXTS.join(" · ")}
`;

const argv = process.argv.slice(2);

if (argv.includes("-h") || argv.includes("--help")) {
  process.stdout.write(USAGE);
  process.exit(0);
}

process.stderr.write(
  "framenote 는 아직 구현되지 않았습니다.\n" +
    "요구사항과 테스트케이스는 확정돼 있고 구현이 다음 단계입니다.\n" +
    "인자 표면은 `framenote --help` 로 볼 수 있습니다.\n",
);
process.exit(1);
