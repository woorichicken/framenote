// 서버 없이 여는 정적 모드.
//
// 플레이어는 이 파일을 모른다. 같은 접점(`/api/...`)을 fetch 를 가로채 브라우저 저장소로
// 구현할 뿐이라, **화면과 프레임 확정 로직은 서버 모드와 한 벌**이다. 정적 모드용 플레이어를
// 따로 만들면 둘이 갈라지고, 갈라진 쪽은 아무도 안 본다.
//
// 서버 모드와 **일부러 다른 것 셋**:
//   1. 메모가 파일이 아니라 이 브라우저에 있다. 그래서 「메모 파일로 내보내기」로 꺼내 넘긴다.
//   2. 꺼내는 글은 `notes.jsonl` 과 같은 줄이다. 사람이 읽는 글은 서버의 format.ts 한 곳에서만
//      만든다 — 여기서 또 만들면 두 글이 갈라지고, 에이전트가 받는 것과 사람이 복사한 것이
//      달라진다. 줄 형식은 types.ts 의 Note 가 정본이라 갈라질 것이 없다.
//   3. 이미지 첨부를 막는다. 저장할 파일 자리가 없고, 메모에 base64 를 담지 않는 것이 계약이다.
(() => {
  const S = window.__FRAMENOTE_STATIC__;
  if (!S) return;

  const KEY = `framenote:notes:${S.storeKey}`;
  /** 저장소가 막힌 창(시크릿·사이트 데이터 차단)에서도 화면은 돌아가야 한다. */
  let memory = null;

  const readRaw = () => {
    if (memory) return memory;
    try {
      const raw = localStorage.getItem(KEY);
      if (raw === null) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  };

  const write = (list) => {
    memory = list;
    try {
      localStorage.setItem(KEY, JSON.stringify(list));
    } catch {
      // 못 써도 화면은 이어간다. 내보내기로 꺼낼 수 있다는 안내는 아래 배지에 이미 있다.
    }
  };

  /**
   * 낡음 표시는 **씨앗을 심을 때 한 번만** 한다.
   *
   * 서버는 새 렌더본이 도착하는 순간을 알지만 정적 페이지는 그 순간이 없다. 대신 "이 페이지가
   * 담은 렌더본"과 메모의 렌더본이 다르면 좌표가 이미 무효라, 열리는 시점에 그렇게 표시한다.
   */
  const STALE_TARGETS = ["draft", "sent", "failed"];
  const seed = () => {
    const list = (S.notes || []).map((n) =>
      n.render !== S.info.render && STALE_TARGETS.includes(n.status) ? { ...n, status: "stale" } : n,
    );
    write(list);
    return list;
  };

  const load = () => readRaw() ?? seed();

  // ── 서버와 같은 값 만들기 ────────────────────────────────
  // 타임코드와 씬 찾기는 순수 계산이라 브라우저에도 같은 식이 필요하다(플레이어도 화면 표시용으로
  // 같은 식을 갖고 있다). 근거는 src/timecode.ts · src/scenes.ts 이고, e2e 가 실제로 만들어진
  // 메모의 값으로 둘이 같은지 확인한다.
  const tcOf = (frame) => {
    const total = frame / (S.info.fps || 1);
    const minutes = Math.floor(total / 60);
    return String(minutes).padStart(2, "0") + ":" + (total - minutes * 60).toFixed(2).padStart(5, "0");
  };
  const sceneOf = (frame) => {
    const list = [...(S.scenes || [])].sort((a, b) => a.startFrame - b.startFrame);
    let name = null;
    for (const s of list) { if (frame >= s.startFrame) name = s.name; else break; }
    return name;
  };
  const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // src/id.ts 와 같다
  const shortId = (length = 8) => {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = "";
    for (let i = 0; i < length; i++) out += ALPHABET[bytes[i] % ALPHABET.length];
    return out;
  };

  const jsonl = (list) => list.map((n) => JSON.stringify(n)).join("\n") + (list.length ? "\n" : "");

  const download = (name, text) => {
    const url = URL.createObjectURL(new Blob([text], { type: "application/x-ndjson" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  };

  // ── 접점 ────────────────────────────────────────────────
  const reply = (status, data) =>
    new Response(status === 204 ? null : JSON.stringify(data), {
      status,
      headers: { "content-type": "application/json; charset=utf-8" },
    });
  const text = (body) =>
    new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } });

  const handle = (method, path, params, rawBody) => {
    const body = typeof rawBody === "string" && rawBody !== "" ? JSON.parse(rawBody) : {};

    if (path === "/api/info" && method === "GET") {
      return reply(200, {
        video: S.video,
        storeRoot: S.notesFile,
        info: S.info,
        scenes: S.scenes || [],
        previewCommand: S.previewCommand ?? null,
        locked: S.locked === true,
        lockReason: S.lockReason ?? "",
        problems: S.problems || [],
      });
    }

    if (path === "/api/notes" && method === "GET") {
      const batch = params.get("batch");
      const all = load();
      return reply(200, batch ? all.filter((n) => n.batch === batch) : all);
    }

    // 사람이 읽는 글 대신 `notes.jsonl` 의 줄을 그대로 준다 — 위 머리말 2번.
    if (path === "/api/format" && method === "GET") {
      const want = params.get("ids");
      const ids = want ? new Set(want.split(",")) : null;
      return text(jsonl(load().filter((n) => (ids ? ids.has(n.id) : n.status !== "closed"))));
    }

    if (path === "/api/notes" && method === "POST") {
      if (typeof body.what !== "string" || body.what.trim() === "") {
        return reply(400, { error: "무엇이 칸을 채워야 합니다." });
      }
      const range = body.range && body.range.length === 2 ? body.range : null;
      if (!range) return reply(400, { error: "구간이 필요합니다." });
      const from = Math.round(range[0]);
      const note = {
        id: shortId(),
        range: [from, Math.round(range[1])],
        tc: tcOf(from),
        createdAt: new Date().toISOString(),
        rect: body.rect ?? null,
        rectFrame: body.rectFrame ?? null,
        scene: sceneOf(from),
        what: body.what.trim(),
        want: body.want && body.want.trim() !== "" ? body.want.trim() : null,
        images: [],
        render: S.info.render,
        sourceKind: S.info.sourceKind,
        batch: null,
        status: "draft",
        failureReason: null,
      };
      write([...load(), note]);
      return reply(201, note);
    }

    if (path === "/api/notes" && method === "DELETE") {
      const want = params.get("ids");
      const ids = new Set((want ?? "").split(",").map((s) => s.trim()).filter((s) => s !== ""));
      if (ids.size === 0) return reply(400, { error: "지울 메모를 ids 로 지정해야 합니다." });
      const all = load();
      const targets = all.filter((n) => ids.has(n.id));
      const missing = [...ids].filter((id) => !targets.some((n) => n.id === id));
      write(all.filter((n) => !ids.has(n.id)));
      return reply(200, { deleted: targets.map((n) => n.id), missing });
    }

    const noteMatch = /^\/api\/notes\/([A-Za-z0-9]+)$/.exec(path);
    if (noteMatch) {
      const id = noteMatch[1];
      const all = load();
      const found = all.find((n) => n.id === id);
      if (!found) return reply(404, { error: "그런 메모가 없습니다." });

      if (method === "PATCH") {
        const next = { ...found };
        if (typeof body.what === "string" && body.what.trim() !== "") next.what = body.what.trim();
        if (body.want !== undefined) next.want = body.want && body.want.trim() !== "" ? body.want.trim() : null;
        if (body.range) {
          next.range = [Math.round(body.range[0]), Math.round(body.range[1])];
          next.tc = tcOf(next.range[0]);
          next.scene = sceneOf(next.range[0]);
        }
        if (body.rect !== undefined) next.rect = body.rect;
        if (body.rectFrame !== undefined) next.rectFrame = body.rectFrame;
        if (body.status !== undefined) next.status = body.status;
        // 작업중을 사람이 고치면 초안으로 되돌린다(알릴 에이전트가 없을 뿐, 상태 규칙은 같다).
        if (found.status === "working" && body.status === undefined) {
          next.status = "draft";
          next.batch = null;
        }
        if (found.status === "stale" && body.range) {
          next.status = "draft";
          next.render = S.info.render;
        }
        if (found.status === "applied" && body.status === "sent") {
          next.render = S.info.render;
          next.batch = null;
        }
        write(all.map((n) => (n.id === id ? next : n)));
        return reply(200, next);
      }

      if (method === "DELETE") {
        write(all.filter((n) => n.id !== id));
        return reply(200, { ok: true });
      }
    }

    if (/^\/api\/notes\/([A-Za-z0-9]+)\/images$/.test(path) && method === "POST") {
      return reply(400, {
        error: "정적 파일로 연 창에서는 이미지를 저장할 자리가 없습니다. 메모 글로 적어 주세요.",
      });
    }

    const resendMatch = /^\/api\/notes\/([A-Za-z0-9]+)\/resend$/.exec(path);
    if (resendMatch && method === "POST") {
      const id = resendMatch[1];
      const all = load();
      if (!all.some((n) => n.id === id)) return reply(404, { error: "그런 메모가 없습니다." });
      const batch = shortId(6);
      const next = all.map((n) =>
        n.id === id ? { ...n, status: "sent", batch, failureReason: null, render: S.info.render } : n,
      );
      write(next);
      download(S.exportName, jsonl(next.filter((n) => n.batch === batch)));
      return reply(200, { batch, count: 1 });
    }

    // 「보내기」는 여기서 **파일 내보내기**다. 받을 서버가 없으니 사람이 파일을 넘긴다.
    if (path === "/api/send" && method === "POST") {
      const all = load();
      const targets = all.filter((n) => n.status === "draft" || n.status === "failed");
      if (targets.length === 0) return reply(200, { batch: null, count: 0 });
      const batch = shortId(6);
      const ids = new Set(targets.map((n) => n.id));
      const next = all.map((n) => (ids.has(n.id) ? { ...n, status: "sent", batch, failureReason: null } : n));
      write(next);
      download(S.exportName, jsonl(next.filter((n) => ids.has(n.id))));
      return reply(200, { batch, count: targets.length });
    }

    return reply(404, { error: `정적 모드에는 없는 접점입니다: ${method} ${path}` });
  };

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init = {}) => {
    const href = typeof input === "string" ? input : input.url;
    const url = new URL(href, location.href);
    if (!url.pathname.startsWith("/api/")) return realFetch(input, init);
    const method = (init.method || (typeof input === "object" ? input.method : "GET") || "GET").toUpperCase();
    try {
      return handle(method, url.pathname, url.searchParams, init.body);
    } catch (e) {
      return reply(500, { error: String(e && e.message ? e.message : e) });
    }
  };

  // 서버가 없으니 알림 통로도 없다. 플레이어가 EventSource 를 만들어도 조용히 아무 일도
  // 없게 둔다 — file:// 에서 진짜로 열면 끝없이 재접속하며 콘솔을 채운다.
  window.EventSource = class {
    constructor() { this.onmessage = null; }
    close() {}
    addEventListener() {}
  };

  // ── 화면에서 달라지는 것 ────────────────────────────────
  const el = (id) => document.getElementById(id);
  // 보내기 버튼의 글자는 플레이어가 메모 수에 따라 다시 쓴다(paintNotes). 여기서 고치면
  // 메모를 하나 쓰는 순간 되돌아간다 — 글자는 플레이어에 맡기고 설명만 붙인다.
  el("send").title = "고를 것 없이 초안·실패 메모를 파일 한 장으로 받습니다. 그 파일을 에이전트에게 주세요.";
  el("copy").title = "고른 메모를 notes.jsonl 형식으로 복사합니다.";
  el("pastehint").textContent = "정적 파일로 연 창이라 이미지 첨부는 저장되지 않습니다. 글로 적어 주세요.";
  el("pickFile").style.display = "none";
  const badge = document.createElement("span");
  badge.textContent = "정적 · 메모는 이 브라우저에 저장됩니다";
  badge.style.cssText = "color:#f0a62e";
  el("work").before(badge);
})();
