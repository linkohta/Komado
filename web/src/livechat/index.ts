/*
 * ライブ配信・アーカイブのチャットをニコニコ動画風に動画上へ流す（弾幕）＋チャット投稿。
 *
 * ここは全体の制御だけを持つ:
 *  - 動画の切り替えを 1 秒ごとに見て、ライブ（またはアーカイブ）ならセッションを張る
 *  - セッションが止まったら、同じ動画を見ている間は時間をおいて張り直す
 *  - 弾幕 ON/OFF と投稿
 * 取得は live.ts（配信中）/ replay.ts（アーカイブ）、描画は danmaku.ts、入力バーは bar.ts。
 */
import { onJson } from '../json-hook.ts';
import { currentVideo, currentVideoId } from '../page.ts';
import { allChatToken } from './continuation.ts';
import { ChatBar, type BarView } from './bar.ts';
import { clearOverlay, danmakuStats, emit, ensureDanmakuStyle, ensureOverlay, setPaused } from './danmaku.ts';
import { cfg, innertube, sapisidCookie } from './innertube.ts';
import { startPolling, stopPolling, type LiveHost } from './live.ts';
import { find, runsText, toComment } from './renderers.ts';
import { replayTick, resetReplay } from './replay.ts';
import { applyActionPanel, createSession, remember, type Session } from './session.ts';
import type { LiveChatRenderer, SendMessageResponse } from './types.ts';

const STORAGE_KEY = 'komado.danmaku';
const PROBE_DELAY_MS = 4000; // プレイヤー応答でライブか判定できないとき next を叩くまでの待ち
const RETRY_DELAY_MS = 30000; // セッションが止まった（通信失敗・待機室・配信終了）あと同じ動画で再試行するまでの待ち
const TICK_MS = 1000;
const REPLAY_EVENTS = ['timeupdate', 'seeking', 'pause', 'play'];

let enabled = true;
let session: Session | null = null;
let activeId: string | null = null; // 現在の動画 ID（ライブでなくても）
// 今の動画で next を叩いたかどうか。動画が変わったら忘れる
// （ミニプレイヤーや「戻る」で同じ配信に戻ってきたときに、もう一度セッションを張れるようにする）
let attempted = false;
let probeTimer: ReturnType<typeof setTimeout> | undefined;
let retryTimer: ReturnType<typeof setTimeout> | undefined;
let sending = false;

/** videoId → true: ライブ配信中またはアーカイブ（チャットがあり得る）, false: 通常の動画 */
const liveById: Record<string, boolean> = {};

const host: LiveHost = {
  isCurrent: (s) => session === s,
  isEnabled: () => enabled,
  end: (s) => {
    stopSession();
    scheduleRetry(s.videoId);
  },
  onActionPanel: (s, panel) => updateActionPanel(s, panel),
};

const bar = new ChatBar(barView, {
  onToggle: () => setEnabled(!enabled),
  onSubmit: () => void submit(),
});

// ------------------------------------------------------------------ 設定

function setEnabled(on: boolean): void {
  enabled = !!on;
  try {
    localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0');
  } catch {
    // ストレージが使えなくても今回の表示には効かせる
  }
  bar.update();
  if (!enabled) clearOverlay();
  if (session && !session.replay) {
    if (enabled) startPolling(session, host);
    else stopPolling(session);
  }
  if (session && session.replay && !enabled) resetReplay(session);
}

// ------------------------------------------------------------------ ライブ判定（プレイヤー応答から）

interface VideoDetails {
  videoId?: unknown;
  isLive?: boolean;
  isLiveContent?: boolean;
}

function notePlayerResponse(o: { videoDetails?: VideoDetails } | undefined): void {
  const d = o && o.videoDetails;
  if (d && typeof d.videoId === 'string') liveById[d.videoId] = !!(d.isLive || d.isLiveContent);
}

function sniff(o: unknown): void {
  if (!o || typeof o !== 'object') return;
  const r = o as { videoDetails?: VideoDetails; playerResponse?: { videoDetails?: VideoDetails } };
  if (r.videoDetails) notePlayerResponse(r);
  else if (r.playerResponse) notePlayerResponse(r.playerResponse);
}

// ------------------------------------------------------------------ セッション

async function startSession(videoId: string): Promise<void> {
  stopSession();
  const s = (session = createSession(videoId));
  try {
    const data = await innertube<unknown>('next', { videoId });
    if (session !== s) return;
    const renderer = find(data, 'liveChatRenderer', 8) as LiveChatRenderer | undefined;
    // 待機室（配信開始前）や終了直後はチャットがまだ無い。しばらくして確かめ直す
    if (!renderer) {
      host.end(s);
      return;
    }
    const cont = renderer.continuations && renderer.continuations[0] && renderer.continuations[0].reloadContinuationData;
    s.baseToken = cont ? allChatToken(cont.continuation) : null;
    s.continuation = s.baseToken;
    s.replay = !!renderer.isReplay;

    updateActionPanel(s, renderer.actionPanel);
    if (!s.continuation) {
      host.end(s);
      return;
    }
    bar.show(true);
    // 投稿用パラメータは next ではなく get_live_chat の応答に入ることがあるので、
    // 弾幕 OFF でも最初の 1 回は取得する（poll 側で enabled を見て継続を決める）
    if (!s.replay) startPolling(s, host);
  } catch {
    if (session === s) host.end(s);
  }
}

function stopSession(): void {
  if (!session) return;
  stopPolling(session);
  session = null;
  clearOverlay();
  bar.show(false);
}

/** セッションが止まったあと、同じ動画を見続けているなら時間をおいて next からやり直す */
function scheduleRetry(videoId: string): void {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    retryTimer = undefined;
    if (activeId === videoId && !session) void startSession(videoId);
  }, RETRY_DELAY_MS);
}

function updateActionPanel(s: Session, panel: unknown): void {
  if (!panel) return;
  applyActionPanel(s, panel);
  bar.update();
}

// ------------------------------------------------------------------ 入力バー

function barView(): BarView {
  const s = session;
  return {
    enabled,
    canPost: !!(s && s.sendParams && !s.replay),
    maxLength: (s && s.maxLength) || 200,
    status: s && s.replay ? 'チャットのリプレイ（投稿はできません）'
      : s && s.restricted ? s.restricted
      : !sapisidCookie() ? 'コメントするにはログインしてください'
      : 'この配信には投稿できません（投稿欄の情報を取得できませんでした）',
  };
}

async function submit(): Promise<void> {
  const s = session;
  const text = bar.text;
  if (!s || !s.sendParams || !text || sending) return;
  sending = true;
  bar.setSending();
  try {
    const data = await innertube<SendMessageResponse>('live_chat/send_message', {
      params: s.sendParams,
      richMessage: { textSegments: [{ text }] },
      clientMessageId: 'komado-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8),
    });
    if (session !== s) return;
    bar.clearText();
    let shown = false;
    for (const action of data.actions || []) {
      const item = action.addChatItemAction && action.addChatItemAction.item;
      const c = item && toComment(item);
      if (c) {
        remember(s, c.id); // ポーリングで同じコメントが届いても二重に流さない
        if (enabled) emit(c, true);
        shown = true;
      }
    }
    if (!shown && enabled) emit({ id: '', ts: 0, runs: [{ text }], color: '#fff' }, true);
    const err = find(data, 'liveChatErrorMessage', 6) || (data.error && data.error.message);
    if (err) {
      bar.flash(typeof err === 'string' ? err : runsText((err as { message?: unknown }).message || err));
    }
  } catch (e) {
    bar.flash('送信できませんでした: ' + (e instanceof Error ? e.message : String(e)));
  } finally {
    sending = false;
    bar.update();
  }
}

// ------------------------------------------------------------------ 監視

function tick(): void {
  ensureDanmakuStyle();
  const id = currentVideoId();
  if (id !== activeId) {
    activeId = id;
    attempted = false;
    stopSession();
    clearTimeout(probeTimer);
    probeTimer = undefined;
    clearTimeout(retryTimer);
    retryTimer = undefined;
    if (id) {
      // プレイヤー応答からライブと判定できないときも、しばらくしたら next で確かめる
      probeTimer = setTimeout(() => {
        probeTimer = undefined;
        if (activeId === id && !session && !attempted && liveById[id] !== false) {
          attempted = true;
          void startSession(id);
        }
      }, PROBE_DELAY_MS);
    }
  }
  if (id && !session && !attempted && liveById[id] === true) {
    clearTimeout(probeTimer);
    probeTimer = undefined;
    attempted = true;
    void startSession(id);
  }
  if (session) {
    bar.place();
    if (enabled) ensureOverlay();
    if (session.replay) replayTick(session, currentVideo(), host);
  }
}

function debug(): Record<string, unknown> {
  const s = session;
  const stats = danmakuStats();
  return {
    session: !!s, replay: !!(s && s.replay), queue: s ? s.queue.length : 0,
    exhausted: !!(s && s.exhausted), lastTime: s ? s.lastTime : -1,
    polling: !!(s && s.polling), continuation: !!(s && s.continuation),
    hasSapisid: !!sapisidCookie(), restricted: s ? s.restricted : null, loggedIn: !!cfg('LOGGED_IN'),
    canPost: !!(s && s.sendParams), liveCount: stats.liveCount, lanes: stats.lanes, enabled,
  };
}

export function installLiveChat(): void {
  try {
    enabled = localStorage.getItem(STORAGE_KEY) !== '0';
  } catch {
    // 読めなければ ON のまま
  }
  onJson(sniff);

  // アーカイブは timeupdate で細かく進める。一時停止中は弾幕も止める
  for (const type of REPLAY_EVENTS) {
    document.addEventListener(type, (e) => {
      // おすすめ欄のインライン再生など、メインプレイヤー以外の <video> は無視する
      if (!session || !session.replay || e.target !== currentVideo()) return;
      const video = e.target as HTMLVideoElement;
      setPaused(video.paused);
      replayTick(session, video, host);
    }, true);
  }

  document.addEventListener('DOMContentLoaded', tick);
  setInterval(tick, TICK_MS);

  window.__komadoLive = { setEnabled, isEnabled: () => enabled, debug };
}
