// framenote 플레이어.
//
// 프레임 정확도가 이 파일의 전부다. `currentTime` 을 fps 로 나눠 프레임을 구하지 않는다 —
// 내부 반올림과 키프레임 스냅으로 1~2프레임 어긋나고, **에러가 안 나서 아무도 모른다.**
// 브라우저가 "지금 이 프레임을 그렸다"고 알려주는 mediaTime 으로만 확정한다.

const $ = (id) => document.getElementById(id);
const v = $("v");

let INFO = null;
let notes = [];
let frame = 0;
let selection = null;      // 스크러버로 잡은 구간 [from, to]
let selectionFromUser = false; // 사람이 스크러버로 잡았나(자동 생성과 구분한다)
let pending = null;        // 작성 중인 네모
let pendingFrame = null;
let current = null;        // 목록에서 고른 메모 id
let pendingImages = [];    // 저장 전에 붙인 이미지

const FRAME_OK = "requestVideoFrameCallback" in HTMLVideoElement.prototype;

const api = async (path, opts) => {
  const res = await fetch(path, opts);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error || `요청이 실패했습니다 (${res.status})`);
  return body;
};

const tc = (f) => {
  const s = f / INFO.info.fps, m = Math.floor(s / 60);
  return String(m).padStart(2, "0") + ":" + (s - m * 60).toFixed(2).padStart(5, "0");
};
const sceneAt = (f) => {
  const list = [...(INFO.scenes || [])].sort((a, b) => a.startFrame - b.startFrame);
  let name = null;
  for (const s of list) { if (f >= s.startFrame) name = s.name; else break; }
  return name;
};

// ── 프레임 확정 ───────────────────────────────────────────
// 브라우저가 그린 프레임의 mediaTime 을 받아 프레임 번호로 바꾼다. 이게 유일한 근거다.
function trackFrames() {
  if (!FRAME_OK) return;
  const tick = (_now, meta) => {
    frame = Math.round(meta.mediaTime * INFO.info.fps);
    paintPosition();
    v.requestVideoFrameCallback(tick);
  };
  v.requestVideoFrameCallback(tick);
}

/** 목표 프레임으로 이동하고 **실제로 그려진 프레임**을 돌려준다. 시각을 더하는 방식이 아니다. */
function seekToFrame(target) {
  return new Promise((resolve, reject) => {
    const t = Math.max(0, Math.min(INFO.info.totalFrames - 1, Math.round(target)));
    if (!FRAME_OK) { v.currentTime = t / INFO.info.fps; resolve(t); return; }
    // 프레임 중앙을 겨눈다 — 경계를 겨누면 앞 프레임 끝으로 잡히는 fencepost 오류가 난다.
    const want = (t + 0.5) / INFO.info.fps;

    // **이미 그 자리면 그대로 끝낸다.** currentTime 이 안 바뀌면 새 프레임이 안 그려지고
    // 콜백이 영영 안 온다 — 실측(2026-08-19) 로 첫 목표가 현재 프레임과 같아 멈췄다.
    // 초 단위로 비교하면 브라우저가 돌려주는 값이 미세하게 달라 못 거른다(0.016666 vs 1/60).
    // 프레임 단위로 본다.
    const frameOfTime = () => Math.floor(v.currentTime * INFO.info.fps + 1e-6);
    if (frameOfTime() === t && !v.seeking) {
      frame = t; paintPosition(); resolve(t); return;
    }

    let done = false;
    // 콜백이 안 오는 상황을 조용히 넘기지 않는다. 멈춘 채로 성공처럼 보이면 안 된다.
    const guard = setTimeout(() => {
      if (done) return;
      done = true;
      // 콜백이 안 왔어도 실제로 그 자리에 가 있으면 그걸로 끝낸다. 못 갔으면 조용히 넘기지 않는다.
      if (frameOfTime() === t) { frame = t; paintPosition(); resolve(t); return; }
      reject(new Error(
        `프레임 ${t} 로 이동하지 못했습니다 (지금 ${frameOfTime()}). 브라우저가 그린 프레임을 알려주지 않습니다.`,
      ));
    }, 3000);

    v.currentTime = want;
    v.requestVideoFrameCallback((_n, meta) => {
      if (done) return;
      done = true;
      clearTimeout(guard);
      frame = Math.round(meta.mediaTime * INFO.info.fps);
      paintPosition();
      resolve(frame);
    });
  });
}
window.__seekToFrame = seekToFrame;          // 프레임 정확도 검증에서 부른다
window.__currentFrame = () => frame;

// ── 그리기 ────────────────────────────────────────────────
function paintPosition() {
  $("tct").textContent = tc(frame);
  const sc = sceneAt(frame);
  $("fr").textContent = `f${frame}${sc ? " · " + sc : ""}`;
  $("head").style.left = (frame / INFO.info.totalFrames * 100) + "%";
  [...$("segs").children].forEach((el) => {
    const from = Number(el.dataset.from), to = Number(el.dataset.to);
    el.classList.toggle("on", frame >= from && frame < to);
  });
}

function buildSegs() {
  const total = INFO.info.totalFrames;
  const scenes = [...(INFO.scenes || [])].sort((a, b) => a.startFrame - b.startFrame);
  const box = $("segs"); box.innerHTML = "";
  const bounds = scenes.length ? scenes.map((s, i) => ({
    name: s.name, from: s.startFrame, to: scenes[i + 1]?.startFrame ?? total,
  })) : [{ name: "", from: 0, to: total }];
  for (const b of bounds) {
    const el = document.createElement("div");
    el.className = "seg";
    el.style.flex = `0 0 ${(b.to - b.from) / total * 100}%`;
    el.dataset.from = b.from; el.dataset.to = b.to;
    el.textContent = b.name;
    box.appendChild(el);
  }
}

function paintMarks() {
  const box = $("draw");
  [...box.querySelectorAll(".rect.mark")].forEach((e) => e.remove());
  const rectOf = v.getBoundingClientRect(), stageOf = $("stage").getBoundingClientRect();
  for (const n of notes) {
    if (!n.rect) continue;
    if (frame < n.range[0] - 30 || frame > n.range[1] + 30) continue;
    const d = document.createElement("div");
    d.className = "rect mark" + (n.status === "applied" ? " applied" : "");
    d.style.left = (rectOf.left - stageOf.left + n.rect.x0 * rectOf.width) + "px";
    d.style.top = (rectOf.top - stageOf.top + n.rect.y0 * rectOf.height) + "px";
    d.style.width = ((n.rect.x1 - n.rect.x0) * rectOf.width) + "px";
    d.style.height = ((n.rect.y1 - n.rect.y0) * rectOf.height) + "px";
    d.innerHTML = `<span class="tag">${n.id.slice(0, 4)}</span>`;
    box.appendChild(d);
  }
}


/** 상태별로 카드에 뜨는 동작. 문서의 상태 지도에 있는 전이만 노출한다. */
function actionsFor(n) {
  const patch = (body) => api(`/api/notes/${n.id}`, {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const acts = [];
  if (n.status === "applied") {
    acts.push(["해결됨", () => patch({ status: "closed" })]);
    acts.push(["다시 열기", () => patch({ status: "sent" })]);
  }
  if (n.status === "stale") {
    // 다시 찍음은 구간·좌표를 새로 잡아야 하므로 편집 모드로 들어간다.
    acts.push(["다시 찍음", async () => { await startRetake(n); }]);
    acts.push(["버림", () => patch({ status: "closed" })]);
  }
  if (n.status === "failed") {
    acts.push(["다시 보내기", () => api(`/api/notes/${n.id}/resend`, { method: "POST" })]);
  }
  if (n.status !== "closed") {
    acts.push(["수정", async () => { await startEdit(n); }]);
    acts.push(["삭제", () => api(`/api/notes/${n.id}`, { method: "DELETE" })]);
  }
  return acts;
}

let editing = null;   // 지금 고치는 중인 메모

/** 기존 메모를 작성창에 펼쳐 고친다. 작업중이면 먼저 경고한다. */
async function startEdit(n) {
  if (n.status === "working") {
    const go = confirm(
      "에이전트가 이 메모로 작업 중입니다. 지금 고치면 그 작업이 취소되고 초안으로 돌아갑니다. 계속할까요?",
    );
    if (!go) return;
  }
  editing = n;
  await selectNote(n.id);
  pending = n.rect; pendingFrame = n.rectFrame;
  setSelection(n.range.slice(), true);
  openComposer();
  $("what").value = n.what;
  $("want").value = n.want ?? "";
  updateWantNudge();
}

/** 낡은 메모를 새 렌더본에서 다시 찍는다. 글과 이미지는 그대로 두고 좌표만 새로 잡는다. */
async function startRetake(n) {
  editing = n;
  await selectNote(n.id);
  pending = null; pendingFrame = null;
  selection = null; selectionFromUser = false;
  $("selbox").style.display = "none";
  openComposer();
  $("what").value = n.what;
  $("want").value = n.want ?? "";
  msg("새 렌더본에서 구간과 네모를 다시 잡으세요.", "ok");
}

const KO = { draft: "초안", sent: "보냄", working: "작업중", applied: "반영됨",
             failed: "실패", closed: "닫힘", stale: "낡음" };

function paintNotes() {
  const box = $("list"); box.innerHTML = "";
  const open = notes.filter((n) => n.status !== "closed");
  for (const n of open) {
    const el = document.createElement("div");
    el.className = "note" + (n.id === current ? " cur" : "");
    const span = n.range[0] === n.range[1] ? `f${n.range[0]}` : `f${n.range[0]}–${n.range[1]}`;
    el.innerHTML =
      `<div class="nr"><span class="dot ${n.status}"></span>${n.id.slice(0, 4)} · ${span} · ${KO[n.status]}` +
      `${n.scene ? " · " + n.scene : ""}</div><div class="nw"></div>` +
      (n.want ? `<div class="nt"></div>` : "") +
      (n.failureReason ? `<div class="nf"></div>` : "") +
      (n.images.length ? `<div class="thumbs">${n.images.map((p) => `<img src="/${p}" alt="">`).join("")}</div>` : "");
    el.querySelector(".nw").textContent = n.what;
    if (n.want) el.querySelector(".nt").textContent = n.want;
    if (n.failureReason) el.querySelector(".nf").textContent = n.failureReason;
    el.onclick = () => selectNote(n.id);

    const acts = document.createElement("div");
    acts.className = "acts";
    for (const [label, run] of actionsFor(n)) {
      const b = document.createElement("button");
      b.className = "act";
      b.textContent = label;
      b.dataset.act = label;
      b.onclick = async (e) => { e.stopPropagation(); await run(); await refresh(); };
      acts.appendChild(b);
    }
    if (acts.children.length) el.appendChild(acts);
    box.appendChild(el);
  }
  const working = notes.filter((n) => n.status === "working");
  $("work").textContent = working.length
    ? `⚬ ${working.map((n) => n.id.slice(0, 4)).join(", ")} 작업 중…` : "";
  $("counts").textContent = `${open.length}건`;
  const sendable = notes.filter((n) => n.status === "draft" || n.status === "failed").length;
  $("send").disabled = sendable === 0;
  $("send").textContent = sendable ? `에이전트에게 보내기 (${sendable})` : "보낼 메모 없음";
  paintMarks();
}

async function selectNote(id) {
  current = id;
  const n = notes.find((x) => x.id === id);
  if (n) { v.pause(); await seekToFrame(n.range[0]); }
  paintNotes();
}

// ── 스크러버: 클릭=점, 드래그=구간 ──────────────────────────
const scrub = $("scrub");
let scrubStart = null;
const frameAtX = (e) => {
  const b = scrub.getBoundingClientRect();
  return Math.round((e.clientX - b.left) / b.width * INFO.info.totalFrames);
};
scrub.addEventListener("mousedown", (e) => { v.pause(); scrubStart = frameAtX(e); seekToFrame(scrubStart); });
window.addEventListener("mousemove", (e) => {
  if (scrubStart === null) return;
  const now = frameAtX(e);
  if (Math.abs(now - scrubStart) > 2) setSelection([Math.min(scrubStart, now), Math.max(scrubStart, now)]);
});
window.addEventListener("mouseup", (e) => {
  if (scrubStart === null) return;
  const now = frameAtX(e);
  if (Math.abs(now - scrubStart) <= 2) setSelection([scrubStart, scrubStart]);
  scrubStart = null;
});
function setSelection(range, byUser = true) {
  selection = range;
  selectionFromUser = byUser;
  const total = INFO.info.totalFrames;
  const box = $("selbox");
  box.style.display = "block";
  box.style.left = (range[0] / total * 100) + "%";
  box.style.width = (Math.max(range[1] - range[0], 1) / total * 100) + "%";
  $("selinfo").textContent = range[0] === range[1]
    ? `점 f${range[0]}` : `구간 f${range[0]}–${range[1]} (반복 재생)`;
}
// 구간이 잡히면 그 구간만 반복 재생한다 — 페이싱은 반복해서 봐야 판단이 된다.
v.addEventListener("timeupdate", () => {
  if (!selection || selection[0] === selection[1] || v.paused) return;
  if (frame >= selection[1]) seekToFrame(selection[0]);
});

$("play").onclick = () => { if (v.paused) { v.play(); $("play").textContent = "❚❚"; } else { v.pause(); $("play").textContent = "▶"; } };
// 한 칸 이동은 목표를 **누적**한다. 앞 이동이 끝나기 전에 또 누르면 그 사이의 누름이
// 삼켜져서, 다섯 번 눌러도 두 칸만 가는 일이 생긴다(실측 2026-08-19).
let stepTarget = null, stepping = false;
async function stepBy(delta) {
  const base = stepTarget === null ? frame : stepTarget;
  stepTarget = Math.max(0, Math.min(INFO.info.totalFrames - 1, base + delta));
  if (stepping) return;
  stepping = true;
  try {
    // 루프 안에서 목표를 비우지 않는다. 비우면 그 사이에 누른 것이 낡은 frame 을 기준으로
    // 다시 계산돼 한두 칸이 삼켜진다(실측 2026-08-19: 다섯 번 눌렀는데 두 칸).
    let done = null;
    while (stepTarget !== done) {
      done = stepTarget;
      await seekToFrame(done);
    }
  } finally { stepping = false; stepTarget = null; }
}
document.addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.key === "ArrowRight") { v.pause(); void stepBy(e.shiftKey ? 30 : 1); e.preventDefault(); }
  if (e.key === "ArrowLeft") { v.pause(); void stepBy(e.shiftKey ? -30 : -1); e.preventDefault(); }
  if (e.key === " ") { $("play").click(); e.preventDefault(); }
});

// ── 네모 그리기 → 작성 ─────────────────────────────────────
const draw = $("draw");
let dragging = false, sx = 0, sy = 0, live = null, startedOnMark = null;
draw.addEventListener("mousedown", (e) => {
  if (INFO.locked || e.target.closest(".composer")) return;
  // 마커 위에서도 끌 수 있어야 한다. 누른 시점에 막으면 마커가 덮은 자리는 영영 새 메모를
  // 못 만든다(실측 2026-08-19). 움직였으면 그리기, 안 움직였으면 그 메모 선택으로 가른다.
  startedOnMark = e.target.closest(".rect.mark");
  const b = v.getBoundingClientRect();
  if (e.clientX < b.left || e.clientX > b.right || e.clientY < b.top || e.clientY > b.bottom) return;
  v.pause(); dragging = true;
  sx = (e.clientX - b.left) / b.width; sy = (e.clientY - b.top) / b.height;
  live = document.createElement("div"); live.className = "rect"; draw.appendChild(live);
  e.preventDefault();
});
window.addEventListener("mousemove", (e) => {
  if (!dragging) return;
  const b = v.getBoundingClientRect(), sb = $("stage").getBoundingClientRect();
  const cx = Math.min(1, Math.max(0, (e.clientX - b.left) / b.width));
  const cy = Math.min(1, Math.max(0, (e.clientY - b.top) / b.height));
  pending = { x0: Math.min(sx, cx), y0: Math.min(sy, cy), x1: Math.max(sx, cx), y1: Math.max(sy, cy) };
  live.style.left = (b.left - sb.left + pending.x0 * b.width) + "px";
  live.style.top = (b.top - sb.top + pending.y0 * b.height) + "px";
  live.style.width = ((pending.x1 - pending.x0) * b.width) + "px";
  live.style.height = ((pending.y1 - pending.y0) * b.height) + "px";
});
window.addEventListener("mouseup", () => {
  if (!dragging) return;
  dragging = false;
  if (!pending || pending.x1 - pending.x0 < 0.02 || pending.y1 - pending.y0 < 0.02) {
    pending = null; live?.remove();
    // 마커 위에서 안 움직였으면 클릭이다 — 그 메모를 고른다.
    if (startedOnMark) {
      const tag = startedOnMark.querySelector(".tag")?.textContent;
      const hit = notes.find((n) => n.id.startsWith(tag ?? "\u0000"));
      if (hit) void selectNote(hit.id);
    }
    startedOnMark = null;
    return;
  }
  startedOnMark = null;
  pendingFrame = frame;
  // 네모만 그려 시작한 메모는 구간이 지금 프레임 하나로 채워진다. 비워 두지 않는다.
  // **사람이 잡은 게 아니라고 표시한다** — 안 그러면 저장 뒤에도 남아서 다음 메모가
  // 그 프레임을 물려받는다(실측 2026-08-19: 두 번째 메모가 첫 메모의 프레임으로 저장됐다).
  if (!selection) setSelection([frame, frame], false);
  openComposer();
});

// "어떻게" 가 비면 **구간을 잡고 이미지를 붙이도록 유도한다.**
// 말로 못 하는 지적("그냥 이상해")은 정당하고, 그럴수록 에이전트가 판단할 근거는 구간과
// 그림뿐이다. 채우라고 막는 게 아니라 다른 근거를 대게 한다.
function updateWantNudge() {
  const el = $("pastehint");
  if (pendingImages.length > 0) {
    el.textContent = `이미지 ${pendingImages.length}장 첨부됨`;
    el.style.color = "";
    return;
  }
  const wantEmpty = $("want").value.trim() === "";
  const r = selection ?? [frame, frame];
  const isPoint = r[0] === r[1];
  if (!wantEmpty) {
    el.textContent = "Cmd/Ctrl+V 로 이미지를 붙일 수 있습니다";
    el.style.color = "";
    return;
  }
  el.style.color = "var(--open)";
  el.textContent = isPoint
    ? "어떻게가 비었습니다 — 스크러버를 끌어 구간을 잡거나 화면을 붙이면 에이전트가 판단할 수 있습니다"
    : "어떻게가 비었습니다 — 화면을 붙이면 에이전트가 판단할 근거가 늘어납니다";
}
$("want").addEventListener("input", updateWantNudge);

function openComposer() {
  const r = selection ?? [frame, frame];
  $("coord").innerHTML =
    `<span>구간</span> f${r[0]}${r[0] === r[1] ? "" : "–" + r[1]} <span>· ${tc(r[0])}</span><br>` +
    (sceneAt(r[0]) ? `<span>씬</span> ${sceneAt(r[0])}<br>` : "") +
    (pending ? `<span>네모</span> [${[pending.x0, pending.y0, pending.x1, pending.y1].map((n) => n.toFixed(2)).join(", ")}] @f${pendingFrame}` : `<span>네모 없음</span>`);
  // 고치는 중이면 쓰던 내용을 지우지 않는다. 네모를 다시 끌면 이 함수가 또 불리는데,
  // 여기서 비우면 저장이 "무엇이 비었다"로 조용히 멈춘다(실측 2026-08-19).
  if (!editing) { $("what").value = ""; $("want").value = ""; pendingImages = []; }
  updateWantNudge();
  msg("", "");
  $("composer").classList.add("on");
  $("what").focus();
}
function closeComposer() {
  editing = null;
  $("composer").classList.remove("on");
  pending = null; pendingFrame = null; pendingImages = [];
  // 자동으로 만든 구간은 이 메모의 것이다. 남겨두면 다음 메모가 물려받는다.
  if (!selectionFromUser) {
    selection = null;
    $("selbox").style.display = "none";
    $("selinfo").textContent = "";
  }
  [...draw.querySelectorAll(".rect:not(.mark)")].forEach((e) => e.remove());
}
function msg(text, kind) {
  const el = $("cmsg");
  el.textContent = text; el.className = "msg" + (text ? " on " + kind : "");
}
$("cancel").onclick = closeComposer;

// 이미지 붙여넣기 — 커서가 입력칸 밖이어도 받는다. 캡처하러 나갔다 오면 커서가 어디에도 없다.
document.addEventListener("paste", (e) => {
  if (!$("composer").classList.contains("on")) return;
  const files = [...(e.clipboardData?.files ?? [])];
  const items = [...(e.clipboardData?.items ?? [])]
    .filter((i) => i.kind === "file").map((i) => i.getAsFile()).filter(Boolean);
  const picked = files.length ? files : items;
  if (!picked.length) return;   // 이미지가 아니면 그대로 통과시켜 글상자로 간다
  e.preventDefault();
  for (const f of picked) addImage(f);
});
draw.addEventListener("dragover", (e) => e.preventDefault());
draw.addEventListener("drop", (e) => {
  if (!$("composer").classList.contains("on")) return;
  e.preventDefault();
  for (const f of e.dataTransfer.files) addImage(f);
});
function addImage(file) {
  if (pendingImages.length >= 10) { msg("이미지는 메모당 10장까지입니다.", "err"); return; }
  if (file.size > 20 * 1024 * 1024) { msg(`${file.name || "이미지"} 가 20MB를 넘습니다.`, "err"); return; }
  pendingImages.push(file);
  updateWantNudge();
}

$("save").onclick = async () => {
  const what = $("what").value.trim();
  if (!what) { msg("무엇이 칸을 채워야 합니다.", "err"); $("what").focus(); return; }
  try {
    const r = selection ?? [frame, frame];
    if (editing) {
      // 고치는 중이면 새 메모를 만들지 않는다. 같은 식별자로 남아 이력이 이어진다.
      await api(`/api/notes/${editing.id}`, {
        method: "PATCH", headers: { "content-type": "application/json" },
        body: JSON.stringify({ range: r, rect: pending, rectFrame: pendingFrame, what, want: $("want").value }),
      });
      editing = null;
      closeComposer();
      await refresh();
      return;
    }
    const note = await api("/api/notes", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ range: r, rect: pending, rectFrame: pendingFrame, what, want: $("want").value }),
    });
    for (const f of pendingImages) {
      const buf = await f.arrayBuffer();
      await fetch(`/api/notes/${note.id}/images?name=${encodeURIComponent(f.name || "paste.png")}`, {
        method: "POST", headers: { "content-type": f.type || "application/octet-stream" }, body: buf,
      }).then(async (res) => { if (!res.ok) msg((await res.json()).error, "err"); });
    }
    closeComposer();
    await refresh();
  } catch (e) { msg(e.message, "err"); }
};

$("send").onclick = async () => {
  try {
    const r = await api("/api/send", { method: "POST" });
    await refresh();
    if (r.count) $("counts").textContent += ` · ${r.count}건 보냄`;
  } catch (e) { alert(e.message); }
};

$("copy").onclick = async () => {
  // 글은 서버에서 받는다. 여기서 조립하면 에이전트가 받는 것과 갈라진다.
  const text = await (await fetch("/api/format")).text();
  try {
    await navigator.clipboard.writeText(text);
    $("copy").textContent = "복사됨";
    setTimeout(() => ($("copy").textContent = "복사"), 1500);
  } catch {
    // 클립보드가 거부되면 실패를 알리고 직접 고를 수 있게 편다. 성공한 척하지 않는다.
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.cssText = "position:fixed;inset:10%;z-index:99;width:80%;height:70%;font:12px monospace";
    document.body.appendChild(ta); ta.select();
    alert("클립보드에 쓰지 못했습니다. 펼쳐진 글상자에서 직접 복사하세요.");
    ta.onblur = () => ta.remove();
  }
};

// ── 갱신 ──────────────────────────────────────────────────
async function refresh() {
  notes = await api("/api/notes");
  paintNotes();
}

async function loadInfo(keepFrame) {
  const prev = keepFrame ? frame : 0;
  INFO = await api("/api/info");
  $("file").textContent = INFO.video.split("/").pop();
  $("render").textContent = INFO.info.render;
  $("spec").textContent = `${INFO.info.width}x${INFO.info.height} ${INFO.info.fps}fps ${INFO.info.totalFrames}f`;
  $("kind").textContent = INFO.info.sourceKind;
  if (INFO.locked || !FRAME_OK) {
    $("lock").style.display = "grid";
    $("lock").textContent = INFO.locked
      ? `메모를 남길 수 없습니다 — ${INFO.lockReason}`
      : "이 브라우저는 그려진 프레임을 알려주지 않아 프레임을 확정할 수 없습니다. " +
        "틀린 프레임이 붙은 메모를 만들지 않도록 작성을 잠급니다. Chrome 계열에서 열어 주세요.";
    INFO.locked = true;
  } else {
    $("lock").style.display = "none";
  }
  if (INFO.problems?.length) console.warn("framenote:", INFO.problems.join(" / "));
  buildSegs();
  // 같은 창에서 영상을 갈아 끼울 때 보던 프레임을 유지한다. 새 창을 띄우지 않는다.
  v.src = `/video?r=${INFO.info.render}`;
  await new Promise((r) => v.addEventListener("loadeddata", r, { once: true }));
  trackFrames();
  await seekToFrame(prev);
}

const es = new EventSource("/events");
es.onmessage = async (e) => {
  const data = JSON.parse(e.data);
  if (data.type !== "notes-changed") return;
  if (data.render && INFO && data.render !== INFO.info.render) await loadInfo(true);
  await refresh();
};

(async () => { await loadInfo(false); await refresh(); })();
