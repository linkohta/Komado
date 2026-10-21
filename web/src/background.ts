/*
 * バックグラウンド再生: ページが非表示になったことを YouTube に気づかせない。
 * WebView 側の対策（BackgroundWebView.kt）と対になっている。
 */
import { isMutedForAd } from './adblock.ts';
import { currentVideoId } from './page.ts';

const BLOCKED_EVENTS = ['visibilitychange', 'webkitvisibilitychange', 'enterpictureinpicture', 'leavepictureinpicture'];

function fake(target: object, name: string, get: () => unknown): void {
  try {
    Object.defineProperty(target, name, { configurable: true, get });
  } catch {
    // 定義済みで変更できないときは諦める
  }
}

export function installBackgroundPlayback(): void {
  fake(document, 'hidden', () => false);
  fake(document, 'webkitHidden', () => false);
  fake(document, 'visibilityState', () => 'visible');
  fake(document, 'webkitVisibilityState', () => 'visible');
  for (const type of BLOCKED_EVENTS) {
    window.addEventListener(type, (e) => e.stopImmediatePropagation(), true);
  }

  // YouTube は「ウィンドウ面積 / 画面面積」が小さいと PiP とみなして一時停止する（Premium 以外）。
  // PiP ウィンドウでも全画面サイズに見せかける。
  fake(window, 'outerWidth', () => screen.width);
  fake(window, 'outerHeight', () => screen.height);
}

let unmutedFor: string | null = null;

/** モバイル版はミュート状態で自動再生する。ミュート解除ボタンが出ているとき（＝ユーザーの意思ではない）だけ解除する */
export function autoUnmute(video: HTMLVideoElement | null): void {
  const id = currentVideoId();
  if (!video || !id || unmutedFor === id || isMutedForAd()) return;
  unmutedFor = id;
  if (!video.muted) return;
  const button = document.querySelector<HTMLElement>('.ytp-unmute');
  if (button && button.offsetParent !== null) button.click();
}
