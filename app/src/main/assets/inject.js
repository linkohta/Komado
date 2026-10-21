/*
 * Komado: YouTube のページに document-start で注入されるスクリプト。
 *  1. 広告データの除去（uBlock Origin の json-prune 相当）と広告スキップ
 *  2. バックグラウンド再生（ページ非表示を YouTube に気づかせない）
 *  3. 要素非表示フィルター / PiP 中は動画だけを表示
 *  4. 再生状態をアプリへ通知し、通知・PiP ボタンからの操作を受ける
 *  5. SponsorBlock のセグメントをスキップ
 * ライブ配信のコメント（弾幕・投稿）は livechat.js が担当し、このスクリプトの後ろに連結される。
 * 先頭に window.__KOMADO_CSS（フィルターリストのセレクタ配列）がアプリ側で付加される。
 */
(function () {
  'use strict';
  if (window.__komado || window.top !== window) return;

  var api = (window.__komado = {});

  function post(message) {
    try {
      if (window.KomadoBridge) window.KomadoBridge.postMessage(JSON.stringify(message));
    } catch (e) {}
  }

  // ------------------------------------------------------------------ 1. 広告データの除去
  var AD_KEYS = ['adPlacements', 'adSlots', 'playerAds', 'adBreakHeartbeatParams'];

  function hasAds(o) {
    if (!o || typeof o !== 'object') return false;
    for (var i = 0; i < AD_KEYS.length; i++) if (AD_KEYS[i] in o) return true;
    return !!(o.playerResponse && hasAds(o.playerResponse));
  }

  function prune(o) {
    for (var i = 0; i < AD_KEYS.length; i++) delete o[AD_KEYS[i]];
    if (o.playerResponse && typeof o.playerResponse === 'object') prune(o.playerResponse);
    return o;
  }

  var nativeParse = JSON.parse;
  JSON.parse = function () {
    var result = nativeParse.apply(this, arguments);
    try { if (hasAds(result)) prune(result); } catch (e) {}
    return result;
  };

  var nativeJson = Response.prototype.json;
  Response.prototype.json = function () {
    return nativeJson.apply(this, arguments).then(function (result) {
      try { if (hasAds(result)) prune(result); } catch (e) {}
      return result;
    });
  };

  // HTML に埋め込まれた初期プレイヤー情報（var ytInitialPlayerResponse = {...}）
  (function () {
    var value;
    try {
      Object.defineProperty(window, 'ytInitialPlayerResponse', {
        configurable: true,
        get: function () { return value; },
        set: function (v) { value = hasAds(v) ? prune(v) : v; }
      });
    } catch (e) {}
  })();

  // すり抜けた広告は早送りしてスキップボタンを押す
  var adMuted = false;
  function handleAds(video) {
    var player = document.querySelector('.html5-video-player');
    if (!player || !video) return;
    if (player.classList.contains('ad-showing') || player.classList.contains('ad-interrupting')) {
      if (!video.muted) { video.muted = true; adMuted = true; }
      if (isFinite(video.duration) && video.duration > 0 && video.currentTime < video.duration - 0.1) {
        video.currentTime = video.duration - 0.05;
      }
      var skip = document.querySelector(
        '.ytp-ad-skip-button, .ytp-ad-skip-button-modern, .ytp-skip-ad-button, .ytp-ad-skip-button-slot button'
      );
      if (skip) skip.click();
    } else if (adMuted) {
      video.muted = false;
      adMuted = false;
    }
  }

  // ------------------------------------------------------------------ 2. バックグラウンド再生
  function fake(name, value) {
    try { Object.defineProperty(document, name, { configurable: true, get: function () { return value; } }); } catch (e) {}
  }
  fake('hidden', false);
  fake('webkitHidden', false);
  fake('visibilityState', 'visible');
  fake('webkitVisibilityState', 'visible');
  ['visibilitychange', 'webkitvisibilitychange', 'enterpictureinpicture', 'leavepictureinpicture'].forEach(function (type) {
    window.addEventListener(type, function (e) { e.stopImmediatePropagation(); }, true);
  });

  // YouTube は「ウィンドウ面積 / 画面面積」が小さいと PiP とみなして一時停止する（Premium 以外）。
  // PiP ウィンドウでも全画面サイズに見せかける。
  try {
    Object.defineProperty(window, 'outerWidth', { configurable: true, get: function () { return screen.width; } });
    Object.defineProperty(window, 'outerHeight', { configurable: true, get: function () { return screen.height; } });
  } catch (e) {}

  // モバイル版はミュート状態で自動再生する。ミュート解除ボタンが出ているとき（＝ユーザーの意思ではない）だけ解除する
  var unmutedFor = null;
  function autoUnmute(video) {
    var id = currentVideoId();
    if (!video || !id || unmutedFor === id || adMuted) return;
    unmutedFor = id;
    if (!video.muted) return;
    var button = document.querySelector('.ytp-unmute');
    if (button && button.offsetParent !== null) button.click();
  }

  // ------------------------------------------------------------------ 3. CSS
  var PIP_CSS = [
    'html.komado-pip, html.komado-pip body { background: #000 !important; overflow: hidden !important; }',
    // 弾幕（livechat.js の .komado-dm）だけは動画の上に残す
    // :where() は詳細度 0 なので、video を表示するルールとの優先順位を変えずに弾幕だけ除外できる
    'html.komado-pip body *:where(:not(.komado-dm, .komado-dm *)) { visibility: hidden !important; transform: none !important; contain: none !important; filter: none !important; }',
    'html.komado-pip video { visibility: visible !important; position: fixed !important; top: 0 !important; left: 0 !important;' +
      ' width: 100vw !important; height: 100vh !important; max-width: none !important; max-height: none !important;' +
      ' margin: 0 !important; object-fit: contain !important; background: #000 !important; z-index: 2147483647 !important; }'
  ].join('\n');

  var selectors = window.__KOMADO_CSS || [];

  function setStyle(id, css) {
    var root = document.head || document.documentElement;
    if (!root) return;
    var el = document.getElementById(id);
    if (!el) {
      el = document.createElement('style');
      el.id = id;
      root.appendChild(el);
    }
    if (el.textContent !== css) el.textContent = css;
  }

  function applyStyles() {
    // 1 セレクタ 1 ルールにして、解釈できないセレクタがあっても他が効くようにする
    setStyle('komado-cosmetic', selectors.map(function (s) { return s + ' { display: none !important; }'; }).join('\n'));
    setStyle('komado-pip', PIP_CSS);
  }

  if (document.documentElement) applyStyles();
  document.addEventListener('DOMContentLoaded', applyStyles);

  // ------------------------------------------------------------------ 4. 状態通知と操作
  var handlers = {};
  if (navigator.mediaSession && navigator.mediaSession.setActionHandler) {
    // YouTube が登録する「次へ / 前へ」を横取りして通知ボタンから呼べるようにする
    var nativeSetHandler = navigator.mediaSession.setActionHandler.bind(navigator.mediaSession);
    navigator.mediaSession.setActionHandler = function (action, handler) {
      handlers[action] = handler;
      try { nativeSetHandler(action, handler); } catch (e) {}
    };
  }

  function currentVideo() {
    return document.querySelector('.html5-video-player video') || document.querySelector('video');
  }

  function currentVideoId() {
    try {
      var url = new URL(location.href);
      if (url.pathname === '/watch') return url.searchParams.get('v');
      var m = url.pathname.match(/^\/(?:shorts|live)\/([\w-]{11})/);
      return m ? m[1] : null;
    } catch (e) {
      return null;
    }
  }

  var lastKey = '';
  function report(force) {
    var video = currentVideo();
    var meta = navigator.mediaSession && navigator.mediaSession.metadata;
    var artwork = meta && meta.artwork && meta.artwork.length ? meta.artwork[meta.artwork.length - 1].src : null;
    var state = {
      type: 'state',
      videoId: currentVideoId(),
      title: (meta && meta.title) || document.title.replace(/ - YouTube$/, ''),
      artist: (meta && meta.artist) || '',
      artwork: artwork,
      playing: !!video && !video.paused && !video.ended,
      position: video ? Math.floor(video.currentTime * 1000) : 0,
      duration: video && isFinite(video.duration) ? Math.floor(video.duration * 1000) : 0,
      width: video ? video.videoWidth : 0,
      height: video ? video.videoHeight : 0,
      hasNext: !!handlers.nexttrack,
      hasPrev: !!handlers.previoustrack
    };
    // 再生位置以外が変わったときだけ送る（位置は Android 側で補間される）
    var key = JSON.stringify([state.videoId, state.title, state.artist, state.artwork, state.playing,
      state.duration, state.width, state.height, state.hasNext, state.hasPrev]);
    if (!force && key === lastKey) return;
    lastKey = key;
    post(state);
  }

  function playSafely(video) {
    var p = video.play();
    if (p && p.catch) p.catch(function () {});
  }

  function clickFirst(selector) {
    var el = document.querySelector(selector);
    if (el) el.click();
    return !!el;
  }

  api.control = function (action, arg) {
    var video = currentVideo();
    switch (action) {
      case 'play': if (video) playSafely(video); break;
      case 'pause': if (video) video.pause(); break;
      case 'toggle': if (video) { if (video.paused) playSafely(video); else video.pause(); } break;
      case 'seekBy': if (video) video.currentTime = Math.max(0, video.currentTime + arg); break;
      case 'seekTo': if (video) video.currentTime = arg; break;
      case 'next':
        if (handlers.nexttrack) handlers.nexttrack({ action: 'nexttrack' });
        else clickFirst('.ytp-next-button, .player-controls-next-button button');
        break;
      case 'prev':
        if (handlers.previoustrack) handlers.previoustrack({ action: 'previoustrack' });
        else if (video) video.currentTime = 0;
        break;
    }
    setTimeout(function () { report(true); }, 300);
  };

  api.setPip = function (on) {
    document.documentElement.classList.toggle('komado-pip', !!on);
  };

  api.addSelectors = function (list) {
    selectors = list || [];
    applyStyles();
  };

  // ------------------------------------------------------------------ 5. SponsorBlock
  var segments = { videoId: null, list: [] };
  var requestedFor = null;
  var skipped = {};

  api.setSegments = function (videoId, list) {
    if (videoId === requestedFor) segments = { videoId: videoId, list: list || [] };
  };

  function checkSegments(video) {
    var id = currentVideoId();
    if (id !== requestedFor) {
      requestedFor = id;
      segments = { videoId: id, list: [] };
      skipped = {};
      if (id) post({ type: 'segments', videoId: id });
    }
    if (!video || segments.videoId !== id) return;
    var t = video.currentTime;
    for (var i = 0; i < segments.list.length; i++) {
      var s = segments.list[i];
      if (t >= s.start && t < s.end - 0.5 && !skipped[s.start]) {
        skipped[s.start] = true; // 自分で巻き戻したときは再スキップしない
        video.currentTime = s.end;
        post({ type: 'skipped', category: s.category });
        break;
      }
    }
  }

  // ------------------------------------------------------------------ イベント
  // メディアイベントはバックグラウンドでも間引かれないので、主にこちらで処理する
  ['play', 'playing', 'pause', 'ended', 'loadedmetadata', 'durationchange', 'emptied', 'seeked'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      if (e.target && e.target.tagName === 'VIDEO') {
        handleAds(e.target);
        if (type === 'playing') autoUnmute(e.target);
        report(type === 'seeked');
      }
    }, true);
  });

  document.addEventListener('timeupdate', function (e) {
    if (e.target && e.target.tagName === 'VIDEO') {
      handleAds(e.target);
      checkSegments(e.target);
    }
  }, true);

  // SPA の画面遷移やタイトル変更を拾う
  setInterval(function () {
    var video = currentVideo();
    handleAds(video);
    checkSegments(video);
    report(false);
  }, 1000);
})();
