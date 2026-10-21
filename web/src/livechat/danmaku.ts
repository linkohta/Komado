/*
 * 弾幕の描画。コメントは .html5-video-player の中に重ねた .komado-dm に右から左へ流す（全画面・PiP でも表示）。
 */
import { setStyle } from '../styles.ts';
import type { ChatComment } from './renderers.ts';

const MAX_ITEMS = 80; // 画面上に同時に出すコメントの上限
const MAX_TEXT = 80; // 1 コメントの最大文字数（超えた分は省略）
const COMMENT_OPACITY = 0.5; // コメントの不透明度（0〜1）。動画が透けて見えるように半透明にする
const CROSS_SECONDS = 6; // 画面幅を横切る秒数

// 文字サイズは端末画面の短辺を基準にする（縦画面でも全画面でも同じ大きさ）。
// PiP のように表示領域が小さいときは、その高さに合わせて縮小する。
const FONT_SCREEN_RATIO = 30; // 短辺 ÷ 30（幅 412px の端末で 14px）
const FONT_MIN_ROWS = 14; // 表示領域にこれだけの行が入る大きさを上限にする

const CSS = [
  '.komado-dm { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 60;',
  '  font-family: "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", Roboto, sans-serif; }',
  '.komado-dm span { position: absolute; left: 100%; top: 0; white-space: nowrap; font-weight: 700; line-height: 1;',
  '  color: #fff; text-shadow: 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;',
  '  opacity: ' + COMMENT_OPACITY + '; will-change: transform; animation: komado-fly linear forwards; }',
  '.komado-dm span.komado-own { text-decoration: underline; text-decoration-thickness: 2px; }',
  '.komado-dm.komado-paused span { animation-play-state: paused; }',
  '.komado-dm img { height: 1em; width: auto; vertical-align: -0.1em; }',
  '@keyframes komado-fly { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--w) - 100%)); } }',
  // PiP 中: styles.ts の PIP_CSS では video 以外が隠れるので、弾幕だけ video の上に重ねる
  'html.komado-pip .komado-dm { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }',
  'html.komado-pip .komado-dm, html.komado-pip .komado-dm * { visibility: visible !important; }',
].join('\n');

let overlay: HTMLDivElement | null = null;
let lanes: number[] = []; // 行ごとに「次のコメントを出せる時刻（秒）」
let liveCount = 0;

export function ensureDanmakuStyle(): void {
  setStyle('komado-danmaku', CSS);
}

/** プレイヤーの中に .komado-dm を用意する。プレイヤーが作り直されたら付け直す */
export function ensureOverlay(): HTMLDivElement | null {
  const player = document.querySelector('.html5-video-player');
  if (!player) return null;
  if (overlay && overlay.parentNode === player) return overlay;
  if (overlay) overlay.remove();
  overlay = document.createElement('div');
  overlay.className = 'komado-dm';
  player.appendChild(overlay);
  lanes = [];
  liveCount = 0;
  return overlay;
}

export function clearOverlay(): void {
  if (overlay) overlay.textContent = '';
  lanes = [];
  liveCount = 0;
}

/** 動画の一時停止に合わせて弾幕も止める */
export function setPaused(paused: boolean): void {
  if (overlay) overlay.classList.toggle('komado-paused', paused);
}

export function danmakuStats(): { liveCount: number; lanes: number } {
  return { liveCount, lanes: lanes.length };
}

function fontSizeFor(height: number): number {
  const shortSide = Math.min(screen.width, screen.height) || 400;
  const base = Math.round(shortSide / FONT_SCREEN_RATIO);
  return Math.max(10, Math.min(base, Math.round(height / FONT_MIN_ROWS)));
}

/** コメントを 1 つ流す。own は自分の投稿（下線を付ける） */
export function emit(c: ChatComment, own = false): void {
  ensureDanmakuStyle();
  const box = ensureOverlay();
  if (!box) return;
  const W = box.clientWidth;
  const H = box.clientHeight;
  if (W < 40 || H < 40 || liveCount >= MAX_ITEMS) return;

  const fontSize = fontSizeFor(H);
  const lineHeight = Math.round(fontSize * 1.15);
  const laneCount = Math.max(1, Math.floor(H / lineHeight));
  const speed = W / CROSS_SECONDS; // px/s

  const el = document.createElement('span');
  el.style.fontSize = fontSize + 'px';
  el.style.color = c.color;
  if (own) el.className = 'komado-own';
  let count = 0;
  for (let i = 0; i < c.runs.length && count < MAX_TEXT; i++) {
    const run = c.runs[i];
    const thumbnails = run.emoji && run.emoji.image && run.emoji.image.thumbnails;
    if (run.emoji && thumbnails && thumbnails.length) {
      const img = document.createElement('img');
      img.src = thumbnails[0].url;
      img.alt = (run.emoji.shortcuts && run.emoji.shortcuts[0]) || '';
      el.appendChild(img);
      count += 2;
    } else if (run.text) {
      let text = run.text.replace(/\s+/g, ' ');
      if (count + text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT - count) + '…';
      el.appendChild(document.createTextNode(text));
      count += text.length;
    }
  }
  if (!el.firstChild) return;

  // 幅を測る間はアニメーションを止めておく。先に開始すると duration 0 のまま即終了し、
  // その animationend で自分を消してしまう
  el.style.animationName = 'none';
  box.appendChild(el);
  const width = el.offsetWidth || fontSize * 4;
  const now = performance.now() / 1000;
  const duration = (W + width) / speed;
  const busyUntil = now + width / speed + 0.3; // この行の末尾が右端から出きるまで

  // 空いている行、なければ最も早く空く行
  let lane = 0;
  let best = Infinity;
  for (let l = 0; l < laneCount; l++) {
    const free = lanes[l] || 0;
    if (free <= now) {
      lane = l;
      break;
    }
    if (free < best) {
      best = free;
      lane = l;
    }
  }
  lanes[lane] = busyUntil;

  el.style.top = lane * lineHeight + 'px';
  el.style.setProperty('--w', W + 'px');
  el.style.animationDuration = duration.toFixed(2) + 's';
  el.style.animationName = ''; // スタイルシートの komado-fly で開始
  liveCount++;
  el.addEventListener('animationend', () => {
    el.remove();
    liveCount--;
  });
  // animationend が来ないケース（非表示など）の保険
  setTimeout(() => {
    if (el.parentNode) {
      el.remove();
      liveCount--;
    }
  }, duration * 1000 + 1000);
}
