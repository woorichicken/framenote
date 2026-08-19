// 프레임 눈금 영상의 글리프와 그리기. 생성기와 검증기가 이 한 곳을 공유한다.
//
// 한 줄로 이어 쓰면 세다가 틀린다(실제로 틀렸다) — 행 배열로 둔다.

export const FONT = {
  "0": [".###.", "#...#", "#..##", "#.#.#", "##..#", "#...#", ".###."],
  "1": ["..#..", ".##..", "..#..", "..#..", "..#..", "..#..", ".###."],
  "2": [".###.", "#...#", "....#", "...#.", "..#..", ".#...", "#####"],
  "3": ["#####", "...#.", "..#..", "...#.", "....#", "#...#", ".###."],
  "4": ["...#.", "..##.", ".#.#.", "#..#.", "#####", "...#.", "...#."],
  "5": ["#####", "#....", "####.", "....#", "....#", "#...#", ".###."],
  "6": ["..##.", ".#...", "#....", "####.", "#...#", "#...#", ".###."],
  "7": ["#####", "....#", "...#.", "..#..", ".#...", ".#...", ".#..."],
  "8": [".###.", "#...#", "#...#", ".###.", "#...#", "#...#", ".###."],
  "9": [".###.", "#...#", "#...#", ".####", "....#", "...#.", ".##.."],
};
export const GW = 5;
export const GH = 7;

/** 글리프가 규격에서 벗어나면 즉시 멈춘다. 어긋난 눈금으로 검증하면 검증이 거짓말을 한다. */
export function assertFontShape() {
  for (const [d, rows] of Object.entries(FONT)) {
    if (rows.length !== GH) throw new Error(`글리프 '${d}' 행이 ${rows.length} 개다 (${GH} 이어야 함)`);
    for (const r of rows) {
      if (r.length !== GW) throw new Error(`글리프 '${d}' 행 '${r}' 길이가 ${r.length} 다 (${GW} 이어야 함)`);
    }
  }
  const seen = new Map();
  for (const [d, rows] of Object.entries(FONT)) {
    const key = rows.join("");
    if (seen.has(key)) throw new Error(`글리프 '${d}' 가 '${seen.get(key)}' 와 같다 — 구분이 안 된다`);
    seen.set(key, d);
  }
  return true;
}

/** 숫자 배치를 계산한다. 생성기와 검증기가 같은 자리를 봐야 하므로 여기서만 정한다. */
export function layout(label, width, height) {
  const scale = Math.max(4, Math.floor(height / (GH * 3)));
  const digitW = (GW + 1) * scale;
  return {
    scale,
    digitW,
    startX: Math.floor((width - digitW * label.length) / 2),
    startY: Math.floor((height - GH * scale) / 2),
  };
}

/** 프레임 하나를 RGB24 버퍼로 그린다. */
export function drawFrame(n, { width, height, frames, gop }) {
  const buf = Buffer.alloc(width * height * 3);
  buf.fill(16 + (n % 8) * 2); // 프레임마다 살짝 달라 인코더가 뭉개지 않는다

  const put = (x, y, r, g, b) => {
    if (x < 0 || y < 0 || x >= width || y >= height) return;
    const i = (y * width + x) * 3;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b;
  };

  const label = String(n);
  const { scale, digitW, startX, startY } = layout(label, width, height);

  label.split("").forEach((ch, di) => {
    const rows = FONT[ch];
    for (let gy = 0; gy < GH; gy++) {
      for (let gx = 0; gx < GW; gx++) {
        if (rows[gy][gx] !== "#") continue;
        for (let sy = 0; sy < scale; sy++) {
          for (let sx = 0; sx < scale; sx++) {
            put(startX + di * digitW + gx * scale + sx, startY + gy * scale + sy, 245, 245, 250);
          }
        }
      }
    }
  });

  // 진행 막대 — 눈으로도 위치를 가늠할 수 있게
  const barW = Math.round((width - 2) * (n / Math.max(1, frames - 1)));
  for (let y = height - 14; y < height - 6; y++) {
    for (let x = 1; x < 1 + barW; x++) put(x, y, 59, 130, 246);
  }

  // 키프레임 자리 표식 — 오차는 보통 키프레임이 아닌 자리에서 난다
  if (n % gop === 0) {
    for (let y = 6; y < 20; y++) for (let x = 6; x < 20; x++) put(x, y, 240, 166, 46);
  }
  return buf;
}
