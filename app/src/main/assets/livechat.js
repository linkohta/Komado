/*
 * Komado: ライブ配信・アーカイブのチャットをニコニコ動画風に動画上へ流す（弾幕）＋チャット投稿。
 * inject.js の後ろに連結して document-start で注入される（トップフレームのみ）。
 *
 *  - m.youtube.com から同一オリジンで InnerTube API を呼ぶ:
 *      /youtubei/v1/next                … チャットの継続トークンと投稿用パラメータ（WEB クライアント指定）
 *      /youtubei/v1/live_chat/get_live_chat        … 配信中: コメント取得（ポーリング）
 *      /youtubei/v1/live_chat/get_live_chat_replay … アーカイブ: 再生位置に合わせてコメント取得
 *      /youtubei/v1/live_chat/send_message         … コメント投稿（配信中のみ。ログイン中は SAPISIDHASH で認証）
 *  - コメントは .html5-video-player の中に重ねた .komado-dm に流す（全画面・PiP でも表示）
 *  - プレイヤー直下に入力バー（弾幕 ON/OFF・入力欄・送信）を差し込む
 */
(function () {
  'use strict';
  if (window.__komadoLive || window.top !== window) return;

  var api = (window.__komadoLive = {});
  var STORAGE_KEY = 'komado.danmaku';
  var WEB_CLIENT_VERSION = '2.20251007.01.00';
  var MAX_ITEMS = 80;        // 画面上に同時に出すコメントの上限
  var MAX_TEXT = 80;         // 1 コメントの最大文字数（超えた分は省略）
  var PROBE_DELAY_MS = 4000; // プレイヤー応答でライブか判定できないとき next を叩くまでの待ち
  var RETRY_DELAY_MS = 30000; // セッションが止まった（通信失敗・待機室・配信終了）あと同じ動画で再試行するまでの待ち

  // ------------------------------------------------------------------ 設定
  var enabled = true;
  try { enabled = localStorage.getItem(STORAGE_KEY) !== '0'; } catch (e) {}

  function setEnabled(on) {
    enabled = !!on;
    try { localStorage.setItem(STORAGE_KEY, enabled ? '1' : '0'); } catch (e) {}
    updateBar();
    if (!enabled) clearOverlay();
    if (session && !session.replay) {
      if (enabled) startPolling(session);
      else stopPolling(session);
    }
    if (session && session.replay && !enabled) resetReplay(session);
  }

  // ------------------------------------------------------------------ ライブ判定（プレイヤー応答から）
  var liveById = {};

  // videoId → true: ライブ配信中またはアーカイブ（チャットがあり得る）, false: 通常の動画
  function notePlayerResponse(o) {
    var d = o && o.videoDetails;
    if (d && typeof d.videoId === 'string') liveById[d.videoId] = !!(d.isLive || d.isLiveContent);
  }

  function sniff(o) {
    if (!o || typeof o !== 'object') return;
    if (o.videoDetails) notePlayerResponse(o);
    else if (o.playerResponse) notePlayerResponse(o.playerResponse);
  }

  var nativeParse = JSON.parse;
  JSON.parse = function () {
    var result = nativeParse.apply(this, arguments);
    try { sniff(result); } catch (e) {}
    return result;
  };
  var nativeJson = Response.prototype.json;
  Response.prototype.json = function () {
    return nativeJson.apply(this, arguments).then(function (result) {
      try { sniff(result); } catch (e) {}
      return result;
    });
  };
  document.addEventListener('DOMContentLoaded', function () {
    try { sniff(window.ytInitialPlayerResponse); } catch (e) {}
  });

  // ------------------------------------------------------------------ InnerTube
  function cfg(key) {
    try { return window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : undefined; } catch (e) { return undefined; }
  }

  function cookie(name) {
    var m = document.cookie.match('(?:^|;\\s*)' + name + '=([^;]*)');
    return m ? decodeURIComponent(m[1]) : null;
  }

  function sha1Hex(text) {
    if (!(window.crypto && crypto.subtle)) return Promise.reject(new Error('no crypto'));
    return crypto.subtle.digest('SHA-1', new TextEncoder().encode(text)).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  function sapisidCookie() {
    return cookie('SAPISID') || cookie('__Secure-3PAPISID') || cookie('__Secure-1PAPISID');
  }

  function authHeaders() {
    var sapisid = sapisidCookie();
    var headers = {
      'Content-Type': 'application/json',
      'X-Youtube-Client-Name': '1',
      'X-Youtube-Client-Version': WEB_CLIENT_VERSION,
      'X-Origin': location.origin
    };
    var visitor = cfg('VISITOR_DATA');
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;
    var pageId = cfg('DELEGATED_SESSION_ID');
    if (pageId) headers['X-Goog-PageId'] = pageId;
    if (!sapisid) return Promise.resolve(headers);
    var ts = Math.floor(Date.now() / 1000);
    return sha1Hex(ts + ' ' + sapisid + ' ' + location.origin).then(function (hash) {
      headers.Authorization = 'SAPISIDHASH ' + ts + '_' + hash;
      headers['X-Goog-AuthUser'] = String(cfg('SESSION_INDEX') || 0);
      headers['X-Youtube-Bootstrap-Logged-In'] = 'true';
      return headers;
    }, function () { return headers; });
  }

  function webContext() {
    var base = cfg('INNERTUBE_CONTEXT') || {};
    var client = Object.assign({}, base.client || {});
    client.clientName = 'WEB';
    client.clientVersion = WEB_CLIENT_VERSION;
    delete client.clientFormFactor;
    delete client.mainAppWebInfo;
    client.hl = client.hl || 'ja';
    return Object.assign({}, base, { client: client });
  }

  function innertube(endpoint, body) {
    body.context = webContext();
    return authHeaders().then(function (headers) {
      return fetch('/youtubei/v1/' + endpoint + '?prettyPrint=false', {
        method: 'POST',
        headers: headers,
        body: JSON.stringify(body),
        credentials: 'same-origin'
      });
    }).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return nativeJson.call(res);
    });
  }

  // 任意の深さにある最初のキーを探す
  function find(o, key, depth) {
    depth = depth === undefined ? 12 : depth;
    if (!o || typeof o !== 'object' || depth < 0) return undefined;
    if (Object.prototype.hasOwnProperty.call(o, key)) return o[key];
    var keys = Object.keys(o);
    for (var i = 0; i < keys.length; i++) {
      var r = find(o[keys[i]], key, depth - 1);
      if (r !== undefined) return r;
    }
    return undefined;
  }

  function runsText(obj) {
    if (!obj) return '';
    if (typeof obj.simpleText === 'string') return obj.simpleText;
    if (obj.runs) return obj.runs.map(function (r) { return r.text || (r.emoji && r.emoji.shortcuts ? r.emoji.shortcuts[0] : ''); }).join('');
    return '';
  }

  // ------------------------------------------------------------------ 継続トークンの書き換え
  // next が返すトークンは「トップチャット」用。「チャット（すべて）」用のトークンは
  // 本体（配信中: field 119693434 / アーカイブ: field 156074452）の中の表示設定
  // （配信中: field 16 / アーカイブ: field 14）のうち sub-field 1 を 4→1、sub-field 5 を 1 にしたもの。
  // 失敗したら元のトークン（トップチャット）を使う。
  var VIEW_FIELD = { 119693434: 16, 156074452: 14 };

  function allChatToken(token) {
    try {
      var bytes = fromBase64Url(token);
      var outer = readFields(bytes);
      var changed = false;
      outer.forEach(function (f) {
        var viewField = VIEW_FIELD[f.field];
        if (!viewField || f.wire !== 2) return;
        var inner = readFields(f.bytes);
        inner.forEach(function (g) {
          if (g.field !== viewField || g.wire !== 2) return;
          var sub = readFields(g.bytes);
          sub.forEach(function (h) {
            if (h.wire !== 0) return;
            if (h.field === 1) { h.value = 1; changed = true; }
            if (h.field === 5) h.value = 1;
          });
          g.bytes = writeFields(sub);
        });
        f.bytes = writeFields(inner);
      });
      return changed ? toBase64Url(writeFields(outer)) : token;
    } catch (e) {
      return token;
    }
  }

  function fromBase64Url(s) {
    s = decodeURIComponent(s).replace(/-/g, '+').replace(/_/g, '/');
    var bin = atob(s);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function toBase64Url(bytes) {
    var bin = '';
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '%3D');
  }

  // protobuf の varint / length-delimited だけを読む（他のワイヤタイプが出たら例外）
  function readFields(bytes) {
    var fields = [], i = 0;
    function varint() {
      var result = 0, shift = 0, b;
      do {
        if (i >= bytes.length) throw new Error('eof');
        b = bytes[i++];
        result += (b & 0x7f) * Math.pow(2, shift);
        shift += 7;
      } while (b & 0x80);
      return result;
    }
    while (i < bytes.length) {
      var key = varint();
      var wire = key & 7, field = Math.floor(key / 8);
      if (wire === 0) fields.push({ field: field, wire: 0, value: varint() });
      else if (wire === 2) {
        var len = varint();
        fields.push({ field: field, wire: 2, bytes: bytes.slice(i, i + len) });
        i += len;
      } else throw new Error('wire ' + wire);
    }
    return fields;
  }

  function writeFields(fields) {
    var out = [];
    function varint(v) {
      while (v >= 128) { out.push((v % 128) | 0x80); v = Math.floor(v / 128); }
      out.push(v);
    }
    fields.forEach(function (f) {
      varint(f.field * 8 + f.wire);
      if (f.wire === 0) varint(f.value);
      else { varint(f.bytes.length); for (var i = 0; i < f.bytes.length; i++) out.push(f.bytes[i]); }
    });
    return Uint8Array.from(out);
  }

  // ------------------------------------------------------------------ セッション（動画 1 本ぶんのチャット）
  var session = null;      // { videoId, replay, continuation, timeoutMs, sendParams, restricted, timer, polling, failures, ... }
  var activeId = null;     // 現在の動画 ID（ライブでなくても）
  var probeTimer = null;

  function startSession(videoId) {
    stopSession();
    var s = session = { videoId: videoId, replay: false, continuation: null, baseToken: null, timeoutMs: 5000,
      sendParams: null, restricted: null, timer: null, polling: false, failures: 0, seen: {}, seenCount: 0,
      // アーカイブ用
      queue: [], fetching: false, lastTime: -1, exhausted: false };
    innertube('next', { videoId: videoId }).then(function (data) {
      if (session !== s) return;
      var renderer = find(data, 'liveChatRenderer', 8);
      // 待機室（配信開始前）や終了直後はチャットがまだ無い。しばらくして確かめ直す
      if (!renderer) { stopSession(); scheduleRetry(videoId); return; }

      var cont = renderer.continuations && renderer.continuations[0] && renderer.continuations[0].reloadContinuationData;
      s.baseToken = cont && allChatToken(cont.continuation);
      s.continuation = s.baseToken;
      s.replay = !!renderer.isReplay;

      applyActionPanel(s, renderer.actionPanel);
      if (!s.continuation) { stopSession(); scheduleRetry(videoId); return; }
      showBar(true);
      // 投稿用パラメータは next ではなく get_live_chat の応答に入ることがあるので、
      // 弾幕 OFF でも最初の 1 回は取得する（poll 側で enabled を見て継続を決める）
      if (!s.replay) startPolling(s);
    }).catch(function () {
      if (session === s) { stopSession(); scheduleRetry(videoId); }
    });
  }

  // セッションが止まったあと、同じ動画を見続けているなら時間をおいて next からやり直す
  var retryTimer = null;
  function scheduleRetry(videoId) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(function () {
      retryTimer = null;
      if (activeId === videoId && !session) startSession(videoId);
    }, RETRY_DELAY_MS);
  }

  // 投稿欄の情報（actionPanel）を取り込む。next と get_live_chat のどちらの応答にも入り得る
  function applyActionPanel(s, panel) {
    if (!panel) return;
    var input = find(panel, 'liveChatMessageInputRenderer', 4);
    var send = input && find(input.sendButton, 'sendLiveChatMessageEndpoint', 6);
    if (send && send.params) {
      s.sendParams = send.params;
      s.maxLength = input.maxCharacterLimit || 200;
      s.restricted = null;
    } else if (!s.sendParams) {
      var restricted = find(panel, 'liveChatRestrictedParticipationRenderer', 4);
      if (restricted) s.restricted = runsText(restricted.message) || null;
    }
    updateBar();
  }

  function stopSession() {
    if (!session) return;
    stopPolling(session);
    session = null;
    clearOverlay();
    showBar(false);
  }

  function startPolling(s) {
    if (s.polling || !s.continuation) return;
    s.polling = true;
    poll(s);
  }

  function stopPolling(s) {
    s.polling = false;
    if (s.timer) { clearTimeout(s.timer); s.timer = null; }
  }

  function poll(s) {
    if (!s.polling || session !== s) return;
    innertube('live_chat/get_live_chat', { continuation: s.continuation }).then(function (data) {
      if (!s.polling || session !== s) return;
      var cc = data.continuationContents && data.continuationContents.liveChatContinuation;
      if (!cc) { stopSession(); scheduleRetry(s.videoId); return; } // 配信終了（アーカイブ化されたら再試行で拾う）
      var next = cc.continuations && cc.continuations[0];
      var cd = next && (next.invalidationContinuationData || next.timedContinuationData || next.reloadContinuationData);
      if (cd) {
        s.continuation = cd.continuation;
        s.timeoutMs = Math.max(1000, Math.min(cd.timeoutMs || 5000, 15000));
      }
      s.failures = 0;
      applyActionPanel(s, cc.actionPanel);
      if (!enabled) { s.polling = false; return; }
      handleActions(s, cc.actions || [], s.timeoutMs);
      s.timer = setTimeout(function () { poll(s); }, s.timeoutMs);
    }).catch(function () {
      if (!s.polling || session !== s) return;
      // 通信断などで続けて失敗したら、いったん止めて next からやり直す（トークンが古くなっている可能性がある）
      if (++s.failures > 5) { stopSession(); scheduleRetry(s.videoId); return; }
      s.timer = setTimeout(function () { poll(s); }, 5000);
    });
  }

  // 1 回の応答に含まれるコメントを、タイムスタンプの間隔に合わせて次の取得までの間に散らして出す
  function handleActions(s, actions, spanMs) {
    var items = [];
    for (var i = 0; i < actions.length; i++) {
      var item = actions[i].addChatItemAction && actions[i].addChatItemAction.item;
      if (!item) continue;
      var c = toComment(item);
      if (c && !s.seen[c.id]) {
        remember(s, c.id);
        items.push(c);
      }
    }
    if (!items.length) return;
    var first = items[0].ts, last = items[items.length - 1].ts;
    var scale = last > first ? Math.min(1, spanMs / (last - first)) : 0;
    items.forEach(function (c) {
      var delay = scale ? (c.ts - first) * scale : 0;
      setTimeout(function () { if (session === s && enabled) emit(c); }, delay);
    });
  }

  // ---- アーカイブ（チャットのリプレイ）
  // 再生位置 (video.currentTime) に合わせて get_live_chat_replay で先読みし、queue から順に流す。
  var REPLAY_LOOKAHEAD_MS = 15000; // 残りがこれを切ったら次を取りに行く
  var REPLAY_SEEK_JUMP_MS = 3000;  // 再生位置がこれ以上飛んだらシークとみなして取り直す

  function resetReplay(s) {
    s.queue = [];
    s.continuation = s.baseToken;
    s.exhausted = false;
    s.seen = {};
    s.seenCount = 0;
    s.lastTime = -1;
    clearOverlay();
  }

  function replayTick(s, video) {
    if (!video || !enabled) return;
    var now = Math.floor(video.currentTime * 1000);
    if (s.lastTime >= 0 && Math.abs(now - s.lastTime) > REPLAY_SEEK_JUMP_MS) {
      resetReplay(s); // シーク
    }
    s.lastTime = now;
    if (video.paused) return;

    // 再生位置を過ぎたものを流す（大きく遅れたものは捨てる）
    while (s.queue.length && s.queue[0].offset <= now) {
      var c = s.queue.shift();
      if (now - c.offset < 2000) emit(c);
    }
    var lastOffset = s.queue.length ? s.queue[s.queue.length - 1].offset : now;
    if (!s.exhausted && !s.fetching && s.continuation && lastOffset - now < REPLAY_LOOKAHEAD_MS) {
      replayFetch(s, now);
    }
  }

  function replayFetch(s, offsetMs) {
    s.fetching = true;
    var token = s.continuation;
    innertube('live_chat/get_live_chat_replay', {
      continuation: token,
      currentPlayerState: { playerOffsetMs: String(offsetMs) }
    }).then(function (data) {
      if (session !== s) return;
      s.fetching = false;
      if (s.continuation !== token) return; // 取得中にシークされた
      var cc = data.continuationContents && data.continuationContents.liveChatContinuation;
      if (!cc) { s.exhausted = true; return; }
      var next = cc.continuations && cc.continuations[0];
      var cd = next && (next.liveChatReplayContinuationData || next.playerSeekContinuationData);
      s.continuation = cd ? cd.continuation : null;
      var added = 0;
      (cc.actions || []).forEach(function (a) {
        var r = a.replayChatItemAction;
        if (!r) return;
        var offset = Number(r.videoOffsetTimeMsec || 0);
        (r.actions || []).forEach(function (inner) {
          var item = inner.addChatItemAction && inner.addChatItemAction.item;
          var c = item && toComment(item);
          if (!c || s.seen[c.id] || offset < offsetMs - 2000) return;
          remember(s, c.id);
          c.offset = offset;
          s.queue.push(c);
          added++;
        });
      });
      s.queue.sort(function (a, b) { return a.offset - b.offset; });
      s.failures = 0;
      if (!s.continuation || !(cc.actions || []).length) s.exhausted = true;
    }).catch(function () {
      if (session !== s) return;
      s.fetching = false;
      if (++s.failures > 5) s.exhausted = true;
    });
  }

  function remember(s, id) {
    s.seen[id] = true;
    if (++s.seenCount > 3000) { s.seen = {}; s.seenCount = 0; }
  }

  function argbToCss(n) {
    n = Number(n) >>> 0;
    return 'rgb(' + ((n >> 16) & 255) + ',' + ((n >> 8) & 255) + ',' + (n & 255) + ')';
  }

  // チャットアイテム → { id, ts, runs, color }
  function toComment(item) {
    var r, color = '#fff', prefix = '';
    if (item.liveChatTextMessageRenderer) {
      r = item.liveChatTextMessageRenderer;
      var badges = r.authorBadges || [];
      for (var i = 0; i < badges.length; i++) {
        var b = badges[i].liveChatAuthorBadgeRenderer;
        var type = b && b.icon && b.icon.iconType;
        if (type === 'OWNER') color = '#ffd600';
        else if (type === 'MODERATOR') color = '#5e84f1';
        else if (b && b.customThumbnail && color === '#fff') color = '#2ba640'; // メンバー
      }
    } else if (item.liveChatPaidMessageRenderer) {
      r = item.liveChatPaidMessageRenderer;
      color = r.bodyBackgroundColor ? argbToCss(r.bodyBackgroundColor) : '#ffca28';
      prefix = runsText(r.purchaseAmountText) + ' ';
    } else if (item.liveChatPaidStickerRenderer) {
      r = item.liveChatPaidStickerRenderer;
      color = '#ffca28';
      prefix = runsText(r.purchaseAmountText) + ' ';
      r = Object.assign({}, r, { message: { runs: [{ text: 'スタンプ' }] } });
    } else if (item.liveChatMembershipItemRenderer) {
      r = item.liveChatMembershipItemRenderer;
      color = '#2ba640';
      if (!r.message) r = Object.assign({}, r, { message: r.headerSubtext || r.headerPrimaryText });
    } else {
      return null;
    }
    var runs = (r.message && r.message.runs) || [];
    if (prefix) runs = [{ text: prefix }].concat(runs);
    if (!runs.length) return null;
    return { id: r.id || String(Math.random()), ts: Number(r.timestampUsec || 0) / 1000, runs: runs, color: color };
  }

  // ------------------------------------------------------------------ 弾幕の描画
  var overlay = null;
  var lanes = [];      // lane ごとに「次のコメントを出せる時刻」
  var liveCount = 0;

  var COMMENT_OPACITY = 0.5; // コメントの不透明度（0〜1）。動画が透けて見えるように半透明にする

  var DM_CSS = [
    '.komado-dm { position: absolute; inset: 0; overflow: hidden; pointer-events: none; z-index: 60;',
    '  font-family: "Hiragino Sans", "Noto Sans JP", "Noto Sans CJK JP", Roboto, sans-serif; }',
    '.komado-dm span { position: absolute; left: 100%; top: 0; white-space: nowrap; font-weight: 700; line-height: 1;',
    '  color: #fff; text-shadow: 0 0 2px #000, 1px 1px 0 #000, -1px -1px 0 #000, 1px -1px 0 #000, -1px 1px 0 #000;',
    '  opacity: ' + COMMENT_OPACITY + '; will-change: transform; animation: komado-fly linear forwards; }',
    '.komado-dm span.komado-own { text-decoration: underline; text-decoration-thickness: 2px; }',
    '.komado-dm.komado-paused span { animation-play-state: paused; }',
    '.komado-dm img { height: 1em; width: auto; vertical-align: -0.1em; }',
    '@keyframes komado-fly { from { transform: translateX(0); } to { transform: translateX(calc(-1 * var(--w) - 100%)); } }',
    // PiP 中: inject.js の PIP_CSS では video 以外が隠れるので、弾幕だけ video の上に重ねる
    'html.komado-pip .komado-dm { position: fixed !important; inset: 0 !important; z-index: 2147483647 !important; }',
    'html.komado-pip .komado-dm, html.komado-pip .komado-dm * { visibility: visible !important; }',
    // 入力バー
    '.komado-bar { display: flex; align-items: center; gap: 6px; padding: 6px 8px; background: #0f0f0f; color: #f1f1f1;',
    '  border-bottom: 1px solid #303030; font-family: Roboto, sans-serif; font-size: 14px; box-sizing: border-box; width: 100%; }',
    '.komado-bar[hidden] { display: none; }',
    '.komado-bar button { flex: none; height: 32px; min-width: 32px; padding: 0 10px; border: 0; border-radius: 16px;',
    '  background: #272727; color: #f1f1f1; font: inherit; }',
    '.komado-bar button.komado-toggle.off { color: #717171; text-decoration: line-through; }',
    '.komado-bar button.komado-send { background: #3ea6ff; color: #0f0f0f; font-weight: 700; }',
    '.komado-bar button:disabled { opacity: 0.5; }',
    '.komado-bar input { flex: 1; min-width: 0; height: 32px; padding: 0 12px; border: 1px solid #303030; border-radius: 16px;',
    '  background: #121212; color: #f1f1f1; font: inherit; outline: none; }',
    '.komado-bar input:focus { border-color: #3ea6ff; }',
    '.komado-bar .komado-status { flex: 1; min-width: 0; color: #aaa; font-size: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }'
  ].join('\n');

  function ensureStyle() {
    var root = document.head || document.documentElement;
    if (!root || document.getElementById('komado-livechat')) return;
    var el = document.createElement('style');
    el.id = 'komado-livechat';
    el.textContent = DM_CSS;
    root.appendChild(el);
  }

  function player() {
    return document.querySelector('.html5-video-player');
  }

  function ensureOverlay() {
    var p = player();
    if (!p) return null;
    if (overlay && overlay.parentNode === p) return overlay;
    if (overlay) overlay.remove();
    overlay = document.createElement('div');
    overlay.className = 'komado-dm';
    p.appendChild(overlay);
    lanes = [];
    liveCount = 0;
    return overlay;
  }

  function clearOverlay() {
    if (overlay) overlay.textContent = '';
    lanes = [];
    liveCount = 0;
  }

  // 文字サイズは端末画面の短辺を基準にする（縦画面でも全画面でも同じ大きさ）。
  // PiP のように表示領域が小さいときは、その高さに合わせて縮小する。
  var FONT_SCREEN_RATIO = 30; // 短辺 ÷ 30（幅 412px の端末で 14px）
  var FONT_MIN_ROWS = 14;     // 表示領域にこれだけの行が入る大きさを上限にする

  function fontSizeFor(height) {
    var shortSide = Math.min(screen.width, screen.height) || 400;
    var base = Math.round(shortSide / FONT_SCREEN_RATIO);
    return Math.max(10, Math.min(base, Math.round(height / FONT_MIN_ROWS)));
  }

  function emit(c, own) {
    ensureStyle();
    var box = ensureOverlay();
    if (!box) return;
    var W = box.clientWidth, H = box.clientHeight;
    if (W < 40 || H < 40 || liveCount >= MAX_ITEMS) return;

    var fontSize = fontSizeFor(H);
    var lineHeight = Math.round(fontSize * 1.15);
    var laneCount = Math.max(1, Math.floor(H / lineHeight));
    var speed = W / 6; // px/s: 画面幅を 6 秒で横切る

    var el = document.createElement('span');
    el.style.fontSize = fontSize + 'px';
    el.style.color = c.color;
    if (own) el.className = 'komado-own';
    var count = 0;
    for (var i = 0; i < c.runs.length && count < MAX_TEXT; i++) {
      var run = c.runs[i];
      if (run.emoji && run.emoji.image && run.emoji.image.thumbnails && run.emoji.image.thumbnails.length) {
        var img = document.createElement('img');
        img.src = run.emoji.image.thumbnails[0].url;
        img.alt = (run.emoji.shortcuts && run.emoji.shortcuts[0]) || '';
        el.appendChild(img);
        count += 2;
      } else if (run.text) {
        var text = run.text.replace(/\s+/g, ' ');
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
    var width = el.offsetWidth || fontSize * 4;
    var now = performance.now() / 1000;
    var duration = (W + width) / speed;
    var busyUntil = now + width / speed + 0.3; // この行の末尾が右端から出きるまで

    // 空いている行、なければ最も早く空く行
    var lane = 0, best = Infinity;
    for (var l = 0; l < laneCount; l++) {
      var free = lanes[l] || 0;
      if (free <= now) { lane = l; best = -1; break; }
      if (free < best) { best = free; lane = l; }
    }
    lanes[lane] = busyUntil;

    el.style.top = (lane * lineHeight) + 'px';
    el.style.setProperty('--w', W + 'px');
    el.style.animationDuration = duration.toFixed(2) + 's';
    el.style.animationName = ''; // スタイルシートの komado-fly で開始
    liveCount++;
    el.addEventListener('animationend', function () { el.remove(); liveCount--; });
    // animationend が来ないケース（非表示など）の保険
    setTimeout(function () { if (el.parentNode) { el.remove(); liveCount--; } }, duration * 1000 + 1000);
  }

  // ------------------------------------------------------------------ 入力バー
  var bar = null, toggleButton = null, input = null, sendButton = null, status = null;
  var barVisible = false;

  function buildBar() {
    bar = document.createElement('div');
    bar.className = 'komado-bar';
    bar.hidden = true;

    toggleButton = document.createElement('button');
    toggleButton.type = 'button';
    toggleButton.className = 'komado-toggle';
    toggleButton.textContent = '弾幕';
    toggleButton.addEventListener('click', function () { setEnabled(!enabled); });

    input = document.createElement('input');
    input.type = 'text';
    input.enterKeyHint = 'send';
    input.autocomplete = 'off';
    input.placeholder = 'コメントを入力';
    input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.isComposing) { e.preventDefault(); submit(); }
    });
    // YouTube 側のキーボードショートカットに食われないようにする
    ['keydown', 'keyup', 'keypress'].forEach(function (t) {
      input.addEventListener(t, function (e) { e.stopPropagation(); });
    });

    sendButton = document.createElement('button');
    sendButton.type = 'button';
    sendButton.className = 'komado-send';
    sendButton.textContent = '送信';
    sendButton.addEventListener('click', submit);

    status = document.createElement('div');
    status.className = 'komado-status';

    bar.appendChild(toggleButton);
    bar.appendChild(input);
    bar.appendChild(status);
    bar.appendChild(sendButton);
  }

  function placeBar() {
    if (!bar) buildBar();
    // モバイル版はプレイヤー本体が position: fixed で、本文側に同じ高さの placeholder が置かれる。その直後に入れる
    var anchor = document.querySelector('ytm-watch .player-placeholder') ||
      document.getElementById('player-container-id') || document.getElementById('player');
    if (!anchor) return false;
    if (bar.previousElementSibling !== anchor || bar.parentNode !== anchor.parentNode) {
      anchor.insertAdjacentElement('afterend', bar);
    }
    return true;
  }

  function showBar(on) {
    barVisible = on;
    updateBar();
  }

  function updateBar() {
    if (!bar) return;
    bar.hidden = !barVisible;
    if (!barVisible) return;
    toggleButton.classList.toggle('off', !enabled);
    toggleButton.title = enabled ? 'コメントを流す: ON' : 'コメントを流す: OFF';
    var canPost = !!(session && session.sendParams && !session.replay);
    input.disabled = !canPost;
    input.maxLength = (session && session.maxLength) || 200;
    sendButton.disabled = !canPost;
    if (canPost) {
      input.hidden = false;
      status.hidden = true;
    } else {
      input.hidden = true;
      status.hidden = false;
      status.textContent = session && session.replay ? 'チャットのリプレイ（投稿はできません）'
        : (session && session.restricted) ? session.restricted
        : !sapisidCookie() ? 'コメントするにはログインしてください'
        : 'この配信には投稿できません（投稿欄の情報を取得できませんでした）';
    }
  }

  var sending = false;
  function submit() {
    var s = session;
    var text = input.value.trim();
    if (!s || !s.sendParams || !text || sending) return;
    sending = true;
    sendButton.disabled = true;
    innertube('live_chat/send_message', {
      params: s.sendParams,
      richMessage: { textSegments: [{ text: text }] },
      clientMessageId: 'komado-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
    }).then(function (data) {
      if (session !== s) return;
      input.value = '';
      var actions = data.actions || [];
      var shown = false;
      for (var i = 0; i < actions.length; i++) {
        var item = actions[i].addChatItemAction && actions[i].addChatItemAction.item;
        var c = item && toComment(item);
        if (c) {
          remember(s, c.id);
          if (enabled) emit(c, true);
          shown = true;
        }
      }
      if (!shown && enabled) emit({ id: '', ts: 0, runs: [{ text: text }], color: '#fff' }, true);
      var err = find(data, 'liveChatErrorMessage', 6) || (data.error && data.error.message);
      if (err) flash(typeof err === 'string' ? err : runsText(err.message || err));
    }).catch(function (e) {
      flash('送信できませんでした: ' + e.message);
    }).then(function () {
      sending = false;
      updateBar();
    });
  }

  var flashTimer = null;
  function flash(message) {
    if (!bar) return;
    input.hidden = true;
    status.hidden = false;
    status.textContent = message;
    clearTimeout(flashTimer);
    flashTimer = setTimeout(updateBar, 3000);
  }

  // ------------------------------------------------------------------ 監視
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

  // 今の動画で next を叩いたかどうか。動画が変わったら忘れる
  // （ミニプレイヤーや「戻る」で同じ配信に戻ってきたときに、もう一度セッションを張れるようにする）
  var attempted = false;

  function tick() {
    ensureStyle();
    var id = currentVideoId();
    if (id !== activeId) {
      activeId = id;
      attempted = false;
      stopSession();
      clearTimeout(probeTimer);
      probeTimer = null;
      clearTimeout(retryTimer);
      retryTimer = null;
      if (id) {
        // プレイヤー応答からライブと判定できないときも、しばらくしたら next で確かめる
        probeTimer = setTimeout(function () {
          probeTimer = null;
          if (activeId === id && !session && !attempted && liveById[id] !== false) {
            attempted = true;
            startSession(id);
          }
        }, PROBE_DELAY_MS);
      }
    }
    if (id && !session && !attempted && liveById[id] === true) {
      clearTimeout(probeTimer);
      probeTimer = null;
      attempted = true;
      startSession(id);
    }
    if (session) {
      placeBar();
      if (enabled) ensureOverlay();
      if (session.replay) replayTick(session, currentVideo());
    }
  }

  function currentVideo() {
    return document.querySelector('.html5-video-player video') || document.querySelector('video');
  }

  // アーカイブは timeupdate（約 4 回/秒）で細かく進める。一時停止中は弾幕も止める
  ['timeupdate', 'seeking', 'pause', 'play'].forEach(function (type) {
    document.addEventListener(type, function (e) {
      // おすすめ欄のインライン再生など、メインプレイヤー以外の <video> は無視する
      if (!session || !session.replay || e.target !== currentVideo()) return;
      if (overlay) overlay.classList.toggle('komado-paused', e.target.paused);
      replayTick(session, e.target);
    }, true);
  });

  api.setEnabled = setEnabled;
  api.debug = function () {
    return { session: !!session, replay: !!(session && session.replay), queue: session ? session.queue.length : 0,
      exhausted: !!(session && session.exhausted), lastTime: session ? session.lastTime : -1,
      polling: !!(session && session.polling), continuation: !!(session && session.continuation),
      hasSapisid: !!sapisidCookie(), restricted: session ? session.restricted : null, loggedIn: !!cfg('LOGGED_IN'),
      canPost: !!(session && session.sendParams), liveCount: liveCount, lanes: lanes.length, enabled: enabled };
  };
  api.isEnabled = function () { return enabled; };

  document.addEventListener('DOMContentLoaded', function () { ensureStyle(); tick(); });
  setInterval(tick, 1000);
})();
