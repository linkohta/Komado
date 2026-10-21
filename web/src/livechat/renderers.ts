/*
 * InnerTube の応答から値を取り出す純粋関数（DOM や通信に触れないのでユニットテストできる）。
 */
import type { ChatItem, MessageRenderer, Run } from './types.ts';

/** 弾幕に流す 1 コメント */
export interface ChatComment {
  id: string;
  /** 投稿時刻（ms）。1 回の応答の中で間隔をあけて流すのに使う */
  ts: number;
  runs: Run[];
  color: string;
}

/** 任意の深さにある最初の key の値を探す（応答の入れ子の形が変わっても追従しやすいように） */
export function find(o: unknown, key: string, depth = 12): unknown {
  if (!o || typeof o !== 'object' || depth < 0) return undefined;
  if (Object.prototype.hasOwnProperty.call(o, key)) return (o as Record<string, unknown>)[key];
  for (const k of Object.keys(o)) {
    const r = find((o as Record<string, unknown>)[k], key, depth - 1);
    if (r !== undefined) return r;
  }
  return undefined;
}

/** YouTube のテキスト（simpleText / runs）を文字列にする。絵文字はショートカット（:smile: など）にする */
export function runsText(obj: unknown): string {
  if (!obj || typeof obj !== 'object') return '';
  const text = obj as { simpleText?: unknown; runs?: Run[] };
  if (typeof text.simpleText === 'string') return text.simpleText;
  if (text.runs) {
    return text.runs.map((r) => r.text || (r.emoji && r.emoji.shortcuts ? r.emoji.shortcuts[0] : '')).join('');
  }
  return '';
}

/** 0xAARRGGBB（スーパーチャットの背景色）→ CSS の rgb() */
export function argbToCss(n: number): string {
  n = Number(n) >>> 0;
  return 'rgb(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ')';
}

const COLOR_DEFAULT = '#fff';
const COLOR_OWNER = '#ffd600';
const COLOR_MODERATOR = '#5e84f1';
const COLOR_MEMBER = '#2ba640';
const COLOR_PAID = '#ffca28';

/** チャットアイテム → 弾幕用のコメント。流さない種類（システムメッセージなど）は null */
export function toComment(item: ChatItem): ChatComment | null {
  let r: MessageRenderer;
  let color = COLOR_DEFAULT;
  let prefix = '';
  if (item.liveChatTextMessageRenderer) {
    r = item.liveChatTextMessageRenderer;
    for (const badge of r.authorBadges || []) {
      const b = badge.liveChatAuthorBadgeRenderer;
      const type = b && b.icon && b.icon.iconType;
      if (type === 'OWNER') color = COLOR_OWNER;
      else if (type === 'MODERATOR') color = COLOR_MODERATOR;
      else if (b && b.customThumbnail && color === COLOR_DEFAULT) color = COLOR_MEMBER; // メンバー
    }
  } else if (item.liveChatPaidMessageRenderer) {
    r = item.liveChatPaidMessageRenderer;
    color = r.bodyBackgroundColor ? argbToCss(r.bodyBackgroundColor) : COLOR_PAID;
    prefix = runsText(r.purchaseAmountText) + ' ';
  } else if (item.liveChatPaidStickerRenderer) {
    r = item.liveChatPaidStickerRenderer;
    color = COLOR_PAID;
    prefix = runsText(r.purchaseAmountText) + ' ';
    r = { ...r, message: { runs: [{ text: 'スタンプ' }] } };
  } else if (item.liveChatMembershipItemRenderer) {
    r = item.liveChatMembershipItemRenderer;
    color = COLOR_MEMBER;
    if (!r.message) r = { ...r, message: r.headerSubtext || r.headerPrimaryText };
  } else {
    return null;
  }
  let runs = (r.message && r.message.runs) || [];
  if (prefix) runs = [{ text: prefix }, ...runs];
  if (!runs.length) return null;
  return { id: r.id || String(Math.random()), ts: Number(r.timestampUsec || 0) / 1000, runs, color };
}
