import { createHash } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

// 최소 WebSocket 서버 — 의존성 0 을 지키려고 직접 구현한다.
//
// 필요한 건 **서버가 미는 텍스트 프레임**뿐이다(에이전트는 듣기만 한다). 그래서 보내기는
// 텍스트 프레임만, 받기는 close/ping 만 처리한다. 압축·확장은 협상하지 않는다.

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface WsClient {
  send(text: string): void;
  close(): void;
  readonly alive: boolean;
}

/** 텍스트 프레임 하나를 만든다(FIN=1, opcode=0x1, 마스크 없음 — 서버는 마스킹하지 않는다). */
export function encodeTextFrame(text: string): Buffer {
  const payload = Buffer.from(text, "utf8");
  const len = payload.length;
  let header: Buffer;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, payload]);
}

export function acceptKey(clientKey: string): string {
  return createHash("sha1").update(clientKey + GUID).digest("base64");
}

/** 업그레이드 요청을 받아 클라이언트로 만든다. 핸드셰이크가 안 맞으면 null. */
export function upgrade(req: IncomingMessage, socket: Duplex): WsClient | null {
  const key = req.headers["sec-websocket-key"];
  if (typeof key !== "string" || (req.headers["upgrade"] ?? "").toLowerCase() !== "websocket") {
    socket.end("HTTP/1.1 400 Bad Request\r\n\r\n");
    return null;
  }
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  );

  let alive = true;
  const die = (): void => { alive = false; };
  socket.on("close", die);
  socket.on("error", die);
  socket.on("end", die);

  // 클라이언트가 보내는 건 close 정도다. 프레임을 해석하지 않고 close(0x8)만 본다.
  socket.on("data", (chunk: Buffer) => {
    if (chunk.length > 0 && (chunk[0]! & 0x0f) === 0x8) {
      alive = false;
      socket.end();
    }
  });

  return {
    get alive() { return alive; },
    send(text: string) {
      if (!alive) return;
      try {
        socket.write(encodeTextFrame(text));
      } catch {
        alive = false;
      }
    },
    close() {
      alive = false;
      try { socket.end(); } catch { /* 이미 닫힘 */ }
    },
  };
}

/** 붙어 있는 클라이언트 묶음. 죽은 것은 보낼 때 걸러진다. */
export class WsHub {
  private clients: WsClient[] = [];

  add(client: WsClient): void {
    this.clients.push(client);
  }

  get size(): number {
    this.clients = this.clients.filter((c) => c.alive);
    return this.clients.length;
  }

  /** 얇게 민다 — 묶음 식별자와 건수만. 전문은 받는 쪽이 따로 읽는다. */
  broadcast(payload: unknown): void {
    const text = JSON.stringify(payload);
    this.clients = this.clients.filter((c) => c.alive);
    for (const c of this.clients) c.send(text);
  }

  closeAll(): void {
    for (const c of this.clients) c.close();
    this.clients = [];
  }
}
