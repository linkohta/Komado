/*
 * 再生状態をアプリへ通知し、通知・PiP・MediaSession からの操作を <video> に伝える。
 */
import { post, type StateMessage } from './bridge.ts';
import { currentVideo, currentVideoId } from './page.ts';

const handlers: Partial<Record<MediaSessionAction, MediaSessionActionHandler | null>> = {};

/** YouTube が登録する「次へ / 前へ」を横取りして、通知ボタンから呼べるようにする */
export function installMediaSessionHook(): void {
  const mediaSession = navigator.mediaSession;
  if (!mediaSession || !mediaSession.setActionHandler) return;
  const nativeSetHandler = mediaSession.setActionHandler.bind(mediaSession);
  mediaSession.setActionHandler = (action, handler) => {
    handlers[action] = handler;
    try {
      nativeSetHandler(action, handler);
    } catch {
      // 未対応のアクションは無視する
    }
  };
}

let lastKey = '';

/** 状態をアプリへ送る。force でなければ再生位置以外が変わったときだけ送る（位置は Android 側で補間される） */
export function report(force: boolean): void {
  const video = currentVideo();
  const meta = navigator.mediaSession && navigator.mediaSession.metadata;
  const artwork = meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : null;
  const state: StateMessage = {
    type: 'state',
    videoId: currentVideoId(),
    title: (meta && meta.title) || document.title.replace(/ - YouTube$/, ''),
    artist: (meta && meta.artist) || '',
    artwork,
    playing: !!video && !video.paused && !video.ended,
    position: video ? Math.floor(video.currentTime * 1000) : 0,
    duration: video && isFinite(video.duration) ? Math.floor(video.duration * 1000) : 0,
    width: video ? video.videoWidth : 0,
    height: video ? video.videoHeight : 0,
    hasNext: !!handlers.nexttrack,
    hasPrev: !!handlers.previoustrack,
  };
  const key = JSON.stringify([state.videoId, state.title, state.artist, state.artwork, state.playing,
    state.duration, state.width, state.height, state.hasNext, state.hasPrev]);
  if (!force && key === lastKey) return;
  lastKey = key;
  post(state);
}

function playSafely(video: HTMLVideoElement): void {
  const p = video.play();
  if (p && p.catch) p.catch(() => {});
}

function clickFirst(selector: string): boolean {
  const el = document.querySelector<HTMLElement>(selector);
  if (el) el.click();
  return !!el;
}

/** アプリからの操作（PlayerCommand）。arg は seekBy / seekTo の秒数 */
export function control(action: ControlAction, arg = 0): void {
  const video = currentVideo();
  switch (action) {
    case 'play':
      if (video) playSafely(video);
      break;
    case 'pause':
      if (video) video.pause();
      break;
    case 'toggle':
      if (video) {
        if (video.paused) playSafely(video);
        else video.pause();
      }
      break;
    case 'seekBy':
      if (video) video.currentTime = Math.max(0, video.currentTime + arg);
      break;
    case 'seekTo':
      if (video) video.currentTime = arg;
      break;
    case 'next': {
      const next = handlers.nexttrack;
      if (next) next({ action: 'nexttrack' });
      else clickFirst('.ytp-next-button, .player-controls-next-button button');
      break;
    }
    case 'prev': {
      const prev = handlers.previoustrack;
      if (prev) prev({ action: 'previoustrack' });
      else if (video) video.currentTime = 0;
      break;
    }
  }
  setTimeout(() => report(true), 300);
}
