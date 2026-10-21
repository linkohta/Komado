/*
 * 配信中のチャット: get_live_chat をポーリングし、届いたコメントを次の取得までの間に散らして流す。
 */
import { emit } from './danmaku.ts';
import { innertube } from './innertube.ts';
import { toComment, type ChatComment } from './renderers.ts';
import { remember, type Session } from './session.ts';
import type { ChatAction, ContinuationResponse } from './types.ts';

const MAX_FAILURES = 5; // 続けてこれを超えて失敗したら、セッションを捨てて next からやり直す
const RETRY_AFTER_ERROR_MS = 5000;

/** ポーリングが controller（index.ts）に問い合わせること */
export interface LiveHost {
  /** s がまだ現在のセッションか（動画が変わった後に届いた応答を捨てるため） */
  isCurrent(s: Session): boolean;
  isEnabled(): boolean;
  /** セッションを終える（配信終了・通信失敗）。controller が時間をおいて再試行する */
  end(s: Session): void;
  onActionPanel(s: Session, panel: unknown): void;
}

export function startPolling(s: Session, host: LiveHost): void {
  if (s.polling || !s.continuation) return;
  s.polling = true;
  void poll(s, host);
}

export function stopPolling(s: Session): void {
  s.polling = false;
  if (s.timer) {
    clearTimeout(s.timer);
    s.timer = null;
  }
}

async function poll(s: Session, host: LiveHost): Promise<void> {
  if (!s.polling || !host.isCurrent(s)) return;
  try {
    const data = await innertube<ContinuationResponse>('live_chat/get_live_chat', { continuation: s.continuation });
    if (!s.polling || !host.isCurrent(s)) return;
    const cc = data.continuationContents && data.continuationContents.liveChatContinuation;
    if (!cc) {
      host.end(s); // 配信終了（アーカイブ化されたら再試行で拾う）
      return;
    }
    const next = cc.continuations && cc.continuations[0];
    const cd = next && (next.invalidationContinuationData || next.timedContinuationData || next.reloadContinuationData);
    if (cd) {
      s.continuation = cd.continuation;
      s.timeoutMs = Math.max(1000, Math.min(cd.timeoutMs || 5000, 15000));
    }
    s.failures = 0;
    host.onActionPanel(s, cc.actionPanel);
    // 弾幕 OFF でも最初の 1 回は取得する（投稿用パラメータが get_live_chat の応答に入ることがあるため）
    if (!host.isEnabled()) {
      s.polling = false;
      return;
    }
    scatter(s, host, cc.actions || [], s.timeoutMs);
    s.timer = setTimeout(() => void poll(s, host), s.timeoutMs);
  } catch {
    if (!s.polling || !host.isCurrent(s)) return;
    if (++s.failures > MAX_FAILURES) {
      host.end(s);
      return;
    }
    s.timer = setTimeout(() => void poll(s, host), RETRY_AFTER_ERROR_MS);
  }
}

/** 1 回の応答に含まれるコメントを、タイムスタンプの間隔に合わせて次の取得までの間（spanMs）に散らして出す */
function scatter(s: Session, host: LiveHost, actions: ChatAction[], spanMs: number): void {
  const items: ChatComment[] = [];
  for (const action of actions) {
    const item = action.addChatItemAction && action.addChatItemAction.item;
    if (!item) continue;
    const c = toComment(item);
    if (c && !s.seen[c.id]) {
      remember(s, c.id);
      items.push(c);
    }
  }
  if (!items.length) return;
  const first = items[0].ts;
  const last = items[items.length - 1].ts;
  const scale = last > first ? Math.min(1, spanMs / (last - first)) : 0;
  for (const c of items) {
    const delay = scale ? (c.ts - first) * scale : 0;
    setTimeout(() => {
      if (host.isCurrent(s) && host.isEnabled()) emit(c);
    }, delay);
  }
}
