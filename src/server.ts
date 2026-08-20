import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join, resolve } from "node:path";

import { listServers, readProjectConfig, registerServer, unregisterServer } from "./config.js";
import { shortId } from "./id.js";
import {
  MAX_IMAGES_PER_NOTE, MAX_IMAGE_BYTES, appendNote, extensionFor,
  readNotes, removeImages, saveImage, writeNotes,
} from "./notes.js";
import { formatNotes } from "./format.js";
import { findStoreRoot, storeDirFor } from "./paths.js";
import { sceneAt } from "./scenes.js";
import { frameToTimecode } from "./timecode.js";
import type { Note, NoteStatus, ProjectConfig, StatusUpdate, VideoInfo } from "./types.js";
import { renderIdOf, readVideoInfo } from "./video.js";
import { WsHub, upgrade } from "./ws.js";

/** 재렌더로 좌표가 무효가 되는 상태. 작업중·반영됨은 제외한다 — 문서 「낡은 메모를 가려낸다」. */
const STALE_TARGETS: NoteStatus[] = ["draft", "sent", "failed"];

export interface ServerHandle {
  port: number;
  url: string;
  close(): Promise<void>;
}

interface State {
  videoPath: string;
  storeRoot: string;
  info: VideoInfo;
  config: ProjectConfig;
  problems: string[];
  locked: boolean;
}

function json(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "content-length": Buffer.byteLength(text) });
  res.end(text);
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error("too large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

function serveVideo(state: State, req: IncomingMessage, res: ServerResponse): void {
  const stat = statSync(state.videoPath);
  const range = req.headers.range;
  const type = state.videoPath.endsWith(".webm") ? "video/webm" : "video/mp4";
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    const start = m?.[1] ? Number(m[1]) : 0;
    const end = m?.[2] ? Number(m[2]) : stat.size - 1;
    res.writeHead(206, {
      "content-type": type,
      "content-range": `bytes ${start}-${end}/${stat.size}`,
      "accept-ranges": "bytes",
      "content-length": end - start + 1,
    });
    createReadStream(state.videoPath, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { "content-type": type, "content-length": stat.size, "accept-ranges": "bytes" });
  createReadStream(state.videoPath).pipe(res);
}

export async function startServer(opts: {
  videoPath: string;
  port?: number;
  /** 플레이어 정적 파일이 있는 디렉터리. index.html 과 player.js 를 담는다. */
  playerDir: string;
}): Promise<ServerHandle> {
  const videoPath = resolve(opts.videoPath);
  const storeRoot = findStoreRoot(videoPath);
  const { config, problems } = readProjectConfig(storeRoot);
  const sourceKind = config.scenes && config.scenes.length > 0 ? "remotion" : "generic";

  let info: VideoInfo;
  let locked = false;
  let lockReason = "";
  try {
    info = await readVideoInfo(videoPath, sourceKind);
  } catch (e) {
    // 규격을 못 읽으면 창은 열되 메모 작성을 잠근다. 창까지 안 열면 원인을 짐작할 근거가 없다.
    locked = true;
    lockReason = (e as Error).message;
    info = { width: 0, height: 0, fps: 0, totalFrames: 0, render: "unknown", sourceKind };
  }

  const state: State = { videoPath, storeRoot, info, config, problems, locked };
  const hub = new WsHub();
  const sse = new Set<ServerResponse>();

  const pushSse = (event: unknown): void => {
    const text = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of sse) {
      try { res.write(text); } catch { sse.delete(res); }
    }
  };

  const notes = (): Note[] => readNotes(storeRoot, videoPath);
  const save = (all: Note[]): void => writeNotes(storeRoot, videoPath, all);

  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((e: unknown) => {
      if (!res.headersSent) json(res, 500, { error: (e as Error).message });
    });
  });

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const path = url.pathname;

    if (path === "/" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(readFileSync(join(opts.playerDir, "index.html"), "utf8"));
      return;
    }
    if (path === "/verify.js" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(opts.playerDir, "verify.js"), "utf8"));
      return;
    }
    if (path === "/player.js" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/javascript; charset=utf-8" });
      res.end(readFileSync(join(opts.playerDir, "player.js"), "utf8"));
      return;
    }
    if (path === "/video" && req.method === "GET") return serveVideo(state, req, res);

    if (path === "/api/info" && req.method === "GET") {
      return json(res, 200, {
        video: state.videoPath,
        storeRoot,
        info: state.info,
        scenes: state.config.scenes ?? [],
        previewCommand: state.config.previewCommand ?? null,
        locked: state.locked,
        lockReason,
        problems: state.problems,
      });
    }

    if (path === "/api/notes" && req.method === "GET") {
      const batch = url.searchParams.get("batch");
      const all = notes();
      return json(res, 200, batch ? all.filter((n) => n.batch === batch) : all);
    }

    // 복사본과 에이전트 전달본이 **같은 한 곳**에서 나오게 한다. 브라우저가 따로 조립하면
    // 한쪽만 고쳐져 갈라진다.
    if (path === "/api/format" && req.method === "GET") {
      const want = url.searchParams.get("ids");
      const ids = want ? new Set(want.split(",")) : null;
      const picked = notes().filter((n) => (ids ? ids.has(n.id) : n.status !== "closed"));
      const text = formatNotes(picked, state.videoPath, state.info);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(text);
      return;
    }

    if (path === "/api/notes" && req.method === "POST") {
      if (state.locked) return json(res, 409, { error: "프레임 규격을 읽지 못해 메모를 남길 수 없습니다.", detail: lockReason });
      const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8")) as Partial<Note>;
      if (typeof body.what !== "string" || body.what.trim() === "") {
        return json(res, 400, { error: "무엇이 칸을 채워야 합니다." });
      }
      const range = body.range && body.range.length === 2 ? body.range : null;
      if (!range) return json(res, 400, { error: "구간이 필요합니다." });
      const id = shortId();
      const note: Note = {
        id,
        range: [Math.round(range[0]), Math.round(range[1])],
        tc: frameToTimecode(Math.round(range[0]), state.info.fps || 1),
        createdAt: new Date().toISOString(),
        rect: body.rect ?? null,
        rectFrame: body.rectFrame ?? null,
        scene: sceneAt(Math.round(range[0]), state.config.scenes),
        what: body.what.trim(),
        want: body.want && body.want.trim() !== "" ? body.want.trim() : null,
        images: [],
        render: state.info.render,
        sourceKind: state.info.sourceKind,
        batch: null,
        status: "draft",
        failureReason: null,
      };
      appendNote(storeRoot, videoPath, note);
      pushSse({ type: "notes-changed" });
      return json(res, 201, note);
    }

    const noteMatch = /^\/api\/notes\/([A-Za-z0-9]+)$/.exec(path);
    if (noteMatch) {
      const id = noteMatch[1]!;
      const all = notes();
      const found = all.find((n) => n.id === id);
      if (!found) return json(res, 404, { error: "그런 메모가 없습니다." });

      if (req.method === "PATCH") {
        const body = JSON.parse((await readBody(req, 2 * 1024 * 1024)).toString("utf8")) as Partial<Note>;
        const next: Note = { ...found };
        if (typeof body.what === "string" && body.what.trim() !== "") next.what = body.what.trim();
        if (body.want !== undefined) next.want = body.want && body.want.trim() !== "" ? body.want.trim() : null;
        if (body.range) {
          next.range = [Math.round(body.range[0]), Math.round(body.range[1])];
          next.tc = frameToTimecode(next.range[0], state.info.fps || 1);
          next.scene = sceneAt(next.range[0], state.config.scenes);
        }
        if (body.rect !== undefined) next.rect = body.rect;
        if (body.rectFrame !== undefined) next.rectFrame = body.rectFrame;
        if (body.status !== undefined) next.status = body.status;
        // 작업중 메모를 사람이 고치면 초안으로 되돌리고 에이전트에게 취소를 알린다.
        if (found.status === "working" && body.status === undefined) {
          next.status = "draft";
          next.batch = null;
          hub.broadcast({ type: "cancel", noteId: found.id });
        }
        // 낡음에서 다시 찍으면 구간·좌표·렌더본이 갱신되고 글과 이미지는 남는다.
        if (found.status === "stale" && body.range) {
          next.status = "draft";
          next.render = state.info.render;
        }
        // 다시 열기: 지금 보고 있는 렌더본 기준으로 되살아나 다음 묶음에 들어간다.
        if (found.status === "applied" && body.status === "sent") {
          next.render = state.info.render;
          next.batch = null;
        }
        save(all.map((n) => (n.id === id ? next : n)));
        pushSse({ type: "notes-changed" });
        return json(res, 200, next);
      }

      if (req.method === "DELETE") {
        removeImages(storeRoot, videoPath, found);
        save(all.filter((n) => n.id !== id));
        pushSse({ type: "notes-changed" });
        return json(res, 200, { ok: true });
      }
    }

    const imgMatch = /^\/api\/notes\/([A-Za-z0-9]+)\/images$/.exec(path);
    if (imgMatch && req.method === "POST") {
      const id = imgMatch[1]!;
      const all = notes();
      const found = all.find((n) => n.id === id);
      if (!found) return json(res, 404, { error: "그런 메모가 없습니다." });
      if (found.images.length >= MAX_IMAGES_PER_NOTE) {
        return json(res, 400, { error: `이미지는 메모당 ${MAX_IMAGES_PER_NOTE}장까지입니다.` });
      }
      // 헤더로 먼저 거절한다 — 다 받고 나서 버리면 큰 파일이 그대로 메모리를 지난다.
      const declared = Number(req.headers["content-length"] ?? NaN);
      if (Number.isFinite(declared) && declared > MAX_IMAGE_BYTES) {
        return json(res, 400, { error: `이미지는 한 장에 ${MAX_IMAGE_BYTES / 1024 / 1024}MB까지입니다.` });
      }
      let raw: Buffer;
      try {
        raw = await readBody(req, MAX_IMAGE_BYTES + 1024);
      } catch {
        return json(res, 400, { error: `이미지는 한 장에 ${MAX_IMAGE_BYTES / 1024 / 1024}MB까지입니다.` });
      }
      if (raw.length > MAX_IMAGE_BYTES) {
        return json(res, 400, { error: `이미지는 한 장에 ${MAX_IMAGE_BYTES / 1024 / 1024}MB까지입니다.` });
      }
      const ext = extensionFor(req.headers["content-type"], url.searchParams.get("name") ?? undefined);
      if (!ext) return json(res, 400, { error: "이미지 형식을 알아보지 못했습니다 (png·jpg·webp·gif)." });
      const rel = saveImage(storeRoot, videoPath, id, found.images.length, ext, raw);
      const next: Note = { ...found, images: [...found.images, rel] };
      save(all.map((n) => (n.id === id ? next : n)));
      pushSse({ type: "notes-changed" });
      return json(res, 201, next);
    }

    // 이미지 열람 — 플레이어와 사람이 본다.
    const fileMatch = /^\/images\/(.+)$/.exec(path);
    if (fileMatch && req.method === "GET") {
      const file = join(storeDirFor(storeRoot, videoPath), "images", fileMatch[1]!);
      if (!existsSync(file)) return json(res, 404, { error: "없습니다." });
      res.writeHead(200, { "content-length": statSync(file).size });
      createReadStream(file).pipe(res);
      return;
    }

    const resendMatch = /^\/api\/notes\/([A-Za-z0-9]+)\/resend$/.exec(path);
    if (resendMatch && req.method === "POST") {
      const id = resendMatch[1]!;
      const all = notes();
      const found = all.find((n) => n.id === id);
      if (!found) return json(res, 404, { error: "그런 메모가 없습니다." });
      // 그 메모만 즉시 새 묶음으로 나간다. 대기 중인 초안은 딸려 나가지 않는다.
      const batch = shortId(6);
      save(all.map((n) => (n.id === id
        ? { ...n, status: "sent" as const, batch, failureReason: null, render: state.info.render }
        : n)));
      hub.broadcast({ type: "batch", batch, count: 1 });
      pushSse({ type: "notes-changed" });
      return json(res, 200, { batch, count: 1 });
    }

    if (path === "/api/send" && req.method === "POST") {
      const all = notes();
      const targets = all.filter((n) => n.status === "draft" || n.status === "failed");
      if (targets.length === 0) return json(res, 200, { batch: null, count: 0 });
      const batch = shortId(6);
      const ids = new Set(targets.map((n) => n.id));
      save(all.map((n) => (ids.has(n.id) ? { ...n, status: "sent" as const, batch, failureReason: null } : n)));
      // 얇게 민다 — 묶음 식별자와 건수만. 전문은 에이전트가 따로 읽는다.
      hub.broadcast({ type: "batch", batch, count: targets.length });
      pushSse({ type: "notes-changed" });
      return json(res, 200, { batch, count: targets.length });
    }

    if (path === "/api/status" && req.method === "POST") {
      const body = JSON.parse((await readBody(req, 256 * 1024)).toString("utf8")) as { updates?: StatusUpdate[] };
      const updates = body.updates;
      if (!Array.isArray(updates) || updates.length === 0) {
        // 묶음 전체를 한 상태로 바꾸는 요청은 받지 않는다 — 부분 성공을 표현할 수 없다.
        return json(res, 400, { error: "메모를 개별 지정한 updates 목록이 필요합니다." });
      }
      const all = notes();
      const byId = new Map(all.map((n) => [n.id, n]));
      const applied: string[] = [];
      let newRender: string | null = null;
      for (const u of updates) {
        const target = byId.get(u.noteId);
        if (!target) continue;
        const next: Note = { ...target, status: u.status };
        if (u.status === "failed") next.failureReason = u.reason ?? "사유 없음";
        if (u.status === "applied") {
          next.failureReason = null;
          if (u.renderedFile && existsSync(resolve(u.renderedFile))) {
            state.videoPath = resolve(u.renderedFile);
            // 렌더본 해시만 갱신하면 새 영상의 길이·해상도가 달라졌을 때 스크러버가 틀린다.
            // 규격을 통째로 다시 읽는다.
            try {
              const fresh = await readVideoInfo(state.videoPath, state.info.sourceKind);
              state.info = fresh;
              newRender = fresh.render;
            } catch {
              newRender = await renderIdOf(state.videoPath);
              state.info = { ...state.info, render: newRender };
            }
          }
        }
        byId.set(u.noteId, next);
        applied.push(u.noteId);
      }
      let result = [...byId.values()];
      if (newRender) {
        // 새 렌더본이 오면 초안·보냄·실패를 낡음으로. 작업중·반영됨은 제외한다.
        result = result.map((n) =>
          n.render !== newRender && STALE_TARGETS.includes(n.status) ? { ...n, status: "stale" as const } : n,
        );
      }
      save(result);
      pushSse({ type: "notes-changed", render: state.info.render });
      return json(res, 200, { applied, render: state.info.render });
    }

    if (path === "/events" && req.method === "GET") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      sse.add(res);
      req.on("close", () => sse.delete(res));
      return;
    }

    json(res, 404, { error: "없는 경로입니다." });
  }

  server.on("upgrade", (req, socket) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname !== "/feed") { socket.end("HTTP/1.1 404 Not Found\r\n\r\n"); return; }
    const client = upgrade(req, socket);
    if (client) hub.add(client);
  });

  // 로컬에만 바인딩한다. 리뷰 화면에는 아직 안 고친 영상과 내부 메모가 그대로 있다.
  const port = await new Promise<number>((resolveP, rejectP) => {
    server.once("error", rejectP);
    server.listen(opts.port ?? 0, "127.0.0.1", () => {
      const addr = server.address();
      resolveP(typeof addr === "object" && addr ? addr.port : 0);
    });
  });

  registerServer(storeRoot, { port, video: videoPath, pid: process.pid, startedAt: new Date().toISOString() });

  return {
    port,
    url: `http://127.0.0.1:${port}`,
    async close() {
      hub.closeAll();
      for (const res of sse) { try { res.end(); } catch { /* 이미 닫힘 */ } }
      sse.clear();
      unregisterServer(storeRoot, port);
      // 살아 있는 연결을 끊지 않으면 close 가 끝나지 않는다. 브라우저의 EventSource 는
      // 끊기면 2초 뒤 다시 붙어서, 닫는 동안 새 연결이 계속 생긴다(실측 2026-08-19:
      // 테스트 정리가 60초 타임아웃까지 매달렸다). Ctrl-C 도 같은 이유로 안 끝난다.
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

export { listServers, readFileSync };
