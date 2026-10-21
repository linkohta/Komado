/*
 * Komado: YouTube のページ（トップフレーム）に document-start で注入されるスクリプトの入口。
 *
 *  1. 広告データの除去と広告スキップ ........ adblock.ts（JSON の横取りは json-hook.ts）
 *  2. バックグラウンド再生 .................. background.ts
 *  3. 要素非表示フィルター / PiP 中の表示 ... styles.ts
 *  4. 再生状態の通知と操作の受け付け ........ playback.ts
 *  5. SponsorBlock のスキップ ............... sponsorblock.ts
 *  6. ライブチャットの弾幕と投稿 ............ livechat/
 *
 * 各モジュールはトップレベルで副作用を起こさず、install*() で初めてフックやタイマーを仕掛ける。
 * 二重注入（古い WebView の onPageStarted フォールバック）と iframe ではここで止める。
 */
import { handleAds, installAdBlock } from './adblock.ts';
import { autoUnmute, installBackgroundPlayback } from './background.ts';
import { installJsonHook } from './json-hook.ts';
import { installLiveChat } from './livechat/index.ts';
import { currentVideo, isVideo } from './page.ts';
import { control, installMediaSessionHook, report } from './playback.ts';
import { checkSegments, setSegments } from './sponsorblock.ts';
import { installStyles, setPip, setSelectors } from './styles.ts';

const MEDIA_EVENTS = ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'emptied', 'seeked'];

function main(): void {
  if (window.__komado || window.top !== window) return;

  window.__komado = { control, setPip, addSelectors: setSelectors, setSegments };

  installJsonHook();
  installAdBlock(); // JSON のリスナーとして最初に登録する（後続のリスナーには広告抜きの値が渡る）
  installBackgroundPlayback();
  installStyles(window.__KOMADO_CSS || []);
  installMediaSessionHook();

  // メディアイベントはバックグラウンドでも間引かれないので、主にこちらで処理する
  for (const type of MEDIA_EVENTS) {
    document.addEventListener(type, (e) => {
      if (!isVideo(e.target)) return;
      handleAds(e.target);
      if (type === 'playing') autoUnmute(e.target);
      report(type === 'seeked');
    }, true);
  }

  document.addEventListener('timeupdate', (e) => {
    if (!isVideo(e.target)) return;
    handleAds(e.target);
    checkSegments(e.target);
  }, true);

  // SPA の画面遷移やタイトル変更を拾う
  setInterval(() => {
    const video = currentVideo();
    handleAds(video);
    checkSegments(video);
    report(false);
  }, 1000);

  // ライブチャットは YouTube の内部 API に強く依存して壊れやすいので、初期化に失敗しても他の機能は止めない
  try {
    installLiveChat();
  } catch (e) {
    console.warn('Komado: live chat disabled', e);
  }
}

main();
