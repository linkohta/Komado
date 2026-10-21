/*
 * アーカイブのチャット（リプレイ）: 再生位置（video.currentTime）に合わせて get_live_chat_replay で先読みし、
 * キューから順に流す。シークしたら最初のトークンから取り直す。
 */
import { clearOverlay, emit } from './danmaku.ts';
import { innertube } from './innertube.ts';
import { toComment } from './renderers.ts';
import { remember, type Session } from './session.ts';
import type { ContinuationResponse } from './types.ts';

const LOOKAHEAD_MS = 15000; // キューの残りがこれを切ったら次を取りに行く
const SEEK_JUMP_MS = 3000; // 再生位置がこれ以上飛んだらシークとみなして取り直す
const LATE_MS = 2000; // これ以上遅れたコメントは流さずに捨てる
const MAX_FAILURES = 5;

export interface ReplayHost {
  isCurrent(s: Session): boolean;
  isEnabled(): boolean;
}

/** 最初からやり直す（シーク・弾幕 OFF） */
export function resetReplay(s: Session): void {
  s.queue = [];
  s.continuation = s.baseToken;
  s.exhausted = false;
  s.seen = {};
  s.seenCount = 0;
  s.lastTime = -1;
  clearOverlay();
}

/** timeupdate（約 4 回/秒）と 1 秒ごとの tick から呼ばれる */
export function replayTick(s: Session, video: HTMLVideoElement | null, host: ReplayHost): void {
  if (!video || !host.isEnabled()) return;
  const now = Math.floor(video.currentTime * 1000);
  if (s.lastTime >= 0 && Math.abs(now - s.lastTime) > SEEK_JUMP_MS) resetReplay(s);
  s.lastTime = now;
  if (video.paused) return;

  // 再生位置を過ぎたものを流す（大きく遅れたものは捨てる）
  while (s.queue.length && s.queue[0].offset <= now) {
    const c = s.queue.shift()!;
    if (now - c.offset < LATE_MS) emit(c);
  }
  const lastOffset = s.queue.length ? s.queue[s.queue.length - 1].offset : now;
  if (!s.exhausted && !s.fetching && s.continuation && lastOffset - now < LOOKAHEAD_MS) {
    void fetchAhead(s, now, host);
  }
}

async function fetchAhead(s: Session, offsetMs: number, host: ReplayHost): Promise<void> {
  s.fetching = true;
  const token = s.continuation;
  try {
    const data = await innertube<ContinuationResponse>('live_chat/get_live_chat_replay', {
      continuation: token,
      currentPlayerState: { playerOffsetMs: String(offsetMs) },
    });
    if (!host.isCurrent(s)) return;
    s.fetching = false;
    if (s.continuation !== token) return; // 取得中にシークされた
    const cc = data.continuationContents && data.continuationContents.liveChatContinuation;
    if (!cc) {
      s.exhausted = true;
      return;
    }
    const next = cc.continuations && cc.continuations[0];
    const cd = next && (next.liveChatReplayContinuationData || next.playerSeekContinuationData);
    s.continuation = cd ? cd.continuation : null;
    for (const action of cc.actions || []) {
      const r = action.replayChatItemAction;
      if (!r) continue;
      const offset = Number(r.videoOffsetTimeMsec || 0);
      for (const inner of r.actions || []) {
        const item = inner.addChatItemAction && inner.addChatItemAction.item;
        const c = item && toComment(item);
        if (!c || s.seen[c.id] || offset < offsetMs - LATE_MS) continue;
        remember(s, c.id);
        s.queue.push({ ...c, offset });
      }
    }
    s.queue.sort((a, b) => a.offset - b.offset);
    s.failures = 0;
    if (!s.continuation || !(cc.actions || []).length) s.exhausted = true;
  } catch {
    if (!host.isCurrent(s)) return;
    s.fetching = false;
    if (++s.failures > MAX_FAILURES) s.exhausted = true;
  }
}
