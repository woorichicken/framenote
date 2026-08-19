import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { configFileFor, serverFileFor } from "./paths.js";
import { isUsableSceneList } from "./scenes.js";
import type { ProjectConfig, ServerEntry } from "./types.js";

/**
 * 저장소가 두는 설정. 없어도 동작하고 그만큼 기능이 준다.
 *
 * 깨진 파일을 조용히 무시하지 않고 무엇이 문제인지 함께 돌려준다 — 조용히 무시하면
 * "왜 씬이 안 보이지"를 사용자가 추측하게 된다.
 */
export function readProjectConfig(storeRoot: string): { config: ProjectConfig; problems: string[] } {
  const file = configFileFor(storeRoot);
  const problems: string[] = [];
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return { config: {}, problems };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    problems.push(`설정 파일을 읽지 못했습니다 (${file}): ${(e as Error).message}`);
    return { config: {}, problems };
  }
  if (parsed === null || typeof parsed !== "object") {
    problems.push(`설정 파일이 객체가 아닙니다 (${file}).`);
    return { config: {}, problems };
  }

  const obj = parsed as Record<string, unknown>;
  const config: ProjectConfig = {};

  if (typeof obj["previewCommand"] === "string" && obj["previewCommand"].trim() !== "") {
    config.previewCommand = obj["previewCommand"];
  } else if (obj["previewCommand"] !== undefined) {
    problems.push("previewCommand 가 비어 있거나 문자열이 아닙니다 — 재렌더를 하지 않습니다.");
  }

  if (obj["scenes"] !== undefined) {
    if (isUsableSceneList(obj["scenes"])) {
      config.scenes = obj["scenes"];
    } else {
      // 절반만 맞는 씬 경계가 제일 나쁘다 — 통째로 버리고 generic 으로 낮춘다.
      problems.push("씬 목록을 읽지 못해 generic 으로 낮췄습니다 (이름과 시작 프레임이 필요합니다).");
    }
  }
  return { config, problems };
}

function readServerEntries(storeRoot: string): ServerEntry[] {
  try {
    const parsed: unknown = JSON.parse(readFileSync(serverFileFor(storeRoot), "utf8"));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (e): e is ServerEntry =>
        e !== null && typeof e === "object" &&
        typeof (e as ServerEntry).port === "number" &&
        typeof (e as ServerEntry).video === "string" &&
        typeof (e as ServerEntry).pid === "number",
    );
  } catch {
    return [];
  }
}

/** 죽은 항목을 걸러낸다. 비정상 종료로 남은 것을 다음 실행이 정리한다. */
function alive(entry: ServerEntry): boolean {
  try {
    process.kill(entry.pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** 지금 떠 있는 서버 목록. 에이전트가 붙을 곳을 이 파일로 찾는다(터미널 출력을 긁지 않는다). */
export function listServers(storeRoot: string): ServerEntry[] {
  return readServerEntries(storeRoot).filter(alive);
}

export function registerServer(storeRoot: string, entry: ServerEntry): void {
  const file = serverFileFor(storeRoot);
  mkdirSync(dirname(file), { recursive: true });
  const kept = readServerEntries(storeRoot).filter((e) => alive(e) && e.pid !== entry.pid);
  writeFileSync(file, JSON.stringify([...kept, entry], null, 2) + "\n", "utf8");
}

export function unregisterServer(storeRoot: string, pid: number): void {
  const file = serverFileFor(storeRoot);
  const kept = readServerEntries(storeRoot).filter((e) => e.pid !== pid && alive(e));
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(kept, null, 2) + "\n", "utf8");
  } catch {
    // 정리 실패가 종료를 막지 않는다 — 다음 실행이 죽은 항목을 걸러낸다.
  }
}
