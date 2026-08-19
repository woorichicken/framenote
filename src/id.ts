import { randomBytes } from "node:crypto";

const ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789"; // 헷갈리는 l·o·0·1 을 뺀다

/**
 * 짧은 무작위 식별자.
 *
 * 순번을 쓰지 않는 이유: 순번은 새 메모마다 파일을 끝까지 읽어 최대값을 구해야 하고,
 * 두 곳에서 동시에 쓰면 겹친다.
 */
export function shortId(length = 8): string {
  const bytes = randomBytes(length);
  let out = "";
  for (let i = 0; i < length; i++) out += ALPHABET[bytes[i]! % ALPHABET.length];
  return out;
}
