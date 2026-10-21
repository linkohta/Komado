/*
 * セッション = 動画 1 本ぶんのチャット。動画が変わる・配信が終わる・通信が続けて失敗すると捨てて作り直す。
 */
import { find, runsText, type ChatComment } from './renderers.ts';
import type { MessageInputRenderer, RestrictedParticipationRenderer } from './types.ts';

/** アーカイブのキューに積むコメント（offset = 動画内の位置 ms） */
export interface ReplayComment extends ChatComment {
  offset: number;
}

export interface Session {
  videoId: string;
  /** true: アーカイブ（チャットのリプレイ）, false: 配信中 */
  replay: boolean;
  /** 次に取得するときのトークン */
  continuation: string | null;
  /** 最初のトークン（アーカイブでシークしたらここからやり直す） */
  baseToken: string | null;
  timeoutMs: number;
  /** 投稿に使うパラメータ。取れていなければ投稿できない */
  sendParams: string | null;
  maxLength?: number;
  /** 投稿できない理由（YouTube の表示文言） */
  restricted: string | null;
  timer: ReturnType<typeof setTimeout> | null;
  polling: boolean;
  failures: number;
  /** 流したコメントの ID（重複除け） */
  seen: Record<string, boolean>;
  seenCount: number;
  // アーカイブ用
  queue: ReplayComment[];
  fetching: boolean;
  lastTime: number;
  exhausted: boolean;
}

export function createSession(videoId: string): Session {
  return {
    videoId, replay: false, continuation: null, baseToken: null, timeoutMs: 5000,
    sendParams: null, restricted: null, timer: null, polling: false, failures: 0, seen: {}, seenCount: 0,
    queue: [], fetching: false, lastTime: -1, exhausted: false,
  };
}

const SEEN_LIMIT = 3000;

export function remember(s: Session, id: string): void {
  s.seen[id] = true;
  if (++s.seenCount > SEEN_LIMIT) {
    s.seen = {};
    s.seenCount = 0;
  }
}

/** 投稿欄の情報（actionPanel）を取り込む。next と get_live_chat のどちらの応答にも入り得る */
export function applyActionPanel(s: Session, panel: unknown): void {
  const input = find(panel, 'liveChatMessageInputRenderer', 4) as MessageInputRenderer | undefined;
  const send = input && (find(input.sendButton, 'sendLiveChatMessageEndpoint', 6) as { params?: string } | undefined);
  if (input && send && send.params) {
    s.sendParams = send.params;
    s.maxLength = input.maxCharacterLimit || 200;
    s.restricted = null;
  } else if (!s.sendParams) {
    const restricted = find(panel, 'liveChatRestrictedParticipationRenderer', 4) as
      RestrictedParticipationRenderer | undefined;
    if (restricted) s.restricted = runsText(restricted.message) || null;
  }
}
