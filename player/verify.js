// 프레임 정확도 검증 — `?verify=1` 일 때만 실려온다.
//
// 화면에 그려진 숫자를 캔버스로 읽어, 플레이어가 보고하는 프레임 번호와 대조한다.
// 눈금 영상(scripts/make-ruler-video.mjs)이 대상이라는 전제다.
//
// 이게 없으면 프레임이 1~2개 어긋나도 **에러가 안 나서 아무도 모른다.**

(() => {
  const FONT = {
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
  const GW = 5, GH = 7;
  const KEYS = new Map(Object.entries(FONT).map(([d, r]) => [r.join(""), d]));

  function decodeDrawnNumber() {
    const v = document.getElementById("v");
    const W = v.videoWidth, H = v.videoHeight;
    const cv = document.createElement("canvas");
    cv.width = W; cv.height = H;
    const ctx = cv.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(v, 0, 0, W, H);
    const px = ctx.getImageData(0, 0, W, H).data;
    const lum = (x, y) => px[(y * W + x) * 4];

    // 긴 자릿수부터 본다. 1자리 배치가 3자리 라벨의 **가운데 숫자**와 같은 자리라
    // 짧은 쪽부터 보면 100 을 0 으로 읽는다(실측 2026-08-19).
    for (let len = 4; len >= 1; len--) {
      const scale = Math.max(4, Math.floor(H / (GH * 3)));
      const digitW = (GW + 1) * scale;
      const startX = Math.floor((W - digitW * len) / 2);
      const startY = Math.floor((H - GH * scale) / 2);
      let out = "", ok = true;
      for (let di = 0; di < len; di++) {
        const rows = [];
        for (let gy = 0; gy < GH; gy++) {
          let row = "";
          for (let gx = 0; gx < GW; gx++) {
            row += lum(startX + di * digitW + gx * scale + (scale >> 1),
                       startY + gy * scale + (scale >> 1)) > 128 ? "#" : ".";
          }
          rows.push(row);
        }
        const d = KEYS.get(rows.join(""));
        if (d === undefined) { ok = false; break; }
        out += d;
      }
      if (ok && (out.length === 1 || out[0] !== "0")) return Number(out);
    }
    return null;
  }

  /** 목표 프레임들로 이동하며 "요청 = 보고 = 그려진 것" 셋이 같은지 본다. */
  window.__verifyFrames = async (targets) => {
    const rows = [];
    window.__progress = { at: null, done: 0, total: targets.length };
    for (const asked of targets) {
      window.__progress.at = asked;
      const reported = await window.__seekToFrame(asked);
      // 캔버스가 새 프레임을 담을 때까지 두 번 넘긴다.
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const drawn = decodeDrawnNumber();
      rows.push({ asked, reported, drawn, ok: reported === asked && drawn === asked });
      window.__progress.done = rows.length;
    }
    return { total: rows.length, bad: rows.filter((r) => !r.ok).length, rows };
  };

  window.__verifyReady = true;
})();
