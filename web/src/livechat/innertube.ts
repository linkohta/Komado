/*
 * InnerTube（YouTube 内部 API）の呼び出し。m.youtube.com から同一オリジンで呼ぶ:
 *   /youtubei/v1/next                           … チャットの継続トークンと投稿用パラメータ
 *   /youtubei/v1/live_chat/get_live_chat        … 配信中: コメント取得（ポーリング）
 *   /youtubei/v1/live_chat/get_live_chat_replay … アーカイブ: 再生位置に合わせてコメント取得
 *   /youtubei/v1/live_chat/send_message         … コメント投稿（ログイン中は SAPISIDHASH で認証）
 *
 * モバイル版（MWEB）のクライアントではチャットが返らないので、WEB クライアントを名乗る。
 */

/** WEB クライアントのバージョン。古すぎると YouTube に拒否されるので、動かなくなったらまずここを上げる */
export const WEB_CLIENT_VERSION = '2.20251007.01.00';

/** YouTube の設定ストア（ytcfg）の値 */
export function cfg(key: string): unknown {
  try {
    return window.ytcfg && window.ytcfg.get ? window.ytcfg.get(key) : undefined;
  } catch {
    return undefined;
  }
}

function cookie(name: string): string | null {
  const m = document.cookie.match('(?:^|;\\s*)' + name + '=([^;]*)');
  return m ? decodeURIComponent(m[1]) : null;
}

/** ログイン中なら認証用の Cookie がある */
export function sapisidCookie(): string | null {
  return cookie('SAPISID') || cookie('__Secure-3PAPISID') || cookie('__Secure-1PAPISID');
}

async function sha1Hex(text: string): Promise<string> {
  if (!(window.crypto && crypto.subtle)) throw new Error('no crypto');
  const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf), (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

async function authHeaders(): Promise<Record<string, string>> {
  const sapisid = sapisidCookie();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Youtube-Client-Name': '1',
    'X-Youtube-Client-Version': WEB_CLIENT_VERSION,
    'X-Origin': location.origin,
  };
  const visitor = cfg('VISITOR_DATA');
  if (visitor) headers['X-Goog-Visitor-Id'] = String(visitor);
  const pageId = cfg('DELEGATED_SESSION_ID');
  if (pageId) headers['X-Goog-PageId'] = String(pageId);
  if (!sapisid) return headers;
  const ts = Math.floor(Date.now() / 1000);
  try {
    const hash = await sha1Hex(ts + ' ' + sapisid + ' ' + location.origin);
    headers.Authorization = 'SAPISIDHASH ' + ts + '_' + hash;
    headers['X-Goog-AuthUser'] = String(cfg('SESSION_INDEX') || 0);
    headers['X-Youtube-Bootstrap-Logged-In'] = 'true';
  } catch {
    // 署名できなければ未ログインとして呼ぶ
  }
  return headers;
}

type ClientContext = Record<string, unknown>;

/** ページの INNERTUBE_CONTEXT（言語・地域・visitorData など）を引き継ぎ、クライアントだけ WEB に差し替える */
function webContext(): Record<string, unknown> {
  const base = (cfg('INNERTUBE_CONTEXT') || {}) as { client?: ClientContext };
  const client: ClientContext = Object.assign({}, base.client || {});
  client.clientName = 'WEB';
  client.clientVersion = WEB_CLIENT_VERSION;
  delete client.clientFormFactor;
  delete client.mainAppWebInfo;
  client.hl = client.hl || 'ja';
  return Object.assign({}, base, { client });
}

/** POST /youtubei/v1/<endpoint>。HTTP エラーは例外にする。応答の型は呼び出し側が指定する（中身は検証しない） */
export async function innertube<T>(endpoint: string, body: Record<string, unknown>): Promise<T> {
  body.context = webContext();
  const headers = await authHeaders();
  const res = await fetch('/youtubei/v1/' + endpoint + '?prettyPrint=false', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    credentials: 'same-origin',
  });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return (await res.json()) as T;
}
